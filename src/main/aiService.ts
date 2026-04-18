import OpenAI from 'openai'
import { toFile } from 'openai/uploads'
import { ActionItem, ProcessAudioResult } from '../shared/types'

let client: OpenAI | null = null

function getClient(): OpenAI {
  if (client) return client
  const apiKey = import.meta.env.MAIN_VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('MAIN_VITE_OPENAI_API_KEY is not configured')
  client = new OpenAI({ apiKey })
  return client
}

const SUMMARY_PROMPT = `Você é um assistente de notas de reunião. Responda SEMPRE em português do Brasil (pt-BR), independentemente do idioma da transcrição.

A partir da transcrição bruta de uma reunião, produza:
1. Um resumo conciso em Markdown com as seções: **Contexto**, **Principais Decisões**, **Destaques da Discussão**.
2. Uma lista de action items em JSON, com os campos: owner (string|null), task (string), due (data ISO|null).

Todo o conteúdo textual — títulos de seção, resumo e tarefas — deve estar em português do Brasil.

Responda estritamente como JSON:
{"summary": "<markdown em pt-BR>", "action_items": [...]}`

export async function summarizeTranscript(
  transcript: string
): Promise<{ summary: string; actionItems: ActionItem[] }> {
  if (!transcript.trim()) return { summary: '', actionItems: [] }
  const openai = getClient()
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: transcript }
    ]
  })
  const raw = completion.choices[0]?.message?.content ?? '{}'
  try {
    const parsed = JSON.parse(raw)
    const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
    const actionItems: ActionItem[] = Array.isArray(parsed.action_items) ? parsed.action_items : []
    return { summary, actionItems }
  } catch (err) {
    console.warn('Failed to parse summary JSON:', err)
    return { summary: raw, actionItems: [] }
  }
}

export async function transcribeAndSummarize(audio: Buffer): Promise<ProcessAudioResult> {
  const openai = getClient()
  const file = await toFile(audio, 'meeting.webm', { type: 'audio/webm' })
  const transcription = await openai.audio.transcriptions.create({ file, model: 'whisper-1' })
  const transcript = transcription.text ?? ''
  if (!transcript.trim()) {
    return { transcript: '', summary: '', actionItems: [] }
  }
  const { summary, actionItems } = await summarizeTranscript(transcript)
  return { transcript, summary, actionItems }
}
