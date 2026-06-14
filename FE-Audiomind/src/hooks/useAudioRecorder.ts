import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AUDIO_DEBUG_ENABLED,
  REALTIME_RECORDER_TIMESLICE_MS,
  REALTIME_RESUME_PREROLL_MS,
  REALTIME_START_PREROLL_MS,
} from '../services/config'

export type AudioRecorderState = 'idle' | 'connecting' | 'recording' | 'paused' | 'stopped' | 'error'

type RollingAudioChunk = {
  blob: Blob
  capturedAtMs: number
}

export interface UseAudioRecorderOptions {
  noiseSuppressionEnabled?: boolean
  timesliceMs?: number
  preRollWindowMs?: number
}

export interface UseAudioRecorderReturn {
  state: AudioRecorderState
  errorMessage: string | null
  audioChunks: Blob[]
  recordingSessionId: number
  startRecording: (expectedSessionId?: number) => Promise<number | null>
  stopRecording: () => void
  abortRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  duration: number
  getCurrentRms: () => number | null
  getRollingChunks: () => Blob[]
}

const RECORDER_MIME_TYPE = 'audio/webm; codecs=opus'
const DURATION_TICK_MS = 250
const FALLBACK_RECORDER_TIMESLICE_MS = 250
const PREFERRED_SAMPLE_RATE = 48_000

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

const isNoiseSuppressionConstraintSupported = (): boolean => {
  return Boolean(navigator.mediaDevices?.getSupportedConstraints?.().noiseSuppression)
}

const buildAudioConstraints = (noiseSuppressionEnabled: boolean): MediaStreamConstraints => {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: { ideal: PREFERRED_SAMPLE_RATE },
  }

  if (isNoiseSuppressionConstraintSupported()) {
    audio.noiseSuppression = noiseSuppressionEnabled
  } else {
    console.info('[Realtime] MIC_CONSTRAINT_UNSUPPORTED', {
      constraint: 'noiseSuppression',
    })
  }

  return { audio }
}

const logSafeMicSettings = (stream: MediaStream) => {
  const track = stream.getAudioTracks?.()[0] ?? stream.getTracks()[0]
  const settings = track?.getSettings?.()
  if (!settings) {
    return
  }

  console.info('[Realtime] MIC_SETTINGS', {
    noiseSuppression: settings.noiseSuppression,
    echoCancellation: settings.echoCancellation,
    autoGainControl: settings.autoGainControl,
    sampleRate: settings.sampleRate,
    channelCount: settings.channelCount,
    deviceIdPresent: typeof settings.deviceId === 'string' && settings.deviceId.length > 0,
  })
}

export const useAudioRecorder = (
  diagnosticMeetingId: number | null = null,
  options: UseAudioRecorderOptions = {},
): UseAudioRecorderReturn => {
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
  const rollingChunksRef = useRef<RollingAudioChunk[]>([])

  const recorderTimesliceMs = Math.max(100, Math.floor(options.timesliceMs ?? REALTIME_RECORDER_TIMESLICE_MS))
  const preRollWindowMs = Math.max(
    0,
    Math.floor(options.preRollWindowMs ?? Math.max(REALTIME_START_PREROLL_MS, REALTIME_RESUME_PREROLL_MS)),
  )
  const noiseSuppressionEnabled = options.noiseSuppressionEnabled ?? true

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
    rollingChunksRef.current = []
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

  const getRollingChunks = useCallback(() => {
    return rollingChunksRef.current.map((chunk) => chunk.blob)
  }, [])

  const startRecording = useCallback(async (expectedSessionId?: number): Promise<number | null> => {
    const activeRecorder = mediaRecorderRef.current
    if (state === 'connecting' || activeRecorder?.state === 'recording' || activeRecorder?.state === 'paused') {
      return recordingSessionIdRef.current
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error')
      setErrorMessage('Trình duyệt không hỗ trợ getUserMedia cho microphone.')
      return null
    }

    const nextSessionId = recordingSessionIdRef.current + 1
    if (typeof expectedSessionId === 'number' && expectedSessionId !== nextSessionId) {
      setState('error')
      setErrorMessage('Recording session mismatch. Vui lòng thử lại.')
      return null
    }

    const sessionId = nextSessionId
    recordingSessionIdRef.current = sessionId
    resetSessionState()
    setState('connecting')
    recorderMimeLoggedRef.current = false
    audioChunkCountRef.current = 0

    try {
      const stream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints(noiseSuppressionEnabled))
      if (!mountedRef.current || recordingSessionIdRef.current !== sessionId) {
        stream.getTracks().forEach((track) => track.stop())
        return null
      }

      const recorder = new MediaRecorder(stream, { mimeType: RECORDER_MIME_TYPE })
      mediaRecorderRef.current = recorder
      streamRef.current = stream
      logSafeMicSettings(stream)
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
          const capturedAtMs = Date.now()
          rollingChunksRef.current = [
            ...rollingChunksRef.current,
            { blob: event.data, capturedAtMs },
          ].filter((chunk) => capturedAtMs - chunk.capturedAtMs <= preRollWindowMs)
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

      let actualTimesliceMs = recorderTimesliceMs
      try {
        recorder.start(recorderTimesliceMs)
      } catch (error) {
        if (recorderTimesliceMs === FALLBACK_RECORDER_TIMESLICE_MS) {
          throw error
        }
        actualTimesliceMs = FALLBACK_RECORDER_TIMESLICE_MS
        recorder.start(FALLBACK_RECORDER_TIMESLICE_MS)
      }

      try {
        if (!recorderMimeLoggedRef.current) {
          console.info('[Realtime] RECORDING_START_ARMED', {
            meetingId: diagnosticMeetingId,
            sessionId,
            timesliceMs: actualTimesliceMs,
            startPreRollMs: REALTIME_START_PREROLL_MS,
            resumePreRollMs: REALTIME_RESUME_PREROLL_MS,
          })
          recorderMimeLoggedRef.current = true
        }
      } catch {
        // ignore logging failures
      }
      startedAtRef.current = Date.now()
      startDurationTimer()
      setState('recording')
      return sessionId
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
      return null
    }
  }, [clearRecorderHandlers, cleanupStream, diagnosticMeetingId, finishRecording, noiseSuppressionEnabled, pauseDurationTimer, preRollWindowMs, recorderTimesliceMs, resetSessionState, startAudioLevelDiagnostics, startDurationTimer, state, stopAudioLevelDiagnostics])

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
    getRollingChunks,
  }
}
