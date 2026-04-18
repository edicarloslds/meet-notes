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

  const refresh = async (): Promise<void> => {
    const list = await window.meetnotes.listMeetings()
    setMeetings(list)
    if (!selectedId && list.length > 0) setSelectedId(list[0].id)
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
    try {
      const { summary, actionItems } = await window.meetnotes.regenerateSummary(
        selected.raw_transcript
      )
      await window.meetnotes.saveMeeting({
        ...selected,
        summary,
        action_items: actionItems,
        status: 'ready'
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
            const preview =
              status === 'processing'
                ? 'Processando transcrição…'
                : status === 'failed'
                  ? 'Falha ao processar'
                  : m.summary.replace(/[#*_`]/g, '').slice(0, 120)
            return (
              <div
                key={m.id}
                role="button"
                tabIndex={0}
                onClick={() => { setSelectedId(m.id); setIsEditing(false) }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setSelectedId(m.id)
                  setCtxMenu({ x: e.clientX, y: e.clientY, meeting: m })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    setSelectedId(m.id); setIsEditing(false)
                  }
                }}
                className={`relative w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-slate-50 transition cursor-pointer ${
                  selectedId === m.id ? 'bg-sky-50' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium truncate flex-1">{m.title}</span>
                  {status === 'processing' && (
                    <span className="shrink-0 text-[10px] text-sky-700 bg-sky-100 rounded px-1.5 py-0.5 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
                      processando
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
                <div className="text-xs text-slate-600 mt-1 line-clamp-2">{preview}</div>
              </div>
            )
          })}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        {selected ? (
          <div className="max-w-3xl mx-auto p-8">
            {!isEditing && (
              <header className="mb-6">
                <h2 className="text-2xl font-semibold">{selected.title}</h2>
                <div className="text-sm text-slate-500 mt-1">
                  {new Date(selected.created_at).toLocaleString()}
                </div>
              </header>
            )}

            {selectedStatus === 'processing' && !isEditing && (
              <section className="bg-white border border-sky-200 rounded-lg p-8 flex items-center gap-4">
                <div className="w-6 h-6 border-2 border-sky-200 border-t-sky-500 rounded-full animate-spin" />
                <div>
                  <div className="text-sm font-medium text-slate-700">Processando transcrição…</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    O resumo ficará disponível assim que a IA terminar.
                  </div>
                </div>
              </section>
            )}

            {selectedStatus === 'failed' && !isEditing && (
              <section className="bg-white border border-red-200 rounded-lg p-6">
                <div className="text-sm font-medium text-red-700">Falha no processamento</div>
                <div className="text-xs text-slate-500 mt-1">
                  Não foi possível transcrever esta gravação. Você pode excluí-la pela lista.
                </div>
              </section>
            )}

            {selectedStatus === 'ready' && !isEditing && (
              <>
                {selected.action_items?.length > 0 && (
                  <section className="mb-6 bg-white border border-slate-200 rounded-lg p-4">
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 mb-2">
                      Action Items
                    </h3>
                    <ul className="space-y-1">
                      {selected.action_items.map((it, i) => (
                        <li key={i} className="text-sm">
                          <span className="font-medium">{it.owner ?? '—'}:</span> {it.task}
                          {it.due && <span className="text-slate-500"> (até {it.due})</span>}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <section className="bg-white border border-slate-200 rounded-lg p-6">
                  {selected.summary ? (
                    <div className="prose prose-slate max-w-none">
                      <ReactMarkdown>{selected.summary}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-sm text-slate-500">
                        {selected.raw_transcript.trim()
                          ? 'Nenhum resumo gerado ainda.'
                          : 'Sem transcrição — nada para resumir.'}
                      </p>
                      {selected.raw_transcript.trim() && (
                        <button
                          onClick={() => void handleRegenerate()}
                          disabled={regenerating}
                          className="shrink-0 text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-md px-3 py-1.5"
                        >
                          {regenerating ? 'Gerando…' : 'Gerar resumo'}
                        </button>
                      )}
                    </div>
                  )}
                  {selected.summary && selected.raw_transcript.trim() && (
                    <div className="mt-4 pt-4 border-t border-slate-100 flex justify-end">
                      <button
                        onClick={() => void handleRegenerate()}
                        disabled={regenerating}
                        className="text-xs text-slate-500 hover:text-slate-700 disabled:opacity-50"
                      >
                        {regenerating ? 'Regenerando…' : 'Regenerar a partir da transcrição'}
                      </button>
                    </div>
                  )}
                </section>

                {selected.raw_transcript && (
                  <details className="mt-6 bg-white border border-slate-200 rounded-lg p-4">
                    <summary className="cursor-pointer text-sm font-medium text-slate-600">
                      Transcrição bruta
                    </summary>
                    <pre className="mt-3 whitespace-pre-wrap text-xs text-slate-700">
                      {selected.raw_transcript}
                    </pre>
                  </details>
                )}
              </>
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

      {ctxMenu && (
        <div
          className="fixed z-50 min-w-[160px] bg-white border border-slate-200 rounded-md shadow-lg py-1 text-sm"
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
