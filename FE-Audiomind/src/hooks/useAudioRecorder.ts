import { useCallback, useEffect, useRef, useState } from 'react'

export type AudioRecorderState = 'idle' | 'requesting-permission' | 'recording' | 'paused' | 'stopped' | 'error'

export interface UseAudioRecorderReturn {
  state: AudioRecorderState
  errorMessage: string | null
  audioChunks: Blob[]
  startRecording: () => Promise<void>
  stopRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  duration: number
}

const RECORDER_MIME_TYPE = 'audio/webm; codecs=opus'
const DURATION_TICK_MS = 250

const mapRecorderError = (error: unknown): string => {
  const errorName = error instanceof Error ? error.name : undefined
  const resolvedName = error instanceof DOMException ? error.name : errorName

  if (resolvedName === 'NotAllowedError' || resolvedName === 'PermissionDeniedError') {
    return 'Quyền microphone bị từ chối. Hãy cho phép truy cập microphone để ghi âm.'
  }

  if (resolvedName === 'NotFoundError') {
    return 'Không tìm thấy thiết bị microphone khả dụng.'
  }

  if (resolvedName === 'NotSupportedError') {
    return 'Trình duyệt không hỗ trợ ghi âm WebM/Opus.'
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return 'Không thể khởi tạo ghi âm. Vui lòng thử lại.'
}

export const useAudioRecorder = (): UseAudioRecorderReturn => {
  const [state, setState] = useState<AudioRecorderState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [audioChunks, setAudioChunks] = useState<Blob[]>([])
  const [duration, setDuration] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const durationTimerRef = useRef<number | null>(null)
  const startedAtRef = useRef<number | null>(null)
  const accumulatedMsRef = useRef(0)
  const mountedRef = useRef(true)
  const recorderMimeLoggedRef = useRef(false)

  const stopDurationTimer = useCallback(() => {
    if (durationTimerRef.current !== null) {
      window.clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }
  }, [])

  const updateDuration = useCallback(() => {
    const runningMs = accumulatedMsRef.current + (startedAtRef.current ? Date.now() - startedAtRef.current : 0)
    setDuration(Math.max(0, Math.floor(runningMs / 1000)))
  }, [])

  const startDurationTimer = useCallback(() => {
    stopDurationTimer()
    updateDuration()
    durationTimerRef.current = window.setInterval(() => {
      updateDuration()
    }, DURATION_TICK_MS)
  }, [stopDurationTimer, updateDuration])

  const pauseDurationTimer = useCallback(() => {
    if (startedAtRef.current !== null) {
      accumulatedMsRef.current += Date.now() - startedAtRef.current
      startedAtRef.current = null
    }
    stopDurationTimer()
    updateDuration()
  }, [stopDurationTimer, updateDuration])

  const resetSessionState = useCallback(() => {
    setErrorMessage(null)
    setAudioChunks([])
    setDuration(0)
    accumulatedMsRef.current = 0
    startedAtRef.current = null
  }, [])

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [])

  const finishRecording = useCallback(() => {
    pauseDurationTimer()
    cleanupStream()
    mediaRecorderRef.current = null
    if (mountedRef.current) {
      setState('stopped')
    }
  }, [cleanupStream, pauseDurationTimer])

  const startRecording = useCallback(async () => {
    if (state === 'requesting-permission' || state === 'recording') {
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error')
      setErrorMessage('Trình duyệt không hỗ trợ getUserMedia cho microphone.')
      return
    }

    resetSessionState()
    setState('requesting-permission')
    recorderMimeLoggedRef.current = false

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      const recorder = new MediaRecorder(stream, { mimeType: RECORDER_MIME_TYPE })
      mediaRecorderRef.current = recorder
      streamRef.current = stream

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && mountedRef.current) {
          setAudioChunks((currentChunks) => [...currentChunks, event.data])
        }
      }

      recorder.onpause = () => {
        if (mountedRef.current) {
          setState('paused')
        }
        pauseDurationTimer()
      }

      recorder.onresume = () => {
        if (mountedRef.current) {
          setState('recording')
        }
        startedAtRef.current = Date.now()
        startDurationTimer()
      }

      recorder.onstop = () => {
        finishRecording()
      }

      recorder.onerror = () => {
        if (mountedRef.current) {
          setState('error')
          setErrorMessage('Đã xảy ra lỗi trong quá trình ghi âm.')
        }
        finishRecording()
      }

      recorder.start(1000)
      // Minimal required log: recorder mimeType
      try {
        if (!recorderMimeLoggedRef.current) {
          // eslint-disable-next-line no-console
          console.log(`AUDIO HASH FRONTEND mimeType=${recorder.mimeType}`)
          recorderMimeLoggedRef.current = true
        }
      } catch {
        // ignore logging failures
      }
      startedAtRef.current = Date.now()
      startDurationTimer()
      setState('recording')
    } catch (error) {
      cleanupStream()
      mediaRecorderRef.current = null
      if (mountedRef.current) {
        setState('error')
        setErrorMessage(mapRecorderError(error))
      }
    }
  }, [cleanupStream, finishRecording, pauseDurationTimer, resetSessionState, startDurationTimer, state])

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      if (mountedRef.current && state !== 'error') {
        setState('stopped')
      }
      return
    }

    if (startedAtRef.current !== null) {
      accumulatedMsRef.current += Date.now() - startedAtRef.current
      startedAtRef.current = null
    }

    stopDurationTimer()
    updateDuration()

    try {
      recorder.stop()
    } catch {
      finishRecording()
    }
  }, [finishRecording, state, stopDurationTimer, updateDuration])

  const pauseRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state !== 'recording') {
      return
    }

    try {
      recorder.pause()
    } catch {
      if (mountedRef.current) {
        setState('error')
        setErrorMessage('Không thể tạm dừng ghi âm.')
      }
    }
  }, [])

  const resumeRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state !== 'paused') {
      return
    }

    try {
      recorder.resume()
    } catch {
      if (mountedRef.current) {
        setState('error')
        setErrorMessage('Không thể tiếp tục ghi âm.')
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      mountedRef.current = false
      stopDurationTimer()
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop()
        } catch {
          finishRecording()
        }
      } else {
        cleanupStream()
      }
    }
  }, [cleanupStream, finishRecording, stopDurationTimer])

  return {
    state,
    errorMessage,
    audioChunks,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    duration,
  }
}
