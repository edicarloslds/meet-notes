import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Meeting, PendingMeta } from '../shared/types'
import { getSettingSync } from './settingsService'

const BACKOFF_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]

function nextBackoff(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)]
}

interface StoreSchema {
  meetings: Meeting[]
  pending: Meeting[]
  pendingMeta: Record<string, PendingMeta>
  deleted: string[]
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
      name: 'distill',
      defaults: { meetings: [], pending: [], pendingMeta: {}, deleted: [] }
    }) as unknown as StoreInstance
  })()
  return storePromise
}

let supabase: SupabaseClient | null = null
let supabaseKey: string | null = null

function getSupabase(): SupabaseClient | null {
  const url = getSettingSync('supabaseUrl')
  const key = getSettingSync('supabaseAnonKey')
  if (!url || !key) {
    supabase = null
    supabaseKey = null
    return null
  }
  const cacheKey = `${url}::${key}`
  if (supabase && supabaseKey === cacheKey) return supabase
  supabase = createClient(url, key)
  supabaseKey = cacheKey
  return supabase
}

export function resetSupabaseClient(): void {
  supabase = null
  supabaseKey = null
}

async function upsertLocal(meeting: Meeting): Promise<void> {
  const store = await getStore()
  const all = store.get('meetings')
  store.set('meetings', [meeting, ...all.filter((m) => m.id !== meeting.id)])
}

async function queuePending(meeting: Meeting, lastError?: string): Promise<void> {
  const store = await getStore()
  const pending = store.get('pending')
  store.set('pending', [meeting, ...pending.filter((m) => m.id !== meeting.id)])
  const meta = { ...(store.get('pendingMeta') ?? {}) }
  const prev = meta[meeting.id]
  const attempts = (prev?.attempts ?? 0) + 1
  meta[meeting.id] = {
    attempts,
    nextAttemptAt: Date.now() + nextBackoff(attempts),
    lastError
  }
  store.set('pendingMeta', meta)
}

async function removePending(id: string): Promise<void> {
  const store = await getStore()
  store.set(
    'pending',
    store.get('pending').filter((m) => m.id !== id)
  )
  const meta = { ...(store.get('pendingMeta') ?? {}) }
  if (meta[id]) {
    delete meta[id]
    store.set('pendingMeta', meta)
  }
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
      await queuePending(record, 'Falha ao enviar para o Supabase.')
    }
  } catch (err) {
    console.warn('saveMeeting sync failed, queued:', err)
    await queuePending(record, (err as Error).message)
  }

  return record
}

export async function deleteMeeting(id: string): Promise<void> {
  const store = await getStore()
  store.set('meetings', store.get('meetings').filter((m) => m.id !== id))
  store.set('pending', store.get('pending').filter((m) => m.id !== id))
  const tombstones = store.get('deleted')
  if (!tombstones.includes(id)) store.set('deleted', [...tombstones, id])
  const client = getSupabase()
  if (!client) return
  const { error } = await client.from('meetings').delete().eq('id', id)
  if (error) {
    console.warn('Supabase delete error:', error.message)
    return
  }
  store.set('deleted', store.get('deleted').filter((d) => d !== id))
}

export async function cleanupStaleProcessing(): Promise<string[]> {
  const store = await getStore()
  const all = store.get('meetings')
  const stale = all.filter((m) => m.status === 'processing').map((m) => m.id)
  if (stale.length === 0) return []
  for (const id of stale) {
    await deleteMeeting(id).catch(() => undefined)
  }
  return stale
}

export async function listMeetings(): Promise<Meeting[]> {
  const store = await getStore()
  const local = store.get('meetings')
  const tombstones = new Set(store.get('deleted'))
  const client = getSupabase()
  if (!client) return local.filter((m) => !tombstones.has(m.id))
  try {
    const { data, error } = await client
      .from('meetings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    if (error || !data) return local.filter((m) => !tombstones.has(m.id))
    const merged = new Map<string, Meeting>()
    for (const m of local) merged.set(m.id, m)
    for (const row of data as Meeting[]) {
      if (tombstones.has(row.id)) {
        void client.from('meetings').delete().eq('id', row.id).then(({ error: delErr }) => {
          if (!delErr) {
            const remaining = store.get('deleted').filter((d) => d !== row.id)
            store.set('deleted', remaining)
          }
        })
        continue
      }
      const existing = merged.get(row.id)
      merged.set(row.id, {
        ...row,
        processing_ms: row.processing_ms ?? existing?.processing_ms,
        synced: true
      })
    }
    const list = Array.from(merged.values())
      .filter((m) => !tombstones.has(m.id))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    store.set('meetings', list)
    return list
  } catch (err) {
    console.warn('listMeetings fallback to local:', err)
    return local.filter((m) => !tombstones.has(m.id))
  }
}

export async function syncPendingMeetings(
  options: { force?: boolean } = {}
): Promise<{ synced: number; remaining: number }> {
  const store = await getStore()
  const pending = store.get('pending')
  const meta = store.get('pendingMeta') ?? {}
  const now = Date.now()
  let synced = 0
  for (const meeting of pending) {
    const entry = meta[meeting.id]
    if (!options.force && entry && entry.nextAttemptAt > now) continue
    try {
      const ok = await pushToSupabase(meeting)
      if (ok) {
        synced++
        await removePending(meeting.id)
        await upsertLocal({ ...meeting, synced: true })
      } else {
        await queuePending(meeting, 'Falha ao enviar para o Supabase.')
      }
    } catch (err) {
      await queuePending(meeting, (err as Error).message)
    }
  }
  return { synced, remaining: (await getStore()).get('pending').length }
}

let syncSchedulerTimer: NodeJS.Timeout | null = null

export function startPendingSyncScheduler(intervalMs = 30_000): void {
  if (syncSchedulerTimer) return
  syncSchedulerTimer = setInterval(() => {
    void syncPendingMeetings().catch((err) =>
      console.warn('Scheduled sync failed:', err)
    )
  }, intervalMs)
  if (syncSchedulerTimer.unref) syncSchedulerTimer.unref()
}

export function stopPendingSyncScheduler(): void {
  if (syncSchedulerTimer) {
    clearInterval(syncSchedulerTimer)
    syncSchedulerTimer = null
  }
}
