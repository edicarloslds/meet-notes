import { useEffect, useState, type ReactElement } from 'react'
import type {
  ModelDownloadProgress,
  WhisperModelInfo,
  WhisperModelStatus
} from '../../../shared/types'

interface Props {
  selectedPath?: string
  onSelect: (path: string | undefined) => void
  onChanged?: () => void
}

interface RowState {
  info: WhisperModelInfo
  status: WhisperModelStatus
  progress?: ModelDownloadProgress
}

export function WhisperModelManager({ selectedPath, onSelect, onChanged }: Props): ReactElement {
  const [rows, setRows] = useState<RowState[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = async (): Promise<void> => {
    const [models, statuses] = await Promise.all([
      window.meetnotes.listWhisperModels(),
      window.meetnotes.getModelStatus()
    ])
    const byId = new Map(statuses.map((s) => [s.id, s]))
    setRows((prev) => {
      const prevById = new Map(prev.map((r) => [r.info.id, r]))
      return models.map((info) => ({
        info,
        status: byId.get(info.id) ?? { id: info.id, installed: false },
        progress: prevById.get(info.id)?.progress
      }))
    })
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
    const off = window.meetnotes.onModelProgress((p) => {
      setRows((prev) =>
        prev.map((r) => (r.info.id === p.id ? { ...r, progress: p } : r))
      )
      if (p.done) {
        void refresh()
        onChanged?.()
      }
    })
    return off
  }, [])

  const handleDownload = async (id: string): Promise<void> => {
    setRows((prev) =>
      prev.map((r) =>
        r.info.id === id
          ? { ...r, progress: { id, receivedBytes: 0, totalBytes: 0, done: false } }
          : r
      )
    )
    try {
      await window.meetnotes.downloadModel(id)
    } catch (err) {
      setRows((prev) =>
        prev.map((r) =>
          r.info.id === id
            ? {
                ...r,
                progress: {
                  id,
                  receivedBytes: 0,
                  totalBytes: 0,
                  done: true,
                  error: err instanceof Error ? err.message : 'Falha no download'
                }
              }
            : r
        )
      )
    }
  }

  const handleCancel = async (id: string): Promise<void> => {
    await window.meetnotes.cancelModelDownload(id)
  }

  const handleDelete = async (id: string, path?: string): Promise<void> => {
    await window.meetnotes.deleteModel(id)
    if (path && path === selectedPath) onSelect(undefined)
    await refresh()
    onChanged?.()
  }

  if (loading) {
    return <div className="text-xs text-slate-500">Carregando modelos…</div>
  }

  return (
    <div className="space-y-2">
      {rows.map(({ info, status, progress }) => {
        const isActive = !!progress && !progress.done
        const isSelected = status.installed && status.path === selectedPath
        const pct =
          progress && progress.totalBytes > 0
            ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
            : 0

        return (
          <div
            key={info.id}
            className={`border rounded-md p-3 ${
              isSelected ? 'border-sky-400 bg-sky-50' : 'border-slate-200 bg-white'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800">
                  {info.label}{' '}
                  <span className="text-xs font-normal text-slate-500">
                    · ~{info.sizeMb} MB
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5">{info.description}</div>
              </div>

              <div className="shrink-0 flex items-center gap-2">
                {status.installed && !isActive && (
                  <>
                    {!isSelected && (
                      <button
                        type="button"
                        onClick={() => status.path && onSelect(status.path)}
                        className="text-xs font-medium text-sky-700 hover:text-sky-800 px-2 py-1"
                      >
                        Usar
                      </button>
                    )}
                    {isSelected && (
                      <span className="text-xs font-medium text-sky-700 bg-sky-100 rounded px-2 py-1">
                        Em uso
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleDelete(info.id, status.path)}
                      className="text-xs text-slate-500 hover:text-red-600 px-2 py-1"
                    >
                      Remover
                    </button>
                  </>
                )}
                {!status.installed && !isActive && (
                  <button
                    type="button"
                    onClick={() => void handleDownload(info.id)}
                    className="text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white rounded-md px-3 py-1.5"
                  >
                    Baixar
                  </button>
                )}
                {isActive && (
                  <button
                    type="button"
                    onClick={() => void handleCancel(info.id)}
                    className="text-xs text-slate-500 hover:text-red-600 px-2 py-1"
                  >
                    Cancelar
                  </button>
                )}
              </div>
            </div>

            {isActive && (
              <div className="mt-2">
                <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-sky-500 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="text-[11px] text-slate-500 mt-1">
                  {progress?.totalBytes
                    ? `${formatMb(progress.receivedBytes)} / ${formatMb(progress.totalBytes)} (${pct}%)`
                    : 'iniciando…'}
                </div>
              </div>
            )}

            {progress?.error && (
              <div className="mt-2 text-[11px] text-red-600">Erro: {progress.error}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
