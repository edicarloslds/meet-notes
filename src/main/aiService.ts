import OpenAI from 'openai'
import { toFile } from 'openai/uploads'
import { ActionItem, ProcessAudioResult } from '../shared/types'

let client: OpenAI | null = null

function getClient(): OpenAI {
  if (client) return client
  const apiKey = process.env.MAIN_VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('MAIN_VITE_OPENAI_API_KEY is not configured')
  client = new OpenAI({ apiKey })
  return client
}

const SUMMARY_PROMPT = `You are a meeting-notes assistant. Given a raw meeting transcript, produce:
1. A concise markdown summary with sections: Context, Key Decisions, Discussion Highlights.
2. A JSON array of action items with fields: owner (string|null), task (string), due (ISO date|null).

Respond strictly as JSON:
{"summary": "<markdown>", "action_items": [...]}`

export async function transcribeAndSummarize(audio: Buffer): Promise<ProcessAudioResult> {
  const openai = getClient()

  const file = await toFile(audio, 'meeting.webm', { type: 'audio/webm' })
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1'
  })
  const transcript = transcription.text ?? ''

  if (!transcript.trim()) {
    return { transcript: '', summary: '_No speech detected._', actionItems: [] }
  }

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: transcript }
    ]
  })

  const raw = completion.choices[0]?.message?.content ?? '{}'
  let summary = ''
  let actionItems: ActionItem[] = []
  try {
    const parsed = JSON.parse(raw)
    summary = typeof parsed.summary === 'string' ? parsed.summary : ''
    if (Array.isArray(parsed.action_items)) actionItems = parsed.action_items
  } catch (err) {
    console.warn('Failed to parse summary JSON:', err)
    summary = raw
  }

  return { transcript, summary, actionItems }
}
