import { useRef, useState } from 'react'

export function useAudioRecorder(): {
  start: () => Promise<void>
  stop: () => Promise<Blob>
  isRecording: boolean
  stream: MediaStream | null
} {
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [stream, setStream] = useState<MediaStream | null>(null)

  const start = async (): Promise<void> => {
    chunksRef.current = []
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    streamRef.current = micStream
    setStream(micStream)

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    const recorder = new MediaRecorder(micStream, {
      mimeType: mime,
      audioBitsPerSecond: 128000
    })
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.start(1000)
    recorderRef.current = recorder
    setIsRecording(true)
  }

  const stop = async (): Promise<Blob> => {
    const recorder = recorderRef.current
    if (!recorder) throw new Error('Recorder not started')
    const done = new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        resolve(blob)
      }
    })
    recorder.stop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recorderRef.current = null
    setStream(null)
    setIsRecording(false)
    return done
  }

  return { start, stop, isRecording, stream }
}
