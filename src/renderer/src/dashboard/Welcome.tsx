import { useState, type ReactElement } from 'react'
import type { SystemSettingsSection } from '../../../shared/types'

type Props = {
  onComplete: () => void
}

type Step = {
  id: SystemSettingsSection
  title: string
  description: string
  why: string
  required: boolean
}

const STEPS: Step[] = [
  {
    id: 'microphone',
    title: 'Microfone',
    description: 'Permite que o Distill capture o áudio das suas reuniões.',
    why: 'Sem esta permissão, nenhuma gravação será possível.',
    required: true
  },
  {
    id: 'screen-recording',
    title: 'Gravação de Tela',
    description:
      'Permite ler o título da janela ativa para detectar quando uma reunião começa (Zoom, Meet, Teams).',
    why: 'Necessário para iniciar a gravação automaticamente. A tela em si não é capturada.',
    required: true
  },
  {
    id: 'accessibility',
    title: 'Acessibilidade (opcional)',
    description: 'Em algumas versões do macOS, melhora a detecção de janelas de reunião.',
    why: 'Só ative se a detecção automática não funcionar mesmo com Gravação de Tela ativa.',
    required: false
  }
]

export function Welcome({ onComplete }: Props): ReactElement {
  const [checked, setChecked] = useState<Record<SystemSettingsSection, boolean>>({
    microphone: false,
    'screen-recording': false,
    accessibility: false
  })
  const [saving, setSaving] = useState(false)

  const handleOpen = async (section: SystemSettingsSection): Promise<void> => {
    await window.distill.openSystemSettings(section)
    setChecked((prev) => ({ ...prev, [section]: true }))
  }

  const handleFinish = async (): Promise<void> => {
    setSaving(true)
    try {
      const current = await window.distill.getSettings()
      await window.distill.saveSettings({
        ...current,
        welcomeCompletedAt: new Date().toISOString()
      })
      onComplete()
    } finally {
      setSaving(false)
    }
  }

  const requiredDone = STEPS.filter((s) => s.required).every((s) => checked[s.id])

  return (
    <div className="h-full w-full overflow-y-auto bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-2xl mx-auto px-10 py-14">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-sky-100 text-sky-600 mb-4">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Bem-vindo ao Distill</h1>
          <p className="mt-3 text-slate-600 leading-relaxed">
            Antes de começar, o macOS precisa conceder algumas permissões. Clique nos botões abaixo para abrir
            cada painel de privacidade e ative o Distill manualmente.
          </p>
        </div>

        <div className="space-y-3">
          {STEPS.map((step, index) => {
            const isChecked = checked[step.id]
            return (
              <div
                key={step.id}
                className={`border rounded-xl p-5 transition ${
                  isChecked ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-white'
                }`}
              >
                <div className="flex items-start gap-4">
                  <div
                    className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${
                      isChecked
                        ? 'bg-emerald-500 text-white'
                        : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {isChecked ? (
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    ) : (
                      index + 1
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-base font-semibold text-slate-900">{step.title}</h3>
                      {!step.required && (
                        <span className="text-[10px] uppercase tracking-wide text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                          opcional
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-slate-600 leading-relaxed">{step.description}</p>
                    <p className="mt-1 text-xs text-slate-500 leading-relaxed">{step.why}</p>
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void handleOpen(step.id)}
                        className="text-sm font-medium bg-slate-900 hover:bg-slate-700 text-white rounded-md px-3 py-1.5"
                      >
                        Abrir Configurações
                      </button>
                      {!isChecked && (
                        <button
                          type="button"
                          onClick={() => setChecked((prev) => ({ ...prev, [step.id]: true }))}
                          className="text-xs text-slate-500 hover:text-slate-800"
                        >
                          Marcar como concluído
                        </button>
                      )}
                      {isChecked && (
                        <span className="text-xs text-emerald-600 font-medium">Concluído</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-8 rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-xs text-slate-600 leading-relaxed">
          <strong className="text-slate-700">Dica:</strong> após ativar cada permissão, o macOS pode pedir para
          reiniciar o Distill para aplicar as mudanças. Você também pode gerenciar essas permissões depois em
          <em> Configurações do Sistema → Privacidade e Segurança</em>.
        </div>

        <div className="mt-8 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => void handleFinish()}
            className="text-sm text-slate-500 hover:text-slate-800"
            disabled={saving}
          >
            Pular por agora
          </button>
          <button
            type="button"
            onClick={() => void handleFinish()}
            disabled={!requiredDone || saving}
            className="text-sm font-medium bg-sky-600 hover:bg-sky-500 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-md px-5 py-2"
          >
            {saving ? 'Salvando…' : 'Continuar'}
          </button>
        </div>
      </div>
    </div>
  )
}
