import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { AppSettings, OllamaStatus, WhisperStatus } from '../../../shared/types'
import { WhisperModelManager } from './WhisperModelManager'

const inputClass =
  'mt-1.5 w-full text-sm bg-white border border-slate-300 rounded-md px-3 py-2 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100 font-mono'

export function SettingsPanel({ onClose }: { onClose: () => void }): ReactElement {
  const [values, setValues] = useState<AppSettings>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [whisperStatus, setWhisperStatus] = useState<WhisperStatus | null>(null)
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null)
  const [rechecking, setRechecking] = useState(false)

  const refreshStatuses = useCallback(async (): Promise<void> => {
    setRechecking(true)
    try {
      const [w, o] = await Promise.all([
        window.distill.getWhisperStatus(),
        window.distill.getOllamaStatus()
      ])
      setWhisperStatus(w)
      setOllamaStatus(o)
    } finally {
      setRechecking(false)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const current = await window.distill.getSettings()
      setValues(current)
      await refreshStatuses()
      setLoading(false)
    })()
  }, [refreshStatuses])

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const saved = await window.distill.saveSettings(values)
      setValues(saved)
      setSavedMsg('Configurações salvas')
      setTimeout(() => setSavedMsg(null), 2500)
      await refreshStatuses()
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

      <div className="space-y-4">
        <WhisperStatusCard status={whisperStatus} />
        <OllamaStatusCard
          status={ollamaStatus}
          rechecking={rechecking}
          onRecheck={() => void refreshStatuses()}
        />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void handleSave()
        }}
        className="mt-4 space-y-4"
      >
        <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
          <header className="px-6 py-4 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-800">Whisper (transcrição)</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Engine local que converte o áudio em texto.
            </p>
          </header>
          <div className="divide-y divide-slate-100">
            <div className="px-6 py-4">
              <label htmlFor="setting-whisperLanguage" className="block text-sm font-medium text-slate-700">
                Idioma
              </label>
              <input
                id="setting-whisperLanguage"
                type="text"
                value={values.whisperLanguage ?? ''}
                onChange={(e) => update('whisperLanguage', e.target.value)}
                placeholder="pt"
                autoComplete="off"
                spellCheck={false}
                className={inputClass}
              />
              <p className="text-xs text-slate-500 mt-1.5">
                Código ISO de 2 letras (ex.: pt, en, es). Use <code className="font-mono bg-slate-100 px-1 rounded">auto</code> para detectar.
              </p>
            </div>
            <div className="px-6 py-4">
              <div className="text-sm font-medium text-slate-700">Modelos</div>
              <p className="text-xs text-slate-500 mt-0.5 mb-3">
                Baixe um modelo para transcrever áudio localmente. O download fica salvo no app.
              </p>
              <WhisperModelManager
                selectedPath={values.whisperModel}
                onSelect={(p) => {
                  update('whisperModel', p)
                  void refreshStatuses()
                }}
                onChanged={() => void refreshStatuses()}
              />
            </div>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
          <header className="px-6 py-4 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-800">Ollama (resumo)</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Servidor que gera o resumo e os itens de ação a partir da transcrição.
            </p>
          </header>
          <div className="divide-y divide-slate-100">
            <div className="px-6 py-4">
              <label htmlFor="setting-ollamaHost" className="block text-sm font-medium text-slate-700">
                Host
              </label>
              <input
                id="setting-ollamaHost"
                type="text"
                value={values.ollamaHost ?? ''}
                onChange={(e) => update('ollamaHost', e.target.value)}
                placeholder="http://127.0.0.1:11434"
                autoComplete="off"
                spellCheck={false}
                className={inputClass}
              />
              <p className="text-xs text-slate-500 mt-1.5">URL do servidor Ollama.</p>
            </div>
            <div className="px-6 py-4">
              <label htmlFor="setting-ollamaModel" className="block text-sm font-medium text-slate-700">
                Modelo
              </label>
              <OllamaModelField
                status={ollamaStatus}
                value={values.ollamaModel}
                onChange={(v) => update('ollamaModel', v)}
              />
              <p className="text-xs text-slate-500 mt-1.5">
                {ollamaStatus?.reachable
                  ? 'Lista carregada do servidor Ollama. Para adicionar outros, rode `ollama pull <modelo>`.'
                  : 'Ollama indisponível — digite o nome do modelo manualmente.'}
              </p>
            </div>
          </div>
        </section>

        <div className="bg-slate-50 border border-slate-200 rounded-lg px-6 py-4 flex items-center justify-end gap-3">
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

function OllamaModelField({
  status,
  value,
  onChange
}: {
  status: OllamaStatus | null
  value?: string
  onChange: (v: string | undefined) => void
}): ReactElement {
  if (!status?.reachable || status.models.length === 0) {
    return (
      <input
        id="setting-ollamaModel"
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder="gemma4:e2b"
        autoComplete="off"
        spellCheck={false}
        className={inputClass}
      />
    )
  }

  return (
    <div className="relative mt-1.5">
      <select
        id="setting-ollamaModel"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="appearance-none w-full text-sm bg-white border border-slate-300 rounded-md pl-3 pr-10 py-2 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100 font-mono"
      >
        <option value="">Padrão (gemma4:e2b)</option>
        {status.models.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        {value && !status.models.includes(value) && (
          <option value={value}>{value} (não instalado)</option>
        )}
      </select>
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
  )
}

function OllamaStatusCard({
  status,
  rechecking,
  onRecheck
}: {
  status: OllamaStatus | null
  rechecking: boolean
  onRecheck: () => void
}): ReactElement | null {
  const [justChecked, setJustChecked] = useState(false)
  const prevRechecking = useRef(false)
  useEffect(() => {
    if (prevRechecking.current && !rechecking) {
      setJustChecked(true)
      const t = setTimeout(() => setJustChecked(false), 1500)
      return () => clearTimeout(t)
    }
    prevRechecking.current = rechecking
    return undefined
  }, [rechecking])

  if (!status) return null
  const ready = status.reachable && status.selectedModelInstalled

  return (
    <section
      className={`border rounded-lg p-5 ${
        ready ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/60'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Status do Ollama</div>
          <div className={`text-sm font-semibold ${ready ? 'text-emerald-700' : 'text-amber-800'}`}>
            {ready ? 'Pronto para resumir' : 'Configuração incompleta'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRecheck}
            disabled={rechecking}
            className="text-xs text-slate-600 hover:text-slate-900 bg-white border border-slate-300 rounded-md px-2 py-1 disabled:opacity-60 inline-flex items-center gap-1.5"
            title="Verificar novamente"
          >
            {rechecking && (
              <span className="w-3 h-3 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
            )}
            {rechecking ? 'Verificando…' : justChecked ? 'Atualizado' : 'Verificar'}
          </button>
          <span
            className={`text-[11px] font-medium rounded-full px-2 py-0.5 ${
              ready ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'
            }`}
          >
            {ready ? 'OK' : 'Ação necessária'}
          </span>
        </div>
      </div>

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex items-start gap-3">
          <dt className="w-28 shrink-0 text-xs uppercase tracking-wider text-slate-500 pt-0.5">Servidor</dt>
          <dd className="flex-1 min-w-0">
            <div className="font-mono text-[12px] text-slate-700 truncate">{status.host}</div>
            {status.reachable ? (
              <div className="text-[11px] text-slate-500 mt-0.5">
                Conectado{status.version ? ` · versão ${status.version}` : ''}
              </div>
            ) : (
              <div className="text-[12px] text-amber-800 mt-0.5">
                {status.error ?? 'Não foi possível conectar.'}{' '}
                <span className="text-slate-600">
                  Inicie o Ollama (<code className="font-mono bg-white px-1 py-0.5 rounded">ollama serve</code>).
                </span>
              </div>
            )}
          </dd>
        </div>

        <div className="flex items-start gap-3">
          <dt className="w-28 shrink-0 text-xs uppercase tracking-wider text-slate-500 pt-0.5">Modelo</dt>
          <dd className="flex-1 min-w-0">
            <div className="text-sm font-medium text-slate-800 font-mono">{status.selectedModel}</div>
            {status.reachable && !status.selectedModelInstalled && (
              <div className="text-[12px] text-amber-800 mt-0.5">
                Não instalado. Rode{' '}
                <code className="font-mono bg-white px-1 py-0.5 rounded">ollama pull {status.selectedModel}</code>.
              </div>
            )}
            {status.reachable && status.models.length > 0 && (
              <div className="text-[11px] text-slate-500 mt-1">
                Instalados: {status.models.join(', ')}
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
