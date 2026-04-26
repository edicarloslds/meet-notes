import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import type { AudioChunkPayload, LiveTranscriptionEvent } from '../shared/types'

interface AppleSpeechCommand {
  type: 'start' | 'audio' | 'finish' | 'cancel'
  locale?: string
  sampleRate?: number
  requiresOnDevice?: boolean
  contextualStrings?: string[]
  pcm?: string
}

interface AppleSpeechHelperEvent {
  type: 'ready' | 'result' | 'error' | 'done'
  text?: string
  isFinal?: boolean
  message?: string
}

export interface AppleSpeechSessionOptions {
  meetingId: string
  locale: string
  requiresOnDevice: boolean
  contextualStrings?: string[]
  onResult: (event: LiveTranscriptionEvent) => void
  onError?: (message: string) => void
}

export class AppleSpeechSession {
  private proc: ChildProcessWithoutNullStreams | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((err: Error) => void) | null = null
  private doneResolve: (() => void) | null = null
  private doneReject: ((err: Error) => void) | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private closed = false
  private done = false

  constructor(private readonly options: AppleSpeechSessionOptions) {}

  async start(sampleRate: number): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('Apple Speech só está disponível no macOS.')
    }

    const helperPath = resolveAppleSpeechHelperPath()
    if (!helperPath) {
      throw new Error(
        'Helper do Apple Speech não encontrado. Rode `pnpm build:apple-speech` antes de usar esta engine.'
      )
    }

    this.proc = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })

    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    const done = new Promise<void>((resolve, reject) => {
      this.doneResolve = resolve
      this.doneReject = reject
    })
    void done.catch(() => undefined)

    const rl = createInterface({ input: this.proc.stdout })
    rl.on('line', (line) => this.handleHelperLine(line))

    this.proc.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim()
      if (message) console.warn(`[apple-speech-helper] ${message}`)
    })

    this.proc.on('error', (err) => {
      this.rejectPending(err)
      this.options.onError?.(err.message)
    })

    this.proc.on('close', (code, signal) => {
      this.closed = true
      this.done = true
      const message = `Apple Speech helper encerrou (${code ?? signal ?? 'sem código'}).`
      this.readyReject?.(new Error(message))
      this.doneResolve?.()
      rl.close()
    })

    await this.send({
      type: 'start',
      locale: this.options.locale,
      sampleRate,
      requiresOnDevice: this.options.requiresOnDevice,
      contextualStrings: this.options.contextualStrings ?? []
    })
    await ready
  }

  async appendAudio(chunk: AudioChunkPayload, sampleRate: number): Promise<void> {
    if (!this.proc || this.closed || chunk.pcm.byteLength === 0) return
    await this.send({
      type: 'audio',
      sampleRate,
      pcm: Buffer.from(chunk.pcm).toString('base64')
    })
  }

  async finish(timeoutMs = 15000): Promise<void> {
    if (!this.proc || this.closed) return
    if (this.done) {
      this.dispose()
      return
    }
    await this.send({ type: 'finish' })
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        this.doneResolve = resolve
        this.doneReject = reject
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ])
    this.dispose()
  }

  dispose(): void {
    if (!this.proc || this.closed) return
    this.closed = true
    try {
      this.proc.stdin.end(`${JSON.stringify({ type: 'cancel' } satisfies AppleSpeechCommand)}\n`)
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (this.proc && !this.proc.killed) this.proc.kill()
    }, 300)
  }

  private async send(command: AppleSpeechCommand): Promise<void> {
    const proc = this.proc
    if (!proc || this.closed) return
    const payload = `${JSON.stringify(command)}\n`
    this.writeQueue = this.writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          proc.stdin.write(payload, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
    )
    return this.writeQueue
  }

  private handleHelperLine(line: string): void {
    let event: AppleSpeechHelperEvent
    try {
      event = JSON.parse(line) as AppleSpeechHelperEvent
    } catch {
      console.warn(`[apple-speech-helper] saída inválida: ${line}`)
      return
    }

    if (event.type === 'ready') {
      this.readyResolve?.()
      this.readyResolve = null
      this.readyReject = null
      return
    }

    if (event.type === 'result') {
      const text = event.text?.trim() ?? ''
      if (!text) return
      this.options.onResult({
        meetingId: this.options.meetingId,
        text,
        isFinal: event.isFinal === true,
        engine: 'apple-speech',
        at: Date.now()
      })
      return
    }

    if (event.type === 'error') {
      const message = event.message?.trim() || 'Falha no Apple Speech.'
      this.options.onError?.(message)
      this.readyReject?.(new Error(message))
      this.doneReject?.(new Error(message))
      return
    }

    if (event.type === 'done') {
      this.done = true
      this.doneResolve?.()
    }
  }

  private rejectPending(err: Error): void {
    this.readyReject?.(err)
    this.doneReject?.(err)
  }
}

export function resolveAppleSpeechHelperPath(): string | null {
  const name = 'apple-speech-helper'
  const appRoot = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'bin', name)]
    : [
        join(appRoot, 'resources', 'bin', name),
        join(appRoot, 'native', 'apple-speech-helper', '.build', 'release', name),
        join(appRoot, 'native', 'apple-speech-helper', '.build', 'debug', name)
      ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}
