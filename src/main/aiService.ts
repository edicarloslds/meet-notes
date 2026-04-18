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

const SUMMARY_PROMPT = `You are a meeting-notes assistant. Given a raw meeting transcript, produce:
1. A concise markdown summary with sections: Context, Key Decisions, Discussion Highlights.
2. A JSON array of action items with fields: owner (string|null), task (string), due (ISO date|null).

Respond strictly as JSON:
{"summary": "<markdown>", "action_items": [...]}`

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
