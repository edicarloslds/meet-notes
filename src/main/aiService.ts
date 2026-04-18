import { spawn } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ActionItem, ProcessAudioResult } from '../shared/types'

const OLLAMA_HOST = import.meta.env.MAIN_VITE_OLLAMA_HOST || 'http://127.0.0.1:11434'
const OLLAMA_MODEL = import.meta.env.MAIN_VITE_OLLAMA_MODEL || 'gemma4:e2b'
const WHISPER_BIN = import.meta.env.MAIN_VITE_WHISPER_BIN || 'whisper-cli'
const WHISPER_MODEL = import.meta.env.MAIN_VITE_WHISPER_MODEL
const WHISPER_LANGUAGE = import.meta.env.MAIN_VITE_WHISPER_LANGUAGE || 'pt'
const FFMPEG_BIN = import.meta.env.MAIN_VITE_FFMPEG_BIN || 'ffmpeg'

const SUMMARY_PROMPT = `Você é um assistente de notas de reunião. Responda SEMPRE em português do Brasil (pt-BR), independentemente do idioma da transcrição.

A partir da transcrição bruta de uma reunião, produza um objeto JSON com DOIS campos separados:

- "summary": string em Markdown contendo APENAS as seções **Contexto**, **Principais Decisões** e **Destaques da Discussão**. NÃO inclua tarefas, action items, próximos passos nem qualquer menção a "action_items" neste campo. Não repita o conteúdo do campo action_items aqui.
- "action_items": array de objetos com os campos owner (string|null), task (string), due (data ISO|null). Se não houver tarefas, retorne [].

Todo o conteúdo textual — títulos de seção, resumo e tarefas — deve estar em português do Brasil.

Responda estritamente como JSON válido, sem texto antes ou depois, seguindo exatamente este shape:
{"summary": "<markdown em pt-BR, sem seção de action items>", "action_items": [{"owner": "...", "task": "...", "due": "..."}]}`

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first !== -1 && last > first) return raw.slice(first, last + 1)
  return raw
}

async function callOllama(transcript: string): Promise<string> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
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
  transcript: string
): Promise<{ summary: string; actionItems: ActionItem[] }> {
  if (!transcript.trim()) return { summary: '', actionItems: [] }
  const raw = await callOllama(transcript)
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

function sanitizeSummary(summary: string): string {
  return summary
    .replace(/"?action_items"?\s*[:=]?\s*\[[^\]]*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => (stdout += d.toString()))
    proc.stderr.on('data', (d) => (stderr += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${bin} exited with code ${code}: ${stderr || stdout}`))
    })
  })
}

async function transcribeWithWhisperCpp(audio: Buffer): Promise<string> {
  if (!WHISPER_MODEL) {
    throw new Error('MAIN_VITE_WHISPER_MODEL is not configured (path to whisper.cpp .bin model)')
  }
  const dir = await mkdtemp(join(tmpdir(), 'meetnotes-'))
  const webmPath = join(dir, 'input.webm')
  const wavPath = join(dir, 'input.wav')
  try {
    await writeFile(webmPath, audio)
    await run(FFMPEG_BIN, ['-y', '-i', webmPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath])
    await run(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '-l', WHISPER_LANGUAGE,
      '-otxt',
      '-of', join(dir, 'out'),
      '-nt'
    ])
    const transcript = await readFile(join(dir, 'out.txt'), 'utf8')
    return transcript.trim()
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function transcribeAndSummarize(audio: Buffer): Promise<ProcessAudioResult> {
  const transcript = await transcribeWithWhisperCpp(audio)
  if (!transcript) {
    return { transcript: '', summary: '', actionItems: [] }
  }
  const { summary, actionItems } = await summarizeTranscript(transcript)
  return { transcript, summary, actionItems }
}
