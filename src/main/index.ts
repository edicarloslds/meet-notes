import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { join } from 'path'
import { IpcChannels, Meeting, MeetingDetectedPayload, ProcessAudioResult } from '../shared/types'
import { startMeetingWatcher, stopMeetingWatcher } from './meetingWatcher'
import { transcribeAndSummarize, summarizeTranscript } from './aiService'
import { saveMeeting, listMeetings, syncPendingMeetings, deleteMeeting } from './storageService'

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

  const pillWidth = 260
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
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('● MN')
  tray.setToolTip('MeetNotes')
  const rebuildMenu = (): void => {
    const menu = Menu.buildFromTemplate([
      { label: 'Abrir MeetNotes', click: () => openDashboard() },
      { label: 'Iniciar gravação', click: () => startManualRecording() },
      { type: 'separator' },
      { label: 'Sair', click: () => { isQuitting = true; app.quit() } }
    ])
    tray?.setContextMenu(menu)
  }
  rebuildMenu()
}

app.whenReady().then(async () => {
  createTray()
  createDashboardWindow()

  startMeetingWatcher({ onDetected: handleDetected, onEnded: handleEnded })

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
        try {
          const result = await transcribeAndSummarize(Buffer.from(audioBuffer))
          await saveMeeting({
            ...placeholder,
            raw_transcript: result.transcript,
            summary: result.summary,
            action_items: result.actionItems,
            status: 'ready'
          })
        } catch (err) {
          console.warn('process-and-save failed:', err)
          await saveMeeting({ ...placeholder, status: 'failed' }).catch(() => undefined)
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
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit()
})
