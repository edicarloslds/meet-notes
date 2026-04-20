import { useRef, useState } from 'react'
import { CHUNK_SAMPLE_RATE, CHUNK_WINDOW_SECONDS } from '../../../shared/types'

const CHUNK_SAMPLES = CHUNK_SAMPLE_RATE * CHUNK_WINDOW_SECONDS

function getWorkletUrl(): string {
  return new URL('pcm-worklet.js', document.baseURI).href
}

export interface AudioRecorderHandle {
  start: (onChunk: (pcm: ArrayBuffer) => void) => Promise<void>
  stop: () => Promise<ArrayBuffer>
  sampleRate: number
  isRecording: boolean
  stream: MediaStream | null
}

function floatToInt16(parts: Float32Array[], totalSamples: number): Int16Array {
  const int16 = new Int16Array(totalSamples)
  let offset = 0
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const s = Math.max(-1, Math.min(1, part[i]))
      int16[offset + i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    offset += part.length
  }
  return int16
}

export function useAudioRecorder(): AudioRecorderHandle {
  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const partsRef = useRef<Float32Array[]>([])
  const samplesRef = useRef(0)
  const onChunkRef = useRef<((pcm: ArrayBuffer) => void) | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [stream, setStream] = useState<MediaStream | null>(null)

  const flushChunk = (): ArrayBuffer | null => {
    if (samplesRef.current === 0) return null
    const int16 = floatToInt16(partsRef.current, samplesRef.current)
    partsRef.current = []
    samplesRef.current = 0
    return int16.buffer as ArrayBuffer
  }

  const start = async (onChunk: (pcm: ArrayBuffer) => void): Promise<void> => {
    onChunkRef.current = onChunk
    partsRef.current = []
    samplesRef.current = 0

    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    streamRef.current = micStream
    setStream(micStream)

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AudioCtx({ sampleRate: CHUNK_SAMPLE_RATE })
    ctxRef.current = ctx

    await ctx.audioWorklet.addModule(getWorkletUrl())
    const source = ctx.createMediaStreamSource(micStream)
    sourceRef.current = source
    const node = new AudioWorkletNode(ctx, 'pcm-collector')
    nodeRef.current = node

    node.port.onmessage = (ev: MessageEvent<Float32Array>): void => {
      const data = ev.data
      partsRef.current.push(data)
      samplesRef.current += data.length
      if (samplesRef.current >= CHUNK_SAMPLES) {
        const buf = flushChunk()
        if (buf) onChunkRef.current?.(buf)
      }
    }

    source.connect(node)
    setIsRecording(true)
  }

  const stop = async (): Promise<ArrayBuffer> => {
    const remaining = flushChunk() ?? new ArrayBuffer(0)
    try {
      nodeRef.current?.port.close()
      nodeRef.current?.disconnect()
      sourceRef.current?.disconnect()
    } catch {
      /* ignore */
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    await ctxRef.current?.close().catch(() => undefined)
    nodeRef.current = null
    sourceRef.current = null
    ctxRef.current = null
    streamRef.current = null
    onChunkRef.current = null
    setStream(null)
    setIsRecording(false)
    return remaining
  }

  return { start, stop, sampleRate: CHUNK_SAMPLE_RATE, isRecording, stream }
}
