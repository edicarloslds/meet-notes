import { MeetingDetectedPayload } from '../shared/types'

type Callbacks = {
  onDetected: (p: MeetingDetectedPayload) => void
  onEnded: () => void
}

const TEAMS_APPS = [/\bmicrosoft teams\b/i, /\bmsteams\b/i, /\bteams\b/i]
const BROWSER_APPS = [/chrome/i, /\barc\b/i, /brave/i, /edge/i, /safari/i, /firefox/i, /vivaldi/i, /opera/i]

// Google Meet rooms use a `xxx-yyyy-zzz` code (three-four-three lowercase letters)
const MEET_ROOM_CODE = /\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/
const MEET_URL_IN_TITLE = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i

// Teams web: meetup-join URL or live meeting path signatures
const TEAMS_WEB_HOST = /teams\.(microsoft|live)\.com/i
const TEAMS_PRODUCT_IN_TITLE = /microsoft teams/i
const TEAMS_MEETUP_URL = /teams\.(microsoft|live)\.com\/l?\/?meetup-join/i
// Words that indicate an active call/meeting window (pt-BR and en)
const MEETING_WORDS = /\b(meeting|meetings|reuni[aã]o|reuni[aã]oes|in[- ]call|call with|chamada|em reuni[aã]o|em chamada|on a call)\b/i
// Explicitly skip generic landing/idle titles
const MEET_LANDING_ONLY = /^(google meet|meet)\s*(-–|[-–]|\|)?\s*(google|google chrome|chrome|safari|arc|brave|firefox|edge|vivaldi|opera)?\s*$/i
const TEAMS_LANDING_ONLY = /^microsoft teams\s*$/i

let pollTimer: NodeJS.Timeout | null = null
let currentMeetingTitle: string | null = null
let warnedOnce = false

function isBrowser(owner: string): boolean {
  return BROWSER_APPS.some((r) => r.test(owner))
}

function isTeamsApp(owner: string): boolean {
  return TEAMS_APPS.some((r) => r.test(owner))
}

function isMeetMeeting(title: string, owner: string): boolean {
  if (!isBrowser(owner)) return false
  if (MEET_LANDING_ONLY.test(title.trim())) return false
  if (MEET_URL_IN_TITLE.test(title)) return true
  // A bare room code is only strong evidence when the "Meet" keyword is also
  // present — avoids false positives on random pages that happen to contain a
  // 3-4-3 letter sequence.
  return /\bmeet\b/i.test(title) && MEET_ROOM_CODE.test(title)
}

function isTeamsWebMeeting(title: string, owner: string): boolean {
  if (!isBrowser(owner)) return false
  if (TEAMS_MEETUP_URL.test(title)) return true
  // Browser tab titles on Teams meetings usually read like
  // "Meeting in 'Channel' | Microsoft Teams" or "Reunião | Microsoft Teams".
  // Require the Teams product name + a meeting keyword, or the Teams host.
  const hasTeams = TEAMS_WEB_HOST.test(title) || TEAMS_PRODUCT_IN_TITLE.test(title)
  if (!hasTeams) return false
  if (TEAMS_LANDING_ONLY.test(title.trim())) return false
  return MEETING_WORDS.test(title)
}

function isTeamsAppMeeting(title: string, owner: string): boolean {
  if (!isTeamsApp(owner)) return false
  if (TEAMS_LANDING_ONLY.test(title.trim())) return false
  // Teams' main window stays titled "Microsoft Teams". The call/meeting window
  // has distinct text (e.g. "Meeting in <channel> | Microsoft Teams",
  // "Reunião | Microsoft Teams") — require a meeting keyword.
  return MEETING_WORDS.test(title)
}

function isMeetingWindow(title: string, owner: string): boolean {
  if (!title) return false
  return isMeetMeeting(title, owner) || isTeamsWebMeeting(title, owner) || isTeamsAppMeeting(title, owner)
}

export function startMeetingWatcher(cb: Callbacks): void {
  if (pollTimer) return

  const poll = async (): Promise<void> => {
    try {
      const { activeWindow } = await import('get-windows')
      const win = await activeWindow()
      if (!win) return
      const title = win.title ?? ''
      const owner = win.owner?.name ?? ''
      const isMeeting = isMeetingWindow(title, owner)

      if (isMeeting && currentMeetingTitle !== title) {
        currentMeetingTitle = title
        cb.onDetected({
          title,
          appName: owner,
          detectedAt: new Date().toISOString()
        })
      } else if (!isMeeting && currentMeetingTitle) {
        currentMeetingTitle = null
        cb.onEnded()
      }
    } catch (err) {
      if (!warnedOnce) {
        warnedOnce = true
        const msg = err instanceof Error ? err.message : String(err)
        if (/accessibility/i.test(msg)) {
          console.warn(
            '[meetingWatcher] macOS Accessibility permission required. ' +
              'Grant it in System Settings › Privacy & Security › Accessibility for Electron/MeetNotes.'
          )
        } else {
          console.warn('[meetingWatcher] poll failed:', msg)
        }
      }
    }
  }

  pollTimer = setInterval(poll, 3000)
  void poll()
}

export function stopMeetingWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  currentMeetingTitle = null
}
