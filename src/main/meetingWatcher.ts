import { MeetingDetectedPayload } from '../shared/types'

type Callbacks = {
  onDetected: (p: MeetingDetectedPayload) => void
  onEnded: () => void
}

const TEAMS_APPS = [/\bmicrosoft teams\b/i, /\bmsteams\b/i, /\bteams\b/i]
const TEAMS_BUNDLE_IDS = [/com\.microsoft\.teams/i, /com\.microsoft\.teams2/i, /msteams/i]
const BROWSER_APPS = [/chrome/i, /\barc\b/i, /brave/i, /edge/i, /safari/i, /firefox/i, /vivaldi/i, /opera/i]

// Google Meet rooms use a `xxx-yyyy-zzz` code (three-four-three lowercase letters)
const MEET_ROOM_CODE = /\b[a-z]{3}-[a-z]{4}-[a-z]{3}\b/
const MEET_URL_IN_TITLE = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i

// Teams web: meetup-join URL or live meeting path signatures
const TEAMS_WEB_HOST = /teams\.(microsoft|live)\.com/i
const TEAMS_PRODUCT_IN_TITLE = /microsoft teams/i
const TEAMS_MEETUP_URL = /teams\.(microsoft|live)\.com\/l?\/?meetup-join/i
// Words that indicate an active call/meeting window (pt-BR and en)
const MEETING_WORDS =
  /\b(meeting|meetings|reuni[aã]o|reuni[aã]oes|in[- ]call|call with|calling|call|chamada|liga[cç][aã]o|em reuni[aã]o|em chamada|on a call|webinar|town hall|live event|evento ao vivo|apresentando|presenting|sharing|compartilhando)\b/i
const TEAMS_BRANDED_TITLE = /(?:\||-|–)\s*microsoft teams\b/i
const TEAMS_NON_MEETING_TITLES = [
  /\bactivity\b/i,
  /\bchat\b/i,
  /\bcalendar\b/i,
  /\bcalls\b/i,
  /\bfiles\b/i,
  /\bhome\b/i,
  /\bfeed\b/i,
  /\bnotifications\b/i,
  /\bsettings\b/i,
  /\bteams\b/i,
  /\bapps\b/i,
  /\bhelp\b/i,
  /\bupdates\b/i,
  /\bplanner\b/i,
  /\bapprovals\b/i,
  /\btasks\b/i,
  /\bvoicemail\b/i,
  /\bcontacts\b/i
]
// Explicitly skip generic landing/idle titles
const MEET_LANDING_ONLY = /^(google meet|meet)\s*(-–|[-–]|\|)?\s*(google|google chrome|chrome|safari|arc|brave|firefox|edge|vivaldi|opera)?\s*$/i
const TEAMS_LANDING_ONLY = /^microsoft teams\s*$/i

let pollTimer: NodeJS.Timeout | null = null
let currentMeetingWindowId: number | null = null
let warnedOnce = false

type WindowOwner = {
  name?: string
  bundleId?: string
  path?: string
}

type WindowLike = {
  id: number
  title: string
  bounds?: {
    width: number
    height: number
  }
  owner?: WindowOwner
}

function isBrowser(owner: string): boolean {
  return BROWSER_APPS.some((r) => r.test(owner))
}

function isTeamsApp(owner: WindowOwner | undefined): boolean {
  const name = owner?.name ?? ''
  const bundleId = owner?.bundleId ?? ''
  const path = owner?.path ?? ''
  return (
    TEAMS_APPS.some((r) => r.test(name)) ||
    TEAMS_BUNDLE_IDS.some((r) => r.test(bundleId)) ||
    /\/microsoft teams\.app/i.test(path) ||
    /\/msteams\.app/i.test(path)
  )
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

function isKnownNonMeetingTeamsTitle(title: string): boolean {
  return TEAMS_NON_MEETING_TITLES.some((pattern) => pattern.test(title))
}

function isLikelyDetachedTeamsMeeting(win: WindowLike, teamsWindowCount: number): boolean {
  const title = win.title.trim()
  if (!title || TEAMS_LANDING_ONLY.test(title)) return false
  if (isKnownNonMeetingTeamsTitle(title)) return false

  const width = win.bounds?.width ?? 0
  const height = win.bounds?.height ?? 0
  const isLargeWindow = width >= 720 && height >= 420

  return (TEAMS_BRANDED_TITLE.test(title) || teamsWindowCount > 1) && isLargeWindow
}

function isTeamsAppMeetingWindow(win: WindowLike, teamsWindowCount: number): boolean {
  if (!isTeamsApp(win.owner)) return false
  const title = win.title.trim()
  if (!title) return false
  if (TEAMS_LANDING_ONLY.test(title.trim())) return false
  // Teams' main window stays titled "Microsoft Teams". The call/meeting window
  // often has distinct text (e.g. "Meeting in <channel> | Microsoft Teams",
  // "Reunião | Microsoft Teams"). Since we now confirm with a popup before
  // opening the pill, we can also accept broader "detached Teams window"
  // signals to avoid missing local meeting windows whose title lacks keywords.
  return MEETING_WORDS.test(title) || isLikelyDetachedTeamsMeeting(win, teamsWindowCount)
}

function isMeetingWindow(win: WindowLike, teamsWindowCount: number): boolean {
  const title = win.title ?? ''
  const owner = win.owner?.name ?? ''
  if (!title) return false
  return (
    isMeetMeeting(title, owner) ||
    isTeamsWebMeeting(title, owner) ||
    isTeamsAppMeetingWindow(win, teamsWindowCount)
  )
}

function dedupeWindows(windows: WindowLike[]): WindowLike[] {
  const seen = new Set<number>()
  const unique: WindowLike[] = []
  for (const win of windows) {
    if (!win || typeof win.id !== 'number' || seen.has(win.id)) continue
    seen.add(win.id)
    unique.push(win)
  }
  return unique
}

function toWindowLike(
  win:
    | {
        id: number
        title?: string
        bounds?: { width: number; height: number }
        owner?: WindowOwner
      }
    | undefined
): WindowLike | null {
  if (!win || typeof win.id !== 'number') return null
  return {
    id: win.id,
    title: win.title ?? '',
    bounds: win.bounds,
    owner: win.owner
  }
}

export function startMeetingWatcher(cb: Callbacks): void {
  if (pollTimer) return

  const poll = async (): Promise<void> => {
    try {
      const { activeWindow, openWindows } = await import('get-windows')
      const [active, open] = await Promise.all([activeWindow(), openWindows()])
      const windows = dedupeWindows(
        [active, ...open]
          .map((win) => toWindowLike(win))
          .filter((win): win is WindowLike => win !== null)
      )
      const teamsWindowCount = windows.filter((win) => isTeamsApp(win.owner)).length
      const detected = windows.find((win) => isMeetingWindow(win, teamsWindowCount))

      if (detected && currentMeetingWindowId !== detected.id) {
        currentMeetingWindowId = detected.id
        cb.onDetected({
          title: detected.title ?? '',
          appName: detected.owner?.name ?? '',
          detectedAt: new Date().toISOString(),
          windowId: detected.id,
          bundleId: detected.owner?.bundleId
        })
      } else if (!detected && currentMeetingWindowId !== null) {
        currentMeetingWindowId = null
        cb.onEnded()
      }
    } catch (err) {
      if (!warnedOnce) {
        warnedOnce = true
        const msg = err instanceof Error ? err.message : String(err)
        if (/accessibility/i.test(msg)) {
          console.warn(
            '[meetingWatcher] macOS Accessibility permission required. ' +
              'Grant it in System Settings › Privacy & Security › Accessibility for Electron/Distill.'
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
  currentMeetingWindowId = null
}
