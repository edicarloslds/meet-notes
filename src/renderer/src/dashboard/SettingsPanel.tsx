import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type SelectHTMLAttributes
} from 'react'
import type {
  AppSettings,
  LiveTranslationProvider,
  OllamaStatus,
  WhisperStatus
} from '../../../shared/types'
import { WhisperModelManager } from './WhisperModelManager'

const inputClass =
  'mt-1.5 w-full text-sm bg-white border border-slate-300 rounded-md px-3 py-2 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100 font-mono'

const selectClass =
  'appearance-none w-full text-sm bg-white border border-slate-300 rounded-md pl-3 pr-10 py-2 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100 font-mono'

type TabId = 'meetings' | 'live' | 'general'

const TABS: ReadonlyArray<{ id: TabId; label: string; description: string }> = [
  {
    id: 'meetings',
    label: 'Reuniões',
    description: 'Captura, transcrição (Whisper) e resumo (Ollama).'
  },
  {
    id: 'live',
    label: 'Tradução ao vivo',
    description: 'Provider e endpoints das legendas traduzidas.'
  },
  {
    id: 'general',
    label: 'Geral',
    description: 'Armazenamento e demais preferências.'
  }
]

function SelectField({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): ReactElement {
  return (
    <div className="relative mt-1.5">
      <select {...props} className={className ?? selectClass}>
        {children}
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

export function SettingsPanel({ onClose }: { onClose: () => void }): ReactElement {
  const [values, setValues] = useState<AppSettings>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [whisperStatus, setWhisperStatus] = useState<WhisperStatus | null>(null)
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('meetings')

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
      <div className="max-w-3xl mx-auto px-10 py-10">
        <div className="text-sm text-slate-500">Carregando configurações…</div>
      </div>
    )
  }

  const provider: LiveTranslationProvider = values.liveTranslationProvider ?? 'libretranslate'
  const activeTabMeta = TABS.find((t) => t.id === activeTab) ?? TABS[0]

  return (
    <div className="max-w-3xl mx-auto px-10 py-10">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Preferências</div>
          <h2 className="text-3xl font-bold text-slate-900 tracking-tight">Configurações</h2>
          <p className="text-sm text-slate-500 mt-2">
            Ajuste a captura de áudio e os modelos usados para transcrição e resumo.
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

      <div role="tablist" aria-label="Configurações" className="border-b border-slate-200 flex gap-1">
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-sky-600 text-sky-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-slate-500 mt-3">{activeTabMeta.description}</p>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void handleSave()
        }}
        className="mt-5 space-y-4"
      >
        {activeTab === 'meetings' && (
          <MeetingsTab
            values={values}
            update={update}
            whisperStatus={whisperStatus}
            ollamaStatus={ollamaStatus}
            rechecking={rechecking}
            onRecheck={() => void refreshStatuses()}
            onWhisperChanged={() => void refreshStatuses()}
          />
        )}

        {activeTab === 'live' && (
          <LiveTab values={values} update={update} provider={provider} />
        )}

        {activeTab === 'general' && <GeneralTab values={values} update={update} />}

        <div className="bg-slate-50 border border-slate-200 rounded-lg px-6 py-4 flex items-center justify-end gap-3 sticky bottom-0">
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

function MeetingsTab({
  values,
  update,
  whisperStatus,
  ollamaStatus,
  rechecking,
  onRecheck,
  onWhisperChanged
}: {
  values: AppSettings
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  whisperStatus: WhisperStatus | null
  ollamaStatus: OllamaStatus | null
  rechecking: boolean
  onRecheck: () => void
  onWhisperChanged: () => void
}): ReactElement {
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <WhisperStatusCard status={whisperStatus} />
        <OllamaStatusCard
          status={ollamaStatus}
          rechecking={rechecking}
          onRecheck={onRecheck}
        />
      </div>

      <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
        <header className="px-6 py-4 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-800">Captura de áudio</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            De onde o Distill tenta capturar o som da reunião.
          </p>
        </header>
        <div className="px-6 py-4">
          <label htmlFor="setting-captureMode" className="block text-sm font-medium text-slate-700">
            Modo preferido
          </label>
          <SelectField
            id="setting-captureMode"
            value={values.captureMode ?? 'auto'}
            onChange={(e) => update('captureMode', e.target.value as AppSettings['captureMode'])}
          >
            <option value="auto">Automático</option>
            <option value="system">Áudio do sistema</option>
            <option value="microphone">Microfone</option>
            <option value="mixed">Sistema + microfone</option>
          </SelectField>
          <p className="text-xs text-slate-500 mt-1.5">
            No modo automático, o Distill usa o áudio do sistema e cai para microfone quando a captura da reunião não estiver disponível.
          </p>
        </div>
      </section>

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
            <SelectField
              id="setting-whisperLanguage"
              value={values.whisperLanguage ?? 'pt'}
              onChange={(e) => update('whisperLanguage', e.target.value)}
            >
              <option value="auto">Detectar automaticamente</option>
              <option value="pt">Português</option>
              <option value="en">Inglês</option>
              <option value="es">Espanhol</option>
            </SelectField>
            <p className="text-xs text-slate-500 mt-1.5">
              Idioma usado pelo Whisper para transcrever o áudio.
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
                onWhisperChanged()
              }}
              onChanged={onWhisperChanged}
            />
          </div>
          <div className="px-6 py-4">
            <label htmlFor="setting-transcriptGlossary" className="block text-sm font-medium text-slate-700">
              Glossário de correção
            </label>
            <textarea
              id="setting-transcriptGlossary"
              value={values.transcriptGlossary ?? ''}
              onChange={(e) => update('transcriptGlossary', e.target.value)}
              rows={5}
              spellCheck={false}
              placeholder={'OpenAI: open ai, open a.i.\nSupabase: super base, supa base'}
              className={`${inputClass} min-h-[120px] font-mono`}
            />
            <p className="text-xs text-slate-500 mt-1.5">
              Uma linha por termo no formato <code className="font-mono">Canonical: variante 1, variante 2</code>. O Distill aplica essas correções após a transcrição.
            </p>
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
              Host <span className="font-normal text-slate-400">(opcional)</span>
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
            <p className="text-xs text-slate-500 mt-1.5">
              Deixe em branco para usar o Ollama local padrão (<code className="font-mono">http://127.0.0.1:11434</code>). Preencha apenas se o servidor estiver em outra máquina ou porta.
            </p>
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
    </>
  )
}

function LiveTab({
  values,
  update,
  provider
}: {
  values: AppSettings
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  provider: LiveTranslationProvider
}): ReactElement {
  return (
    <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
      <header className="px-6 py-4 border-b border-slate-100">
        <h3 className="text-sm font-semibold text-slate-800">Tradução ao vivo</h3>
        <p className="text-xs text-slate-500 mt-0.5">
          Provider dedicado para as legendas traduzidas. O Ollama fica reservado para resumos.
        </p>
      </header>
      <div className="divide-y divide-slate-100">
        <div className="px-6 py-4">
          <label htmlFor="setting-liveTranslationProvider" className="block text-sm font-medium text-slate-700">
            Provider
          </label>
          <SelectField
            id="setting-liveTranslationProvider"
            value={provider}
            onChange={(e) => update('liveTranslationProvider', e.target.value as LiveTranslationProvider)}
          >
            <option value="libretranslate">LibreTranslate</option>
            <option value="local-opus">Local OPUS</option>
          </SelectField>
          <p className="text-xs text-slate-500 mt-1.5">
            {provider === 'libretranslate'
              ? 'LibreTranslate funciona com servidor local ou remoto.'
              : 'Local OPUS espera um serviço local CTranslate2/OPUS-MT compatível com POST /translate.'}
          </p>
        </div>

        {provider === 'libretranslate' ? (
          <>
            <div className="px-6 py-4">
              <label htmlFor="setting-libreTranslateHost" className="block text-sm font-medium text-slate-700">
                Host LibreTranslate
              </label>
              <input
                id="setting-libreTranslateHost"
                type="text"
                value={values.libreTranslateHost ?? ''}
                onChange={(e) => update('libreTranslateHost', e.target.value)}
                placeholder="http://127.0.0.1:5000"
                autoComplete="off"
                spellCheck={false}
                className={inputClass}
              />
            </div>
            <div className="px-6 py-4">
              <label htmlFor="setting-libreTranslateApiKey" className="block text-sm font-medium text-slate-700">
                API key LibreTranslate <span className="font-normal text-slate-400">(opcional)</span>
              </label>
              <input
                id="setting-libreTranslateApiKey"
                type="password"
                value={values.libreTranslateApiKey ?? ''}
                onChange={(e) => update('libreTranslateApiKey', e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className={inputClass}
              />
            </div>
          </>
        ) : (
          <div className="px-6 py-4">
            <label htmlFor="setting-localOpusHost" className="block text-sm font-medium text-slate-700">
              Host Local OPUS
            </label>
            <input
              id="setting-localOpusHost"
              type="text"
              value={values.localOpusHost ?? ''}
              onChange={(e) => update('localOpusHost', e.target.value)}
              placeholder="http://127.0.0.1:5056"
              autoComplete="off"
              spellCheck={false}
              className={inputClass}
            />
          </div>
        )}
      </div>
    </section>
  )
}

function GeneralTab({
  values,
  update
}: {
  values: AppSettings
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
}): ReactElement {
  return (
    <section className="bg-white border border-slate-200 rounded-lg shadow-sm">
      <header className="px-6 py-4 border-b border-slate-100">
        <h3 className="text-sm font-semibold text-slate-800">Armazenamento</h3>
        <p className="text-xs text-slate-500 mt-0.5">Onde seus dados são salvos.</p>
      </header>
      <div className="divide-y divide-slate-100">
        <div className="px-6 py-4">
          <div className="flex items-start gap-3">
            <input
              id="setting-disableSupabase"
              type="checkbox"
              checked={values.disableSupabase ?? false}
              onChange={(e) => update('disableSupabase', e.target.checked)}
              className="mt-0.5 w-4 h-4 text-sky-600 rounded border-slate-300 focus:ring-sky-500"
            />
            <label htmlFor="setting-disableSupabase" className="cursor-pointer">
              <div className="text-sm font-medium text-slate-700">Salvar apenas localmente</div>
              <div className="text-xs text-slate-500 mt-0.5">
                Ao marcar esta opção, os dados não serão sincronizados com o Supabase e ficarão apenas no seu computador.
              </div>
            </label>
          </div>
        </div>
      </div>
    </section>
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
      className={`border rounded-lg p-5 h-full ${
        ready ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/60'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Whisper</div>
          <div className={`text-sm font-semibold ${ready ? 'text-emerald-700' : 'text-amber-800'}`}>
            {ready ? 'Pronto para transcrever' : 'Configuração incompleta'}
          </div>
        </div>
        <span
          className={`shrink-0 text-[11px] font-medium rounded-full px-2 py-0.5 ${
            ready ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'
          }`}
        >
          {ready ? 'OK' : 'Ação necessária'}
        </span>
      </div>

      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-slate-500">Binário</dt>
          <dd className="mt-0.5 min-w-0">
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

        <div>
          <dt className="text-[11px] uppercase tracking-wider text-slate-500">Modelo</dt>
          <dd className="mt-0.5 min-w-0">
            {status.model ? (
              <>
                <div className="text-sm font-medium text-slate-800 truncate">
                  {status.model.label ?? status.model.filename}
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    {formatMb(status.model.sizeBytes)}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-slate-500 truncate mt-0.5">
                  {status.model.path}
                </div>
              </>
            ) : (
              <div className="text-[12px] text-amber-800">Nenhum modelo selecionado.</div>
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
    <SelectField
      id="setting-ollamaModel"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
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
    </SelectField>
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
      className={`border rounded-lg p-5 h-full ${
        ready ? 'border-emerald-200 bg-emerald-50/50' : 'border-sky-200 bg-sky-50/60'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Ollama</div>
          <div className={`text-sm font-semibold ${ready ? 'text-emerald-700' : 'text-sky-800'}`}>
            {ready ? 'Pronto para resumir' : 'Opcional'}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
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
              ready ? 'bg-emerald-100 text-emerald-700' : 'bg-sky-100 text-sky-800'
            }`}
          >
            {ready ? 'OK' : 'Opcional'}
          </span>
        </div>
      </div>

      <dl className="mt-3 space-y-2 text-sm">
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-slate-500">Servidor</dt>
          <dd className="mt-0.5 min-w-0">
            <div className="font-mono text-[12px] text-slate-700 truncate">{status.host}</div>
            {status.reachable ? (
              <div className="text-[11px] text-slate-500 mt-0.5">
                Conectado{status.version ? ` · versão ${status.version}` : ''}
              </div>
            ) : (
              <div className="text-[12px] text-sky-800 mt-0.5">
                {status.error ?? 'Não foi possível conectar.'}{' '}
                <span className="text-slate-600">
                  Inicie com <code className="font-mono bg-white px-1 py-0.5 rounded">ollama serve</code>.
                </span>
              </div>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-[11px] uppercase tracking-wider text-slate-500">Modelo</dt>
          <dd className="mt-0.5 min-w-0">
            <div className="text-sm font-medium text-slate-800 font-mono truncate">{status.selectedModel}</div>
            {status.reachable && !status.selectedModelInstalled && (
              <div className="text-[12px] text-sky-800 mt-0.5">
                Não instalado. Rode{' '}
                <code className="font-mono bg-white px-1 py-0.5 rounded">ollama pull {status.selectedModel}</code>.
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
