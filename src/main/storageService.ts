import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Meeting } from '../shared/types'

interface StoreSchema {
  meetings: Meeting[]
  pending: Meeting[]
}

type StoreInstance = {
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K]
  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void
}

let storePromise: Promise<StoreInstance> | null = null

function getStore(): Promise<StoreInstance> {
  if (storePromise) return storePromise
  storePromise = (async () => {
    const { default: Store } = await import('electron-store')
    return new Store<StoreSchema>({
      name: 'meetnotes',
      defaults: { meetings: [], pending: [] }
    }) as unknown as StoreInstance
  })()
  return storePromise
}

let supabase: SupabaseClient | null = null

function getSupabase(): SupabaseClient | null {
  if (supabase) return supabase
  const url = import.meta.env.MAIN_VITE_SUPABASE_URL
  const key = import.meta.env.MAIN_VITE_SUPABASE_ANON_KEY
  if (!url || !key) return null
  supabase = createClient(url, key)
  return supabase
}

async function upsertLocal(meeting: Meeting): Promise<void> {
  const store = await getStore()
  const all = store.get('meetings')
  store.set('meetings', [meeting, ...all.filter((m) => m.id !== meeting.id)])
}

async function queuePending(meeting: Meeting): Promise<void> {
  const store = await getStore()
  const pending = store.get('pending')
  store.set('pending', [meeting, ...pending.filter((m) => m.id !== meeting.id)])
}

async function removePending(id: string): Promise<void> {
  const store = await getStore()
  store.set(
    'pending',
    store.get('pending').filter((m) => m.id !== id)
  )
}

async function pushToSupabase(meeting: Meeting): Promise<boolean> {
  const client = getSupabase()
  if (!client) return false
  const { error } = await client.from('meetings').upsert({
    id: meeting.id,
    user_id: meeting.user_id,
    title: meeting.title,
    raw_transcript: meeting.raw_transcript,
    summary: meeting.summary,
    action_items: meeting.action_items,
    created_at: meeting.created_at
  })
  if (error) {
    console.warn('Supabase upsert error:', error.message)
    return false
  }
  return true
}

export async function saveMeeting(meeting: Meeting): Promise<Meeting> {
  const record: Meeting = { ...meeting, synced: false }
  await upsertLocal(record)

  if (record.status && record.status !== 'ready') {
    return record
  }

  try {
    const ok = await pushToSupabase(record)
    if (ok) {
      record.synced = true
      await upsertLocal(record)
      await removePending(record.id)
    } else {
      await queuePending(record)
    }
  } catch (err) {
    console.warn('saveMeeting sync failed, queued:', err)
    await queuePending(record)
  }

  return record
}

export async function deleteMeeting(id: string): Promise<void> {
  const store = await getStore()
  store.set('meetings', store.get('meetings').filter((m) => m.id !== id))
  store.set('pending', store.get('pending').filter((m) => m.id !== id))
  const client = getSupabase()
  if (!client) return
  const { error } = await client.from('meetings').delete().eq('id', id)
  if (error) console.warn('Supabase delete error:', error.message)
}

export async function listMeetings(): Promise<Meeting[]> {
  const store = await getStore()
  const local = store.get('meetings')
  const client = getSupabase()
  if (!client) return local
  try {
    const { data, error } = await client
      .from('meetings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error || !data) return local
    const merged = new Map<string, Meeting>()
    for (const m of local) merged.set(m.id, m)
    for (const row of data as Meeting[]) merged.set(row.id, { ...row, synced: true })
    const list = Array.from(merged.values()).sort((a, b) =>
      a.created_at < b.created_at ? 1 : -1
    )
    store.set('meetings', list)
    return list
  } catch (err) {
    console.warn('listMeetings fallback to local:', err)
    return local
  }
}

export async function syncPendingMeetings(): Promise<{ synced: number; remaining: number }> {
  const store = await getStore()
  const pending = store.get('pending')
  let synced = 0
  for (const meeting of pending) {
    const ok = await pushToSupabase(meeting)
    if (ok) {
      synced++
      await removePending(meeting.id)
      await upsertLocal({ ...meeting, synced: true })
    }
  }
  return { synced, remaining: store.get('pending').length }
}
