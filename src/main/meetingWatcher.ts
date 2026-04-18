import { MeetingDetectedPayload } from '../shared/types'

type Callbacks = {
  onDetected: (p: MeetingDetectedPayload) => void
  onEnded: () => void
}

const MEETING_KEYWORDS = [/reuni[aã]o/i, /meeting/i, /microsoft teams/i]
const TEAMS_APPS = [/teams/i, /microsoft teams/i]

let pollTimer: NodeJS.Timeout | null = null
let currentMeetingTitle: string | null = null
let warnedOnce = false

function isMeetingWindow(title: string, owner: string): boolean {
  const appMatch = TEAMS_APPS.some((r) => r.test(owner))
  if (!appMatch) return false
  return MEETING_KEYWORDS.some((r) => r.test(title))
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
