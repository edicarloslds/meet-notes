import { AppSettings } from '../shared/types'

interface SettingsSchema {
  settings: AppSettings
}

type SettingsStore = {
  get<K extends keyof SettingsSchema>(key: K): SettingsSchema[K]
  set<K extends keyof SettingsSchema>(key: K, value: SettingsSchema[K]): void
}

let storePromise: Promise<SettingsStore> | null = null

function getStore(): Promise<SettingsStore> {
  if (storePromise) return storePromise
  storePromise = (async () => {
    const { default: Store } = await import('electron-store')
    return new Store<SettingsSchema>({
      name: 'distill-settings',
      defaults: { settings: {} }
    }) as unknown as SettingsStore
  })()
  return storePromise
}

export const SETTINGS_KEYS = [
  'ollamaHost',
  'ollamaModel',
  'whisperBin',
  'whisperModel',
  'whisperLanguage',
  'transcriptionEngine',
  'appleSpeechLocale',
  'appleSpeechRequiresOnDevice',
  'liveTranslationProvider',
  'libreTranslateHost',
  'libreTranslateApiKey',
  'localOpusHost',
  'liveSourceLocale',
  'liveTargetLocale',
  'liveCaptureMode',
  'captureMode',
  'pillCompact',
  'pillX',
  'pillY',
  'transcriptGlossary',
  'supabaseUrl',
  'supabaseAnonKey',
  'disableSupabase',
  'welcomeCompletedAt'
] as const

export type SettingKey = (typeof SETTINGS_KEYS)[number]

const ENV_MAP: Partial<Record<SettingKey, string>> = {
  supabaseUrl: 'MAIN_VITE_SUPABASE_URL',
  supabaseAnonKey: 'MAIN_VITE_SUPABASE_ANON_KEY'
}

let cached: AppSettings | null = null

const DEFAULT_SETTINGS: AppSettings = {
  transcriptionEngine: 'whisper',
  appleSpeechLocale: 'pt-BR',
  appleSpeechRequiresOnDevice: false,
  liveTranslationProvider: 'libretranslate',
  libreTranslateHost: 'http://127.0.0.1:5000',
  localOpusHost: 'http://127.0.0.1:5056',
  liveSourceLocale: 'en-US',
  liveTargetLocale: 'pt-BR',
  liveCaptureMode: 'auto'
}

async function loadSettings(): Promise<AppSettings> {
  if (cached) return cached
  const store = await getStore()
  cached = {
    ...DEFAULT_SETTINGS,
    ...(store.get('settings') || {})
  }
  return cached
}

export async function getSettings(): Promise<AppSettings> {
  return { ...(await loadSettings()) }
}

export async function saveSettings(next: AppSettings): Promise<AppSettings> {
  const store = await getStore()
  const cleaned: AppSettings = {}
  for (const key of SETTINGS_KEYS) {
    const value = next[key]
    if (typeof value === 'boolean') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(cleaned as any)[key] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(cleaned as any)[key] = value
    } else if (typeof value === 'string' && value.trim()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(cleaned as any)[key] = value.trim()
    }
  }
  store.set('settings', cleaned)
  cached = cleaned
  return { ...cleaned }
}

export function getSettingSync(key: SettingKey): any {
  const override = cached?.[key]
  if (override !== undefined) return override
  const envKey = ENV_MAP[key]
  if (!envKey) return undefined
  return (import.meta.env as unknown as Record<string, string | undefined>)[envKey]
}

export async function primeSettingsCache(): Promise<void> {
  await loadSettings()
}
