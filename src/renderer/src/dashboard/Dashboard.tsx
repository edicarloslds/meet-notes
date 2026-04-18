import { useEffect, useMemo, useState, type ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Meeting } from '../../../shared/types'

export function Dashboard(): ReactElement {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

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
    const off = window.meetnotes.onMeetingEnded(() => void refresh())
    return () => {
      window.removeEventListener('online', handleOnline)
      off()
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
              Nenhuma reunião ainda. Abra o Teams e inicie uma reunião para começar.
            </div>
          )}
          {filtered.map((m) => (
            <button
              key={m.id}
              onClick={() => setSelectedId(m.id)}
              className={`w-full text-left px-4 py-3 border-b border-slate-100 hover:bg-slate-50 transition ${
                selectedId === m.id ? 'bg-sky-50' : ''
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium truncate">{m.title}</span>
                {m.synced === false && (
                  <span className="text-[10px] text-amber-600 bg-amber-50 rounded px-1.5 py-0.5">
                    offline
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {new Date(m.created_at).toLocaleString()}
              </div>
              <div className="text-xs text-slate-600 mt-1 line-clamp-2">
                {m.summary.replace(/[#*_`]/g, '').slice(0, 120)}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        {selected ? (
          <div className="max-w-3xl mx-auto p-8">
            <header className="mb-6">
              <h2 className="text-2xl font-semibold">{selected.title}</h2>
              <div className="text-sm text-slate-500 mt-1">
                {new Date(selected.created_at).toLocaleString()}
              </div>
            </header>

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

            <section className="prose prose-slate max-w-none bg-white border border-slate-200 rounded-lg p-6">
              <ReactMarkdown>{selected.summary || '_Sem resumo._'}</ReactMarkdown>
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
