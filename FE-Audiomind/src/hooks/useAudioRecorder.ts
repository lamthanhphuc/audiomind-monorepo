import { useCallback, useEffect, useRef, useState } from 'react'
import { AUDIO_DEBUG_ENABLED } from '../services/config'

export type AudioRecorderState = 'idle' | 'connecting' | 'recording' | 'paused' | 'stopped' | 'error'

export interface UseAudioRecorderReturn {
  state: AudioRecorderState
  errorMessage: string | null
  audioChunks: Blob[]
  recordingSessionId: number
  startRecording: (expectedSessionId?: number) => Promise<void>
  stopRecording: () => void
  abortRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  duration: number
  getCurrentRms: () => number | null
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

export const useAudioRecorder = (diagnosticMeetingId: number | null = null): UseAudioRecorderReturn => {
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
  const audioChunkCountRef = useRef(0)
  const recordingSessionIdRef = useRef(0)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioAnalyserRef = useRef<AnalyserNode | null>(null)
  const audioAnalyserSamplesRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const audioLevelTimerRef = useRef<number | null>(null)

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

  const stopAudioLevelDiagnostics = useCallback(() => {
    if (audioLevelTimerRef.current !== null) {
      window.clearInterval(audioLevelTimerRef.current)
      audioLevelTimerRef.current = null
    }

    if (audioSourceNodeRef.current) {
      try {
        audioSourceNodeRef.current.disconnect()
      } catch {
        // ignore cleanup errors
      }
      audioSourceNodeRef.current = null
    }

    if (audioAnalyserRef.current) {
      try {
        audioAnalyserRef.current.disconnect()
      } catch {
        // ignore cleanup errors
      }
      audioAnalyserRef.current = null
      audioAnalyserSamplesRef.current = null
    }

    if (audioContextRef.current) {
      const context = audioContextRef.current
      audioContextRef.current = null
      void context.close().catch(() => {})
    }
  }, [])

  const readAudioMetrics = useCallback((): { rms: number; peak: number } | null => {
    const analyser = audioAnalyserRef.current
    if (!analyser) {
      return null
    }

    if (!audioAnalyserSamplesRef.current || audioAnalyserSamplesRef.current.length !== analyser.fftSize) {
      audioAnalyserSamplesRef.current = new Uint8Array(analyser.fftSize)
    }

    const samples = audioAnalyserSamplesRef.current
    analyser.getByteTimeDomainData(samples)
    let sumSquares = 0
    let peak = 0
    for (const sample of samples) {
      const normalized = (sample - 128) / 128
      sumSquares += normalized * normalized
      peak = Math.max(peak, Math.abs(normalized))
    }

    return {
      rms: Math.sqrt(sumSquares / samples.length),
      peak,
    }
  }, [])

  const getCurrentRms = useCallback((): number | null => {
    return readAudioMetrics()?.rms ?? null
  }, [readAudioMetrics])

  const startAudioLevelDiagnostics = useCallback((stream: MediaStream, sessionId: number, meetingId: number | null) => {
    stopAudioLevelDiagnostics()

    const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) {
      return
    }

    try {
      const audioContext = new AudioContextCtor()
      const sourceNode = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      sourceNode.connect(analyser)

      audioContextRef.current = audioContext
      audioSourceNodeRef.current = sourceNode
      audioAnalyserRef.current = analyser
      audioAnalyserSamplesRef.current = new Uint8Array(analyser.fftSize)

      const shouldLogLevel = meetingId !== null && (AUDIO_DEBUG_ENABLED || import.meta.env.DEV)
      const logLevel = () => {
        if (!mountedRef.current || recordingSessionIdRef.current !== sessionId) {
          return
        }

        const metrics = readAudioMetrics()
        if (!metrics) {
          return
        }
        // eslint-disable-next-line no-console
        console.info('[Realtime] REALTIME_AUDIO_LEVEL', {
          meetingId,
          sessionId,
          rms: Number(metrics.rms.toFixed(4)),
          peak: Number(metrics.peak.toFixed(4)),
        })
      }

      if (shouldLogLevel) {
        logLevel()
        audioLevelTimerRef.current = window.setInterval(logLevel, 1000)
      }
    } catch {
      stopAudioLevelDiagnostics()
    }
  }, [readAudioMetrics, stopAudioLevelDiagnostics])

  const clearRecorderHandlers = useCallback((recorder: MediaRecorder | null) => {
    if (!recorder) {
      return
    }

    recorder.ondataavailable = null
    recorder.onpause = null
    recorder.onresume = null
    recorder.onstop = null
    recorder.onerror = null
  }, [])

  const abortRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    const hasActiveRecorder =
      state === 'connecting' ||
      state === 'recording' ||
      state === 'paused' ||
      (recorder !== null && recorder.state !== 'inactive')

    if (hasActiveRecorder) {
      recordingSessionIdRef.current += 1
    }
    stopDurationTimer()
    resetSessionState()
    stopAudioLevelDiagnostics()

    if (recorder && recorder.state !== 'inactive') {
      try {
        clearRecorderHandlers(recorder)
        recorder.stop()
      } catch {
        cleanupStream()
      }
    } else {
      cleanupStream()
    }

    mediaRecorderRef.current = null
    if (mountedRef.current) {
      setState('idle')
    }
  }, [clearRecorderHandlers, cleanupStream, resetSessionState, state, stopAudioLevelDiagnostics, stopDurationTimer])

  const finishRecording = useCallback((sessionId: number) => {
    if (recordingSessionIdRef.current !== sessionId) {
      return
    }

    const recorder = mediaRecorderRef.current
    pauseDurationTimer()
    cleanupStream()
    stopAudioLevelDiagnostics()
    clearRecorderHandlers(recorder)
    mediaRecorderRef.current = null
    if (mountedRef.current) {
      setState('stopped')
    }
  }, [clearRecorderHandlers, cleanupStream, pauseDurationTimer, stopAudioLevelDiagnostics])

  const startRecording = useCallback(async (expectedSessionId?: number) => {
    const activeRecorder = mediaRecorderRef.current
    if (state === 'connecting' || activeRecorder?.state === 'recording' || activeRecorder?.state === 'paused') {
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error')
      setErrorMessage('Trình duyệt không hỗ trợ getUserMedia cho microphone.')
      return
    }

    const nextSessionId = recordingSessionIdRef.current + 1
    if (typeof expectedSessionId === 'number' && expectedSessionId !== nextSessionId) {
      setState('error')
      setErrorMessage('Recording session mismatch. Vui lòng thử lại.')
      return
    }

    const sessionId = nextSessionId
    recordingSessionIdRef.current = sessionId
    resetSessionState()
    setState('connecting')
    recorderMimeLoggedRef.current = false
    audioChunkCountRef.current = 0

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mountedRef.current || recordingSessionIdRef.current !== sessionId) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      const recorder = new MediaRecorder(stream, { mimeType: RECORDER_MIME_TYPE })
      mediaRecorderRef.current = recorder
      streamRef.current = stream
      startAudioLevelDiagnostics(stream, sessionId, diagnosticMeetingId)

      recorder.ondataavailable = (event) => {
        if (!mountedRef.current || recordingSessionIdRef.current !== sessionId) {
          return
        }

        audioChunkCountRef.current += 1
        const chunkCount = audioChunkCountRef.current

        if (AUDIO_DEBUG_ENABLED) {
          try {
            // eslint-disable-next-line no-console
            console.info('[AudioRecorder] chunk diagnostics', {
              size: event.data.size,
              mimeType: event.data.type || recorder.mimeType || RECORDER_MIME_TYPE,
              recorderState: recorder.state,
              chunkSequence: chunkCount,
              bufferedChunks: chunkCount,
            })
          } catch {
            // ignore debug logging failures
          }
        }

        if (event.data.size > 0 && mountedRef.current) {
          setAudioChunks((currentChunks) => [...currentChunks, event.data])
        }
      }

      recorder.onpause = () => {
        if (!mountedRef.current || recordingSessionIdRef.current !== sessionId) {
          return
        }

        if (mountedRef.current) {
          setState('paused')
        }
        pauseDurationTimer()
      }

      recorder.onresume = () => {
        if (!mountedRef.current || recordingSessionIdRef.current !== sessionId) {
          return
        }

        if (mountedRef.current) {
          setState('recording')
        }
        startedAtRef.current = Date.now()
        startDurationTimer()
      }

      recorder.onstop = () => {
        finishRecording(sessionId)
      }

      recorder.onerror = () => {
        if (recordingSessionIdRef.current !== sessionId) {
          return
        }

        if (mountedRef.current) {
          setState('error')
          setErrorMessage('Đã xảy ra lỗi trong quá trình ghi âm.')
        }
        finishRecording(sessionId)
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
      if (recordingSessionIdRef.current === sessionId) {
        cleanupStream()
        stopAudioLevelDiagnostics()
        clearRecorderHandlers(mediaRecorderRef.current)
        mediaRecorderRef.current = null
        if (mountedRef.current) {
          setState('error')
          setErrorMessage(mapRecorderError(error))
        }
      }
    }
  }, [clearRecorderHandlers, cleanupStream, diagnosticMeetingId, finishRecording, pauseDurationTimer, resetSessionState, startAudioLevelDiagnostics, startDurationTimer, state, stopAudioLevelDiagnostics])

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
      finishRecording(recordingSessionIdRef.current)
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
      stopAudioLevelDiagnostics()
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        try {
          clearRecorderHandlers(recorder)
          recorder.stop()
        } catch {
          cleanupStream()
          mediaRecorderRef.current = null
        }
      } else {
        cleanupStream()
        mediaRecorderRef.current = null
      }
    }
  }, [clearRecorderHandlers, cleanupStream, stopAudioLevelDiagnostics, stopDurationTimer])

  return {
    state,
    errorMessage,
    audioChunks,
    recordingSessionId: recordingSessionIdRef.current,
    startRecording,
    stopRecording,
    abortRecording,
    pauseRecording,
    resumeRecording,
    duration,
    getCurrentRms,
  }
}
