import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { join } from 'path'
import {
  AppSettings,
  IpcChannels,
  Meeting,
  MeetingDetectedPayload,
  MeetingProgressEvent,
  ProcessAudioResult,
  StageName,
  StageStatus,
  SystemSettingsSection
} from '../shared/types'
import { startMeetingWatcher, stopMeetingWatcher } from './meetingWatcher'
import {
  assertOllamaReady,
  assertWhisperReady,
  getOllamaStatus,
  getWhisperStatus,
  isAbortError,
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
  transcripts: string[]
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
            await saveMeeting({ ...placeholder, status: 'failed' }).catch(() => undefined)
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
    await assertOllamaReady()
    const existing = chunkJobs.get(meetingId)
    if (existing) {
      existing.cancelled = true
      existing.controller.abort()
    }
    chunkJobs.set(meetingId, {
      controller: new AbortController(),
      transcripts: [],
      queue: Promise.resolve(),
      cancelled: false
    })
  })

  ipcMain.handle(
    IpcChannels.SubmitAudioChunk,
    async (_e, meetingId: string, pcmBuffer: ArrayBuffer, sampleRate: number) => {
      const job = chunkJobs.get(meetingId)
      if (!job || job.cancelled) return
      const int16 = new Int16Array(pcmBuffer)
      job.queue = job.queue.then(async () => {
        if (job.cancelled || job.controller.signal.aborted) return
        try {
          const text = await transcribePcmChunk(int16, sampleRate, job.controller.signal)
          if (text.trim()) job.transcripts.push(text.trim())
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
    (_e, placeholder: Meeting, remainingPcm: ArrayBuffer | null, sampleRate: number) => {
      void (async (): Promise<void> => {
        const meetingId = placeholder.id
        const job =
          chunkJobs.get(meetingId) ??
          ({
            controller: new AbortController(),
            transcripts: [],
            queue: Promise.resolve(),
            cancelled: false
          } satisfies ChunkJob)
        chunkJobs.set(meetingId, job)
        processingJobs.set(meetingId, job.controller)
        const startedAt = Date.now()

        await saveMeeting({ ...placeholder, status: 'processing' }).catch(() => undefined)

        try {
          if (remainingPcm && remainingPcm.byteLength > 0) {
            const int16 = new Int16Array(remainingPcm)
            emitProgress(meetingId, 'transcribing', 'active')
            job.queue = job.queue.then(async () => {
              if (job.cancelled || job.controller.signal.aborted) return
              const text = await transcribePcmChunk(
                int16,
                sampleRate,
                job.controller.signal,
                (pct) => emitProgress(meetingId, 'transcribing', 'active', { progress: pct })
              )
              if (text.trim()) job.transcripts.push(text.trim())
            })
          } else {
            emitProgress(meetingId, 'transcribing', 'active')
          }
          await job.queue
          if (job.cancelled) throw new DOMException('Aborted', 'AbortError')
          emitProgress(meetingId, 'transcribing', 'done')

          const transcript = job.transcripts.join('\n').trim()
          if (!transcript) {
            const msg =
              'Nenhuma fala foi reconhecida pelo Whisper. Verifique o áudio e o modelo selecionado.'
            emitProgress(meetingId, 'transcribing', 'failed', { error: msg })
            throw new Error(msg)
          }

          emitProgress(meetingId, 'summarizing', 'active')
          const { summary, actionItems } = await summarizeTranscript(
            transcript,
            job.controller.signal
          )
          emitProgress(meetingId, 'summarizing', 'done')

          emitProgress(meetingId, 'saving', 'active')
          await saveMeeting({
            ...placeholder,
            raw_transcript: transcript,
            summary,
            action_items: actionItems,
            status: 'ready',
            processing_ms: Date.now() - startedAt
          })
          emitProgress(meetingId, 'saving', 'done')
        } catch (err) {
          if (isAbortError(err) || job.controller.signal.aborted || job.cancelled) {
            await deleteMeeting(meetingId).catch(() => undefined)
          } else {
            console.warn('finalize-meeting failed:', err)
            emitProgress(meetingId, 'saving', 'failed', { error: (err as Error).message })
            await saveMeeting({ ...placeholder, status: 'failed' }).catch(() => undefined)
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
