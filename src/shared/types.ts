export type PillState = 'idle' | 'recording' | 'transcribing' | 'saving'

export interface Meeting {
  id: string
  user_id: string | null
  title: string
  raw_transcript: string
  summary: string
  action_items: ActionItem[]
  created_at: string
  synced?: boolean
  status?: 'processing' | 'ready' | 'failed'
}

export interface ActionItem {
  owner?: string
  task: string
  due?: string
}

export interface MeetingDetectedPayload {
  title: string
  appName: string
  detectedAt: string
}

export interface ProcessAudioResult {
  transcript: string
  summary: string
  actionItems: ActionItem[]
}

export const IpcChannels = {
  MeetingDetected: 'meeting:detected',
  MeetingEnded: 'meeting:ended',
  PillStart: 'pill:start',
  PillStop: 'pill:stop',
  PillStateChanged: 'pill:state-changed',
  ProcessAudio: 'audio:process',
  SaveMeeting: 'meeting:save',
  ListMeetings: 'meeting:list',
  SyncPending: 'meeting:sync-pending',
  SimulateMeeting: 'meeting:simulate',
  DeleteMeeting: 'meeting:delete',
  RegenerateSummary: 'meeting:regenerate-summary',
  ProcessAndSave: 'audio:process-and-save'
} as const
