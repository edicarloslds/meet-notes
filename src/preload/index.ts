import { contextBridge, ipcRenderer } from 'electron'
import {
  ActionItem,
  AppSettings,
  IpcChannels,
  Meeting,
  MeetingDetectedPayload,
  MeetingProgressEvent,
  ModelDownloadProgress,
  OllamaStatus,
  ProcessAudioResult,
  WhisperModelInfo,
  WhisperModelStatus,
  WhisperStatus
} from '../shared/types'

const api = {
  onMeetingDetected: (cb: (p: MeetingDetectedPayload) => void): (() => void) => {
    const listener = (_: unknown, payload: MeetingDetectedPayload): void => cb(payload)
    ipcRenderer.on(IpcChannels.MeetingDetected, listener)
    return (): void => {
      ipcRenderer.removeListener(IpcChannels.MeetingDetected, listener)
    }
  },
  onMeetingProgress: (cb: (p: MeetingProgressEvent) => void): (() => void) => {
    const listener = (_: unknown, payload: MeetingProgressEvent): void => cb(payload)
    ipcRenderer.on(IpcChannels.MeetingProgress, listener)
    return (): void => {
      ipcRenderer.removeListener(IpcChannels.MeetingProgress, listener)
    }
  },
  onMeetingEnded: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IpcChannels.MeetingEnded, listener)
    return (): void => {
      ipcRenderer.removeListener(IpcChannels.MeetingEnded, listener)
    }
  },
  processAudio: (audio: ArrayBuffer): Promise<ProcessAudioResult> =>
    ipcRenderer.invoke(IpcChannels.ProcessAudio, audio),
  processAndSave: (placeholder: Meeting, audio: ArrayBuffer): void => {
    ipcRenderer.send(IpcChannels.ProcessAndSave, placeholder, audio)
  },
  saveMeeting: (meeting: Meeting): Promise<Meeting> =>
    ipcRenderer.invoke(IpcChannels.SaveMeeting, meeting),
  listMeetings: (): Promise<Meeting[]> => ipcRenderer.invoke(IpcChannels.ListMeetings),
  syncPending: (): Promise<{ synced: number; remaining: number }> =>
    ipcRenderer.invoke(IpcChannels.SyncPending),
  closePill: (): void => {
    ipcRenderer.send(IpcChannels.PillStop)
  },
  simulateMeeting: (title?: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.SimulateMeeting, title),
  deleteMeeting: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.DeleteMeeting, id),
  cancelProcessing: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.CancelProcessing, id),
  regenerateSummary: (transcript: string): Promise<{ summary: string; actionItems: ActionItem[] }> =>
    ipcRenderer.invoke(IpcChannels.RegenerateSummary, transcript),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IpcChannels.GetSettings),
  saveSettings: (settings: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke(IpcChannels.SaveSettings, settings),
  listWhisperModels: (): Promise<WhisperModelInfo[]> =>
    ipcRenderer.invoke(IpcChannels.ListWhisperModels),
  getModelStatus: (): Promise<WhisperModelStatus[]> =>
    ipcRenderer.invoke(IpcChannels.GetModelStatus),
  downloadModel: (id: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.DownloadModel, id),
  cancelModelDownload: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.CancelModelDownload, id),
  deleteModel: (id: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.DeleteModel, id),
  getWhisperStatus: (): Promise<WhisperStatus> =>
    ipcRenderer.invoke(IpcChannels.GetWhisperStatus),
  getOllamaStatus: (): Promise<OllamaStatus> =>
    ipcRenderer.invoke(IpcChannels.GetOllamaStatus),
  onModelProgress: (cb: (p: ModelDownloadProgress) => void): (() => void) => {
    const listener = (_: unknown, payload: ModelDownloadProgress): void => cb(payload)
    ipcRenderer.on(IpcChannels.ModelProgress, listener)
    return (): void => {
      ipcRenderer.removeListener(IpcChannels.ModelProgress, listener)
    }
  }
}

contextBridge.exposeInMainWorld('meetnotes', api)

export type MeetNotesAPI = typeof api
