import { useRef, useState } from 'react'

export function useAudioRecorder(): {
  start: () => Promise<void>
  stop: () => Promise<Blob>
  isRecording: boolean
} {
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const [isRecording, setIsRecording] = useState(false)

  const start = async (): Promise<void> => {
    chunksRef.current = []
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    streamRef.current = stream
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    const recorder = new MediaRecorder(stream, { mimeType: mime })
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
    setIsRecording(false)
    return done
  }

  return { start, stop, isRecording }
}
