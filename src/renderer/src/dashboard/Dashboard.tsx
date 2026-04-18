import { useEffect, useMemo, useState, type ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Meeting } from '../../../shared/types'

export function Dashboard(): ReactElement {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftTranscript, setDraftTranscript] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; meeting: Meeting } | null>(null)
  const [tab, setTab] = useState<'summary' | 'transcript' | 'actions'>('summary')
  const [copied, setCopied] = useState(false)

  const refresh = async (): Promise<void> => {
    const list = await window.meetnotes.listMeetings()
    setMeetings(list)
    setSelectedId((cur) => cur ?? (list[0]?.id ?? null))
  }

  useEffect(() => {
    void refresh()
    const handleOnline = async (): Promise<void> => {
      const res = await window.meetnotes.syncPending()
      if (res.synced > 0) {
        setSyncMsg(`${res.synced} reunião(ões) sincronizada(s)`)
        void refresh()
        setTimeout(() => setSyncMsg(null), 4000)
      }
    }
    window.addEventListener('online', handleOnline)
    const closeCtx = (): void => setCtxMenu(null)
    window.addEventListener('click', closeCtx)
    window.addEventListener('scroll', closeCtx, true)
    const offEnded = window.meetnotes.onMeetingEnded(() => void refresh())
    const offDetected = window.meetnotes.onMeetingDetected(() => void refresh())
    const interval = window.setInterval(() => void refresh(), 5000)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('click', closeCtx)
      window.removeEventListener('scroll', closeCtx, true)
      offEnded()
      offDetected()
      window.clearInterval(interval)
    }
  }, [])

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

  const startEdit = (m: Meeting): void => {
    setSelectedId(m.id)
    setDraftTitle(m.title)
    setDraftTranscript(m.raw_transcript)
    setIsEditing(true)
  }

  const saveEdit = async (): Promise<void> => {
    if (!selected) return
    await window.meetnotes.saveMeeting({
      ...selected,
      title: draftTitle.trim() || selected.title,
      raw_transcript: draftTranscript
    })
    setIsEditing(false)
    await refresh()
  }

  const deleteById = async (m: Meeting): Promise<void> => {
    if (!window.confirm(`Excluir "${m.title}"?`)) return
    await window.meetnotes.deleteMeeting(m.id)
    if (selectedId === m.id) {
      setSelectedId(null)
      setIsEditing(false)
    }
    await refresh()
  }

  const handleRegenerate = async (): Promise<void> => {
    if (!selected || !selected.raw_transcript.trim()) return
    setRegenerating(true)
    const startedAt = Date.now()
    try {
      const { summary, actionItems } = await window.meetnotes.regenerateSummary(
        selected.raw_transcript
      )
      await window.meetnotes.saveMeeting({
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

  return (
    <div className="h-full w-full flex text-slate-800">
      <aside className="w-[340px] shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div
          className="px-4 pb-4 pt-10 border-b border-slate-200"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <h1 className="text-lg font-semibold">MeetNotes</h1>
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
            return (
              <div
                key={m.id}
                role="button"
                tabIndex={0}
                onClick={() => { setSelectedId(m.id); setIsEditing(false); setTab('summary') }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setSelectedId(m.id)
                  setCtxMenu({ x: e.clientX, y: e.clientY, meeting: m })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    setSelectedId(m.id); setIsEditing(false); setTab('summary')
                  }
                }}
                className={`relative w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-slate-50 transition cursor-pointer ${
                  selectedId === m.id ? 'bg-sky-50' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate flex-1">{m.title}</span>
                  {(status === 'processing' || (regenerating && selectedId === m.id)) && (
                    <span className="shrink-0 text-[10px] text-sky-700 bg-sky-100 rounded px-1.5 py-0.5 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
                      {regenerating && selectedId === m.id ? 'regenerando' : 'processando'}
                    </span>
                  )}
                  {status === 'failed' && (
                    <span className="shrink-0 text-[10px] text-red-700 bg-red-100 rounded px-1.5 py-0.5">
                      falhou
                    </span>
                  )}
                  {status === 'ready' && m.synced === false && (
                    <span className="shrink-0 text-[10px] text-amber-600 bg-amber-50 rounded px-1.5 py-0.5">
                      offline
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {new Date(m.created_at).toLocaleString()}
                </div>
              </div>
            )
          })}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        {selected ? (
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
                </header>

                {selectedStatus === 'ready' && (
                  <div className="flex items-center justify-between mb-8">
                    <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-xl">
                      <TabButton active={tab === 'summary'} onClick={() => setTab('summary')}>
                        Resumo
                      </TabButton>
                      <TabButton active={tab === 'transcript'} onClick={() => setTab('transcript')}>
                        Transcrição
                      </TabButton>
                      <TabButton active={tab === 'actions'} onClick={() => setTab('actions')}>
                        Itens de Ação
                      </TabButton>
                    </div>
                    {tab === 'summary' && selected.summary && (
                      <button
                        onClick={() => {
                          void navigator.clipboard.writeText(selected.summary)
                          setCopied(true)
                          setTimeout(() => setCopied(false), 1500)
                        }}
                        className={`inline-flex items-center justify-center gap-1.5 text-sm transition-colors w-[140px] ${
                          copied ? 'text-emerald-600' : 'text-slate-500 hover:text-slate-900'
                        }`}
                      >
                        {copied ? (
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                          </svg>
                        )}
                        <span>{copied ? 'Copiado!' : 'Copiar resumo'}</span>
                      </button>
                    )}
                  </div>
                )}
              </>
            )}

            {selectedStatus === 'processing' && !isEditing && (
              <div className="flex items-center gap-4 py-10">
                <div className="w-6 h-6 border-2 border-sky-200 border-t-sky-500 rounded-full animate-spin" />
                <div>
                  <div className="text-sm font-medium text-slate-700">Processando transcrição…</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    O resumo ficará disponível assim que a IA terminar.
                  </div>
                </div>
              </div>
            )}

            {selectedStatus === 'failed' && !isEditing && (
              <div className="py-10">
                <div className="text-sm font-medium text-red-700">Falha no processamento</div>
                <div className="text-xs text-slate-500 mt-1">
                  Não foi possível transcrever esta gravação. Você pode excluí-la pela lista.
                </div>
              </div>
            )}

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
                {selected.raw_transcript.trim() ? (
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
                    onClick={() => setIsEditing(false)}
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

      {ctxMenu && (ctxMenu.meeting.status ?? 'ready') !== 'processing' && (
        <div
          className="fixed z-50 min-w-[160px] bg-white border border-slate-200 rounded-lg shadow-xl py-1 text-sm"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => { startEdit(ctxMenu.meeting); setCtxMenu(null) }}
            className="w-full text-left px-3 py-1.5 hover:bg-slate-100 text-slate-700"
          >
            Editar
          </button>
          <button
            onClick={() => { void deleteById(ctxMenu.meeting); setCtxMenu(null) }}
            className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600"
          >
            Excluir
          </button>
        </div>
      )}
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
