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
      name: 'meetnotes-settings',
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
  'supabaseUrl',
  'supabaseAnonKey',
  'welcomeCompletedAt'
] as const

export type SettingKey = (typeof SETTINGS_KEYS)[number]

const ENV_MAP: Partial<Record<SettingKey, string>> = {
  supabaseUrl: 'MAIN_VITE_SUPABASE_URL',
  supabaseAnonKey: 'MAIN_VITE_SUPABASE_ANON_KEY'
}

let cached: AppSettings | null = null

async function loadSettings(): Promise<AppSettings> {
  if (cached) return cached
  const store = await getStore()
  cached = store.get('settings') || {}
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
    if (typeof value === 'string' && value.trim()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(cleaned as any)[key] = value.trim()
    }
  }
  store.set('settings', cleaned)
  cached = cleaned
  return { ...cleaned }
}

export function getSettingSync(key: SettingKey): string | undefined {
  const override = cached?.[key]
  if (override) return override
  const envKey = ENV_MAP[key]
  if (!envKey) return undefined
  return (import.meta.env as unknown as Record<string, string | undefined>)[envKey]
}

export async function primeSettingsCache(): Promise<void> {
  await loadSettings()
}

export function getEffectiveSettings(): Record<SettingKey, string | undefined> {
  const out = {} as Record<SettingKey, string | undefined>
  for (const key of SETTINGS_KEYS) out[key] = getSettingSync(key)
  return out
}
