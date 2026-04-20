import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  OLLAMA_NOT_READY_MARKER,
  WHISPER_NOT_READY_MARKER,
  type Meeting
} from '../../../shared/types'
import { useAudioRecorder } from '../hooks/useAudioRecorder'

export function Pill(): ReactElement {
  const [title, setTitle] = useState<string>('Reunião detectada')
  const [elapsed, setElapsed] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [pending, setPending] = useState<'start' | 'stop' | null>(null)
  const [showSpinner, setShowSpinner] = useState(false)
  const tickRef = useRef<number | null>(null)
  const meetingIdRef = useRef<string | null>(null)
  const { start, stop, sampleRate, isRecording, stream } = useAudioRecorder()

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
      if (p?.title) setTitle(p.title)
    })
    return off
  }, [])

  useEffect(() => {
    if (isRecording) {
      const t0 = Date.now()
      tickRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - t0) / 1000))
      }, 1000)
    } else if (tickRef.current) {
      clearInterval(tickRef.current)
      tickRef.current = null
      setElapsed(0)
    }
    return () => {
      if (tickRef.current) clearInterval(tickRef.current)
    }
  }, [isRecording])

  const handleStart = async (): Promise<void> => {
    if (pending) return
    setErrorMsg(null)
    setPending('start')
    try {
      const meetingId = crypto.randomUUID()
      meetingIdRef.current = meetingId
      await window.distill.startMeetingChunks(meetingId)
      await start((pcm) => {
        void window.distill.submitAudioChunk(meetingId, pcm, sampleRate)
      })
    } catch (err) {
      console.error('Failed to start recording:', err)
      const msg = err instanceof Error ? err.message : String(err)
      if (meetingIdRef.current) {
        void window.distill.abortMeetingChunks(meetingIdRef.current)
        meetingIdRef.current = null
      }
      setErrorMsg(mapStartError(msg))
    } finally {
      setPending(null)
    }
  }

  const handleCancel = async (): Promise<void> => {
    if (isRecording) {
      try { await stop() } catch { /* ignore discarded audio */ }
    }
    if (meetingIdRef.current) {
      void window.distill.abortMeetingChunks(meetingIdRef.current)
      meetingIdRef.current = null
    }
    window.distill.closePill()
  }

  const handleStop = async (): Promise<void> => {
    if (pending) return
    if (!isRecording) {
      window.distill.closePill()
      return
    }
    setPending('stop')
    const meetingId = meetingIdRef.current ?? crypto.randomUUID()
    const placeholder: Meeting = {
      id: meetingId,
      user_id: null,
      title,
      raw_transcript: '',
      summary: '',
      action_items: [],
      created_at: new Date().toISOString(),
      status: 'processing'
    }
    try {
      const remaining = await stop()
      window.distill.finalizeMeeting(placeholder, remaining, sampleRate)
    } catch (err) {
      console.error('Stop pipeline failed:', err)
      if (meetingIdRef.current) {
        void window.distill.abortMeetingChunks(meetingIdRef.current)
      }
      try {
        await window.distill.saveMeeting({ ...placeholder, status: 'failed' })
      } catch { /* ignore */ }
    } finally {
      meetingIdRef.current = null
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

  return (
    <div className="w-full h-full flex items-center justify-center p-1">
      <div className="flex items-center gap-2 px-3 h-14 w-full rounded-full bg-slate-900/75 backdrop-blur-md border border-white/10 shadow-2xl text-white">
        {isRecording ? (
          <>
            <button
              onClick={() => void handleCancel()}
              title="Cancelar"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/10 transition cursor-pointer"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>

            <div className="flex-1 flex items-center justify-center gap-3 min-w-0">
              <ListenBars stream={stream} />
              <span className="text-xs font-mono text-white/80 tabular-nums">{fmt(elapsed)}</span>
            </div>

            <button
              onClick={() => void handleStop()}
              disabled={pending !== null}
              title="Parar gravação"
              className="shrink-0 h-8 px-3 flex items-center gap-1.5 rounded-full bg-red-500 hover:bg-red-400 disabled:opacity-70 disabled:cursor-wait text-white text-xs font-medium transition cursor-pointer"
            >
              {pending === 'stop' && showSpinner ? (
                <Spinner />
              ) : (
                <span className="w-2.5 h-2.5 rounded-sm bg-white" />
              )}
              Parar
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => void handleCancel()}
              title="Fechar"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 transition cursor-pointer"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>

            <div className="flex-1 flex flex-col min-w-0">
              <span className="text-[10px] uppercase tracking-wider text-white/50">
                {errorMsg ? 'Erro' : 'Reunião'}
              </span>
              <span
                title={errorMsg ?? undefined}
                className={`text-xs truncate ${errorMsg ? 'text-red-300' : 'text-white/85'}`}
              >
                {errorMsg ?? title}
              </span>
            </div>

            <button
              onClick={() => void handleStart()}
              disabled={pending !== null}
              className="shrink-0 h-8 px-3 flex items-center gap-1.5 rounded-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-70 disabled:cursor-wait text-white text-xs font-medium transition cursor-pointer"
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

function Spinner(): ReactElement {
  return (
    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

const BAR_COUNT = 28

function ListenBars({ stream }: { stream: MediaStream | null }): ReactElement {
  const barRefs = useRef<Array<HTMLSpanElement | null>>([])

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
      const step = Math.max(1, Math.floor(usable / BAR_COUNT))
      for (let i = 0; i < BAR_COUNT; i++) {
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
  }, [stream])

  return (
    <div className="flex items-center gap-[2px] h-7" aria-hidden>
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
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
