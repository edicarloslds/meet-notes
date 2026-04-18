import { spawn } from 'child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegStatic from 'ffmpeg-static'
import {
  ActionItem,
  OLLAMA_NOT_READY_MARKER,
  OllamaStatus,
  ProcessAudioResult,
  StageName,
  StageStatus,
  WHISPER_NOT_READY_MARKER,
  WhisperStatus
} from '../shared/types'
import { WHISPER_MODELS } from './modelDownloader'

export type StageReporter = (stage: StageName, status: StageStatus, error?: string) => void
import { getSettingSync } from './settingsService'

const OLLAMA_HOST_DEFAULT = 'http://127.0.0.1:11434'
const OLLAMA_MODEL_DEFAULT = 'gemma4:e2b'
const WHISPER_BIN_DEFAULT = 'whisper-cli'
const WHISPER_LANGUAGE_DEFAULT = 'pt'

function resolveWhisperBin(): string {
  return getSettingSync('whisperBin') || WHISPER_BIN_DEFAULT
}

function resolveFfmpegPath(): string {
  if (!ffmpegStatic) throw new Error('ffmpeg-static não disponível; reinstale as dependências.')
  return ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
}

const SUMMARY_PROMPT = `Você é um assistente de notas de reunião. Responda SEMPRE em português do Brasil (pt-BR), independentemente do idioma da transcrição.

A partir da transcrição bruta de uma reunião, produza um objeto JSON com DOIS campos separados:

- "summary": string em Markdown seguindo EXATAMENTE este formato, com três seções nesta ordem, cada uma em um parágrafo separado por linha em branco:

## Contexto
<um parágrafo de 2–4 frases>

## Principais Decisões
- <decisão 1>
- <decisão 2>

## Destaques da Discussão
- <destaque 1>
- <destaque 2>

Regras do campo summary:
- Use cabeçalhos "##" nas três seções (Contexto, Principais Decisões, Destaques da Discussão).
- Separe seções com UMA linha em branco (\\n\\n).
- Em "Principais Decisões" e "Destaques da Discussão", use lista com "-". Se não houver itens, escreva "- Nenhuma identificada.".
- NÃO inclua tarefas, action items, próximos passos nem qualquer menção a "action_items" neste campo.

- "action_items": array de objetos com os campos owner (string|null), task (string), due (data ISO|null). Se não houver tarefas, retorne [].

Todo o conteúdo textual — títulos de seção, resumo e tarefas — deve estar em português do Brasil.

Responda estritamente como JSON válido, sem texto antes ou depois.`

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first !== -1 && last > first) return raw.slice(first, last + 1)
  return raw
}

async function callOllama(transcript: string, signal?: AbortSignal): Promise<string> {
  const host = getSettingSync('ollamaHost') || OLLAMA_HOST_DEFAULT
  const model = getSettingSync('ollamaModel') || OLLAMA_MODEL_DEFAULT
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          action_items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                owner: { type: ['string', 'null'] },
                task: { type: 'string' },
                due: { type: ['string', 'null'] }
              },
              required: ['owner', 'task', 'due']
            }
          }
        },
        required: ['summary', 'action_items']
      },
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: transcript }
      ]
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Ollama request failed (${res.status}): ${text}`)
  }
  const data = (await res.json()) as { message?: { content?: string } }
  return data.message?.content ?? ''
}

export async function summarizeTranscript(
  transcript: string,
  signal?: AbortSignal
): Promise<{ summary: string; actionItems: ActionItem[] }> {
  if (!transcript.trim()) return { summary: '', actionItems: [] }
  const raw = await callOllama(transcript, signal)
  try {
    const parsed = JSON.parse(extractJson(raw))
    const summary = typeof parsed.summary === 'string' ? sanitizeSummary(parsed.summary) : ''
    const actionItems: ActionItem[] = Array.isArray(parsed.action_items) ? parsed.action_items : []
    return { summary, actionItems }
  } catch (err) {
    console.warn('Failed to parse Ollama summary JSON:', err)
    return { summary: sanitizeSummary(raw), actionItems: [] }
  }
}

const SECTION_LABELS = ['Contexto', 'Principais Decisões', 'Destaques da Discussão']

function sanitizeSummary(summary: string): string {
  let out = summary.replace(/"?action_items"?\s*[:=]?\s*\[[^\]]*\]/gi, '').trim()

  const hasHeadings = /^#{1,3}\s+/m.test(out)
  if (!hasHeadings) {
    for (const label of SECTION_LABELS) {
      const re = new RegExp(`(^|[\\s\\S])\\*{0,2}${escapeRegex(label)}\\*{0,2}\\s*:\\s*`, 'g')
      out = out.replace(re, (_m, prefix: string) => {
        const leading = prefix && !/\n$/.test(prefix) ? `${prefix}\n\n` : prefix || ''
        return `${leading}## ${label}\n\n`
      })
    }
  }

  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function run(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  opts?: { logStderr?: boolean }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const proc = spawn(bin, args, signal ? { signal } : {})
    let stdout = ''
    let stderr = ''
    const tag = bin.split('/').pop() ?? bin
    proc.stdout.on('data', (d) => (stdout += d.toString()))
    proc.stderr.on('data', (d) => {
      const s = d.toString()
      stderr += s
      if (opts?.logStderr) process.stderr.write(`[${tag}] ${s}`)
    })
    proc.on('error', reject)
    proc.on('close', (code, sig) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${bin} exited with code ${code ?? sig}: ${stderr || stdout}`))
    })
  })
}

async function convertToWav(
  audio: Buffer,
  dir: string,
  signal?: AbortSignal
): Promise<string> {
  const ffmpegBin = resolveFfmpegPath()
  const webmPath = join(dir, 'input.webm')
  const wavPath = join(dir, 'input.wav')
  await writeFile(webmPath, audio)
  await run(
    ffmpegBin,
    ['-y', '-i', webmPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
    signal
  )
  return wavPath
}

async function runWhisperOnWav(wavPath: string, dir: string, signal?: AbortSignal): Promise<string> {
  const whisperModel = getSettingSync('whisperModel')
  if (!whisperModel) {
    throw new Error(`${WHISPER_NOT_READY_MARKER} Nenhum modelo do Whisper configurado. Abra Configurações e baixe um modelo.`)
  }
  if (!(await fileExists(whisperModel))) {
    throw new Error(`${WHISPER_NOT_READY_MARKER} O arquivo do modelo não foi encontrado em ${whisperModel}. Baixe novamente em Configurações.`)
  }
  const whisperBin = resolveWhisperBin()
  const whisperLanguage = getSettingSync('whisperLanguage') || WHISPER_LANGUAGE_DEFAULT
  try {
    await run(
      whisperBin,
      ['-m', whisperModel, '-f', wavPath, '-l', whisperLanguage, '-otxt', '-of', join(dir, 'out'), '-nt'],
      signal
    )
  } catch (err) {
    if (isMissingBinaryError(err)) {
      throw new Error(
        `${WHISPER_NOT_READY_MARKER} Binário "${whisperBin}" não encontrado no PATH. Instale o whisper.cpp (ex.: brew install whisper-cpp) ou informe o caminho em Configurações.`
      )
    }
    throw err
  }
  const transcript = await readFile(join(dir, 'out.txt'), 'utf8')
  return transcript.trim()
}

function isMissingBinaryError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; message?: string }
  if (e.code === 'ENOENT') return true
  return typeof e.message === 'string' && /ENOENT|not found|não encontrado/i.test(e.message)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isFile() && s.size > 0
  } catch {
    return false
  }
}

export function isWhisperNotReadyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const msg = (err as { message?: string }).message
  return typeof msg === 'string' && msg.includes(WHISPER_NOT_READY_MARKER)
}

export function stripNotReadyMarker(msg: string): string {
  return msg.replace(WHISPER_NOT_READY_MARKER, '').trim()
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: string }
  return e.name === 'AbortError' || e.code === 'ABORT_ERR'
}

export async function getWhisperStatus(): Promise<WhisperStatus> {
  const status: WhisperStatus = { binAvailable: false }
  const bin = resolveWhisperBin()

  try {
    const { stdout, stderr } = await run(bin, ['-h'])
    status.binAvailable = true
    const combined = `${stdout}\n${stderr}`
    const versionMatch = combined.match(/whisper\.cpp[^\n]*?(?:version|build)[:\s]+([^\s,)]+)/i)
    if (versionMatch) status.binVersion = versionMatch[1]
    try {
      const { stdout: whichOut } = await run(process.platform === 'win32' ? 'where' : 'which', [bin])
      status.binPath = whichOut.trim().split('\n')[0] || bin
    } catch {
      status.binPath = bin
    }
  } catch (err) {
    if (isMissingBinaryError(err)) {
      status.binError = `Binário "${bin}" não encontrado no PATH.`
    } else {
      status.binError = (err as Error).message
    }
  }

  const modelPath = getSettingSync('whisperModel')
  if (modelPath && (await fileExists(modelPath))) {
    const s = await stat(modelPath)
    const info = WHISPER_MODELS.find((m) => modelPath.endsWith(m.filename))
    status.model = {
      id: info?.id,
      label: info?.label,
      filename: info?.filename ?? modelPath.split('/').pop() ?? modelPath,
      path: modelPath,
      sizeBytes: s.size
    }
  }

  return status
}

export async function getOllamaStatus(): Promise<OllamaStatus> {
  const host = getSettingSync('ollamaHost') || OLLAMA_HOST_DEFAULT
  const selectedModel = getSettingSync('ollamaModel') || OLLAMA_MODEL_DEFAULT
  const status: OllamaStatus = {
    reachable: false,
    host,
    models: [],
    selectedModel,
    selectedModelInstalled: false
  }

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const [tagsRes, versionRes] = await Promise.all([
      fetch(`${host}/api/tags`, { signal: ctrl.signal }),
      fetch(`${host}/api/version`, { signal: ctrl.signal }).catch(() => null)
    ])
    clearTimeout(timer)

    if (!tagsRes.ok) {
      status.error = `Ollama respondeu com HTTP ${tagsRes.status}.`
      return status
    }
    status.reachable = true
    const data = (await tagsRes.json()) as { models?: Array<{ name?: string }> }
    status.models = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean)
    status.selectedModelInstalled = status.models.some(
      (m) => m === selectedModel || m.startsWith(`${selectedModel}:`) || m === `${selectedModel}:latest`
    )
    if (versionRes?.ok) {
      const v = (await versionRes.json()) as { version?: string }
      if (v.version) status.version = v.version
    }
  } catch (err) {
    const msg = (err as Error).message || 'Falha ao conectar ao Ollama.'
    status.error =
      (err as Error).name === 'AbortError'
        ? `Timeout ao conectar em ${host}. Ollama está rodando?`
        : msg
  }

  return status
}

export async function assertOllamaReady(): Promise<void> {
  const status = await getOllamaStatus()
  if (!status.reachable) {
    throw new Error(
      `${OLLAMA_NOT_READY_MARKER} Ollama indisponível em ${status.host}. ${status.error ?? 'Verifique se o serviço está rodando.'} Abra Configurações.`
    )
  }
  if (!status.selectedModelInstalled) {
    throw new Error(
      `${OLLAMA_NOT_READY_MARKER} Modelo "${status.selectedModel}" não está instalado no Ollama. Rode \`ollama pull ${status.selectedModel}\` ou escolha outro em Configurações.`
    )
  }
}

export function isOllamaNotReadyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const msg = (err as { message?: string }).message
  return typeof msg === 'string' && msg.includes(OLLAMA_NOT_READY_MARKER)
}

export async function assertWhisperReady(): Promise<void> {
  const status = await getWhisperStatus()
  if (!status.binAvailable) {
    throw new Error(
      `${WHISPER_NOT_READY_MARKER} ${status.binError ?? 'whisper-cli indisponível.'} Abra Configurações.`
    )
  }
  if (!status.model) {
    throw new Error(
      `${WHISPER_NOT_READY_MARKER} Nenhum modelo do Whisper selecionado. Abra Configurações e baixe um modelo.`
    )
  }
}

export async function transcribeAndSummarize(
  audio: Buffer,
  onStage?: StageReporter,
  signal?: AbortSignal
): Promise<ProcessAudioResult> {
  await assertWhisperReady()
  await assertOllamaReady()

  const dir = await mkdtemp(join(tmpdir(), 'meetnotes-'))
  let wavPath: string
  const stageErr = (stage: StageName, err: unknown): void => {
    const msg = isAbortError(err) ? 'Cancelado' : (err as Error).message
    onStage?.(stage, 'failed', msg)
  }
  try {
    onStage?.('converting', 'active')
    try {
      wavPath = await convertToWav(audio, dir, signal)
      onStage?.('converting', 'done')
    } catch (err) {
      stageErr('converting', err)
      throw err
    }

    onStage?.('transcribing', 'active')
    let transcript: string
    try {
      transcript = await runWhisperOnWav(wavPath, dir, signal)
      onStage?.('transcribing', 'done')
    } catch (err) {
      stageErr('transcribing', err)
      throw err
    }

    if (!transcript) {
      const msg = 'Nenhuma fala foi reconhecida pelo Whisper. Verifique o áudio e o modelo selecionado.'
      onStage?.('transcribing', 'failed', msg)
      throw new Error(msg)
    }

    onStage?.('summarizing', 'active')
    try {
      const { summary, actionItems } = await summarizeTranscript(transcript, signal)
      onStage?.('summarizing', 'done')
      return { transcript, summary, actionItems }
    } catch (err) {
      stageErr('summarizing', err)
      throw err
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
