import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement
} from 'react'
import {
  OLLAMA_NOT_READY_MARKER,
  WHISPER_NOT_READY_MARKER,
  type AudioChunkPayload,
  type AudioCaptureMode,
  type AudioCaptureSource,
  type Meeting
} from '../../../shared/types'
import { useAudioRecorder } from '../hooks/useAudioRecorder'

type PillRegionStyle = CSSProperties & {
  WebkitAppRegion: 'drag' | 'no-drag'
}

interface PillDragState {
  pointerStartX: number
  pointerStartY: number
  pillStartX: number
  pillStartY: number
}

interface PillInfoDetailsProps {
  title: string
  secondary: string
  tertiary: string
  isError?: boolean
}

export function Pill(): ReactElement {
  const [title, setTitle] = useState<string>('Reunião detectada')
  const [elapsed, setElapsed] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [pending, setPending] = useState<'start' | 'pause' | 'resume' | 'stop' | null>(null)
  const [showSpinner, setShowSpinner] = useState(false)
  const [isCompact, setIsCompact] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [captureMode, setCaptureMode] = useState<AudioCaptureMode>('auto')
  const [activeCaptureSource, setActiveCaptureSource] = useState<AudioCaptureSource | null>(null)
  const [activeCaptureWarnings, setActiveCaptureWarnings] = useState<string[]>([])
  const [captureHint, setCaptureHint] = useState<string>('Audio do sistema com fallback para microfone')
  const [continuationMeeting, setContinuationMeeting] = useState<Meeting | null>(null)
  const [partCount, setPartCount] = useState(0)
  const tickRef = useRef<number | null>(null)
  const meetingIdRef = useRef<string | null>(null)
  const dragRef = useRef<PillDragState | null>(null)
  const recordedMsRef = useRef(0)
  const chunkOffsetMsRef = useRef(0)
  const recordingStartedAtRef = useRef<number | null>(null)
  const { start, pause, resume, stop, sampleRate, isRecording, isPaused, stream } = useAudioRecorder()

  useEffect(() => {
    if (!pending) {
      setShowSpinner(false)
      return
    }
    const id = window.setTimeout(() => setShowSpinner(true), 150)
    return () => window.clearTimeout(id)
  }, [pending])

  useEffect(() => {
    const off = window.distill.onMeetingDetected((p) => {
      if (meetingIdRef.current) return
      if (p?.title) setTitle(p.title)
      setInfoOpen(false)
      if (p?.continueMeeting) {
        setContinuationMeeting(p.continueMeeting)
        setCaptureHint('Continuar gravando nesta reunião')
      } else {
        setContinuationMeeting(null)
        setCaptureHint('Audio do sistema com fallback para microfone')
      }
      setErrorMsg(null)
    })
    return off
  }, [])

  useEffect(() => {
    void window.distill
      .getSettings()
      .then((settings) => setIsCompact(settings.pillCompact === true))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (isRecording) {
      if (recordingStartedAtRef.current === null) {
        recordingStartedAtRef.current = Date.now()
      }
      tickRef.current = window.setInterval(() => {
        const startedAt = recordingStartedAtRef.current ?? Date.now()
        setElapsed(Math.floor((recordedMsRef.current + Date.now() - startedAt) / 1000))
      }, 1000)
    } else if (tickRef.current) {
      clearInterval(tickRef.current)
      tickRef.current = null
      setElapsed(Math.floor(recordedMsRef.current / 1000))
    }
    return () => {
      if (tickRef.current) clearInterval(tickRef.current)
    }
  }, [isRecording])

  const resetRecordingSession = (): void => {
    meetingIdRef.current = null
    recordedMsRef.current = 0
    chunkOffsetMsRef.current = 0
    recordingStartedAtRef.current = null
    setElapsed(0)
    setPartCount(0)
    setInfoOpen(false)
    setActiveCaptureSource(null)
    setActiveCaptureWarnings([])
    setContinuationMeeting(null)
  }

  const addActiveRecordingTime = (): void => {
    if (recordingStartedAtRef.current === null) return
    recordedMsRef.current += Date.now() - recordingStartedAtRef.current
    recordingStartedAtRef.current = null
    setElapsed(Math.floor(recordedMsRef.current / 1000))
  }

  const handleStart = async (): Promise<void> => {
    if (pending) return
    setErrorMsg(null)
    setPending('start')
    try {
      const settings = await window.distill.getSettings()
      const selectedMode = settings.captureMode ?? 'auto'
      setCaptureMode(selectedMode)
      const continuing = continuationMeeting
      const meetingId = continuing?.id ?? crypto.randomUUID()
      const offsetMs = getContinuationOffset(continuing)
      meetingIdRef.current = meetingId
      chunkOffsetMsRef.current = offsetMs
      recordedMsRef.current = offsetMs
      recordingStartedAtRef.current = Date.now()
      setElapsed(Math.floor(offsetMs / 1000))
      setPartCount(offsetMs > 0 ? 2 : 1)
      if (continuing?.title) setTitle(continuing.title)
      await window.distill.startMeetingChunks(meetingId, { engine: 'whisper' })
      const started = await start((chunk) => {
        void window.distill.submitAudioChunk(meetingId, offsetAudioChunk(chunk, chunkOffsetMsRef.current), sampleRate)
      }, selectedMode)
      setActiveCaptureSource(started.source)
      setActiveCaptureWarnings(started.warnings)
      setCaptureHint(formatCaptureHint(selectedMode, started.source, started.warnings))
    } catch (err) {
      console.error('Failed to start recording:', err)
      const msg = err instanceof Error ? err.message : String(err)
      if (meetingIdRef.current) {
        void window.distill.abortMeetingChunks(meetingIdRef.current)
      }
      resetRecordingSession()
      setErrorMsg(mapStartError(msg))
    } finally {
      setPending(null)
    }
  }

  const handleCancel = async (): Promise<void> => {
    if (isRecording || isPaused) {
      try { await stop() } catch { /* ignore discarded audio */ }
    }
    if (meetingIdRef.current) {
      void window.distill.abortMeetingChunks(meetingIdRef.current)
    }
    resetRecordingSession()
    window.distill.closePill()
  }

  const handlePause = async (): Promise<void> => {
    const meetingId = meetingIdRef.current
    if (pending || !isRecording || !meetingId) return
    setPending('pause')
    try {
      const remaining = await pause()
      addActiveRecordingTime()
      if (remaining && remaining.pcm.byteLength > 0) {
        await window.distill.submitAudioChunk(
          meetingId,
          offsetAudioChunk(remaining, chunkOffsetMsRef.current),
          sampleRate
        )
      }
    } catch (err) {
      console.error('Pause pipeline failed:', err)
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(mapStartError(msg))
    } finally {
      setPending(null)
    }
  }

  const handleResume = async (): Promise<void> => {
    if (pending || !isPaused || !meetingIdRef.current) return
    setErrorMsg(null)
    setPending('resume')
    try {
      await resume()
      recordingStartedAtRef.current = Date.now()
      setPartCount((count) => Math.max(1, count + 1))
    } catch (err) {
      console.error('Resume pipeline failed:', err)
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(mapStartError(msg))
    } finally {
      setPending(null)
    }
  }

  const handleStop = async (): Promise<void> => {
    if (pending) return
    if (!isRecording && !isPaused) {
      window.distill.closePill()
      return
    }
    setPending('stop')
    const meetingId = meetingIdRef.current ?? crypto.randomUUID()
    const continuing = continuationMeeting
    const placeholder: Meeting = {
      id: meetingId,
      user_id: continuing?.user_id ?? null,
      title,
      raw_transcript: continuing?.raw_transcript ?? '',
      summary: continuing?.summary ?? '',
      action_items: continuing?.action_items ?? [],
      transcript_segments: continuing?.transcript_segments,
      created_at: continuing?.created_at ?? new Date().toISOString(),
      status: 'processing',
      capture_mode: captureMode,
      capture_source: activeCaptureSource ?? undefined
    }
    try {
      if (isRecording) addActiveRecordingTime()
      const remaining = await stop()
      window.distill.finalizeMeeting(
        placeholder,
        remaining ? offsetAudioChunk(remaining, chunkOffsetMsRef.current) : null,
        sampleRate
      )
    } catch (err) {
      console.error('Stop pipeline failed:', err)
      if (meetingIdRef.current) {
        void window.distill.abortMeetingChunks(meetingIdRef.current)
      }
      try {
        await window.distill.saveMeeting({ ...placeholder, status: 'failed' })
      } catch { /* ignore */ }
    } finally {
      resetRecordingSession()
      window.distill.closePill()
    }
  }

  const mapStartError = (msg: string): string => {
    if (msg.includes(WHISPER_NOT_READY_MARKER)) return 'Whisper não configurado'
    if (msg.includes(OLLAMA_NOT_READY_MARKER)) return 'Ollama indisponível'
    if (/permission|denied|notallowed/i.test(msg)) return 'Permissão negada'
    const clean = msg.replace(/^Error(?: invoking remote method [^:]+)?:\s*/i, '').trim()
    return clean.slice(0, 90) || 'Falha ao gravar'
  }

  const fmt = (s: number): string => {
    const m = Math.floor(s / 60).toString().padStart(2, '0')
    const r = (s % 60).toString().padStart(2, '0')
    return `${m}:${r}`
  }

  const handleToggleCompact = async (): Promise<void> => {
    const next = !isCompact
    setIsCompact(next)
    if (next) setInfoOpen(false)
    try {
      await window.distill.setPillCompact(next)
    } catch (err) {
      console.error('Failed to toggle pill compact mode:', err)
      setIsCompact(!next)
    }
  }

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      const nextX = drag.pillStartX + (event.screenX - drag.pointerStartX)
      const nextY = drag.pillStartY + (event.screenY - drag.pointerStartY)
      void window.distill.setPillPosition(nextX, nextY)
    }

    const handleMouseUp = (): void => {
      dragRef.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const handlePointerDown = async (
    event: ReactMouseEvent<HTMLDivElement>
  ): Promise<void> => {
    const target = event.target as HTMLElement
    if (target.closest('button')) return
    const position = await window.distill.getPillPosition()
    if (!position) return
    dragRef.current = {
      pointerStartX: event.screenX,
      pointerStartY: event.screenY,
      pillStartX: position.x,
      pillStartY: position.y
    }
  }

  const noDragStyle: PillRegionStyle = { WebkitAppRegion: 'no-drag' }
  const sessionActive = isRecording || isPaused
  const statusLabel = isPaused ? 'Pausada' : isRecording ? 'Capturando' : 'Fonte de audio'
  const activePartLabel = sessionActive ? `Parte ${Math.max(1, partCount)}` : null
  const infoSecondary = sessionActive
    ? [activePartLabel, formatSourceLabel(activeCaptureSource)].filter(Boolean).join(' · ')
    : errorMsg ?? captureHint
  const infoTertiary = sessionActive
    ? activeCaptureWarnings[0] ?? formatModeLabel(captureMode)
    : continuationMeeting
      ? 'Continuação de gravação'
      : formatModeLabel(captureMode)

  return (
    <div className="w-full h-full flex items-center justify-center p-1">
      <div
        className={`flex items-center ${
          isCompact ? 'justify-center gap-2 px-2' : 'gap-2 px-3'
        } h-full w-full rounded-full bg-slate-900/75 backdrop-blur-md border border-white/10 shadow-2xl text-white select-none cursor-grab active:cursor-grabbing`}
        style={noDragStyle}
        role="group"
        aria-label="Controles da gravação"
        title="Arraste para mover. Clique duas vezes para recentralizar."
        onDoubleClick={(event) => {
          const target = event.target as HTMLElement
          if (target.closest('button')) return
          void window.distill.resetPillPosition()
        }}
        onMouseDown={(event) => void handlePointerDown(event)}
      >
        {isCompact ? (
          sessionActive ? (
            <>
              <button
                onClick={() => void handleCancel()}
                title="Cancelar"
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/10 transition cursor-pointer"
                style={noDragStyle}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>

              <button
                onClick={() => void handleToggleCompact()}
                title="Expandir pill"
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 transition cursor-pointer"
                style={noDragStyle}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <path d="M16 3h3a2 2 0 0 1 2 2v3" />
                  <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
                  <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              </button>

              <button
                onClick={() => isPaused ? void handleResume() : void handlePause()}
                disabled={pending !== null}
                title={isPaused ? 'Retomar gravação' : 'Pausar gravação'}
                aria-label={isPaused ? 'Retomar gravação' : 'Pausar gravação'}
                className={`shrink-0 w-7 h-7 flex items-center justify-center rounded-full disabled:opacity-70 disabled:cursor-wait text-white transition cursor-pointer ${
                  isPaused ? 'bg-emerald-500 hover:bg-emerald-400' : 'bg-white/10 hover:bg-white/20'
                }`}
                style={noDragStyle}
              >
                {(pending === 'pause' || pending === 'resume') && showSpinner ? (
                  <Spinner />
                ) : isPaused ? (
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
                    <path d="M8 6.5v11l9-5.5-9-5.5z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
                    <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
                  </svg>
                )}
              </button>

              <button
                onClick={() => void handleStop()}
                disabled={pending !== null}
                title="Encerrar e processar"
                aria-label="Encerrar e processar"
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-red-500 hover:bg-red-400 disabled:opacity-70 disabled:cursor-wait text-white transition cursor-pointer"
                style={noDragStyle}
              >
                {pending === 'stop' && showSpinner ? (
                  <Spinner />
                ) : (
                  <span className="w-2.5 h-2.5 rounded-sm bg-white" />
                )}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => void handleCancel()}
                title="Fechar"
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 transition cursor-pointer"
                style={noDragStyle}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>

              <button
                onClick={() => void handleToggleCompact()}
                title="Expandir pill"
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 transition cursor-pointer"
                style={noDragStyle}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <path d="M16 3h3a2 2 0 0 1 2 2v3" />
                  <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
                  <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              </button>

              <button
                onClick={() => void handleStart()}
                disabled={pending !== null}
                title={errorMsg ?? 'Iniciar gravação'}
                aria-label="Iniciar gravação"
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-70 disabled:cursor-wait text-white transition cursor-pointer"
                style={noDragStyle}
              >
                {pending === 'start' && showSpinner ? (
                  <Spinner />
                ) : (
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
                    <path d="M8 6.5v11l9-5.5-9-5.5z" />
                  </svg>
                )}
              </button>
            </>
          )
        ) : sessionActive ? (
          <>
            <button
              onClick={() => void handleCancel()}
              title="Cancelar"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/10 transition cursor-pointer"
              style={noDragStyle}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>

            <button
              onClick={() => void handleToggleCompact()}
              title="Compactar pill"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-white/55 hover:text-white hover:bg-white/10 transition cursor-pointer"
              style={noDragStyle}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 3H5a2 2 0 0 0-2 2v5" />
                <path d="M14 3h5a2 2 0 0 1 2 2v5" />
                <path d="M10 21H5a2 2 0 0 1-2-2v-5" />
                <path d="M14 21h5a2 2 0 0 0 2-2v-5" />
                <path d="M9 9l6 6" />
                <path d="M15 9l-6 6" />
              </svg>
            </button>

            <button
              onClick={() => setInfoOpen((open) => !open)}
              title={infoOpen ? 'Ocultar detalhes' : 'Detalhes da gravação'}
              aria-label={infoOpen ? 'Ocultar detalhes da gravação' : 'Mostrar detalhes da gravação'}
              className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition cursor-pointer ${
                infoOpen ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white hover:bg-white/10'
              }`}
              style={noDragStyle}
            >
              <InfoGlyph />
            </button>

            <div className="flex-1 min-w-0 pr-1">
              {infoOpen ? (
                <PillInfoDetails
                  title={title}
                  secondary={infoSecondary}
                  tertiary={infoTertiary}
                />
              ) : (
                <div className="flex h-8 items-center gap-3 min-w-0 overflow-hidden">
                  <span className="sr-only">{title}</span>
                  {isPaused ? (
                    <span className="inline-flex h-7 shrink-0 items-center rounded-full bg-amber-400/15 px-2.5 text-[10px] font-medium text-amber-200">
                      Pausada
                    </span>
                  ) : (
                    <ListenBars stream={stream} />
                  )}
                  <span className="shrink-0 text-base font-mono font-semibold text-white/85 tabular-nums">
                    {fmt(elapsed)}
                  </span>
                </div>
              )}
            </div>

            <button
              onClick={() => isPaused ? void handleResume() : void handlePause()}
              disabled={pending !== null}
              title={isPaused ? 'Retomar gravação' : 'Pausar gravação'}
              className={`shrink-0 h-8 px-3 flex items-center gap-1.5 rounded-full disabled:opacity-70 disabled:cursor-wait text-white text-xs font-medium transition cursor-pointer ${
                isPaused ? 'bg-emerald-500 hover:bg-emerald-400' : 'bg-white/10 hover:bg-white/20'
              }`}
              style={noDragStyle}
            >
              {(pending === 'pause' || pending === 'resume') && showSpinner ? (
                <Spinner />
              ) : isPaused ? (
                <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden>
                  <path d="M8 6.5v11l9-5.5-9-5.5z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden>
                  <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
                </svg>
              )}
              {isPaused ? 'Retomar' : 'Pausar'}
            </button>

            <button
              onClick={() => void handleStop()}
              disabled={pending !== null}
              title="Encerrar e processar"
              className="shrink-0 h-8 px-3 flex items-center gap-1.5 rounded-full bg-red-500 hover:bg-red-400 disabled:opacity-70 disabled:cursor-wait text-white text-xs font-medium transition cursor-pointer"
              style={noDragStyle}
            >
              {pending === 'stop' && showSpinner ? (
                <Spinner />
              ) : (
                <span className="w-2.5 h-2.5 rounded-sm bg-white" />
              )}
              Encerrar
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => void handleCancel()}
              title="Fechar"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 transition cursor-pointer"
              style={noDragStyle}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>

            <button
              onClick={() => void handleToggleCompact()}
              title="Compactar pill"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-white/55 hover:text-white hover:bg-white/10 transition cursor-pointer"
              style={noDragStyle}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 3H5a2 2 0 0 0-2 2v5" />
                <path d="M14 3h5a2 2 0 0 1 2 2v5" />
                <path d="M10 21H5a2 2 0 0 1-2-2v-5" />
                <path d="M14 21h5a2 2 0 0 0 2-2v-5" />
                <path d="M9 9l6 6" />
                <path d="M15 9l-6 6" />
              </svg>
            </button>

            <button
              onClick={() => setInfoOpen((open) => !open)}
              title={infoOpen ? 'Ocultar detalhes' : 'Detalhes da gravação'}
              aria-label={infoOpen ? 'Ocultar detalhes da gravação' : 'Mostrar detalhes da gravação'}
              className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition cursor-pointer ${
                infoOpen ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white hover:bg-white/10'
              }`}
              style={noDragStyle}
            >
              <InfoGlyph />
            </button>

            <div className="flex-1 flex flex-col min-w-0">
              {infoOpen ? (
                <PillInfoDetails
                  title={title}
                  secondary={infoSecondary}
                  tertiary={infoTertiary}
                  isError={Boolean(errorMsg)}
                />
              ) : (
                <>
                  <span className="text-[10px] uppercase tracking-wider text-white/50">
                    {errorMsg ? 'Erro' : statusLabel}
                  </span>
                  <span
                    title={errorMsg ?? undefined}
                    className={`text-xs truncate ${errorMsg ? 'text-red-300' : 'text-white/85'}`}
                  >
                    {errorMsg ?? 'Pronta para gravar'}
                  </span>
                </>
              )}
            </div>

            <button
              onClick={() => void handleStart()}
              disabled={pending !== null}
              className="shrink-0 h-8 px-3 flex items-center gap-1.5 rounded-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-70 disabled:cursor-wait text-white text-xs font-medium transition cursor-pointer"
              style={noDragStyle}
            >
              {pending === 'start' && showSpinner ? (
                <Spinner />
              ) : (
                <span className="w-2 h-2 rounded-full bg-white" />
              )}
              Iniciar
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function formatCaptureHint(
  mode: AudioCaptureMode,
  source: AudioCaptureSource,
  warnings: string[]
): string {
  const base =
    mode === 'auto'
      ? `Auto em uso: ${formatSourceLabel(source)}`
      : `${formatModeLabel(mode)}: ${formatSourceLabel(source)}`
  return warnings[0] ? `${base} (${warnings[0]})` : base
}

function getContinuationOffset(meeting: Meeting | null): number {
  if (!meeting?.transcript_segments?.length) return 0
  return meeting.transcript_segments.reduce(
    (max, segment) => Math.max(max, segment.endMs),
    0
  )
}

function offsetAudioChunk(chunk: AudioChunkPayload, offsetMs: number): AudioChunkPayload {
  if (offsetMs <= 0) return chunk
  return {
    ...chunk,
    startMs: chunk.startMs + offsetMs,
    endMs: chunk.endMs + offsetMs
  }
}

function formatSourceLabel(source: AudioCaptureSource | null): string {
  switch (source) {
    case 'system':
      return 'audio do sistema'
    case 'microphone':
      return 'microfone'
    case 'mixed':
      return 'sistema + microfone'
    default:
      return 'aguardando captura'
  }
}

function formatModeLabel(mode: AudioCaptureMode): string {
  switch (mode) {
    case 'system':
      return 'Modo sistema'
    case 'microphone':
      return 'Modo microfone'
    case 'mixed':
      return 'Modo misto'
    default:
      return 'Modo automatico'
  }
}

function InfoGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  )
}

function PillInfoDetails({
  title,
  secondary,
  tertiary,
  isError = false
}: PillInfoDetailsProps): ReactElement {
  return (
    <div className="min-w-0 leading-none" title={`${title} · ${secondary} · ${tertiary}`}>
      <div className="truncate text-[11px] font-semibold text-white/90">
        {title}
      </div>
      <div className={`mt-1 truncate text-[10px] ${isError ? 'text-red-300' : 'text-white/60'}`}>
        {secondary}
      </div>
      <div className="mt-0.5 truncate text-[9px] text-white/40">
        {tertiary}
      </div>
    </div>
  )
}

function Spinner(): ReactElement {
  return (
    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

const BAR_COUNT = 18

function ListenBars({
  stream,
  compact = false
}: {
  stream: MediaStream | null
  compact?: boolean
}): ReactElement {
  const barRefs = useRef<Array<HTMLSpanElement | null>>([])
  const barCount = compact ? 12 : BAR_COUNT

  useEffect(() => {
    if (!stream) return
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AudioCtx()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 128
    analyser.smoothingTimeConstant = 0.7
    source.connect(analyser)

    const buffer = new Uint8Array(analyser.frequencyBinCount)
    let raf = 0
    const tick = (): void => {
      analyser.getByteFrequencyData(buffer)
      const usable = Math.floor(buffer.length * 0.75)
      const step = Math.max(1, Math.floor(usable / barCount))
      for (let i = 0; i < barCount; i++) {
        let sum = 0
        for (let j = 0; j < step; j++) sum += buffer[i * step + j] ?? 0
        const avg = sum / step / 255
        const scale = Math.max(0.08, Math.min(1, avg * 1.8))
        const el = barRefs.current[i]
        if (el) el.style.transform = `scaleY(${scale})`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      source.disconnect()
      analyser.disconnect()
      void ctx.close()
    }
  }, [barCount, stream])

  return (
    <div
      className={`shrink-0 flex items-center gap-[2px] overflow-hidden ${compact ? 'h-5 w-14' : 'h-7 w-20'}`}
      aria-hidden
    >
      {Array.from({ length: barCount }).map((_, i) => (
        <span
          key={i}
          ref={(el) => { barRefs.current[i] = el }}
          className="w-[2px] h-full bg-white rounded-full origin-center transition-transform duration-75"
          style={{ transform: 'scaleY(0.08)' }}
        />
      ))}
    </div>
  )
}
