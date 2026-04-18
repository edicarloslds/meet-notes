import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { AppSettings, WhisperStatus } from '../../../shared/types'
import { WhisperModelManager } from './WhisperModelManager'

interface FieldDef {
  key: keyof AppSettings
  label: string
  placeholder: string
  help?: string
}

const FIELDS: FieldDef[] = [
  {
    key: 'ollamaHost',
    label: 'Ollama Host',
    placeholder: 'http://127.0.0.1:11434',
    help: 'URL do servidor Ollama.'
  },
  {
    key: 'ollamaModel',
    label: 'Ollama Model',
    placeholder: 'gemma4:e2b',
    help: 'Modelo usado para gerar o resumo.'
  },
  {
    key: 'whisperLanguage',
    label: 'Idioma do Whisper',
    placeholder: 'pt'
  }
]

export function SettingsPanel({ onClose }: { onClose: () => void }): ReactElement {
  const [values, setValues] = useState<AppSettings>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [whisperStatus, setWhisperStatus] = useState<WhisperStatus | null>(null)

  const refreshWhisperStatus = useCallback(async (): Promise<void> => {
    const s = await window.meetnotes.getWhisperStatus()
    setWhisperStatus(s)
  }, [])

  useEffect(() => {
    void (async () => {
      const current = await window.meetnotes.getSettings()
      setValues(current)
      await refreshWhisperStatus()
      setLoading(false)
    })()
  }, [refreshWhisperStatus])

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const saved = await window.meetnotes.saveSettings(values)
      setValues(saved)
      setSavedMsg('Configurações salvas')
      setTimeout(() => setSavedMsg(null), 2500)
      await refreshWhisperStatus()
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-10 py-10">
        <div className="text-sm text-slate-500">Carregando configurações…</div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-10 py-10">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Preferências</div>
          <h2 className="text-3xl font-bold text-slate-900 tracking-tight">Configurações</h2>
          <p className="text-sm text-slate-500 mt-2">
            Ajuste os modelos usados para transcrição e resumo.
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-sm text-slate-500 hover:text-slate-800"
          aria-label="Fechar"
        >
          Fechar
        </button>
      </header>

      <WhisperStatusCard status={whisperStatus} />

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void handleSave()
        }}
        className="bg-white border border-slate-200 rounded-lg shadow-sm divide-y divide-slate-100 mt-6"
      >
        {FIELDS.map((field) => (
          <div key={field.key} className="px-6 py-4">
            <label
              htmlFor={`setting-${field.key}`}
              className="block text-sm font-medium text-slate-700"
            >
              {field.label}
            </label>
            <input
              id={`setting-${field.key}`}
              type="text"
              value={values[field.key] ?? ''}
              onChange={(e) => update(field.key, e.target.value)}
              placeholder={field.placeholder}
              autoComplete="off"
              spellCheck={false}
              className="mt-1.5 w-full text-sm bg-white border border-slate-300 rounded-md px-3 py-2 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100 font-mono"
            />
            {field.help && (
              <p className="text-xs text-slate-500 mt-1.5">{field.help}</p>
            )}
          </div>
        ))}

        <div className="px-6 py-4">
          <div className="text-sm font-medium text-slate-700">Modelos do Whisper</div>
          <p className="text-xs text-slate-500 mt-0.5 mb-3">
            Baixe um modelo para transcrever áudio localmente. O download fica salvo no app.
          </p>
          <WhisperModelManager
            selectedPath={values.whisperModel}
            onSelect={(p) => {
              update('whisperModel', p)
              void refreshWhisperStatus()
            }}
            onChanged={() => void refreshWhisperStatus()}
          />
        </div>

        <div className="px-6 py-4 bg-slate-50 rounded-b-lg flex items-center justify-end gap-3">
          {savedMsg && <span className="text-xs text-emerald-600">{savedMsg}</span>}
          <button
            type="button"
            onClick={onClose}
            className="text-sm font-medium bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 rounded-md px-4 py-2 min-w-[96px]"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving}
            className="text-sm font-medium bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-md px-4 py-2 min-w-[96px]"
          >
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </form>
    </div>
  )
}

function WhisperStatusCard({
  status
}: {
  status: WhisperStatus | null
}): ReactElement | null {
  if (!status) return null
  const ready = status.binAvailable && !!status.model

  return (
    <section
      className={`border rounded-lg p-5 ${
        ready ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/60'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Status do Whisper</div>
          <div className={`text-sm font-semibold ${ready ? 'text-emerald-700' : 'text-amber-800'}`}>
            {ready ? 'Pronto para transcrever' : 'Configuração incompleta'}
          </div>
        </div>
        <span
          className={`text-[11px] font-medium rounded-full px-2 py-0.5 ${
            ready ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'
          }`}
        >
          {ready ? 'OK' : 'Ação necessária'}
        </span>
      </div>

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex items-start gap-3">
          <dt className="w-28 shrink-0 text-xs uppercase tracking-wider text-slate-500 pt-0.5">Binário</dt>
          <dd className="flex-1 min-w-0">
            {status.binAvailable ? (
              <>
                <div className="font-mono text-[12px] text-slate-700 truncate">
                  {status.binPath ?? 'whisper-cli'}
                </div>
                {status.binVersion && (
                  <div className="text-[11px] text-slate-500 mt-0.5">Versão: {status.binVersion}</div>
                )}
              </>
            ) : (
              <div className="text-[12px] text-amber-800">
                {status.binError ?? 'whisper-cli não encontrado.'}{' '}
                <span className="text-slate-600">
                  Instale com <code className="font-mono bg-white px-1 py-0.5 rounded">brew install whisper-cpp</code>.
                </span>
              </div>
            )}
          </dd>
        </div>

        <div className="flex items-start gap-3">
          <dt className="w-28 shrink-0 text-xs uppercase tracking-wider text-slate-500 pt-0.5">Modelo</dt>
          <dd className="flex-1 min-w-0">
            {status.model ? (
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800">
                  {status.model.label ?? status.model.filename}
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    {formatMb(status.model.sizeBytes)}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-slate-500 truncate mt-0.5">
                  {status.model.path}
                </div>
              </div>
            ) : (
              <div className="text-[12px] text-amber-800">
                Nenhum modelo selecionado. Baixe um abaixo.
              </div>
            )}
          </dd>
        </div>
      </dl>
    </section>
  )
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}
