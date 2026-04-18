import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { PillState, Meeting } from '../../../shared/types'
import { useAudioRecorder } from '../hooks/useAudioRecorder'

export function Pill(): ReactElement {
  const [state, setState] = useState<PillState>('idle')
  const [title, setTitle] = useState<string>('Reunião detectada')
  const [elapsed, setElapsed] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const tickRef = useRef<number | null>(null)
  const { start, stop, isRecording } = useAudioRecorder()

  useEffect(() => {
    const off = window.meetnotes.onMeetingDetected((p) => {
      if (p?.title) setTitle(p.title)
    })
    return off
  }, [])

  useEffect(() => {
    if (state === 'recording') {
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
  }, [state])

  const handleStart = async (): Promise<void> => {
    setErrorMsg(null)
    try {
      await start()
      setState('recording')
    } catch (err) {
      console.error('Failed to start recording:', err)
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(/permission|denied|notallowed/i.test(msg) ? 'Permissão negada' : 'Falha ao gravar')
      setState('idle')
    }
  }

  const handleStop = async (): Promise<void> => {
    if (!isRecording) {
      window.meetnotes.closePill()
      return
    }
    setState('transcribing')
    try {
      const blob = await stop()
      const arrayBuffer = await blob.arrayBuffer()
      const result = await window.meetnotes.processAudio(arrayBuffer)
      setState('saving')
      const meeting: Meeting = {
        id: crypto.randomUUID(),
        user_id: null,
        title,
        raw_transcript: result.transcript,
        summary: result.summary,
        action_items: result.actionItems,
        created_at: new Date().toISOString()
      }
      await window.meetnotes.saveMeeting(meeting)
    } catch (err) {
      console.error('Stop pipeline failed:', err)
    } finally {
      setState('idle')
      window.meetnotes.closePill()
    }
  }

  const fmt = (s: number): string => {
    const m = Math.floor(s / 60).toString().padStart(2, '0')
    const r = (s % 60).toString().padStart(2, '0')
    return `${m}:${r}`
  }

  return (
    <div className="w-full h-full flex items-center justify-center p-1">
      <div className="flex items-center gap-3 px-4 h-14 w-[240px] rounded-full bg-slate-900/70 backdrop-blur-md border border-white/10 shadow-2xl text-white">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <StatusDot state={state} />
          <div className="flex flex-col min-w-0">
            <span className="text-[11px] uppercase tracking-wide text-white/60 truncate">
              {labelFor(state)}
            </span>
            {state === 'recording' && (
              <span className="text-xs font-mono text-white/80">{fmt(elapsed)}</span>
            )}
            {state === 'transcribing' && (
              <span className="text-xs text-white/70 truncate">IA gerando resumo…</span>
            )}
            {state === 'saving' && (
              <span className="text-xs text-white/70 truncate">Salvando…</span>
            )}
            {state === 'idle' && (
              <span className={`text-xs truncate ${errorMsg ? 'text-red-300' : 'text-white/70'}`}>
                {errorMsg ?? title}
              </span>
            )}
          </div>
        </div>
        {state === 'idle' && (
          <button
            onClick={handleStart}
            className="shrink-0 text-xs font-medium bg-red-500 hover:bg-red-400 text-white rounded-full px-3 py-1 transition"
          >
            Gravar
          </button>
        )}
        {state === 'recording' && (
          <button
            onClick={handleStop}
            className="shrink-0 text-xs font-medium bg-white text-slate-900 rounded-full px-3 py-1 hover:bg-white/90 transition"
          >
            Parar
          </button>
        )}
        {(state === 'transcribing' || state === 'saving') && (
          <div className="shrink-0 w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        )}
        {(state === 'idle' || state === 'recording') && (
          <button
            onClick={async () => {
              if (isRecording) {
                try { await stop() } catch { /* ignore */ }
              }
              window.meetnotes.closePill()
            }}
            title="Fechar"
            className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-white/60 hover:text-white hover:bg-white/10 transition"
          >
            ×
          </button>
        )}
      </div>
    </div>
  )
}

function labelFor(state: PillState): string {
  switch (state) {
    case 'idle': return 'Detectado'
    case 'recording': return 'Gravando'
    case 'transcribing': return 'Transcrevendo'
    case 'saving': return 'Salvando'
  }
}

function StatusDot({ state }: { state: PillState }): ReactElement {
  const color =
    state === 'recording' ? 'bg-red-500' :
    state === 'transcribing' ? 'bg-amber-400' :
    state === 'saving' ? 'bg-emerald-400' :
    'bg-sky-400'
  const anim = state === 'recording' ? 'animate-pulse-rec' : ''
  return <span className={`w-2.5 h-2.5 rounded-full ${color} ${anim}`} />
}
