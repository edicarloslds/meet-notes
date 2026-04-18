import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { IpcChannels, Meeting, ProcessAudioResult } from '../shared/types'
import { startMeetingWatcher, stopMeetingWatcher } from './meetingWatcher'
import { transcribeAndSummarize } from './aiService'
import { saveMeeting, listMeetings, syncPendingMeetings } from './storageService'

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

  pillWindow = new BrowserWindow({
    width: 260,
    height: 64,
    x: 40,
    y: 40,
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

  startMeetingWatcher({
    onDetected: (payload) => {
      showPill(payload.title)
      dashboardWindow?.webContents.send(IpcChannels.MeetingDetected, payload)
    },
    onEnded: () => {
      dashboardWindow?.webContents.send(IpcChannels.MeetingEnded)
    }
  })

  // Attempt to sync anything offline.
  syncPendingMeetings().catch((err) => console.warn('Sync on boot failed:', err))

  ipcMain.handle(IpcChannels.ProcessAudio, async (_e, audioBuffer: ArrayBuffer): Promise<ProcessAudioResult> => {
    return transcribeAndSummarize(Buffer.from(audioBuffer))
  })

  ipcMain.handle(IpcChannels.SaveMeeting, async (_e, meeting: Meeting) => {
    return saveMeeting(meeting)
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createDashboardWindow()
  })
})

app.on('window-all-closed', () => {
  stopMeetingWatcher()
  if (process.platform !== 'darwin') app.quit()
})
