import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type SelectHTMLAttributes
} from 'react'
import type {
  AppSettings,
  AudioCaptureMode,
  LiveTranslationProvider,
  LiveTranslationStatus,
  LiveTranscriptSession
} from '../../../shared/types'
import { useAudioRecorder } from '../hooks/useAudioRecorder'

const LANGUAGE_OPTIONS = [
  { locale: 'pt-BR', label: 'Português' },
  { locale: 'en-US', label: 'Inglês' },
  { locale: 'es-ES', label: 'Espanhol' }
] as const

const MAX_MESSAGE_CHARS = 140
const MAX_VISIBLE_MESSAGES = 80
const LIVE_SEGMENT_STABLE_MS = 1_600
const MIN_LIVE_TRANSLATION_CHARS = 18
const MAX_TRANSLATIONS_IN_FLIGHT = 4
const RETRY_BACKOFF_MS = [1_500, 4_000, 9_000] as const

type TargetLocale = 'none' | (typeof LANGUAGE_OPTIONS)[number]['locale']

const liveSelectClass =
  'appearance-none w-full rounded-md border border-white/10 bg-slate-900 pl-3 pr-10 py-2 text-sm text-slate-100 outline-none focus:border-sky-400 disabled:opacity-60'

function LiveSelectField({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): ReactElement {
  return (
    <div className="relative mt-1">
      <select {...props} className={className ?? liveSelectClass}>
        {children}
      </select>
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
  )
}

interface LiveMessage {
  id: string
  original: string
  at: number
  updatedAt: number
  translated?: string
  translating?: boolean
  error?: string
  attempts?: number
  nextRetryAt?: number
}

export function LiveTranscript(): ReactElement {
  const [session, setSession] = useState<LiveTranscriptSession | null>(null)
  const [sourceLocale, setSourceLocale] = useState('en-US')
  const [targetLocale, setTargetLocale] = useState<TargetLocale>('pt-BR')
  const [captureMode, setCaptureMode] = useState<AudioCaptureMode>('auto')
  const [messages, setMessages] = useState<LiveMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [translationError, setTranslationError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [pending, setPending] = useState<'start' | 'stop' | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [appSettings, setAppSettings] = useState<AppSettings>({})
  const [translationStatus, setTranslationStatus] = useState<LiveTranslationStatus | null>(null)
  const [checkingTranslation, setCheckingTranslation] = useState(false)
  const [, setScrollTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<LiveTranscriptSession | null>(null)
  const meetingIdRef = useRef<string | null>(null)
  const submitQueueRef = useRef<Promise<void>>(Promise.resolve())
  const translateTimerRef = useRef<number | null>(null)
  const nextMessageIdRef = useRef(0)
  const translationScopeRef = useRef('')
  const latestTranscriptRef = useRef('')
  const resetBaselineRef = useRef('')
  const resetSegmentCountRef = useRef(0)
  const translationGenerationRef = useRef(0)
  const autoScrollRef = useRef(true)
  const { start, stop, sampleRate, isRecording, stream } = useAudioRecorder()

  useEffect(() => {
    const offSession = window.distill.onLiveTranscriptSession((next) => {
      sessionRef.current = next
      setSession(next)
      if (next.sourceLocale) setSourceLocale(next.sourceLocale)
      if (next.targetLocale) setTargetLocale(next.targetLocale as TargetLocale)
      latestTranscriptRef.current = next.transcript.trim()
      setMessages((prev) =>
        reconcileTranscriptMessages(
          prev,
          transcriptAfterReset(
            latestTranscriptRef.current,
            resetBaselineRef.current,
            resetSegmentCountRef.current
          ),
          Date.now(),
          createMessageId
        )
      )
      setError(null)
      setTranslationError(null)
      setUpdatedAt(Date.now())
    })
    const offLive = window.distill.onLiveTranscription((event) => {
      const current = sessionRef.current
      if (current && current.meetingId && current.meetingId !== event.meetingId) return
      if (event.error) setError(event.error)
      if (event.text.trim()) {
        const transcript = event.text.trim()
        latestTranscriptRef.current = transcript
        setMessages((prev) =>
          reconcileTranscriptMessages(
            prev,
            transcriptAfterReset(transcript, resetBaselineRef.current, resetSegmentCountRef.current),
            event.at,
            createMessageId
          )
        )
        setUpdatedAt(event.at)
      }
    })
    return () => {
      offSession()
      offLive()
    }
  }, [])

  useEffect(() => {
    void window.distill.getSettings().then(setAppSettings).catch(() => undefined)
    void refreshLiveTranslationStatus()
  }, [])

  useEffect(() => {
    if (!autoScrollRef.current) return
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth'
    })
  }, [messages])

  useEffect(() => {
    const cleanup = (): void => {
      const meetingId = meetingIdRef.current
      if (meetingId) void window.distill.abortMeetingChunks(meetingId)
    }
    window.addEventListener('beforeunload', cleanup)
    return () => {
      window.removeEventListener('beforeunload', cleanup)
    }
  }, [])

  useEffect(() => {
    if (translateTimerRef.current) window.clearTimeout(translateTimerRef.current)
    const scope = `${sourceLocale}->${targetLocale}`
    if (translationScopeRef.current !== scope) {
      translationScopeRef.current = scope
      setMessages((prev) => stripTranslations(prev))
    }

    if (targetLocale === 'none' || targetLocale === sourceLocale) {
      setTranslationError(null)
      setMessages((prev) => stripTranslations(prev))
      return
    }

    translateTimerRef.current = window.setTimeout(() => {
      const generation = translationGenerationRef.current
      const availableSlots = Math.max(
        0,
        MAX_TRANSLATIONS_IN_FLIGHT - messages.filter((message) => message.translating).length
      )
      if (availableSlots === 0) return

      const now = Date.now()
      const nextMessages = messages
        .filter((message, index) => shouldTranslateMessage(message, index, messages.length, now))
        .slice(0, availableSlots)
      if (nextMessages.length === 0) return

      const pendingIds = new Set(nextMessages.map((message) => message.id))

      setMessages((prev) => prev.map((message) =>
        pendingIds.has(message.id) ? { ...message, translating: true, error: undefined } : message
      ))

      for (const next of nextMessages) {
        void window.distill
          .translateLiveText(next.original, sourceLocale, targetLocale)
          .then((result) => {
            if (translationGenerationRef.current !== generation) return
            if (translationScopeRef.current !== scope) return
            setMessages((prev) => prev.map((message) => {
              if (message.id !== next.id || message.original !== next.original) return message
              if (result.error) {
                return markTranslationFailure(message, result.error)
              }
              return {
                ...message,
                translating: false,
                translated: result.translatedText,
                error: undefined,
                attempts: 0,
                nextRetryAt: undefined
              }
            }))
            setTranslationError(result.error ?? null)
          })
          .catch((err) => {
            if (translationGenerationRef.current !== generation) return
            if (translationScopeRef.current !== scope) return
            const message = err instanceof Error ? err.message : String(err)
            setTranslationError(message)
            setMessages((prev) => prev.map((item) =>
              item.id === next.id && item.original === next.original
                ? markTranslationFailure(item, message)
                : item
            ))
          })
      }
    }, 900)

    return () => {
      if (translateTimerRef.current) window.clearTimeout(translateTimerRef.current)
    }
  }, [sourceLocale, targetLocale, messages])

  const handleStart = async (): Promise<void> => {
    if (pending || isRecording) return
    setPending('start')
    setError(null)
    setTranslationError(null)
    setMessages([])
    nextMessageIdRef.current = 0
    latestTranscriptRef.current = ''
    resetBaselineRef.current = ''
    resetSegmentCountRef.current = 0
    translationGenerationRef.current += 1
    const meetingId = `live-${crypto.randomUUID()}`
    const nextSession: LiveTranscriptSession = {
      meetingId,
      title: 'Transcrição ao vivo',
      transcript: '',
      startedAt: Date.now(),
      sourceLocale,
      targetLocale
    }
    meetingIdRef.current = meetingId
    sessionRef.current = nextSession
    setSession(nextSession)

    try {
      await window.distill.startMeetingChunks(meetingId, {
        engine: 'apple-speech',
        appleSpeechLocale: sourceLocale,
        appleSpeechRequiresOnDevice: false
      })
      await start(
        () => undefined,
        captureMode,
        (chunk) => {
          submitQueueRef.current = submitQueueRef.current
            .then(() => window.distill.submitLiveAudioFrame(meetingId, chunk, sampleRate))
            .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        }
      )
    } catch (err) {
      meetingIdRef.current = null
      await window.distill.abortMeetingChunks(meetingId).catch(() => undefined)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const handleStop = async (): Promise<void> => {
    const meetingId = meetingIdRef.current
    if (pending || !meetingId) return
    setPending('stop')
    try {
      await stop()
      await submitQueueRef.current
      await window.distill.abortMeetingChunks(meetingId)
      meetingIdRef.current = null
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const canEditLanguages = !isRecording && pending === null
  const translating = targetLocale !== 'none' && targetLocale !== sourceLocale
  const activeTranslationCount = messages.filter((message) => message.translating).length

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    autoScrollRef.current = distanceFromBottom < 80
    setScrollTick((tick) => tick + 1)
  }

  const handleJumpToLatest = (): void => {
    autoScrollRef.current = true
    setScrollTick((tick) => tick + 1)
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth'
    })
  }

  const handleResetCaptions = (): void => {
    setMessages([])
    setError(null)
    setTranslationError(null)
    setUpdatedAt(Date.now())
    nextMessageIdRef.current = 0
    resetBaselineRef.current = latestTranscriptRef.current
    resetSegmentCountRef.current = buildTranscriptMessages(latestTranscriptRef.current).length
    translationGenerationRef.current += 1
    autoScrollRef.current = true
    if (translateTimerRef.current) window.clearTimeout(translateTimerRef.current)
  }

  const updateLiveTranslationSetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ): void => {
    setAppSettings((prev) => {
      const next = { ...prev, [key]: value }
      void window.distill.saveSettings(next).then(setAppSettings).catch((err) => {
        setTranslationError(err instanceof Error ? err.message : String(err))
      })
      window.setTimeout(() => void refreshLiveTranslationStatus(), 200)
      return next
    })
  }

  const refreshLiveTranslationStatus = async (): Promise<void> => {
    setCheckingTranslation(true)
    try {
      const status = await window.distill.getLiveTranslationStatus()
      setTranslationStatus(status)
      if (status.reachable) setTranslationError(null)
      else setTranslationError(status.error ?? 'Tradutor indisponível.')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setTranslationError(message)
      setTranslationStatus(null)
    } finally {
      setCheckingTranslation(false)
    }
  }

  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-100 flex flex-col">
      <header
        className="shrink-0 border-b border-white/10 bg-slate-950/95 px-5 pb-4 pt-12"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 pl-2">
            <div className="text-[11px] uppercase tracking-wider text-sky-300">Distill Live</div>
            <h1 className="mt-1 truncate text-lg font-semibold text-white">
              {session?.title || 'Transcrição ao vivo'}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span>{formatLanguageLabel(sourceLocale)}</span>
              <span className="text-slate-600">→</span>
              <span>{targetLocale === 'none' ? 'sem tradução' : formatLanguageLabel(targetLocale)}</span>
              <span className="text-slate-600">·</span>
              <span>{formatCaptureMode(captureMode)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <button
              type="button"
              onClick={handleResetCaptions}
              disabled={messages.length === 0}
              className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/10 bg-slate-900 text-slate-300 shadow-sm transition hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Resetar legendas"
              title="Resetar legendas"
            >
              <ResetGlyph />
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/10 bg-slate-900 text-slate-300 shadow-sm transition hover:bg-slate-800 hover:text-white"
              aria-label="Configurações da transcrição"
              title="Configurações"
            >
              <SettingsGlyph />
            </button>
            <button
              type="button"
              onClick={() => isRecording ? void handleStop() : void handleStart()}
              disabled={pending !== null}
              className={`rounded-md px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:cursor-wait disabled:opacity-70 ${
                isRecording ? 'bg-red-500 hover:bg-red-400' : 'bg-emerald-500 hover:bg-emerald-400'
              }`}
            >
              {pending === 'start' ? 'Iniciando...' : pending === 'stop' ? 'Parando...' : isRecording ? 'Parar' : 'Iniciar'}
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-400">
          <span>{formatStatus(isRecording, stream, messages.length, translating, activeTranslationCount)}</span>
          <span>{updatedAt ? `Atualizado ${formatTime(updatedAt)}` : 'Pronto'}</span>
        </div>
      </header>

      <main
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative min-h-0 flex-1 overflow-y-auto px-5 py-5"
      >
        {error && (
          <div className="mb-4 rounded-md border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        )}
        {translationError && (
          <div className="mb-4 rounded-md border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            Tradução indisponível: {translationError}
          </div>
        )}

        {messages.length > 0 ? (
          <div className="space-y-2">
            {messages.map((message, index) => (
              <CaptionMessage key={message.id} message={message} index={index} />
            ))}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-sky-400/10 text-sky-200 ring-1 ring-sky-300/20">
                <TranscriptGlyph />
              </div>
              <div className="text-sm font-medium text-slate-200">
                {isRecording ? 'Escutando' : 'Configure os idiomas e inicie'}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                As legendas aparecem aqui em tempo real.
              </div>
            </div>
          </div>
        )}
      </main>
      {!autoScrollRef.current && (
        <button
          type="button"
          onClick={handleJumpToLatest}
          className="absolute bottom-5 right-6 rounded-full border border-sky-300/25 bg-sky-400/15 px-3 py-1.5 text-xs font-medium text-sky-100 shadow-lg backdrop-blur transition hover:bg-sky-400/25"
        >
          Ir para o atual
        </button>
      )}
      {settingsOpen && (
        <div className="absolute inset-0 z-20 flex justify-end bg-slate-950/45 backdrop-blur-[1px]">
          <button
            type="button"
            aria-label="Fechar configurações"
            className="flex-1 cursor-default"
            onClick={() => setSettingsOpen(false)}
          />
          <aside className="h-full w-[340px] border-l border-white/10 bg-slate-950 px-5 pb-5 pt-12 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-sky-300">Preferências</div>
                <h2 className="mt-1 text-lg font-semibold text-white">Transcrição ao vivo</h2>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/10 hover:text-white"
                aria-label="Fechar"
              >
                <CloseGlyph />
              </button>
            </div>

            <div className="mt-6 space-y-5">
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Tradutor</span>
                <LiveSelectField
                  value={appSettings.liveTranslationProvider ?? 'libretranslate'}
                  onChange={(e) => updateLiveTranslationSetting(
                    'liveTranslationProvider',
                    e.target.value as LiveTranslationProvider
                  )}
                >
                  <option value="libretranslate">LibreTranslate</option>
                  <option value="local-opus">Local OPUS</option>
                </LiveSelectField>
              </label>
              {(appSettings.liveTranslationProvider ?? 'libretranslate') === 'libretranslate' ? (
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">Host LibreTranslate</span>
                  <input
                    type="text"
                    value={appSettings.libreTranslateHost ?? 'http://127.0.0.1:5000'}
                    onChange={(e) => updateLiveTranslationSetting('libreTranslateHost', e.target.value)}
                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-400"
                    spellCheck={false}
                  />
                </label>
              ) : (
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">Host Local OPUS</span>
                  <input
                    type="text"
                    value={appSettings.localOpusHost ?? 'http://127.0.0.1:5056'}
                    onChange={(e) => updateLiveTranslationSetting('localOpusHost', e.target.value)}
                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-400"
                    spellCheck={false}
                  />
                </label>
              )}
              <div className={`rounded-md border px-3 py-2 text-xs leading-5 ${
                translationStatus?.reachable
                  ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
                  : 'border-amber-400/20 bg-amber-400/10 text-amber-100'
              }`}>
                <div className="flex items-center justify-between gap-3">
                  <span>
                    {translationStatus?.reachable
                      ? `Tradutor conectado em ${translationStatus.host}`
                      : translationStatus?.error ?? 'Verifique o tradutor antes de iniciar.'}
                  </span>
                  <button
                    type="button"
                    onClick={() => void refreshLiveTranslationStatus()}
                    disabled={checkingTranslation}
                    className="shrink-0 rounded border border-white/10 px-2 py-1 font-medium text-white/90 transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
                  >
                    {checkingTranslation ? 'Testando...' : 'Testar'}
                  </button>
                </div>
              </div>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Origem</span>
                <LiveSelectField
                  value={sourceLocale}
                  disabled={!canEditLanguages}
                  onChange={(e) => setSourceLocale(e.target.value)}
                >
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.locale} value={option.locale}>{option.label}</option>
                  ))}
                </LiveSelectField>
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Traduzir para</span>
                <LiveSelectField
                  value={targetLocale}
                  disabled={!canEditLanguages}
                  onChange={(e) => setTargetLocale(e.target.value as TargetLocale)}
                >
                  <option value="none">Sem tradução</option>
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.locale} value={option.locale}>{option.label}</option>
                  ))}
                </LiveSelectField>
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">Áudio</span>
                <LiveSelectField
                  value={captureMode}
                  disabled={!canEditLanguages}
                  onChange={(e) => setCaptureMode(e.target.value as AudioCaptureMode)}
                >
                  <option value="auto">Automático</option>
                  <option value="system">Sistema</option>
                  <option value="microphone">Microfone</option>
                  <option value="mixed">Sistema + microfone</option>
                </LiveSelectField>
              </label>
              {!canEditLanguages && (
                <div className="rounded-md border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs leading-5 text-amber-100">
                  Pare a sessão atual para alterar idiomas ou fonte de áudio.
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )

  function createMessageId(): string {
    nextMessageIdRef.current += 1
    return `live-message-${nextMessageIdRef.current}`
  }
}

function CaptionMessage({ message, index }: { message: LiveMessage; index: number }): ReactElement {
  const primary = message.translated || message.original
  const secondary = message.translated ? message.original : null

  return (
    <article className="border-l-2 border-sky-300/40 bg-slate-900/55 px-3 py-2.5 ring-1 ring-white/5">
      <div className="mb-1 flex items-center justify-between gap-3 text-[10px] uppercase tracking-wider text-slate-500">
        <span>{formatMessageTime(message.at, index)}</span>
        {message.translating && <span className="text-sky-300">Traduzindo</span>}
      </div>
      <p className="text-[15px] leading-6 text-slate-100">{primary}</p>
      {secondary && <p className="mt-1 text-xs leading-5 text-slate-400">{secondary}</p>}
      {message.error && !message.translating && (
        <p className="mt-1 text-xs leading-5 text-amber-200">Tentando traduzir novamente...</p>
      )}
    </article>
  )
}

function transcriptAfterReset(transcript: string, baseline: string, baselineSegmentCount: number): string {
  if (!baseline) return transcript
  if (transcript.startsWith(baseline)) return transcript.slice(baseline.length).trim()
  return buildTranscriptMessages(transcript).slice(baselineSegmentCount).join(' ')
}

function reconcileTranscriptMessages(
  previous: LiveMessage[],
  transcript: string,
  at: number,
  createId: () => string
): LiveMessage[] {
  const segments = buildTranscriptMessages(transcript)
  const previousPool = [...previous]

  return segments.map((original, index) => {
    const sameIndex = previous[index]
    if (sameIndex?.original === original) {
      removeMessage(previousPool, sameIndex)
      return sameIndex
    }

    const sameTextIndex = previousPool.findIndex((message) => message.original === original)
    if (sameTextIndex !== -1) {
      const [matched] = previousPool.splice(sameTextIndex, 1)
      return matched
    }

    const draft = sameIndex && isLikelyDraftRevision(sameIndex.original, original) ? sameIndex : null
    return {
      id: draft?.id ?? createId(),
      original,
      at: draft?.at ?? at,
      updatedAt: at
    }
  }).slice(-MAX_VISIBLE_MESSAGES)
}

function removeMessage(messages: LiveMessage[], message: LiveMessage): void {
  const index = messages.indexOf(message)
  if (index !== -1) messages.splice(index, 1)
}

function stripTranslations(messages: LiveMessage[]): LiveMessage[] {
  if (!messages.some((message) => message.translated || message.translating || message.error)) {
    return messages
  }
  return messages.map((message) => ({
    id: message.id,
    original: message.original,
    at: message.at,
    updatedAt: message.updatedAt
  }))
}

function shouldTranslateMessage(message: LiveMessage, index: number, total: number, now: number): boolean {
  if (message.original.trim().length < MIN_LIVE_TRANSLATION_CHARS) return false
  if (message.translated || message.translating) return false
  if (message.nextRetryAt && message.nextRetryAt > now) return false
  const isLast = index === total - 1
  const isStable = now - message.updatedAt >= LIVE_SEGMENT_STABLE_MS
  return !isLast || isStable || hasSentenceEnding(message.original) || message.original.length >= MAX_MESSAGE_CHARS
}

function markTranslationFailure(message: LiveMessage, error: string): LiveMessage {
  const attempts = (message.attempts ?? 0) + 1
  const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]
  return {
    ...message,
    translating: false,
    error,
    attempts,
    nextRetryAt: Date.now() + backoff
  }
}

function buildTranscriptMessages(transcript: string): string[] {
  const normalized = transcript.replace(/\s+/g, ' ').trim()
  if (!normalized) return []

  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [normalized]
  const messages: string[] = []
  let current = ''

  for (const sentence of sentences) {
    for (const part of splitLongSegment(sentence.trim(), MAX_MESSAGE_CHARS)) {
      if (!part) continue
      const candidate = current ? `${current} ${part}` : part
      if (candidate.length > MAX_MESSAGE_CHARS && current) {
        messages.push(current)
        current = part
      } else {
        current = candidate
      }
    }
  }

  if (current) messages.push(current)
  return messages
}

function splitLongSegment(segment: string, maxChars: number): string[] {
  if (segment.length <= maxChars) return [segment]

  const words = segment.split(/\s+/).filter(Boolean)
  const chunks: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length > maxChars && current) {
      chunks.push(trimTrailingSoftBreak(current))
      current = word
    } else {
      current = candidate
    }
  }

  if (current) chunks.push(trimTrailingSoftBreak(current))
  return chunks
}

function trimTrailingSoftBreak(value: string): string {
  return value.replace(/[,;:]$/, '').trim()
}

function isLikelyDraftRevision(previous: string, next: string): boolean {
  const a = normalizeDraft(previous)
  const b = normalizeDraft(next)
  return a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a))
}

function normalizeDraft(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function hasSentenceEnding(value: string): boolean {
  return /[.!?…]$/.test(value.trim())
}

function formatStatus(
  isRecording: boolean,
  stream: MediaStream | null,
  messageCount: number,
  translating: boolean,
  activeTranslationCount: number
): string {
  if (!isRecording) return 'Parado'
  const audioTracks = stream?.getAudioTracks().length ?? 0
  const suffix = translating
    ? activeTranslationCount > 0
      ? ` · traduzindo ${activeTranslationCount}`
      : ' · traduzindo'
    : ''
  return messageCount > 0
    ? `${messageCount} trechos${suffix}`
    : audioTracks > 0
      ? `Ouvindo${suffix}`
      : `Aguardando áudio${suffix}`
}

function formatLanguageLabel(locale: string): string {
  return LANGUAGE_OPTIONS.find((option) => option.locale === locale)?.label ?? locale
}

function formatCaptureMode(mode: AudioCaptureMode): string {
  switch (mode) {
    case 'system':
      return 'Sistema'
    case 'microphone':
      return 'Microfone'
    case 'mixed':
      return 'Sistema + microfone'
    default:
      return 'Automático'
  }
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function formatMessageTime(at: number | undefined, index: number): string {
  if (!at) return `Trecho ${index + 1}`
  return formatTime(at)
}

function TranscriptGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
      <path d="M8 9h8" />
      <path d="M8 13h5" />
    </svg>
  )
}

function SettingsGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function ResetGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v6h6" />
    </svg>
  )
}

function CloseGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
