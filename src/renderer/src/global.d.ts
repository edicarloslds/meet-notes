import type { DistillAPI } from '../../preload'

declare global {
  interface Window {
    distill: DistillAPI
  }
}

export {}
