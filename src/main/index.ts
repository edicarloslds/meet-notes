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
import { getOllamaStatus, getWhisperStatus, isAbortError, transcribeAndSummarize, summarizeTranscript } from './aiService'
import {
  cleanupStaleProcessing,
  deleteMeeting,
  listMeetings,
  resetSupabaseClient,
  saveMeeting,
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
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  pillWindow.setAlwaysOnTop(true, 'floating')
  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
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

function emitProgress(meetingId: string, stage: StageName, status: StageStatus, error?: string): void {
  const payload: MeetingProgressEvent = {
    meetingId,
    stage,
    status,
    at: Date.now(),
    ...(error ? { error } : {})
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
  tray.setToolTip('MeetNotes')
  const rebuildMenu = (): void => {
    const menu = Menu.buildFromTemplate([
      { label: 'Abrir MeetNotes', click: () => openDashboard() },
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

  ipcMain.handle(IpcChannels.ProcessAudio, async (_e, audioBuffer: ArrayBuffer): Promise<ProcessAudioResult> => {
    return transcribeAndSummarize(Buffer.from(audioBuffer))
  })

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
            (stage, status, error) => emitProgress(meetingId, stage, status, error),
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
            emitProgress(meetingId, 'saving', 'failed', (err as Error).message)
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
    const controller = processingJobs.get(id)
    if (controller) {
      controller.abort()
      return
    }
    await deleteMeeting(id).catch(() => undefined)
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send(IpcChannels.MeetingEnded)
    }
  })

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
      appName: 'MeetNotes (simulado)',
      detectedAt: new Date().toISOString()
    })
  })

  app.on('activate', () => openDashboard())
})

app.on('before-quit', () => {
  isQuitting = true
  stopMeetingWatcher()
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit()
})
