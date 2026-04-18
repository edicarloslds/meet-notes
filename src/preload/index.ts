import { contextBridge, ipcRenderer } from 'electron'
import { ActionItem, IpcChannels, Meeting, MeetingDetectedPayload, ProcessAudioResult } from '../shared/types'

const api = {
  onMeetingDetected: (cb: (p: MeetingDetectedPayload) => void): (() => void) => {
    const listener = (_: unknown, payload: MeetingDetectedPayload): void => cb(payload)
    ipcRenderer.on(IpcChannels.MeetingDetected, listener)
    return (): void => {
      ipcRenderer.removeListener(IpcChannels.MeetingDetected, listener)
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
  regenerateSummary: (transcript: string): Promise<{ summary: string; actionItems: ActionItem[] }> =>
    ipcRenderer.invoke(IpcChannels.RegenerateSummary, transcript)
}

contextBridge.exposeInMainWorld('meetnotes', api)

export type MeetNotesAPI = typeof api
