import { MeetingDetectedPayload } from '../shared/types'

type Callbacks = {
  onDetected: (p: MeetingDetectedPayload) => void
  onEnded: () => void
}

const TEAMS_APPS = [/teams/i, /microsoft teams/i]
const TEAMS_TITLE_PATTERNS = [/reuni[aã]o/i, /meeting/i, /microsoft teams/i]
const BROWSER_APPS = [/chrome/i, /arc/i, /brave/i, /edge/i, /safari/i, /firefox/i, /vivaldi/i]
const MEET_TITLE_PATTERNS = [/meet\.google\.com/i, /google meet/i, /^meet\s*[-–]/i, /\bmeet\s*[-–]/i]

let pollTimer: NodeJS.Timeout | null = null
let currentMeetingTitle: string | null = null
let warnedOnce = false

function isMeetingWindow(title: string, owner: string): boolean {
  if (TEAMS_APPS.some((r) => r.test(owner)) && TEAMS_TITLE_PATTERNS.some((r) => r.test(title))) {
    return true
  }
  if (BROWSER_APPS.some((r) => r.test(owner)) && MEET_TITLE_PATTERNS.some((r) => r.test(title))) {
    return true
  }
  return false
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
