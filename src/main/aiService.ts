import { spawn } from 'child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegStatic from 'ffmpeg-static'
import {
  ActionItem,
  OLLAMA_NOT_READY_MARKER,
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaStatus,
  ProcessAudioResult,
  StageName,
  StageStatus,
  TranscriptSegment,
  WHISPER_NOT_READY_MARKER,
  WhisperStatus
} from '../shared/types'
import { WHISPER_MODELS } from './modelDownloader'

export interface StageExtra {
  error?: string
  progress?: number
}
export type StageReporter = (stage: StageName, status: StageStatus, extra?: StageExtra) => void
import { getSettingSync } from './settingsService'

const OLLAMA_HOST_DEFAULT = 'http://127.0.0.1:11434'
const OLLAMA_MODEL_DEFAULT = 'gemma4:e2b'
const WHISPER_BIN_DEFAULT = 'whisper-cli'
const WHISPER_LANGUAGE_DEFAULT = 'pt'
const AUDIO_FILTER_CHAIN = 'highpass=f=100,lowpass=f=7600,afftdn=nf=-25,dynaudnorm=f=150:g=15'
const DEFAULT_FILLERS = [
  'ahn',
  'ah',
  'eh',
  'hum',
  'uh',
  'um',
  'tipo',
  'né',
  'ne'
]

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

const CHAT_SYSTEM_PROMPT =
  'Responda somente em português do Brasil. Seja claro, natural e direto. Se o usuário pedir outro idioma explicitamente, use o idioma pedido.'

const CHAT_USER_PREFIX =
  'Responda em português do Brasil, com uma resposta curta e natural.\n\nMensagem do usuário:'

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

export async function chatWithOllama(
  request: OllamaChatRequest,
  signal?: AbortSignal
): Promise<OllamaChatResponse> {
  const host = getSettingSync('ollamaHost') || OLLAMA_HOST_DEFAULT
  const model = request.model.trim() || getSettingSync('ollamaModel') || OLLAMA_MODEL_DEFAULT
  const messages = request.messages
    .filter((message) => message.content.trim())
    .map((message, index, all) => ({
      role: message.role,
      content:
        index === all.length - 1 && message.role === 'user'
          ? `${CHAT_USER_PREFIX}\n${message.content}`
          : message.content
    }))

  if (messages.length === 0) {
    throw new Error('Envie uma mensagem para iniciar o chat.')
  }

  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: request.think,
      options: {
        temperature: 0.1,
        top_p: 0.8,
        repeat_penalty: 1.15
      },
      messages: [
        { role: 'system', content: CHAT_SYSTEM_PROMPT },
        ...messages
      ]
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Ollama request failed (${res.status}): ${text}`)
  }
  const data = (await res.json()) as {
    model?: string
    message?: {
      role?: string
      content?: string
      thinking?: string
    }
  }
  return {
    model: data.model ?? model,
    message: {
      role: 'assistant',
      content: data.message?.content ?? '',
      thinking: data.message?.thinking
    }
  }
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

interface GlossaryEntry {
  canonical: string
  variants: string[]
}

export function normalizeTranscriptArtifacts(
  transcript: string,
  segments: TranscriptSegment[]
): { transcript: string; segments: TranscriptSegment[] } {
  const glossary = parseGlossary(getSettingSync('transcriptGlossary'))
  const normalizedSegments = segments
    .map((segment) => ({
      ...segment,
      text: normalizeTranscriptText(segment.text, glossary)
    }))
    .filter((segment) => segment.text.trim())
    .map((segment) => ({
      ...segment,
      ...assessSegmentQuality(segment.text)
    }))

  if (normalizedSegments.length > 0) {
    return {
      transcript: normalizedSegments.map((segment) => segment.text).join('\n\n').trim(),
      segments: normalizedSegments
    }
  }

  return {
    transcript: normalizeTranscriptText(transcript, glossary),
    segments: []
  }
}

function normalizeTranscriptText(input: string, glossary: GlossaryEntry[]): string {
  let out = input.trim()
  if (!out) return ''

  out = out.replace(/\s+/g, ' ')
  out = out.replace(/\b([\p{L}\p{N}]+)(?:\s+\1\b)+/giu, '$1')
  out = collapseFillerBursts(out)
  out = out.replace(/\s*([,.;!?])\s*/g, '$1 ')
  out = out.replace(/\s+([,.;!?])/g, '$1')
  out = out.replace(/([!?.,;:]){2,}/g, '$1')
  out = applyGlossary(out, glossary)
  out = capitalizeSentences(out)
  out = out.replace(/\s+/g, ' ').trim()
  if (!/[.!?]$/.test(out)) out = `${out}.`
  return out
}

function parseGlossary(raw: unknown): GlossaryEntry[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^([^:=]+)\s*[:=]\s*(.+)$/)
      if (!match) return []
      const canonical = match[1].trim()
      const variants = match[2]
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      if (!canonical || variants.length === 0) return []
      return [{ canonical, variants }]
    })
}

function applyGlossary(text: string, glossary: GlossaryEntry[]): string {
  let out = text
  for (const entry of glossary) {
    for (const variant of entry.variants) {
      const re = new RegExp(`\\b${escapeRegex(variant)}\\b`, 'gi')
      out = out.replace(re, entry.canonical)
    }
  }
  return out
}

function collapseFillerBursts(text: string): string {
  let out = text
  for (const filler of DEFAULT_FILLERS) {
    const re = new RegExp(`(?:\\b${escapeRegex(filler)}\\b[ ,]*){2,}`, 'gi')
    out = out.replace(re, `${filler} `)
  }
  return out
}

function capitalizeSentences(text: string): string {
  let shouldCapitalize = true
  let out = ''
  for (const char of text) {
    if (shouldCapitalize && /\p{L}/u.test(char)) {
      out += char.toLocaleUpperCase('pt-BR')
      shouldCapitalize = false
    } else {
      out += char
      if (/\S/u.test(char)) shouldCapitalize = false
    }
    if (/[.!?]/.test(char)) shouldCapitalize = true
  }
  return out
}

function assessSegmentQuality(text: string): {
  quality: 'high' | 'medium' | 'low'
  qualityReasons: string[]
} {
  const reasons: string[] = []
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length < 4) reasons.push('Trecho muito curto')
  if (!/[.!?]$/.test(text.trim())) reasons.push('Sem pontuação final')
  if (/\b(\p{L}+)(?:\s+\1\b){1,}/iu.test(text)) reasons.push('Possível repetição')
  if (DEFAULT_FILLERS.some((filler) => new RegExp(`\\b${escapeRegex(filler)}\\b`, 'i').test(text))) {
    reasons.push('Contém fillers')
  }

  if (reasons.length >= 2) return { quality: 'low', qualityReasons: reasons }
  if (reasons.length === 1) return { quality: 'medium', qualityReasons: reasons }
  return { quality: 'high', qualityReasons: ['Sem sinais heurísticos de problema'] }
}

function run(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  opts?: { logStderr?: boolean; onStderr?: (chunk: string) => void }
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
      opts?.onStderr?.(s)
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
  const rawWavPath = join(dir, 'input-raw.wav')
  const wavPath = join(dir, 'input.wav')
  await writeFile(webmPath, audio)
  await run(
    ffmpegBin,
    ['-y', '-i', webmPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', rawWavPath],
    signal
  )
  await preprocessWav(rawWavPath, wavPath, signal)
  return wavPath
}

async function preprocessWav(
  inputPath: string,
  outputPath: string,
  signal?: AbortSignal
): Promise<void> {
  const ffmpegBin = resolveFfmpegPath()
  await run(
    ffmpegBin,
    [
      '-y',
      '-i',
      inputPath,
      '-af',
      AUDIO_FILTER_CHAIN,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      outputPath
    ],
    signal
  )
}

async function runWhisperOnWav(
  wavPath: string,
  dir: string,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void
): Promise<string> {
  const whisperModel = getSettingSync('whisperModel')
  if (!whisperModel) {
    throw new Error(`${WHISPER_NOT_READY_MARKER} Nenhum modelo do Whisper configurado. Abra Configurações e baixe um modelo.`)
  }
  if (!(await fileExists(whisperModel))) {
    throw new Error(`${WHISPER_NOT_READY_MARKER} O arquivo do modelo não foi encontrado em ${whisperModel}. Baixe novamente em Configurações.`)
  }
  const whisperBin = resolveWhisperBin()
  const whisperLanguage = getSettingSync('whisperLanguage') || WHISPER_LANGUAGE_DEFAULT
  const outBase = join(dir, 'out')
  let lastReported = -1
  const progressRegex = /progress\s*=\s*(\d+)\s*%/gi
  try {
    await run(
      whisperBin,
      ['-m', whisperModel, '-f', wavPath, '-l', whisperLanguage, '-otxt', '-of', outBase, '-nt', '-pp'],
      signal,
      onProgress
        ? {
            onStderr: (chunk) => {
              let m: RegExpExecArray | null
              while ((m = progressRegex.exec(chunk)) !== null) {
                const pct = Math.max(0, Math.min(100, Number(m[1])))
                if (pct !== lastReported) {
                  lastReported = pct
                  onProgress(pct)
                }
              }
            }
          }
        : undefined
    )
  } catch (err) {
    if (isMissingBinaryError(err)) {
      throw new Error(
        `${WHISPER_NOT_READY_MARKER} Binário "${whisperBin}" não encontrado no PATH. Instale o whisper.cpp (ex.: brew install whisper-cpp) ou informe o caminho em Configurações.`
      )
    }
    throw err
  }
  const transcript = await readFile(`${outBase}.txt`, 'utf8')
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

function cleanMarker(message: string | undefined, marker: string): string | undefined {
  if (!message) return undefined
  return message.replace(marker, '').trim() || undefined
}

export async function transcribeAndSummarize(
  audio: Buffer,
  onStage?: StageReporter,
  signal?: AbortSignal
): Promise<ProcessAudioResult> {
  await assertWhisperReady()

  const dir = await mkdtemp(join(tmpdir(), 'distill-'))
  let wavPath: string
  const stageErr = (stage: StageName, err: unknown): void => {
    const msg = isAbortError(err) ? 'Cancelado' : (err as Error).message
    onStage?.(stage, 'failed', { error: msg })
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
      transcript = await runWhisperOnWav(wavPath, dir, signal, (pct) =>
        onStage?.('transcribing', 'active', { progress: pct })
      )
      transcript = normalizeTranscriptArtifacts(transcript, []).transcript
      onStage?.('transcribing', 'done')
    } catch (err) {
      stageErr('transcribing', err)
      throw err
    }

    if (!transcript) {
      const msg = 'Nenhuma fala foi reconhecida pelo Whisper. Verifique o áudio e o modelo selecionado.'
      onStage?.('transcribing', 'failed', { error: msg })
      throw new Error(msg)
    }

    onStage?.('summarizing', 'active')
    try {
      await assertOllamaReady()
      const { summary, actionItems } = await summarizeTranscript(transcript, signal)
      onStage?.('summarizing', 'done')
      return { transcript, summary, actionItems, summaryStatus: 'complete' }
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw err
      const message = (err as Error).message
      const summaryStatus = message.includes(OLLAMA_NOT_READY_MARKER) ? 'skipped' : 'failed'
      const summaryError =
        cleanMarker(message, OLLAMA_NOT_READY_MARKER) ??
        'Nao foi possivel gerar o resumo desta reuniao.'
      onStage?.('summarizing', 'failed', { error: summaryError })
      return {
        transcript,
        summary: '',
        actionItems: [],
        summaryStatus,
        summaryError
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function buildWavFromPcm(pcm: Int16Array, sampleRate: number): Buffer {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const dataSize = pcm.byteLength
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buffer, 44)
  return buffer
}

export async function transcribePcmChunk(
  pcm: Int16Array,
  sampleRate: number,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void
): Promise<string> {
  if (pcm.length === 0) return ''
  const dir = await mkdtemp(join(tmpdir(), 'distill-chunk-'))
  try {
    const rawWavPath = join(dir, 'chunk-raw.wav')
    const wavPath = join(dir, 'chunk.wav')
    await writeFile(rawWavPath, buildWavFromPcm(pcm, sampleRate))
    await preprocessWav(rawWavPath, wavPath, signal)
    return await runWhisperOnWav(wavPath, dir, signal, onProgress)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
