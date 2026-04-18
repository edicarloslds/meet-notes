import type { MeetNotesAPI } from '../../preload'

declare global {
  interface Window {
    meetnotes: MeetNotesAPI
  }
}

export {}
