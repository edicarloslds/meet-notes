import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import {
  AudioChunkPayload,
  AppSettings,
  IpcChannels,
  Meeting,
  MeetingExportFormat,
  MeetingDetectedPayload,
  MeetingProgressEvent,
  OLLAMA_NOT_READY_MARKER,
  ProcessAudioResult,
  StageName,
  StageStatus,
  SystemSettingsSection
} from '../shared/types'
import type { TranscriptSegment } from '../shared/types'
import { startMeetingWatcher, stopMeetingWatcher } from './meetingWatcher'
import {
  assertOllamaReady,
  assertWhisperReady,
  getOllamaStatus,
  getWhisperStatus,
  isAbortError,
  normalizeTranscriptArtifacts,
  summarizeTranscript,
  transcribeAndSummarize,
  transcribePcmChunk
} from './aiService'
import {
  cleanupStaleProcessing,
  deleteMeeting,
  listMeetings,
  resetSupabaseClient,
  saveMeeting,
  startPendingSyncScheduler,
  stopPendingSyncScheduler,
  syncPendingMeetings
} from './storageService'
import { getSettings, primeSettingsCache, saveSettings } from './settingsService'
import {
  cancelDownload,
  deleteModel,
  downloadModel,
  listModelStatus,
  WHISPER_MODELS
} from './modelDownloader'

let dashboardWindow: BrowserWindow | null = null
let pillWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function createDashboardWindow(): void {
  dashboardWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  dashboardWindow.on('ready-to-show', () => dashboardWindow?.show())
  dashboardWindow.on('closed', () => {
    dashboardWindow = null
  })

  dashboardWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    dashboardWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/dashboard.html`)
  } else {
    dashboardWindow.loadFile(join(__dirname, '../renderer/dashboard.html'))
  }
}

function openDashboard(): void {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    createDashboardWindow()
  } else {
    if (dashboardWindow.isMinimized()) dashboardWindow.restore()
    dashboardWindow.show()
    dashboardWindow.focus()
  }
}

function createPillWindow(): void {
  if (pillWindow && !pillWindow.isDestroyed()) return

  const pillWidth = 380
  const pillHeight = 64
  const { workArea } = screen.getPrimaryDisplay()
  pillWindow = new BrowserWindow({
    width: pillWidth,
    height: pillHeight,
    x: workArea.x + Math.round((workArea.width - pillWidth) / 2),
    y: workArea.y + workArea.height - pillHeight - 32,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  pillWindow.setAlwaysOnTop(true, 'screen-saver')
  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  pillWindow.once('ready-to-show', () => pillWindow?.showInactive())
  pillWindow.on('closed', () => {
    pillWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    pillWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/pill.html`)
  } else {
    pillWindow.loadFile(join(__dirname, '../renderer/pill.html'))
  }
}

function showPill(meetingTitle: string): void {
  createPillWindow()
  pillWindow?.webContents.once('did-finish-load', () => {
    pillWindow?.webContents.send(IpcChannels.MeetingDetected, { title: meetingTitle })
  })
  if (pillWindow?.webContents.isLoading() === false) {
    pillWindow.webContents.send(IpcChannels.MeetingDetected, { title: meetingTitle })
  }
}

function hidePill(): void {
  if (pillWindow && !pillWindow.isDestroyed()) {
    pillWindow.close()
    pillWindow = null
  }
}

function handleDetected(payload: MeetingDetectedPayload): void {
  showPill(payload.title)
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send(IpcChannels.MeetingDetected, payload)
  }
}

const processingJobs = new Map<string, AbortController>()

interface ChunkJob {
  controller: AbortController
  transcript: string
  segments: TranscriptSegment[]
  queue: Promise<void>
  cancelled: boolean
}
const chunkJobs = new Map<string, ChunkJob>()

function emitProgress(
  meetingId: string,
  stage: StageName,
  status: StageStatus,
  extra?: { error?: string; progress?: number }
): void {
  const payload: MeetingProgressEvent = {
    meetingId,
    stage,
    status,
    at: Date.now(),
    ...(extra?.error ? { error: extra.error } : {}),
    ...(typeof extra?.progress === 'number' ? { progress: extra.progress } : {})
  }
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send(IpcChannels.MeetingProgress, payload)
  }
}

function cleanMarker(message: string | undefined, marker: string): string | undefined {
  if (!message) return undefined
  return message.replace(marker, '').trim() || undefined
}

function mergeChunkTranscript(existing: string, incoming: string): string {
  const trimmedIncoming = incoming.trim()
  if (!trimmedIncoming) return existing
  if (!existing.trim()) return trimmedIncoming

  const existingWords = tokenizeForOverlap(existing)
  const incomingWords = trimmedIncoming.split(/\s+/)
  const normalizedIncoming = incomingWords.map(normalizeWord).filter(Boolean)
  const maxWords = Math.min(existingWords.length, normalizedIncoming.length, 24)

  for (let overlap = maxWords; overlap >= 6; overlap--) {
    const suffix = existingWords.slice(existingWords.length - overlap)
    const prefix = normalizedIncoming.slice(0, overlap)
    if (suffix.length === prefix.length && suffix.every((word, index) => word === prefix[index])) {
      const remainder = incomingWords.slice(overlap).join(' ').trim()
      return remainder ? `${existing.trim()}\n${remainder}` : existing.trim()
    }
  }

  const existingNormalized = existingWords.join(' ')
  const incomingNormalized = normalizedIncoming.join(' ')
  if (incomingNormalized && existingNormalized.endsWith(incomingNormalized)) {
    return existing.trim()
  }

  return `${existing.trim()}\n${trimmedIncoming}`
}

function appendTranscriptSegment(
  segments: TranscriptSegment[],
  next: TranscriptSegment
): TranscriptSegment[] {
  const mergedText = mergeChunkTranscript(segments[segments.length - 1]?.text ?? '', next.text)
  if (segments.length === 0) {
    return mergedText.trim() ? [{ ...next, text: mergedText.trim() }] : segments
  }
  const last = segments[segments.length - 1]
  if (mergedText.trim() === last.text.trim()) return segments
  const appendedText =
    mergedText.length > last.text.length
      ? mergedText.slice(last.text.length).trim()
      : next.text.trim()
  if (!appendedText) return segments
  return [
    ...segments,
    {
      ...next,
      text: appendedText
    }
  ]
}

function tokenizeForOverlap(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean)
}

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function formatExportTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

function slugifyFilename(input: string): string {
  const normalized = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'meeting'
}

function renderMeetingExport(meeting: Meeting, format: MeetingExportFormat): string {
  const title = meeting.title.trim() || 'Reunião'
  const createdAt = new Date(meeting.created_at).toLocaleString('pt-BR')
  const actionLines =
    meeting.action_items?.length
      ? meeting.action_items.map((item) => {
          const owner = item.owner ? `${item.owner}: ` : ''
          const due = item.due ? ` (até ${item.due})` : ''
          return format === 'markdown'
            ? `- ${owner}${item.task}${due}`
            : `- ${owner}${item.task}${due}`
        })
      : [format === 'markdown' ? '- Nenhum item de ação identificado.' : '- Nenhum item de ação identificado.']

  const transcriptBody =
    meeting.transcript_segments?.length
      ? meeting.transcript_segments
          .map((segment) => {
            const time = `${formatExportTimestamp(segment.startMs)}-${formatExportTimestamp(segment.endMs)}`
            const speaker = segment.speakerLabel ? `${segment.speakerLabel}: ` : ''
            return format === 'markdown'
              ? `- [${time}] ${speaker}${segment.text}`
              : `[${time}] ${speaker}${segment.text}`
          })
          .join(format === 'markdown' ? '\n' : '\n\n')
      : meeting.raw_transcript.trim() || 'Sem transcrição.'

  if (format === 'text') {
    return [
      title,
      `Data: ${createdAt}`,
      '',
      'Resumo',
      meeting.summary.trim() || 'Sem resumo.',
      '',
      'Itens de ação',
      ...actionLines,
      '',
      'Transcrição',
      transcriptBody
    ].join('\n')
  }

  return [
    `# ${title}`,
    '',
    `**Data:** ${createdAt}`,
    '',
    '## Resumo',
    meeting.summary.trim() || 'Sem resumo.',
    '',
    '## Itens de Ação',
    ...actionLines,
    '',
    '## Transcrição',
    transcriptBody
  ].join('\n')
}

function handleEnded(): void {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send(IpcChannels.MeetingEnded)
  }
}

function startManualRecording(): void {
  showPill('Gravação manual')
}

function createTray(): void {
  if (tray) return
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'trayTemplate.png')
    : join(__dirname, '../../resources/trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Distill')
  const rebuildMenu = (): void => {
    const menu = Menu.buildFromTemplate([
      { label: 'Abrir Distill', click: () => openDashboard() },
      { label: 'Iniciar gravação', accelerator: 'CommandOrControl+Shift+R', click: () => startManualRecording() },
      { type: 'separator' },
      { label: 'Sair', click: () => { isQuitting = true; app.quit() } }
    ])
    tray?.setContextMenu(menu)
  }
  rebuildMenu()
}

app.whenReady().then(async () => {
  await primeSettingsCache()

  createTray()
  createDashboardWindow()

  const recordingShortcut = 'CommandOrControl+Shift+R'
  if (!globalShortcut.register(recordingShortcut, () => startManualRecording())) {
    console.warn(`Falha ao registrar atalho ${recordingShortcut}`)
  }

  startMeetingWatcher({ onDetected: handleDetected, onEnded: handleEnded })

  cleanupStaleProcessing()
    .then((ids) => {
      if (ids.length > 0) console.log(`Cleaned ${ids.length} stale processing meeting(s)`)
    })
    .catch((err) => console.warn('Cleanup on boot failed:', err))

  syncPendingMeetings().catch((err) => console.warn('Sync on boot failed:', err))
  startPendingSyncScheduler()

  ipcMain.handle(
    IpcChannels.ProcessAudio,
    async (_e, audioBuffer: ArrayBuffer): Promise<ProcessAudioResult> => {
      return transcribeAndSummarize(Buffer.from(audioBuffer))
    }
  )

  ipcMain.handle(IpcChannels.SaveMeeting, async (_e, meeting: Meeting) => {
    const saved = await saveMeeting(meeting)
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send(IpcChannels.MeetingEnded)
    }
    return saved
  })

  ipcMain.on(
    IpcChannels.ProcessAndSave,
    (_e, placeholder: Meeting, audioBuffer: ArrayBuffer) => {
      void (async (): Promise<void> => {
        const startedAt = Date.now()
        const meetingId = placeholder.id
        const controller = new AbortController()
        processingJobs.set(meetingId, controller)
        try {
          const result = await transcribeAndSummarize(
            Buffer.from(audioBuffer),
            (stage, status, extra) => emitProgress(meetingId, stage, status, extra),
            controller.signal
          )
          emitProgress(meetingId, 'saving', 'active')
          await saveMeeting({
            ...placeholder,
            raw_transcript: result.transcript,
            summary: result.summary,
            action_items: result.actionItems,
            status: 'ready',
            processing_ms: Date.now() - startedAt
          })
          emitProgress(meetingId, 'saving', 'done')
        } catch (err) {
          if (isAbortError(err) || controller.signal.aborted) {
            await deleteMeeting(meetingId).catch(() => undefined)
          } else {
            console.warn('process-and-save failed:', err)
            emitProgress(meetingId, 'saving', 'failed', { error: (err as Error).message })
            await saveMeeting({
              ...placeholder,
              status: 'failed',
              failure_stage: 'saving',
              failure_reason: (err as Error).message
            }).catch(() => undefined)
          }
        } finally {
          processingJobs.delete(meetingId)
        }
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send(IpcChannels.MeetingEnded)
        }
      })()
    }
  )

  ipcMain.handle(IpcChannels.CancelProcessing, async (_e, id: string) => {
    const chunkJob = chunkJobs.get(id)
    if (chunkJob) {
      chunkJob.cancelled = true
      chunkJob.controller.abort()
    }
    const controller = processingJobs.get(id)
    if (controller) {
      controller.abort()
      return
    }
    if (chunkJob) return
    await deleteMeeting(id).catch(() => undefined)
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send(IpcChannels.MeetingEnded)
    }
  })

  ipcMain.handle(IpcChannels.StartMeetingChunks, async (_e, meetingId: string) => {
    await assertWhisperReady()
    const existing = chunkJobs.get(meetingId)
    if (existing) {
      existing.cancelled = true
      existing.controller.abort()
    }
    chunkJobs.set(meetingId, {
      controller: new AbortController(),
      transcript: '',
      segments: [],
      queue: Promise.resolve(),
      cancelled: false
    })
  })

  ipcMain.handle(
    IpcChannels.SubmitAudioChunk,
    async (_e, meetingId: string, chunk: AudioChunkPayload, sampleRate: number) => {
      const job = chunkJobs.get(meetingId)
      if (!job || job.cancelled) return
      const int16 = new Int16Array(chunk.pcm)
      job.queue = job.queue.then(async () => {
        if (job.cancelled || job.controller.signal.aborted) return
        try {
          const text = await transcribePcmChunk(int16, sampleRate, job.controller.signal)
          const merged = mergeChunkTranscript(job.transcript, text)
          const appended = merged.slice(job.transcript.length).trim()
          if (appended) {
            job.transcript = merged
            job.segments = appendTranscriptSegment(job.segments, {
              id: `${meetingId}-${chunk.startMs}-${chunk.endMs}`,
              startMs: chunk.startMs,
              endMs: chunk.endMs,
              text
            })
          }
        } catch (err) {
          if (!isAbortError(err)) console.warn('Chunk transcription failed:', err)
        }
      })
    }
  )

  ipcMain.handle(IpcChannels.AbortMeetingChunks, async (_e, meetingId: string) => {
    const job = chunkJobs.get(meetingId)
    if (!job) return
    job.cancelled = true
    job.controller.abort()
    chunkJobs.delete(meetingId)
  })

  ipcMain.on(
    IpcChannels.FinalizeMeeting,
    (_e, placeholder: Meeting, remainingChunk: AudioChunkPayload | null, sampleRate: number) => {
      void (async (): Promise<void> => {
        const meetingId = placeholder.id
        const job =
          chunkJobs.get(meetingId) ??
          ({
            controller: new AbortController(),
            transcript: '',
            segments: [],
            queue: Promise.resolve(),
            cancelled: false
          } satisfies ChunkJob)
        chunkJobs.set(meetingId, job)
        processingJobs.set(meetingId, job.controller)
        const startedAt = Date.now()
        let failedStage: StageName | 'capture' = 'transcribing'

        await saveMeeting({ ...placeholder, status: 'processing' }).catch(() => undefined)

        try {
          if (remainingChunk && remainingChunk.pcm.byteLength > 0) {
            const int16 = new Int16Array(remainingChunk.pcm)
            emitProgress(meetingId, 'transcribing', 'active')
            failedStage = 'transcribing'
            job.queue = job.queue.then(async () => {
              if (job.cancelled || job.controller.signal.aborted) return
              const text = await transcribePcmChunk(
                int16,
                sampleRate,
                job.controller.signal,
                (pct) => emitProgress(meetingId, 'transcribing', 'active', { progress: pct })
              )
              const merged = mergeChunkTranscript(job.transcript, text)
              const appended = merged.slice(job.transcript.length).trim()
              if (appended) {
                job.transcript = merged
                job.segments = appendTranscriptSegment(job.segments, {
                  id: `${meetingId}-${remainingChunk.startMs}-${remainingChunk.endMs}`,
                  startMs: remainingChunk.startMs,
                  endMs: remainingChunk.endMs,
                  text
                })
              }
            })
          } else {
            emitProgress(meetingId, 'transcribing', 'active')
          }
          await job.queue
          if (job.cancelled) throw new DOMException('Aborted', 'AbortError')
          emitProgress(meetingId, 'transcribing', 'done')

          const normalized = normalizeTranscriptArtifacts(job.transcript, job.segments)
          const transcript = normalized.transcript.trim()
          const transcriptSegments = normalized.segments
          if (!transcript) {
            const msg =
              'Nenhuma fala foi reconhecida pelo Whisper. Verifique o áudio e o modelo selecionado.'
            emitProgress(meetingId, 'transcribing', 'failed', { error: msg })
            throw new Error(msg)
          }

          let summary = ''
          let actionItems = placeholder.action_items
          let summaryStatus: Meeting['summary_status'] = 'complete'
          let summaryError: string | undefined

          emitProgress(meetingId, 'summarizing', 'active')
          failedStage = 'summarizing'
          try {
            await assertOllamaReady()
            const result = await summarizeTranscript(transcript, job.controller.signal)
            summary = result.summary
            actionItems = result.actionItems
            emitProgress(meetingId, 'summarizing', 'done')
          } catch (err) {
            if (isAbortError(err) || job.controller.signal.aborted || job.cancelled) throw err
            const message = (err as Error).message
            summaryStatus = message.includes(OLLAMA_NOT_READY_MARKER) ? 'skipped' : 'failed'
            summaryError =
              cleanMarker(message, OLLAMA_NOT_READY_MARKER) ??
              'Nao foi possivel gerar o resumo desta reuniao.'
            emitProgress(meetingId, 'summarizing', 'failed', { error: summaryError })
          }

          emitProgress(meetingId, 'saving', 'active')
          failedStage = 'saving'
          await saveMeeting({
            ...placeholder,
            raw_transcript: transcript,
            transcript_segments: transcriptSegments,
            summary,
            action_items: actionItems,
            status: 'ready',
            processing_ms: Date.now() - startedAt,
            summary_status: summaryStatus,
            summary_error: summaryError,
            failure_stage: summaryStatus === 'failed' ? 'summarizing' : undefined,
            failure_reason: summaryStatus === 'failed' ? summaryError : undefined
          })
          emitProgress(meetingId, 'saving', 'done')
        } catch (err) {
          if (isAbortError(err) || job.controller.signal.aborted || job.cancelled) {
            await deleteMeeting(meetingId).catch(() => undefined)
          } else {
            console.warn('finalize-meeting failed:', err)
            emitProgress(meetingId, 'saving', 'failed', { error: (err as Error).message })
            await saveMeeting({
              ...placeholder,
              status: 'failed',
              failure_stage: failedStage,
              failure_reason: (err as Error).message
            }).catch(() => undefined)
          }
        } finally {
          chunkJobs.delete(meetingId)
          processingJobs.delete(meetingId)
        }
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send(IpcChannels.MeetingEnded)
        }
      })()
    }
  )

  ipcMain.handle(IpcChannels.ListMeetings, async () => listMeetings())
  ipcMain.handle(IpcChannels.SyncPending, async () => syncPendingMeetings())
  ipcMain.on(IpcChannels.PillStop, () => hidePill())
  ipcMain.handle(IpcChannels.DeleteMeeting, async (_e, id: string) => {
    await deleteMeeting(id)
  })
  ipcMain.handle(IpcChannels.ExportMeeting, async (_e, meeting: Meeting, format: MeetingExportFormat) => {
    const ext = format === 'markdown' ? 'md' : 'txt'
    const defaultPath = `${slugifyFilename(meeting.title)}.${ext}`
    const saveOptions = {
      defaultPath,
      filters: [
        {
          name: format === 'markdown' ? 'Markdown' : 'Texto',
          extensions: [ext]
        }
      ]
    }
    const result = dashboardWindow && !dashboardWindow.isDestroyed()
      ? await dialog.showSaveDialog(dashboardWindow, saveOptions)
      : await dialog.showSaveDialog(saveOptions)
    if (result.canceled || !result.filePath) return { canceled: true }
    await writeFile(result.filePath, renderMeetingExport(meeting, format), 'utf8')
    return { canceled: false, path: result.filePath }
  })
  ipcMain.handle(IpcChannels.RegenerateSummary, async (_e, transcript: string) => {
    return summarizeTranscript(transcript)
  })
  ipcMain.handle(IpcChannels.GetSettings, async () => getSettings())
  ipcMain.handle(IpcChannels.SaveSettings, async (_e, next: AppSettings) => {
    const saved = await saveSettings(next)
    resetSupabaseClient()
    return saved
  })
  ipcMain.handle(IpcChannels.ListWhisperModels, async () => WHISPER_MODELS)
  ipcMain.handle(IpcChannels.GetModelStatus, async () => listModelStatus())
  ipcMain.handle(IpcChannels.DownloadModel, async (_e, id: string) => {
    const path = await downloadModel(id)
    const current = await getSettings()
    if (!current.whisperModel) {
      await saveSettings({ ...current, whisperModel: path })
    }
    return path
  })
  ipcMain.handle(IpcChannels.CancelModelDownload, async (_e, id: string) => {
    cancelDownload(id)
  })
  ipcMain.handle(IpcChannels.DeleteModel, async (_e, id: string) => {
    await deleteModel(id)
    const current = await getSettings()
    if (current.whisperModel && current.whisperModel.endsWith(`ggml-${id === 'large-v3' ? 'large-v3' : id}.bin`)) {
      await saveSettings({ ...current, whisperModel: undefined })
    }
  })
  ipcMain.handle(IpcChannels.GetWhisperStatus, async () => getWhisperStatus())
  ipcMain.handle(IpcChannels.GetOllamaStatus, async () => getOllamaStatus())
  ipcMain.handle(IpcChannels.OpenSystemSettings, async (_e, section: SystemSettingsSection) => {
    const urls: Record<SystemSettingsSection, string> = {
      microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    }
    const url = urls[section]
    if (url) await shell.openExternal(url)
  })
  ipcMain.handle(IpcChannels.SimulateMeeting, async (_e, title?: string) => {
    handleDetected({
      title: title?.trim() || 'Reunião de teste',
      appName: 'Distill (simulado)',
      detectedAt: new Date().toISOString()
    })
  })

  app.on('activate', () => openDashboard())
})

app.on('before-quit', () => {
  isQuitting = true
  stopMeetingWatcher()
  stopPendingSyncScheduler()
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit()
})
