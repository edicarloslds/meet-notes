import type { LiveTranslationProvider, LiveTranslationStatus } from '../shared/types'
import { getSettingSync } from './settingsService'

const LIBRETRANSLATE_HOST_DEFAULT = 'http://127.0.0.1:5000'
const LOCAL_OPUS_HOST_DEFAULT = 'http://127.0.0.1:5056'
const LIVE_TRANSLATION_TIMEOUT_MS = 2_500
const LIVE_TRANSLATION_STATUS_TIMEOUT_MS = 1_500
const LIBRETRANSLATE_LANGUAGES_CACHE_MS = 30_000

interface TranslationPayload {
  text: string
  sourceLocale: string
  targetLocale: string
  signal?: AbortSignal
}

interface ProviderResult {
  translatedText: string
  provider: LiveTranslationProvider
}

interface ProviderConfig {
  provider: LiveTranslationProvider
  host: string
}

interface LibreTranslateLanguage {
  code: string
  targets?: string[]
}

let libreTranslateLanguagesCache:
  | { host: string; expiresAt: number; languages: LibreTranslateLanguage[] }
  | null = null

export async function translateLiveText(
  text: string,
  sourceLocale: string,
  targetLocale: string,
  signal?: AbortSignal
): Promise<ProviderResult> {
  const trimmed = text.trim()
  if (!trimmed) {
    return { translatedText: '', provider: resolveLiveTranslationProvider() }
  }
  if (sourceLocale === targetLocale) {
    return { translatedText: trimmed, provider: resolveLiveTranslationProvider() }
  }

  const payload = { text: trimmed, sourceLocale, targetLocale, signal }
  const provider = resolveLiveTranslationProvider()

  switch (provider) {
    case 'local-opus':
      return {
        translatedText: await translateWithLocalOpus(payload),
        provider
      }
    case 'libretranslate':
    default:
      return {
        translatedText: await translateWithLibreTranslate(payload),
        provider: 'libretranslate'
      }
  }
}

export async function getLiveTranslationStatus(): Promise<LiveTranslationStatus> {
  const config = getProviderConfig()
  try {
    if (config.provider === 'local-opus') {
      await fetchJson(`${config.host}/health`, 'Local OPUS', config.host, LIVE_TRANSLATION_STATUS_TIMEOUT_MS)
    } else {
      await fetchJson(`${config.host}/languages`, 'LibreTranslate', config.host, LIVE_TRANSLATION_STATUS_TIMEOUT_MS)
    }
    return { provider: config.provider, host: config.host, reachable: true }
  } catch (err) {
    return {
      provider: config.provider,
      host: config.host,
      reachable: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

function resolveLiveTranslationProvider(): LiveTranslationProvider {
  const configured = getSettingSync('liveTranslationProvider')
  return configured === 'local-opus' ? 'local-opus' : 'libretranslate'
}

function getProviderConfig(): ProviderConfig {
  const provider = resolveLiveTranslationProvider()
  if (provider === 'local-opus') {
    return {
      provider,
      host: normalizeHost(getSettingSync('localOpusHost') || LOCAL_OPUS_HOST_DEFAULT)
    }
  }
  return {
    provider,
    host: normalizeHost(getSettingSync('libreTranslateHost') || LIBRETRANSLATE_HOST_DEFAULT)
  }
}

async function translateWithLibreTranslate({
  text,
  sourceLocale,
  targetLocale,
  signal
}: TranslationPayload): Promise<string> {
  const host = getProviderConfig().host
  const apiKey = getSettingSync('libreTranslateApiKey')
  const sourceCandidates = toLibreTranslateLanguageCandidates(sourceLocale)
  const targetCandidates = toLibreTranslateLanguageCandidates(targetLocale)
  const pairs = await resolveLibreTranslatePairs(host, sourceCandidates, targetCandidates)
  let lastError: Error | null = null

  for (const { source, target } of pairs) {
    try {
      return await translateWithLibreTranslatePair({
        host,
        apiKey,
        text,
        source,
        target,
        signal
      })
    } catch (err) {
      if (!isUnsupportedLanguageError(err)) throw err
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw lastError ?? new Error(
    `LibreTranslate não anunciou suporte para ${sourceCandidates.join('/')} → ${targetCandidates.join('/')}. ` +
    `Abra ${host}/languages para conferir os códigos carregados.`
  )
}

async function translateWithLibreTranslatePair({
  host,
  apiKey,
  text,
  source,
  target,
  signal
}: {
  host: string
  apiKey: unknown
  text: string
  source: string
  target: string
  signal?: AbortSignal
}): Promise<string> {
  const body: Record<string, string> = {
    q: text,
    source,
    target,
    format: 'text'
  }
  if (typeof apiKey === 'string' && apiKey.trim()) body.api_key = apiKey.trim()

  const data = await postJson<{ translatedText?: unknown; error?: unknown }>(
    `${host}/translate`,
    body,
    signal,
    'LibreTranslate',
    host
  )
  if (typeof data.error === 'string' && data.error.trim()) {
    throw new Error(`LibreTranslate: ${data.error}`)
  }
  if (typeof data.translatedText !== 'string') {
    throw new Error('LibreTranslate retornou uma resposta sem translatedText.')
  }
  return data.translatedText.trim()
}

async function translateWithLocalOpus({
  text,
  sourceLocale,
  targetLocale,
  signal
}: TranslationPayload): Promise<string> {
  const host = getProviderConfig().host
  const data = await postJson<{ translatedText?: unknown; error?: unknown }>(
    `${host}/translate`,
    {
      text,
      source: toOpusLanguage(sourceLocale),
      target: toOpusLanguage(targetLocale)
    },
    signal,
    'Local OPUS',
    host
  )
  if (typeof data.error === 'string' && data.error.trim()) {
    throw new Error(`Local OPUS: ${data.error}`)
  }
  if (typeof data.translatedText !== 'string') {
    throw new Error('Local OPUS retornou uma resposta sem translatedText.')
  }
  return data.translatedText.trim()
}

async function postJson<T>(
  url: string,
  body: Record<string, string>,
  signal: AbortSignal | undefined,
  label: string,
  host: string
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LIVE_TRANSLATION_TIMEOUT_MS)
  const abortForwarder = (): void => controller.abort(signal?.reason)
  if (signal) signal.addEventListener('abort', abortForwarder, { once: true })

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(formatProviderHttpError(label, host, res.status, text || res.statusText))
    }
    return (await res.json()) as T
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${label} demorou demais para traduzir.`)
    }
    if (isNetworkFailure(err)) {
      throw new Error(formatProviderNetworkError(label, host))
    }
    throw err
  } finally {
    clearTimeout(timeout)
    if (signal) signal.removeEventListener('abort', abortForwarder)
  }
}

async function fetchJson<T>(
  url: string,
  label: string,
  host: string,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(formatProviderHttpError(label, host, res.status, text || res.statusText))
    }
    return (await res.json()) as T
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${label} não respondeu em ${host}.`)
    }
    if (isNetworkFailure(err)) {
      throw new Error(formatProviderNetworkError(label, host))
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

function formatProviderHttpError(label: string, host: string, status: number, details: string): string {
  if (label === 'LibreTranslate' && status === 403) {
    return `LibreTranslate recusou acesso (403) em ${host}. Essa instância exige API key ou bloqueia uso público; configure uma API key ou rode LibreTranslate localmente.`
  }
  if (status === 429) {
    return `${label} limitou requisições em ${host}. Reduza a frequência ou use uma instância local.`
  }
  return `${label} falhou (${status}) em ${host}: ${details}`
}

function formatProviderNetworkError(label: string, host: string): string {
  if (label === 'Local OPUS') {
    return `Local OPUS indisponível em ${host}. Inicie o bridge com scripts/local-opus-server.py e configure modelos para o par de idiomas.`
  }
  return `${label} indisponível em ${host}. Inicie o servidor local ou ajuste o host/API key nas configurações.`
}

function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(err.message))
}

function normalizeHost(host: string): string {
  return host.replace(/\/+$/, '')
}

function toLibreTranslateLanguageCandidates(locale: string): string[] {
  switch (locale) {
    case 'pt-BR':
      return ['pt-BR', 'pb', 'pt']
    case 'en-US':
      return ['en']
    case 'es-ES':
      return ['es']
    default:
      return [locale.split('-')[0] || locale]
  }
}

async function resolveLibreTranslatePairs(
  host: string,
  sourceCandidates: string[],
  targetCandidates: string[]
): Promise<Array<{ source: string; target: string }>> {
  const languagePairs = sourceCandidates.flatMap((source) =>
    targetCandidates.map((target) => ({ source, target }))
  )

  try {
    const languages = await getLibreTranslateLanguages(host)
    const supported = languagePairs.filter(({ source, target }) => {
      const language = languages.find((item) => item.code === source)
      return Array.isArray(language?.targets) && language.targets.includes(target)
    })
    if (supported.length > 0) return supported

    const available = languages
      .map((language) => `${language.code}->${(language.targets ?? []).join(',')}`)
      .join(' | ')
    throw new Error(
      `LibreTranslate em ${host} não tem o par ${sourceCandidates.join('/')} → ${targetCandidates.join('/')}. ` +
      `Disponível: ${available || 'nenhum idioma anunciado'}.`
    )
  } catch (err) {
    if (err instanceof Error && err.message.includes('não tem o par')) throw err
    return languagePairs
  }
}

async function getLibreTranslateLanguages(host: string): Promise<LibreTranslateLanguage[]> {
  const now = Date.now()
  if (
    libreTranslateLanguagesCache &&
    libreTranslateLanguagesCache.host === host &&
    libreTranslateLanguagesCache.expiresAt > now
  ) {
    return libreTranslateLanguagesCache.languages
  }

  const languages = await fetchJson<LibreTranslateLanguage[]>(
    `${host}/languages`,
    'LibreTranslate',
    host,
    LIVE_TRANSLATION_STATUS_TIMEOUT_MS
  )
  libreTranslateLanguagesCache = {
    host,
    expiresAt: now + LIBRETRANSLATE_LANGUAGES_CACHE_MS,
    languages
  }
  return languages
}

function isUnsupportedLanguageError(err: unknown): boolean {
  return err instanceof Error && /not supported|unsupported/i.test(err.message)
}

function toOpusLanguage(locale: string): string {
  switch (locale) {
    case 'pt-BR':
      return 'pt'
    case 'en-US':
      return 'en'
    case 'es-ES':
      return 'es'
    default:
      return locale.split('-')[0] || locale
  }
}
