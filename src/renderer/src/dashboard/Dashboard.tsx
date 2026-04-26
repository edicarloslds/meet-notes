import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  OLLAMA_NOT_READY_MARKER,
  type TranscriptSegment,
  WHISPER_NOT_READY_MARKER,
  type Meeting,
  type OllamaStatus,
  type WhisperStatus
} from '../../../shared/types'
import { SettingsPanel } from './SettingsPanel'
import { ProcessingTimeline, type TimelineState } from './ProcessingTimeline'
import { Welcome } from './Welcome'

type SegmentQuality = TranscriptSegment['quality']

export function Dashboard(): ReactElement {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftTranscript, setDraftTranscript] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [tab, setTab] = useState<'summary' | 'transcript' | 'actions'>('summary')
  const [copied, setCopied] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [whisperStatus, setWhisperStatus] = useState<WhisperStatus | null>(null)
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null)
  const [showWelcome, setShowWelcome] = useState<boolean | null>(null)
  const [progressByMeeting, setProgressByMeeting] = useState<Record<string, TimelineState>>({})
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null)
  const [segmentDraft, setSegmentDraft] = useState('')
  const [speakerDraft, setSpeakerDraft] = useState('')
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [replaceMsg, setReplaceMsg] = useState<string | null>(null)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [tickNow, setTickNow] = useState(() => Date.now())
  const tickIntervalRef = useRef<number | null>(null)
  const exportMenuRef = useRef<HTMLDivElement | null>(null)

  const refresh = async (): Promise<void> => {
    const list = await window.distill.listMeetings()
    setMeetings(list)
    setSelectedId((cur) => cur ?? (list[0]?.id ?? null))
  }

  const refreshStatuses = async (): Promise<void> => {
    try {
      const [w, o] = await Promise.all([
        window.distill.getWhisperStatus(),
        window.distill.getOllamaStatus()
      ])
      setWhisperStatus(w)
      setOllamaStatus(o)
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    void (async (): Promise<void> => {
      const s = await window.distill.getSettings()
      setShowWelcome(!s.welcomeCompletedAt)
    })()
    void refresh()
    void refreshStatuses()
    const handleOnline = async (): Promise<void> => {
      const res = await window.distill.syncPending()
      if (res.synced > 0) {
        setSyncMsg(`${res.synced} reunião(ões) sincronizada(s)`)
        void refresh()
        setTimeout(() => setSyncMsg(null), 4000)
      }
    }
    window.addEventListener('online', handleOnline)
    const offEnded = window.distill.onMeetingEnded(() => void refresh())
    const offDetected = window.distill.onMeetingDetected(() => void refresh())
    const offProgress = window.distill.onMeetingProgress((p) => {
      setProgressByMeeting((prev) => {
        const prior = prev[p.meetingId] ?? {}
        const existing = prior[p.stage]
        const next: TimelineState = {
          ...prior,
          [p.stage]: {
            status: p.status,
            startedAt:
              p.status === 'active'
                ? existing?.startedAt ?? p.at
                : existing?.startedAt ?? (p.status === 'done' ? p.at : p.at),
            finishedAt: p.status === 'active' ? undefined : p.at,
            error: p.error,
            progress:
              p.status === 'active'
                ? typeof p.progress === 'number'
                  ? p.progress
                  : existing?.progress
                : undefined
          }
        }
        return { ...prev, [p.meetingId]: next }
      })
    })
    const interval = window.setInterval(() => void refresh(), 5000)
    return () => {
      window.removeEventListener('online', handleOnline)
      offEnded()
      offDetected()
      offProgress()
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    if (!pendingDeleteId) return
    const close = (): void => setPendingDeleteId(null)
    const t = window.setTimeout(() => {
      window.addEventListener('click', close)
      window.addEventListener('scroll', close, true)
    }, 0)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [pendingDeleteId])

  useEffect(() => {
    if (!exportMenuOpen) return
    const close = (event: Event): void => {
      const target = event.target as Node | null
      if (target && exportMenuRef.current?.contains(target)) return
      setExportMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExportMenuOpen(false)
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('scroll', close, true)
    }
  }, [exportMenuOpen])

  useEffect(() => {
    const hasActive = Object.values(progressByMeeting).some((s) =>
      Object.values(s).some((stage) => stage?.status === 'active')
    )
    if (hasActive && tickIntervalRef.current === null) {
      tickIntervalRef.current = window.setInterval(() => setTickNow(Date.now()), 500)
    } else if (!hasActive && tickIntervalRef.current !== null) {
      window.clearInterval(tickIntervalRef.current)
      tickIntervalRef.current = null
    }
    return () => {
      if (tickIntervalRef.current !== null) {
        window.clearInterval(tickIntervalRef.current)
        tickIntervalRef.current = null
      }
    }
  }, [progressByMeeting])

  useEffect(() => {
    setProgressByMeeting((prev) => {
      const updated = { ...prev }
      let changed = false
      for (const m of meetings) {
        if (m.status === 'ready' && updated[m.id]) {
          delete updated[m.id]
          changed = true
        }
      }
      return changed ? updated : prev
    })
  }, [meetings])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return meetings
    return meetings.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        m.summary.toLowerCase().includes(q) ||
        m.raw_transcript.toLowerCase().includes(q)
    )
  }, [meetings, query])

  const selected = meetings.find((m) => m.id === selectedId) ?? null
  const selectedStatus = selected?.status ?? 'ready'
  const selectedSummaryStatus = selected
    ? selected.summary_status ?? (selected.summary.trim() ? 'complete' : undefined)
    : undefined

  const clearSegmentEditing = (): void => {
    setEditingSegmentId(null)
    setSegmentDraft('')
    setSpeakerDraft('')
  }

  const startEdit = (m: Meeting): void => {
    clearSegmentEditing()
    setSelectedId(m.id)
    setDraftTitle(m.title)
    setDraftTranscript(m.raw_transcript)
    setIsEditing(true)
  }

  const saveEdit = async (): Promise<void> => {
    if (!selected) return
    const transcriptChanged = draftTranscript.trim() !== selected.raw_transcript.trim()
    await window.distill.saveMeeting({
      ...selected,
      title: draftTitle.trim() || selected.title,
      raw_transcript: draftTranscript,
      transcript_segments: transcriptChanged ? undefined : selected.transcript_segments,
      summary: transcriptChanged ? '' : selected.summary,
      action_items: transcriptChanged ? [] : selected.action_items,
      summary_status: transcriptChanged ? 'skipped' : selected.summary_status,
      summary_error: transcriptChanged
        ? 'Resumo desatualizado após revisão manual da transcrição. Gere novamente.'
        : selected.summary_error
    })
    clearSegmentEditing()
    setIsEditing(false)
    await refresh()
  }

  const confirmDelete = async (m: Meeting): Promise<void> => {
    setMeetings((prev) => prev.filter((it) => it.id !== m.id))
    setPendingDeleteId(null)
    if (selectedId === m.id) {
      setSelectedId(null)
      clearSegmentEditing()
      setIsEditing(false)
    }
    try {
      await window.distill.deleteMeeting(m.id)
    } finally {
      await refresh()
    }
  }

  const handleRegenerate = async (): Promise<void> => {
    if (!selected || !selected.raw_transcript.trim()) return
    setRegenerating(true)
    const startedAt = Date.now()
    try {
      const { summary, actionItems } = await window.distill.regenerateSummary(
        selected.raw_transcript
      )
      await window.distill.saveMeeting({
        ...selected,
        summary,
        action_items: actionItems,
        status: 'ready',
        processing_ms: Date.now() - startedAt
      })
      await refresh()
    } finally {
      setRegenerating(false)
    }
  }

  const startSegmentEdit = (segmentId: string, text: string): void => {
    setEditingSegmentId(segmentId)
    setSegmentDraft(text)
    const speaker = selected?.transcript_segments?.find((segment) => segment.id === segmentId)?.speakerLabel ?? ''
    setSpeakerDraft(speaker)
  }

  const cancelSegmentEdit = (): void => {
    clearSegmentEditing()
  }

  const handleReplaceAll = async (): Promise<void> => {
    if (!selected) return
    const find = findText.trim()
    if (!find) {
      setReplaceMsg('Informe o texto que deseja encontrar.')
      return
    }

    if (selected.transcript_segments?.length) {
      let count = 0
      const replacedSegments = selected.transcript_segments.map((segment) => {
        const replaced = replaceAllLiteral(segment.text, find, replaceText)
        count += replaced.count
        return { ...segment, text: replaced.text }
      })
      if (count === 0) {
        setReplaceMsg('Nenhuma ocorrência encontrada.')
        return
      }
      await window.distill.saveMeeting({
        ...selected,
        transcript_segments: replacedSegments,
        raw_transcript: rebuildTranscriptFromSegments(replacedSegments),
        summary: '',
        action_items: [],
        summary_status: 'skipped',
        summary_error: 'Resumo desatualizado após substituições na transcrição. Gere novamente.'
      })
      setReplaceMsg(`${count} ocorrência(s) substituída(s).`)
      await refresh()
      return
    }

    const replaced = replaceAllLiteral(selected.raw_transcript, find, replaceText)
    if (replaced.count === 0) {
      setReplaceMsg('Nenhuma ocorrência encontrada.')
      return
    }
    await window.distill.saveMeeting({
      ...selected,
      raw_transcript: replaced.text,
      summary: '',
      action_items: [],
      summary_status: 'skipped',
      summary_error: 'Resumo desatualizado após substituições na transcrição. Gere novamente.'
    })
    setReplaceMsg(`${replaced.count} ocorrência(s) substituída(s).`)
    await refresh()
  }

  const saveSegmentEdit = async (segmentId: string): Promise<void> => {
    if (!selected?.transcript_segments?.length) return
    const nextSegments = selected.transcript_segments.map((segment) =>
      segment.id === segmentId
        ? { ...segment, text: segmentDraft.trim() || segment.text }
        : segment
    )
    await window.distill.saveMeeting({
      ...selected,
      transcript_segments: nextSegments,
      raw_transcript: rebuildTranscriptFromSegments(nextSegments),
      summary: '',
      action_items: [],
      summary_status: 'skipped',
      summary_error: 'Resumo desatualizado após revisão por trecho. Gere novamente.'
    })
    cancelSegmentEdit()
    await refresh()
  }

  const saveSpeakerEdit = async (segmentId: string): Promise<void> => {
    if (!selected?.transcript_segments?.length) return
    const nextSegments = selected.transcript_segments.map((segment) =>
      segment.id === segmentId
        ? { ...segment, speakerLabel: speakerDraft.trim() || undefined }
        : segment
    )
    await window.distill.saveMeeting({
      ...selected,
      transcript_segments: nextSegments
    })
    cancelSegmentEdit()
    await refresh()
  }

  const handleExport = async (format: 'markdown' | 'text'): Promise<void> => {
    if (!selected) return
    setExportMenuOpen(false)
    const result = await window.distill.exportMeeting(selected, format)
    if (result.canceled) return
    setExportMsg(`Exportado em ${result.path}`)
    setTimeout(() => setExportMsg(null), 3500)
  }

  const handleContinueMeeting = async (): Promise<void> => {
    if (!selected || selected.status === 'processing') return
    clearSegmentEditing()
    setIsEditing(false)
    await window.distill.continueMeeting(selected)
  }

  const handleOpenLiveTranscript = async (): Promise<void> => {
    await window.distill.openLiveTranscript()
  }

  if (showWelcome === null) {
    return <div className="h-full w-full" />
  }

  if (showWelcome) {
    return <Welcome onComplete={() => setShowWelcome(false)} />
  }

  return (
    <div className="h-full w-full flex text-slate-800">
      <aside className="w-[340px] shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div
          className="px-4 pb-4 pt-10 border-b border-slate-200"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold">Distill</h1>
            <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
              <button
                type="button"
                aria-label="Transcrição ao vivo"
                title="Transcrição ao vivo"
                onClick={() => void handleOpenLiveTranscript()}
                className="p-1.5 rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-200/70"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
                  <path d="M8 9h8" />
                  <path d="M8 13h5" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="Configurações"
                title="Configurações"
                onClick={() => setShowSettings(true)}
                className="p-1.5 rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-200/70"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </div>
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar reuniões…"
            className="mt-3 w-full bg-slate-100 rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          />
          {syncMsg && (
            <div className="mt-2 text-xs text-emerald-600">{syncMsg}</div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="p-6 text-sm text-slate-500">
              Nenhuma reunião ainda. Inicie uma gravação pelo ícone da barra de menu.
            </div>
          )}
          {filtered.map((m) => {
            const status = m.status ?? 'ready'
            const isPendingDelete = pendingDeleteId === m.id
            const actionsDisabled = status === 'processing'
            return (
              <div
                key={m.id}
                role="button"
                tabIndex={0}
                onClick={() => { clearSegmentEditing(); setShowSettings(false); setSelectedId(m.id); setIsEditing(false); setTab('summary') }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    clearSegmentEditing(); setShowSettings(false); setSelectedId(m.id); setIsEditing(false); setTab('summary')
                  }
                }}
                className={`group relative w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-slate-50 transition cursor-pointer ${
                  selectedId === m.id ? 'bg-sky-50' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate flex-1">{m.title}</span>
                  <div className="shrink-0">
                    {actionsDisabled && (
                      <button
                        type="button"
                        aria-label="Cancelar processamento"
                        title="Cancelar processamento"
                        onClick={(e) => { e.stopPropagation(); void window.distill.cancelProcessing(m.id) }}
                        className="p-1 rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50"
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="9" />
                          <path d="M15 9l-6 6" />
                          <path d="M9 9l6 6" />
                        </svg>
                      </button>
                    )}
                    {!actionsDisabled && (
                      isPendingDelete ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void confirmDelete(m) }}
                          className="text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md px-2 py-1"
                        >
                          Confirmar
                        </button>
                      ) : (
                        <div className="hidden group-hover:flex items-center gap-0.5">
                          <button
                            type="button"
                            aria-label="Editar"
                            title="Editar"
                            onClick={(e) => { e.stopPropagation(); startEdit(m) }}
                            className="p-1 rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-200/70"
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            aria-label="Excluir"
                            title="Excluir"
                            onClick={(e) => { e.stopPropagation(); setPendingDeleteId(m.id) }}
                            className="p-1 rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50"
                          >
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 6h18" />
                              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                            </svg>
                          </button>
                        </div>
                      )
                    )}
                  </div>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-500 truncate">
                    {new Date(m.created_at).toLocaleString()}
                  </div>
                  <div className="shrink-0 flex flex-wrap items-center justify-end gap-1">
                    {(status === 'processing' || (regenerating && selectedId === m.id)) && (
                      <span className="text-[10px] text-sky-700 bg-sky-100 rounded px-1.5 py-0.5 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
                        {regenerating && selectedId === m.id ? 'regenerando' : 'processando'}
                      </span>
                    )}
                    {status === 'failed' && !isPendingDelete && (
                      <span className="text-[10px] text-red-700 bg-red-100 rounded px-1.5 py-0.5">
                        falhou
                      </span>
                    )}
                    {status === 'ready' && m.synced === false && !isPendingDelete && (
                      <span className="text-[10px] text-amber-600 bg-amber-50 rounded px-1.5 py-0.5">
                        offline
                      </span>
                    )}
                    {m.capture_source && !isPendingDelete && (
                      <span className="text-[10px] text-slate-600 bg-slate-100 rounded px-1.5 py-0.5">
                        {formatCaptureSource(m.capture_source)}
                      </span>
                    )}
                    {status === 'ready' && m.summary_status === 'skipped' && !m.summary.trim() && !isPendingDelete && (
                      <span className="text-[10px] text-sky-700 bg-sky-100 rounded px-1.5 py-0.5">
                        sem resumo
                      </span>
                    )}
                    {status === 'ready' && m.summary_status === 'failed' && !isPendingDelete && (
                      <span className="text-[10px] text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">
                        resumo falhou
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        {!showSettings && (() => {
          const whisperIssue =
            whisperStatus && (!whisperStatus.binAvailable || !whisperStatus.model)
              ? !whisperStatus.binAvailable
                ? 'Instale o whisper-cli (ex.: brew install whisper-cpp).'
                : 'Nenhum modelo do Whisper selecionado.'
              : null
          if (!whisperIssue) return null
          return (
            <div className="bg-amber-50 border-b border-amber-200 px-6 py-3 flex items-center justify-between gap-4">
              <div className="text-sm text-amber-900">
                <span className="font-medium">Transcrição indisponível.</span> Whisper: {whisperIssue}
              </div>
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="shrink-0 text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white rounded-md px-3 py-1.5"
              >
                Abrir Configurações
              </button>
            </div>
          )
        })()}
        {!showSettings && ollamaStatus && (!ollamaStatus.reachable || !ollamaStatus.selectedModelInstalled) && (
          <div className="bg-sky-50 border-b border-sky-200 px-6 py-3 flex items-center justify-between gap-4">
            <div className="text-sm text-sky-900">
              <span className="font-medium">Resumo opcional indisponível.</span>{' '}
              {!ollamaStatus.reachable
                ? `Ollama offline em ${ollamaStatus.host}.`
                : `Modelo "${ollamaStatus.selectedModel}" ainda nao instalado.`}{' '}
              A gravacao e a transcricao continuam funcionando.
            </div>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="shrink-0 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white rounded-md px-3 py-1.5"
            >
              Ajustar resumo
            </button>
          </div>
        )}
        {showSettings ? (
          <SettingsPanel onClose={() => { setShowSettings(false); void refreshStatuses() }} />
        ) : selected ? (
          <div className="max-w-3xl mx-auto px-10 py-10">
            {!isEditing && (
              <>
                <header className="mb-8">
                  <div className="text-xs uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">
                    <span>{formatHeaderDate(selected.created_at)}</span>
                    {typeof selected.processing_ms === 'number' && selectedStatus === 'ready' && (
                      <>
                        <span className="text-slate-300">·</span>
                        <span title="Tempo de transcrição + resumo" className="normal-case tracking-normal text-slate-500">
                          processado em {formatDuration(selected.processing_ms)}
                        </span>
                      </>
                    )}
                  </div>
                  <h2 className="text-4xl font-bold text-slate-900 leading-tight tracking-tight">
                    {selected.title}
                  </h2>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {selected.capture_source && (
                      <span className="text-xs font-medium text-slate-600 bg-slate-100 rounded-full px-2.5 py-1">
                        Fonte: {formatCaptureSource(selected.capture_source)}
                      </span>
                    )}
                    {selectedSummaryStatus && selectedSummaryStatus !== 'complete' && (
                      <span className={`text-xs font-medium rounded-full px-2.5 py-1 ${summaryBadgeClass(selectedSummaryStatus)}`}>
                        {selectedSummaryStatus === 'skipped' ? 'Resumo pendente' : 'Resumo com erro'}
                      </span>
                    )}
                  </div>
                </header>

                {selectedStatus === 'ready' && (
                  <div className="mb-8 rounded-lg bg-slate-100/80 p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="inline-flex min-w-0 items-center gap-1 rounded-md bg-white/60 p-0.5">
                        <TabButton active={tab === 'summary'} onClick={() => { clearSegmentEditing(); setTab('summary') }}>
                          Resumo
                        </TabButton>
                        <TabButton active={tab === 'transcript'} onClick={() => { clearSegmentEditing(); setTab('transcript') }}>
                          Transcrição
                        </TabButton>
                        <TabButton active={tab === 'actions'} onClick={() => { clearSegmentEditing(); setTab('actions') }}>
                          Itens de Ação
                        </TabButton>
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleContinueMeeting()}
                          aria-label="Continuar gravação"
                          title="Continuar gravação"
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-slate-900 text-white shadow-sm transition hover:bg-slate-700"
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                            <path d="M6 6.5v11l8-5.5-8-5.5z" />
                            <path d="M16 6h2v12h-2z" />
                            <path d="M20 6h2v12h-2z" />
                          </svg>
                        </button>

                        <div ref={exportMenuRef} className="relative">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                            setExportMenuOpen((open) => !open)
                          }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-700 shadow-sm transition hover:border-slate-400 hover:bg-slate-50 hover:text-slate-950"
                            aria-haspopup="menu"
                            aria-expanded={exportMenuOpen}
                            aria-label="Exportar"
                            title="Exportar"
                          >
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M12 3v12" />
                              <path d="M7 10l5 5 5-5" />
                              <path d="M5 21h14" />
                            </svg>
                          </button>
                          {exportMenuOpen && (
                            <div
                              role="menu"
                              className="absolute right-0 top-full z-20 mt-2 w-56 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg ring-1 ring-slate-900/5"
                            >
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => void handleExport('markdown')}
                                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 hover:text-slate-950"
                              >
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sky-50 text-sky-700">
                                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <path d="M14 2v6h6" />
                                    <path d="M8 13h8" />
                                    <path d="M8 17h5" />
                                  </svg>
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block font-medium">Markdown</span>
                                  <span className="block text-xs text-slate-500">Resumo formatado em .md</span>
                                </span>
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">.md</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => void handleExport('text')}
                                className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 hover:text-slate-950"
                              >
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-700">
                                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <path d="M14 2v6h6" />
                                    <path d="M8 12h8" />
                                    <path d="M8 16h8" />
                                    <path d="M8 20h4" />
                                  </svg>
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block font-medium">Texto simples</span>
                                  <span className="block text-xs text-slate-500">Arquivo limpo em .txt</span>
                                </span>
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">.txt</span>
                              </button>
                            </div>
                          )}
                        </div>

                        {tab === 'summary' && selected.summary && (
                          <button
                            type="button"
                            aria-label={copied ? 'Resumo copiado' : 'Copiar resumo'}
                            title={copied ? 'Resumo copiado' : 'Copiar resumo'}
                            onClick={() => {
                              void navigator.clipboard.writeText(selected.summary)
                              setCopied(true)
                              setTimeout(() => setCopied(false), 1500)
                            }}
                            className={`inline-flex h-8 w-8 items-center justify-center rounded-md border shadow-sm transition ${
                              copied
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50 hover:text-slate-950'
                            }`}
                          >
                            {copied ? (
                              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M20 6L9 17l-5-5" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <rect x="9" y="9" width="13" height="13" rx="2" />
                                <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                              </svg>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {exportMsg && (
                  <div className="mb-4 text-xs text-emerald-600">{exportMsg}</div>
                )}
              </>
            )}

            {selectedStatus === 'processing' && !isEditing && (
              <div className="py-6">
                <div className="text-sm font-medium text-slate-700 mb-6">Processando reunião…</div>
                <ProcessingTimeline
                  state={progressByMeeting[selected.id] ?? {}}
                  now={tickNow}
                />
              </div>
            )}

            {selectedStatus === 'failed' && !isEditing && (() => {
              const errors = Object.values(progressByMeeting[selected.id] ?? {})
                .map((s) => s?.error)
                .filter(Boolean) as string[]
              const failureMessage = selected.failure_reason ?? errors[errors.length - 1]
              const notReadyErr =
                [selected.failure_reason, ...errors].find(
                  (e): e is string =>
                    typeof e === 'string' &&
                    (e.includes(WHISPER_NOT_READY_MARKER) || e.includes(OLLAMA_NOT_READY_MARKER))
                ) ?? null
              const cleanErr = notReadyErr
                ?.replace(WHISPER_NOT_READY_MARKER, '')
                .replace(OLLAMA_NOT_READY_MARKER, '')
                .trim()
              return (
                <div className="py-10">
                  <div className="text-sm font-medium text-red-700">Falha no processamento</div>
                  {notReadyErr ? (
                    <>
                      <div className="text-xs text-slate-600 mt-1">{cleanErr}</div>
                      <button
                        type="button"
                        onClick={() => setShowSettings(true)}
                        className="mt-4 text-sm font-medium bg-sky-600 hover:bg-sky-500 text-white rounded-md px-4 py-2"
                      >
                        Abrir Configurações
                      </button>
                    </>
                  ) : (
                    <div className="text-xs text-slate-500 mt-1">
                      {failureMessage ?? 'Não foi possível transcrever esta gravação. Você pode excluí-la pela lista.'}
                    </div>
                  )}
                </div>
              )
            })()}

            {selectedStatus === 'ready' && !isEditing && tab === 'summary' && regenerating && (
              <div className="flex items-center gap-4 py-10">
                <div className="w-6 h-6 border-2 border-sky-200 border-t-sky-500 rounded-full animate-spin" />
                <div>
                  <div className="text-sm font-medium text-slate-700">Regenerando resumo…</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    A IA está reprocessando a transcrição.
                  </div>
                </div>
              </div>
            )}

            {selectedStatus === 'ready' && !isEditing && tab === 'summary' && !regenerating && (
              <section>
                {selectedSummaryStatus && selectedSummaryStatus !== 'complete' && (
                  <div className={`mb-5 rounded-lg border px-4 py-3 ${summaryPanelClass(selectedSummaryStatus)}`}>
                    <div className="text-sm font-medium">
                      {selectedSummaryStatus === 'skipped'
                        ? 'Resumo nao gerado automaticamente'
                        : 'Resumo nao pôde ser concluido'}
                    </div>
                    <div className="text-xs mt-1">
                      {selected.summary_error ??
                        (selectedSummaryStatus === 'skipped'
                          ? 'A transcricao foi salva normalmente. Quando o Ollama estiver pronto, voce pode gerar o resumo depois.'
                          : 'A transcricao foi salva, mas a etapa de resumo falhou.')}
                    </div>
                  </div>
                )}
                {selected.summary ? (
                  <div>
                    <div className="markdown-body">
                      <ReactMarkdown>{selected.summary}</ReactMarkdown>
                    </div>
                    {selected.raw_transcript.trim() && (
                      <div className="mt-8 pt-4 border-t border-slate-100 flex justify-end">
                        <button
                          onClick={() => void handleRegenerate()}
                          disabled={regenerating}
                          className="text-xs text-slate-500 hover:text-slate-700 disabled:opacity-50"
                        >
                          {regenerating ? 'Regenerando…' : 'Regenerar a partir da transcrição'}
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="py-12 text-center">
                    <p className="text-sm text-slate-500 mb-4">
                      {selected.raw_transcript.trim()
                        ? 'Nenhum resumo gerado ainda.'
                        : 'Sem transcrição — nada para resumir.'}
                    </p>
                    {selected.raw_transcript.trim() && (
                      <button
                        onClick={() => void handleRegenerate()}
                        disabled={regenerating}
                        className="text-sm font-medium bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-md px-4 py-2"
                      >
                        {regenerating ? 'Gerando…' : 'Gerar resumo'}
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}

            {selectedStatus === 'ready' && !isEditing && tab === 'transcript' && (
              <section>
                <div className="mb-5 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="min-w-[180px] flex-1 text-xs font-medium text-slate-600">
                      Encontrar
                      <input
                        value={findText}
                        onChange={(e) => {
                          setFindText(e.target.value)
                          setReplaceMsg(null)
                        }}
                        placeholder="Palavra ou trecho"
                        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                      />
                    </label>
                    <label className="min-w-[180px] flex-1 text-xs font-medium text-slate-600">
                      Substituir por
                      <input
                        value={replaceText}
                        onChange={(e) => {
                          setReplaceText(e.target.value)
                          setReplaceMsg(null)
                        }}
                        placeholder="Novo texto"
                        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void handleReplaceAll()}
                      disabled={!findText.trim()}
                      className="h-9 rounded-md bg-slate-900 px-3 text-xs font-medium text-white shadow-sm transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      Substituir tudo
                    </button>
                  </div>
                  {replaceMsg && (
                    <div className="mt-2 text-xs text-slate-500">{replaceMsg}</div>
                  )}
                </div>
                {selected.transcript_segments?.length ? (
                  <div className="space-y-4">
                    {selected.transcript_segments.map((segment) => (
                      <article
                        key={segment.id}
                        className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
                      >
                        <div className="flex items-start justify-between gap-4 mb-1.5">
                          <div>
                            <div className="text-[11px] font-medium text-slate-500 tabular-nums">
                              {formatTimestamp(segment.startMs)} - {formatTimestamp(segment.endMs)}
                            </div>
                            <div className="mt-1 flex items-center gap-2">
                              <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 ${segmentQualityClass(segment.quality)}`}>
                                {segmentQualityLabel(segment.quality)}
                              </span>
                              {segment.qualityReasons?.[0] && (
                                <span className="text-[10px] text-slate-500">
                                  {segment.qualityReasons[0]}
                                </span>
                              )}
                            </div>
                          </div>
                          {editingSegmentId === segment.id ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void saveSegmentEdit(segment.id)}
                                className="text-xs font-medium text-sky-700 hover:text-sky-900"
                              >
                                Salvar
                              </button>
                              <button
                                type="button"
                                onClick={() => void saveSpeakerEdit(segment.id)}
                                className="text-xs font-medium text-amber-700 hover:text-amber-900"
                              >
                                Salvar speaker
                              </button>
                              <button
                                type="button"
                                onClick={cancelSegmentEdit}
                                className="text-xs text-slate-500 hover:text-slate-800"
                              >
                                Cancelar
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => startSegmentEdit(segment.id, segment.text)}
                              className="text-xs text-slate-500 hover:text-slate-800"
                            >
                              Revisar trecho
                            </button>
                          )}
                        </div>
                        <div className="mb-2 text-xs text-slate-500">
                          Speaker: {segment.speakerLabel ?? 'Não definido'}
                        </div>
                        {editingSegmentId === segment.id ? (
                          <div className="space-y-3">
                            <input
                              value={speakerDraft}
                              onChange={(e) => setSpeakerDraft(e.target.value)}
                              placeholder="Ex.: Speaker 1, Ana, Cliente"
                              className="w-full text-sm text-slate-700 bg-white border border-slate-300 rounded-md px-3 py-2 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                            />
                            <textarea
                              value={segmentDraft}
                              onChange={(e) => setSegmentDraft(e.target.value)}
                              rows={4}
                              className="w-full text-sm text-slate-700 bg-white border border-slate-300 rounded-md p-3 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                            />
                          </div>
                        ) : (
                          <p className="text-[15px] leading-relaxed text-slate-700">
                            {segment.speakerLabel && (
                              <span className="font-semibold text-slate-900">{segment.speakerLabel}: </span>
                            )}
                            {segment.text}
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                ) : selected.raw_transcript.trim() ? (
                  <div className="space-y-4 text-[15px] leading-relaxed text-slate-700">
                    {splitTranscript(selected.raw_transcript).map((para, i) => (
                      <p key={i}>{para}</p>
                    ))}
                  </div>
                ) : (
                  <div className="py-12 text-center text-sm text-slate-500">
                    Sem transcrição disponível.
                  </div>
                )}
              </section>
            )}

            {selectedStatus === 'ready' && !isEditing && tab === 'actions' && (
              <section>
                {selected.action_items?.length > 0 ? (
                  <ul className="space-y-4">
                    {selected.action_items.map((it, i) => (
                      <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-slate-700">
                        <span className="mt-2 w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
                        <div>
                          {it.owner && <span className="font-semibold text-slate-900">{it.owner}: </span>}
                          {it.task}
                          {it.due && <span className="text-slate-500"> (até {it.due})</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="py-12 text-center text-sm text-slate-500">
                    Nenhum item de ação identificado.
                  </div>
                )}
              </section>
            )}

            {isEditing && (
              <form
                onSubmit={(e) => { e.preventDefault(); void saveEdit() }}
                className="bg-white border border-slate-200 rounded-lg shadow-sm"
              >
                <div className="px-6 py-5 border-b border-slate-100">
                  <h2 className="text-lg font-semibold text-slate-800">Editar reunião</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Ajuste o título e a transcrição. Depois você pode regenerar o resumo.
                  </p>
                </div>

                <div className="px-6 py-5 space-y-5">
                  <div>
                    <label htmlFor="edit-title" className="block text-sm font-medium text-slate-700 mb-1.5">
                      Título
                    </label>
                    <input
                      id="edit-title"
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      className="w-full text-sm bg-white border border-slate-300 rounded-md px-3 py-2 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
                    />
                  </div>

                  <div>
                    <label htmlFor="edit-transcript" className="block text-sm font-medium text-slate-700 mb-1.5">
                      Transcrição
                    </label>
                    <textarea
                      id="edit-transcript"
                      value={draftTranscript}
                      onChange={(e) => setDraftTranscript(e.target.value)}
                      rows={14}
                      className="w-full text-sm text-slate-700 bg-white border border-slate-300 rounded-md p-3 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100 font-mono"
                    />
                  </div>
                </div>

                <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 rounded-b-lg flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { clearSegmentEditing(); setIsEditing(false) }}
                    className="text-sm font-medium bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 rounded-md px-4 py-2 min-w-[96px]"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="text-sm font-medium bg-sky-600 hover:bg-sky-500 text-white rounded-md px-4 py-2 min-w-[96px]"
                  >
                    Salvar
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-slate-400">
            Selecione uma reunião para visualizar
          </div>
        )}
      </main>

    </div>
  )
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): ReactElement {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
        active
          ? 'bg-white text-slate-900 shadow-sm'
          : 'text-slate-500 hover:text-slate-800'
      }`}
    >
      {children}
    </button>
  )
}

function formatHeaderDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'short'
  })
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return s === 0 ? `${m}min` : `${m}min ${s}s`
}

function splitTranscript(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (/\n\s*\n/.test(trimmed)) {
    return trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  }
  const sentences = trimmed.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [trimmed]
  const chunks: string[] = []
  const size = 3
  for (let i = 0; i < sentences.length; i += size) {
    chunks.push(sentences.slice(i, i + size).join(' ').trim())
  }
  return chunks
}

function replaceAllLiteral(text: string, find: string, replacement: string): { text: string; count: number } {
  if (!find) return { text, count: 0 }
  let count = 0
  const re = new RegExp(escapeRegExp(find), 'gi')
  const next = text.replace(re, () => {
    count++
    return replacement
  })
  return { text: next, count }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rebuildTranscriptFromSegments(segments: NonNullable<Meeting['transcript_segments']>): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

function formatCaptureSource(source: NonNullable<Meeting['capture_source']>): string {
  switch (source) {
    case 'system':
      return 'audio do sistema'
    case 'microphone':
      return 'microfone'
    case 'mixed':
      return 'sistema + microfone'
  }
}

function summaryBadgeClass(status: 'skipped' | 'failed'): string {
  return status === 'skipped'
    ? 'bg-sky-100 text-sky-700'
    : 'bg-amber-100 text-amber-800'
}

function summaryPanelClass(status: 'skipped' | 'failed'): string {
  return status === 'skipped'
    ? 'border-sky-200 bg-sky-50 text-sky-900'
    : 'border-amber-200 bg-amber-50 text-amber-900'
}

function segmentQualityLabel(quality: SegmentQuality): string {
  switch (quality) {
    case 'low':
      return 'Revisar'
    case 'medium':
      return 'Atenção'
    default:
      return 'Bom'
  }
}

function segmentQualityClass(quality: SegmentQuality): string {
  switch (quality) {
    case 'low':
      return 'bg-red-100 text-red-700'
    case 'medium':
      return 'bg-amber-100 text-amber-800'
    default:
      return 'bg-emerald-100 text-emerald-700'
  }
}
