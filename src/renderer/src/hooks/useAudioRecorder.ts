import { useRef, useState } from 'react'
import {
  type AudioChunkPayload,
  CHUNK_SAMPLE_RATE,
  CHUNK_WINDOW_SECONDS,
  type AudioCaptureMode,
  type AudioCaptureSource
} from '../../../shared/types'

const CHUNK_SAMPLES = CHUNK_SAMPLE_RATE * CHUNK_WINDOW_SECONDS
const CHUNK_OVERLAP_SECONDS = 4
const CHUNK_OVERLAP_SAMPLES = CHUNK_SAMPLE_RATE * CHUNK_OVERLAP_SECONDS

function getWorkletUrl(): string {
  return new URL('pcm-worklet.js', document.baseURI).href
}

export interface AudioRecorderHandle {
  start: (
    onChunk: (chunk: AudioChunkPayload) => void,
    mode?: AudioCaptureMode
  ) => Promise<{ source: AudioCaptureSource; warnings: string[] }>
  stop: () => Promise<AudioChunkPayload | null>
  sampleRate: number
  isRecording: boolean
  stream: MediaStream | null
  captureSource: AudioCaptureSource | null
  captureWarnings: string[]
}

interface CaptureSession {
  inputStreams: MediaStream[]
  source: AudioCaptureSource
  warnings: string[]
}

const MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
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

function extractTail(
  parts: Float32Array[],
  totalSamples: number,
  tailSamples: number
): Float32Array {
  const tail = new Float32Array(tailSamples)
  let writeOffset = 0
  let absoluteCursor = 0
  const targetStart = totalSamples - tailSamples

  for (const part of parts) {
    const partStart = absoluteCursor
    const partEnd = absoluteCursor + part.length
    if (partEnd > targetStart) {
      const from = Math.max(0, targetStart - partStart)
      const slice = part.subarray(from)
      tail.set(slice, writeOffset)
      writeOffset += slice.length
    }
    absoluteCursor = partEnd
  }

  return tail
}

function samplesToMs(samples: number): number {
  return Math.round((samples / CHUNK_SAMPLE_RATE) * 1000)
}

export function useAudioRecorder(): AudioRecorderHandle {
  const inputStreamsRef = useRef<MediaStream[]>([])
  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const sinkRef = useRef<GainNode | null>(null)
  const sourceRefs = useRef<MediaStreamAudioSourceNode[]>([])
  const partsRef = useRef<Float32Array[]>([])
  const samplesRef = useRef(0)
  const onChunkRef = useRef<((chunk: AudioChunkPayload) => void) | null>(null)
  const totalCapturedSamplesRef = useRef(0)
  const bufferStartSampleRef = useRef(0)
  const lastEmittedEndSampleRef = useRef(0)
  const [isRecording, setIsRecording] = useState(false)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [captureSource, setCaptureSource] = useState<AudioCaptureSource | null>(null)
  const [captureWarnings, setCaptureWarnings] = useState<string[]>([])

  const flushChunk = (keepTailSamples = 0): AudioChunkPayload | null => {
    if (samplesRef.current === 0) return null
    const startSample = bufferStartSampleRef.current
    const endSample = startSample + samplesRef.current
    const int16 = floatToInt16(partsRef.current, samplesRef.current)
    const payload: AudioChunkPayload = {
      pcm: int16.buffer as ArrayBuffer,
      startMs: samplesToMs(startSample),
      endMs: samplesToMs(endSample)
    }

    const tailSamples = Math.min(keepTailSamples, samplesRef.current)
    if (tailSamples > 0) {
      partsRef.current = [extractTail(partsRef.current, samplesRef.current, tailSamples)]
      samplesRef.current = tailSamples
      bufferStartSampleRef.current = endSample - tailSamples
    } else {
      partsRef.current = []
      samplesRef.current = 0
      bufferStartSampleRef.current = endSample
    }
    lastEmittedEndSampleRef.current = endSample
    return payload
  }

  const start = async (
    onChunk: (chunk: AudioChunkPayload) => void,
    mode: AudioCaptureMode = 'auto'
  ): Promise<{ source: AudioCaptureSource; warnings: string[] }> => {
    onChunkRef.current = onChunk
    partsRef.current = []
    samplesRef.current = 0
    totalCapturedSamplesRef.current = 0
    bufferStartSampleRef.current = 0
    lastEmittedEndSampleRef.current = 0

    const session = await createCaptureSession(mode)
    inputStreamsRef.current = session.inputStreams
    setCaptureSource(session.source)
    setCaptureWarnings(session.warnings)

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AudioCtx({ sampleRate: CHUNK_SAMPLE_RATE })
    ctxRef.current = ctx

    await ctx.audioWorklet.addModule(getWorkletUrl())
    const node = new AudioWorkletNode(ctx, 'pcm-collector')
    nodeRef.current = node
    const sink = ctx.createGain()
    sink.gain.value = 0
    sinkRef.current = sink
    node.connect(sink)
    sink.connect(ctx.destination)

    const monitor = ctx.createMediaStreamDestination()
    const sourceNodes = session.inputStreams.map((inputStream) => {
      const source = ctx.createMediaStreamSource(inputStream)
      source.connect(node)
      source.connect(monitor)
      return source
    })
    sourceRefs.current = sourceNodes
    setStream(monitor.stream)

    node.port.onmessage = (ev: MessageEvent<Float32Array>): void => {
      const data = ev.data
      partsRef.current.push(data)
      samplesRef.current += data.length
      totalCapturedSamplesRef.current += data.length
      if (samplesRef.current >= CHUNK_SAMPLES) {
        const chunk = flushChunk(CHUNK_OVERLAP_SAMPLES)
        if (chunk) onChunkRef.current?.(chunk)
      }
    }

    setIsRecording(true)
    return { source: session.source, warnings: session.warnings }
  }

  const stop = async (): Promise<AudioChunkPayload | null> => {
    const hasNewAudio = totalCapturedSamplesRef.current > lastEmittedEndSampleRef.current
    const remaining = hasNewAudio ? flushChunk() : null
    try {
      nodeRef.current?.port.close()
      nodeRef.current?.disconnect()
      sinkRef.current?.disconnect()
      sourceRefs.current.forEach((source) => source.disconnect())
    } catch {
      /* ignore */
    }
    inputStreamsRef.current.forEach((inputStream) => stopStream(inputStream))
    await ctxRef.current?.close().catch(() => undefined)
    nodeRef.current = null
    sinkRef.current = null
    sourceRefs.current = []
    ctxRef.current = null
    inputStreamsRef.current = []
    onChunkRef.current = null
    setStream(null)
    setIsRecording(false)
    setCaptureSource(null)
    setCaptureWarnings([])
    return remaining
  }

  return {
    start,
    stop,
    sampleRate: CHUNK_SAMPLE_RATE,
    isRecording,
    stream,
    captureSource,
    captureWarnings
  }
}

async function createCaptureSession(mode: AudioCaptureMode): Promise<CaptureSession> {
  switch (mode) {
    case 'microphone': {
      const micStream = await requestMicrophoneStream()
      return { inputStreams: [micStream], source: 'microphone', warnings: [] }
    }
    case 'system': {
      const systemStream = await requestSystemStream()
      return { inputStreams: [systemStream], source: 'system', warnings: [] }
    }
    case 'mixed': {
      const warnings: string[] = []
      const { stream: systemStream, error: systemError } = await attemptSystemStream()
      const { stream: micStream, error: micError } = await attemptMicrophoneStream()

      const hasSystem = hasAudioTrack(systemStream)
      const hasMic = hasAudioTrack(micStream)

      if (hasSystem && hasMic) {
        return { inputStreams: [systemStream!, micStream!], source: 'mixed', warnings }
      }
      if (hasSystem) {
        if (micError) warnings.push(`Microfone indisponivel: ${micError}`)
        return { inputStreams: [systemStream!], source: 'system', warnings }
      }
      if (hasMic) {
        if (systemError) warnings.push(`Audio do sistema indisponivel: ${systemError}`)
        return { inputStreams: [micStream!], source: 'microphone', warnings }
      }

      stopStream(systemStream)
      stopStream(micStream)
      throw new Error(joinErrorMessages(systemError, micError, 'Nenhuma fonte de audio ficou disponivel.'))
    }
    case 'auto':
    default: {
      const { stream: systemStream, error } = await attemptSystemStream()
      if (hasAudioTrack(systemStream)) {
        return { inputStreams: [systemStream!], source: 'system', warnings: [] }
      }
      stopStream(systemStream)
      const micStream = await requestMicrophoneStream()
      const warnings = [
        error
          ? `Audio do sistema indisponivel; usando microfone. ${error}`
          : 'Audio do sistema indisponivel; usando microfone.'
      ]
      return { inputStreams: [micStream], source: 'microphone', warnings }
    }
  }
}

async function requestSystemStream(): Promise<MediaStream> {
  const { stream, error } = await attemptSystemStream()
  if (hasAudioTrack(stream)) return stream as MediaStream
  stopStream(stream)
  throw new Error(error ?? 'Nenhum audio do sistema foi disponibilizado pela captura de tela.')
}

async function requestMicrophoneStream(): Promise<MediaStream> {
  const { stream, error } = await attemptMicrophoneStream()
  if (hasAudioTrack(stream)) return stream as MediaStream
  stopStream(stream)
  throw new Error(error ?? 'Nao foi possivel acessar o microfone.')
}

async function attemptSystemStream(): Promise<{ stream: MediaStream | null; error?: string }> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    })
    if (!hasAudioTrack(stream)) {
      return {
        stream,
        error:
          'Compartilhe uma tela ou janela com audio habilitado, ou troque para o modo Microfone.'
      }
    }
    return { stream }
  } catch (err) {
    return { stream: null, error: normalizeCaptureError(err, 'Nao foi possivel iniciar a captura do sistema.') }
  }
}

async function attemptMicrophoneStream(): Promise<{ stream: MediaStream | null; error?: string }> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: MIC_CONSTRAINTS,
      video: false
    })
    if (!hasAudioTrack(stream)) {
      return { stream, error: 'O microfone foi concedido sem faixa de audio ativa.' }
    }
    return { stream }
  } catch (err) {
    return { stream: null, error: normalizeCaptureError(err, 'Nao foi possivel acessar o microfone.') }
  }
}

function hasAudioTrack(stream: MediaStream | null): boolean {
  if (!stream) return false
  return stream.getAudioTracks().some((track) => track.readyState === 'live')
}

function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop())
}

function joinErrorMessages(...messages: Array<string | undefined>): string {
  const unique = messages.map((message) => message?.trim()).filter(Boolean)
  return unique.length > 0 ? unique.join(' ') : 'Falha ao iniciar a captura.'
}

function normalizeCaptureError(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const domErr = err as DOMException
    switch (domErr.name) {
      case 'NotAllowedError':
        return 'Permissao negada pelo macOS ou pelo seletor de captura.'
      case 'NotFoundError':
        return 'Nenhuma fonte de captura compativel foi encontrada.'
      case 'NotReadableError':
        return 'A fonte de captura esta em uso ou indisponivel no momento.'
      case 'AbortError':
        return 'A captura foi cancelada antes de iniciar.'
      default:
        if (typeof domErr.message === 'string' && domErr.message.trim()) return domErr.message.trim()
    }
  }
  return fallback
}
