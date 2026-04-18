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
  processing_ms?: number
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

export interface WhisperModelInfo {
  id: string
  label: string
  filename: string
  sizeMb: number
  description: string
}

export interface WhisperModelStatus {
  id: string
  installed: boolean
  path?: string
}

export interface ModelDownloadProgress {
  id: string
  receivedBytes: number
  totalBytes: number
  done: boolean
  error?: string
}

export type StageName = 'converting' | 'transcribing' | 'summarizing' | 'saving'
export type StageStatus = 'active' | 'done' | 'failed'

export const WHISPER_NOT_READY_MARKER = '[whisper-not-ready]'

export interface MeetingProgressEvent {
  meetingId: string
  stage: StageName
  status: StageStatus
  at: number
  error?: string
}

export interface AppSettings {
  ollamaHost?: string
  ollamaModel?: string
  whisperBin?: string
  whisperModel?: string
  whisperLanguage?: string
  supabaseUrl?: string
  supabaseAnonKey?: string
}

export interface WhisperStatus {
  binAvailable: boolean
  binPath?: string
  binVersion?: string
  binError?: string
  model?: {
    id?: string
    label?: string
    filename: string
    path: string
    sizeBytes: number
  }
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
  ProcessAndSave: 'audio:process-and-save',
  CancelProcessing: 'meeting:cancel-processing',
  MeetingProgress: 'meeting:progress',
  GetSettings: 'settings:get',
  SaveSettings: 'settings:save',
  ListWhisperModels: 'models:list',
  GetModelStatus: 'models:status',
  DownloadModel: 'models:download',
  CancelModelDownload: 'models:cancel',
  DeleteModel: 'models:delete',
  ModelProgress: 'models:progress',
  GetWhisperStatus: 'whisper:status'
} as const
