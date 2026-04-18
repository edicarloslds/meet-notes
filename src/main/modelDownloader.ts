import { app, BrowserWindow } from 'electron'
import { createWriteStream } from 'fs'
import { mkdir, rename, stat, unlink } from 'fs/promises'
import { get as httpsGet } from 'https'
import { join } from 'path'
import { IpcChannels, ModelDownloadProgress, WhisperModelInfo, WhisperModelStatus } from '../shared/types'

const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export const WHISPER_MODELS: WhisperModelInfo[] = [
  {
    id: 'tiny',
    label: 'Tiny',
    filename: 'ggml-tiny.bin',
    sizeMb: 75,
    description: 'Mais rápido, menor precisão. Ideal para testes.'
  },
  {
    id: 'base',
    label: 'Base',
    filename: 'ggml-base.bin',
    sizeMb: 142,
    description: 'Balanço razoável entre velocidade e qualidade.'
  },
  {
    id: 'small',
    label: 'Small',
    filename: 'ggml-small.bin',
    sizeMb: 466,
    description: 'Boa qualidade, ainda rápido em CPU moderna.'
  },
  {
    id: 'medium',
    label: 'Medium',
    filename: 'ggml-medium.bin',
    sizeMb: 1500,
    description: 'Alta qualidade. Mais lento, exige mais RAM.'
  },
  {
    id: 'large-v3',
    label: 'Large v3',
    filename: 'ggml-large-v3.bin',
    sizeMb: 2900,
    description: 'Máxima qualidade. Requer máquina robusta.'
  }
]

function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

export function modelPath(id: string): string | null {
  const info = WHISPER_MODELS.find((m) => m.id === id)
  if (!info) return null
  return join(modelsDir(), info.filename)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isFile() && s.size > 0
  } catch {
    return false
  }
}

export async function listModelStatus(): Promise<WhisperModelStatus[]> {
  await mkdir(modelsDir(), { recursive: true })
  const out: WhisperModelStatus[] = []
  for (const m of WHISPER_MODELS) {
    const p = join(modelsDir(), m.filename)
    const installed = await fileExists(p)
    out.push({ id: m.id, installed, path: installed ? p : undefined })
  }
  return out
}

export async function deleteModel(id: string): Promise<void> {
  const p = modelPath(id)
  if (!p) return
  try {
    await unlink(p)
  } catch {
    /* ignore */
  }
}

interface ActiveDownload {
  id: string
  abort: () => void
}

const active = new Map<string, ActiveDownload>()

function broadcastProgress(progress: ModelDownloadProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannels.ModelProgress, progress)
    }
  }
}

export function cancelDownload(id: string): void {
  const entry = active.get(id)
  if (entry) entry.abort()
}

export async function downloadModel(id: string): Promise<string> {
  const info = WHISPER_MODELS.find((m) => m.id === id)
  if (!info) throw new Error(`Modelo desconhecido: ${id}`)
  if (active.has(id)) throw new Error(`Download já em andamento: ${id}`)

  await mkdir(modelsDir(), { recursive: true })
  const finalPath = join(modelsDir(), info.filename)
  const tmpPath = `${finalPath}.part`

  if (await fileExists(finalPath)) {
    broadcastProgress({ id, receivedBytes: 1, totalBytes: 1, done: true })
    return finalPath
  }

  return new Promise<string>((resolve, reject) => {
    let aborted = false
    let received = 0

    const cleanup = async (): Promise<void> => {
      active.delete(id)
      try {
        await unlink(tmpPath)
      } catch {
        /* ignore */
      }
    }

    const doRequest = (url: string, redirects = 0): void => {
      const req = httpsGet(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 5) {
            reject(new Error('Redirecionamentos demais'))
            return
          }
          res.resume()
          doRequest(res.headers.location, redirects + 1)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} ao baixar modelo`))
          res.resume()
          return
        }
        const total = Number(res.headers['content-length']) || info.sizeMb * 1024 * 1024
        const out = createWriteStream(tmpPath)
        let lastEmit = 0

        res.on('data', (chunk: Buffer) => {
          if (aborted) return
          received += chunk.length
          const now = Date.now()
          if (now - lastEmit > 150) {
            lastEmit = now
            broadcastProgress({ id, receivedBytes: received, totalBytes: total, done: false })
          }
        })
        res.on('error', (err) => {
          out.destroy()
          void cleanup()
          reject(err)
        })
        res.pipe(out)
        out.on('finish', () => {
          out.close(async () => {
            if (aborted) {
              await cleanup()
              reject(new Error('Download cancelado'))
              return
            }
            try {
              await rename(tmpPath, finalPath)
              broadcastProgress({ id, receivedBytes: total, totalBytes: total, done: true })
              active.delete(id)
              resolve(finalPath)
            } catch (err) {
              await cleanup()
              reject(err as Error)
            }
          })
        })
        out.on('error', async (err) => {
          await cleanup()
          reject(err)
        })

        active.set(id, {
          id,
          abort: () => {
            aborted = true
            req.destroy(new Error('aborted'))
            res.destroy()
          }
        })
      })
      req.on('error', async (err) => {
        if (aborted) {
          broadcastProgress({ id, receivedBytes: received, totalBytes: 0, done: true, error: 'cancelled' })
        } else {
          broadcastProgress({ id, receivedBytes: received, totalBytes: 0, done: true, error: err.message })
        }
        await cleanup()
        reject(err)
      })
    }

    doRequest(`${BASE_URL}/${info.filename}`)
  })
}
