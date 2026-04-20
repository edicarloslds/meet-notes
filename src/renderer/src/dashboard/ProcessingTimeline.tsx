import type { ReactElement } from 'react'
import type { StageName, StageStatus } from '../../../shared/types'

export interface StageState {
  status: StageStatus
  startedAt?: number
  finishedAt?: number
  error?: string
}

export type TimelineState = Partial<Record<StageName, StageState>>

const STAGES: { name: StageName; label: string; description: string }[] = [
  { name: 'converting', label: 'Convertendo áudio', description: 'Preparando WAV com ffmpeg' },
  { name: 'transcribing', label: 'Transcrevendo', description: 'Convertendo fala em texto' },
  { name: 'summarizing', label: 'Resumindo', description: 'Gerando resumo e itens de ação' },
  { name: 'saving', label: 'Salvando', description: 'Persistindo localmente e sincronizando' }
]

function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}min ${s}s` : `${m}min`
}

export function ProcessingTimeline({
  state,
  now
}: {
  state: TimelineState
  now: number
}): ReactElement {
  return (
    <ol className="relative border-l-2 border-slate-200 ml-3 pl-6 space-y-5">
      {STAGES.map(({ name, label, description }) => {
        const s = state[name]
        const status: StageStatus | 'pending' = s?.status ?? 'pending'
        const elapsed =
          s?.startedAt && s?.finishedAt
            ? s.finishedAt - s.startedAt
            : s?.startedAt && status === 'active'
              ? now - s.startedAt
              : undefined

        return (
          <li key={name} className="relative">
            <span className="absolute -left-[34px] top-0.5 w-5 h-5">
              {status === 'active' && (
                <span className="absolute inset-0 rounded-full border-2 border-sky-200 border-t-sky-500 animate-spin" />
              )}
              <span
                className={`absolute inset-0 flex items-center justify-center rounded-full border-2 ${dotStyles(status)}`}
              >
                {status === 'active' && (
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />
                )}
                {status === 'done' && (
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-600">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
                {status === 'failed' && (
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-red-600">
                    <path d="M18 6L6 18" />
                    <path d="M6 6l12 12" />
                  </svg>
                )}
              </span>
            </span>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className={`text-sm font-medium ${labelStyles(status)}`}>{label}</div>
                <div className="text-xs text-slate-500 mt-0.5">{description}</div>
                {s?.error && (
                  <div className="text-xs text-red-600 mt-1 break-words">{s.error}</div>
                )}
              </div>
              {elapsed !== undefined && (
                <div className="text-[11px] text-slate-500 shrink-0 tabular-nums">
                  {formatElapsed(elapsed)}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function dotStyles(status: StageStatus | 'pending'): string {
  switch (status) {
    case 'active':
      return 'border-transparent bg-transparent'
    case 'done':
      return 'border-emerald-500 bg-white'
    case 'failed':
      return 'border-red-500 bg-white'
    default:
      return 'border-slate-300 bg-white'
  }
}

function labelStyles(status: StageStatus | 'pending'): string {
  switch (status) {
    case 'active':
      return 'text-slate-900'
    case 'done':
      return 'text-slate-700'
    case 'failed':
      return 'text-red-700'
    default:
      return 'text-slate-400'
  }
}
