export type AudioCaptureMode = 'auto' | 'system' | 'microphone' | 'mixed'
export type AudioCaptureSource = 'system' | 'microphone' | 'mixed'
export type TranscriptionEngine = 'whisper' | 'apple-speech'
export type LiveTranslationProvider = 'libretranslate' | 'local-opus'
export type SummaryStatus = 'complete' | 'skipped' | 'failed'

export interface AudioChunkPayload {
  pcm: ArrayBuffer
  startMs: number
  endMs: number
}

export interface TranscriptSegment {
  id: string
  startMs: number
  endMs: number
  text: string
  speakerLabel?: string
  quality?: 'high' | 'medium' | 'low'
  qualityReasons?: string[]
}

export type MeetingExportFormat = 'markdown' | 'text'

export interface Meeting {
  id: string
  user_id: string | null
  title: string
  raw_transcript: string
  summary: string
  action_items: ActionItem[]
  transcript_segments?: TranscriptSegment[]
  created_at: string
  synced?: boolean
  status?: 'processing' | 'ready' | 'failed'
  processing_ms?: number
  capture_mode?: AudioCaptureMode
  capture_source?: AudioCaptureSource
  summary_status?: SummaryStatus
  summary_error?: string
  failure_stage?: StageName | 'capture'
  failure_reason?: string
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
  windowId: number
  bundleId?: string
  continueMeeting?: Meeting
}

export interface ProcessAudioResult {
  transcript: string
  summary: string
  actionItems: ActionItem[]
  summaryStatus?: SummaryStatus
  summaryError?: string
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
export const OLLAMA_NOT_READY_MARKER = '[ollama-not-ready]'

export interface OllamaStatus {
  reachable: boolean
  host: string
  version?: string
  models: string[]
  selectedModel: string
  selectedModelInstalled: boolean
  error?: string
}

export interface MeetingProgressEvent {
  meetingId: string
  stage: StageName
  status: StageStatus
  at: number
  error?: string
  progress?: number
}

export interface LiveTranscriptionEvent {
  meetingId: string
  text: string
  isFinal: boolean
  engine: TranscriptionEngine
  at: number
  error?: string
}

export interface LiveTranscriptSession {
  meetingId: string
  title: string
  transcript: string
  startedAt: number
  sourceLocale?: string
  targetLocale?: string
}

export interface LiveTranscriptionOptions {
  engine?: TranscriptionEngine
  appleSpeechLocale?: string
  appleSpeechRequiresOnDevice?: boolean
}

export interface LiveTranslationResult {
  translatedText: string
  error?: string
  provider?: LiveTranslationProvider
}

export interface LiveTranslationStatus {
  provider: LiveTranslationProvider
  host: string
  reachable: boolean
  error?: string
}

export interface PendingMeta {
  attempts: number
  nextAttemptAt: number
  lastError?: string
}

export const CHUNK_SAMPLE_RATE = 16000
export const CHUNK_WINDOW_SECONDS = 30

export interface AppSettings {
  ollamaHost?: string
  ollamaModel?: string
  whisperBin?: string
  whisperModel?: string
  whisperLanguage?: string
  transcriptionEngine?: TranscriptionEngine
  appleSpeechLocale?: string
  appleSpeechRequiresOnDevice?: boolean
  liveTranslationProvider?: LiveTranslationProvider
  libreTranslateHost?: string
  libreTranslateApiKey?: string
  localOpusHost?: string
  captureMode?: AudioCaptureMode
  pillCompact?: boolean
  pillX?: number
  pillY?: number
  transcriptGlossary?: string
  supabaseUrl?: string
  supabaseAnonKey?: string
  disableSupabase?: boolean
  welcomeCompletedAt?: string
}

export type SystemSettingsSection = 'microphone' | 'screen-recording' | 'accessibility'

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
  PillStop: 'pill:stop',
  ProcessAudio: 'audio:process',
  SaveMeeting: 'meeting:save',
  ListMeetings: 'meeting:list',
  SyncPending: 'meeting:sync-pending',
  SimulateMeeting: 'meeting:simulate',
  ContinueMeeting: 'meeting:continue',
  DeleteMeeting: 'meeting:delete',
  RegenerateSummary: 'meeting:regenerate-summary',
  ExportMeeting: 'meeting:export',
  ResetPillPosition: 'pill:reset-position',
  OpenLiveTranscript: 'pill:open-live-transcript',
  SetPillCompact: 'pill:set-compact',
  GetPillPosition: 'pill:get-position',
  SetPillPosition: 'pill:set-position',
  ProcessAndSave: 'audio:process-and-save',
  CancelProcessing: 'meeting:cancel-processing',
  MeetingProgress: 'meeting:progress',
  LiveTranscription: 'meeting:live-transcription',
  LiveTranscriptSession: 'meeting:live-session',
  TranslateLiveText: 'meeting:translate-live-text',
  GetLiveTranslationStatus: 'meeting:live-translation-status',
  GetSettings: 'settings:get',
  SaveSettings: 'settings:save',
  ListWhisperModels: 'models:list',
  GetModelStatus: 'models:status',
  DownloadModel: 'models:download',
  CancelModelDownload: 'models:cancel',
  DeleteModel: 'models:delete',
  ModelProgress: 'models:progress',
  GetWhisperStatus: 'whisper:status',
  GetOllamaStatus: 'ollama:status',
  OpenSystemSettings: 'system:open-settings',
  StartMeetingChunks: 'audio:start-chunks',
  SubmitAudioChunk: 'audio:submit-chunk',
  SubmitLiveAudioFrame: 'audio:submit-live-frame',
  FinalizeMeeting: 'audio:finalize-meeting',
  AbortMeetingChunks: 'audio:abort-chunks'
} as const
