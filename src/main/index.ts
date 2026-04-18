import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'path'
import { IpcChannels, Meeting, MeetingDetectedPayload, ProcessAudioResult } from '../shared/types'
import { startMeetingWatcher, stopMeetingWatcher } from './meetingWatcher'
import { transcribeAndSummarize, summarizeTranscript } from './aiService'
import { saveMeeting, listMeetings, syncPendingMeetings, deleteMeeting } from './storageService'

let dashboardWindow: BrowserWindow | null = null
let pillWindow: BrowserWindow | null = null

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

app.whenReady().then(async () => {
  createDashboardWindow()

  const handleDetected = (payload: MeetingDetectedPayload): void => {
    showPill(payload.title)
    dashboardWindow?.webContents.send(IpcChannels.MeetingDetected, payload)
  }
  const handleEnded = (): void => {
    dashboardWindow?.webContents.send(IpcChannels.MeetingEnded)
  }

  startMeetingWatcher({ onDetected: handleDetected, onEnded: handleEnded })

  // Attempt to sync anything offline.
  syncPendingMeetings().catch((err) => console.warn('Sync on boot failed:', err))

  ipcMain.handle(IpcChannels.ProcessAudio, async (_e, audioBuffer: ArrayBuffer): Promise<ProcessAudioResult> => {
    return transcribeAndSummarize(Buffer.from(audioBuffer))
  })

  ipcMain.handle(IpcChannels.SaveMeeting, async (_e, meeting: Meeting) => {
    const saved = await saveMeeting(meeting)
    dashboardWindow?.webContents.send(IpcChannels.MeetingEnded)
    return saved
  })

  ipcMain.handle(IpcChannels.ListMeetings, async () => {
    return listMeetings()
  })

  ipcMain.handle(IpcChannels.SyncPending, async () => {
    return syncPendingMeetings()
  })

  ipcMain.on(IpcChannels.PillStop, () => {
    hidePill()
  })

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createDashboardWindow()
  })
})

app.on('window-all-closed', () => {
  stopMeetingWatcher()
  if (process.platform !== 'darwin') app.quit()
})
