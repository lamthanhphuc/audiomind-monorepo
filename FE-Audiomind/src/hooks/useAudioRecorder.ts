import { useCallback, useEffect, useRef, useState } from 'react'
import {
  acquireAudioSource,
  attachAudioTrackEndedHandler,
  mapAudioSourceErrorMessage,
  type TabMicMixerHandles,
} from '../utils/audioSourceAcquisition'
import {
  isBrowserTabRecordingSource,
  RECORDING_SOURCE_ERRORS,
  type RecordingSource,
} from '../constants/recordingSource'
import {
  AUDIO_DEBUG_ENABLED,
  REALTIME_RECORDER_TIMESLICE_MS,
  REALTIME_RESUME_PREROLL_MS,
  REALTIME_START_PREROLL_MS,
} from '../services/config'
import {
  createTabAudioPipelineMonitor,
  ensureAudioContextRunning,
  type TabAudioPipelineMonitor,
} from '../utils/tabAudioPipeline'

export type AudioRecorderState = 'idle' | 'connecting' | 'recording' | 'paused' | 'stopped' | 'error'

type RollingAudioChunk = {
  blob: Blob
  capturedAtMs: number
}

export interface UseAudioRecorderOptions {
  noiseSuppressionEnabled?: boolean
  timesliceMs?: number
  preRollWindowMs?: number
  recordingSource?: RecordingSource
  onTrackEnded?: () => void
  onCaptureError?: (message: string) => void
  onPipelineStalled?: () => void
}

export interface UseAudioRecorderReturn {
  state: AudioRecorderState
  errorMessage: string | null
  audioChunks: Blob[]
  recordingSessionId: number
  startRecording: (expectedSessionId?: number) => Promise<number | null>
  stopRecording: () => void
  stopRecordingGraceful: () => Promise<GracefulStopResult>
  cleanupRecordingResources: () => void
  abortRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  duration: number
  getCurrentRms: () => number | null
  getRollingChunks: () => Blob[]
  getActiveStreamIds?: () => Array<'tab' | 'mic'>
}

const RECORDER_MIME_TYPE = 'audio/webm; codecs=opus'
const DURATION_TICK_MS = 250
const FALLBACK_RECORDER_TIMESLICE_MS = 250

export const REQUEST_DATA_GRACE_MS = 1000
export const RECORDER_STOP_TIMEOUT_MS = 2000
export const OVERALL_GRACEFUL_STOP_TIMEOUT_MS = 5000

export type GracefulStopResult = {
  fullBlob: Blob
  sessionId: number
  collectedChunkCount: number
  postStopChunkCount: number
  chunks: Blob[]
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, ms)
})

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
  const sourceCleanupRef = useRef<(() => void) | null>(null)
  const trackEndedDetachRef = useRef<(() => void) | null>(null)
  const tabPipelineMonitorRef = useRef<TabAudioPipelineMonitor | null>(null)
  const tabMixerHandlesRef = useRef<TabMicMixerHandles | null>(null)
  const recordingStartedAtRef = useRef<number | null>(null)
  const gracefulStopInProgressRef = useRef(false)
  const audioChunksRef = useRef<Blob[]>([])

  const recorderTimesliceMs = Math.max(100, Math.floor(options.timesliceMs ?? REALTIME_RECORDER_TIMESLICE_MS))
  const preRollWindowMs = Math.max(
    0,
    Math.floor(options.preRollWindowMs ?? Math.max(REALTIME_START_PREROLL_MS, REALTIME_RESUME_PREROLL_MS)),
  )
  const noiseSuppressionEnabled = options.noiseSuppressionEnabled ?? true
  const recordingSource = options.recordingSource ?? 'microphone'
  const onTrackEnded = options.onTrackEnded
  const onCaptureError = options.onCaptureError
  const onPipelineStalled = options.onPipelineStalled
  const isTabCaptureSource = isBrowserTabRecordingSource(recordingSource)

  const detachTrackEndedHandler = useCallback(() => {
    trackEndedDetachRef.current?.()
    trackEndedDetachRef.current = null
  }, [])

  const stopTabPipelineMonitor = useCallback(() => {
    tabPipelineMonitorRef.current?.cleanup()
    tabPipelineMonitorRef.current = null
    tabMixerHandlesRef.current = null
    recordingStartedAtRef.current = null
  }, [])

  const releaseAcquiredSource = useCallback(() => {
    detachTrackEndedHandler()
    stopTabPipelineMonitor()
    sourceCleanupRef.current?.()
    sourceCleanupRef.current = null
  }, [detachTrackEndedHandler, stopTabPipelineMonitor])

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
    releaseAcquiredSource()
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [releaseAcquiredSource])

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

  const startTabPipelineMonitor = useCallback((
    stream: MediaStream,
    sessionId: number,
    meetingId: number | null,
    tabMixerHandles?: TabMicMixerHandles,
  ) => {
    stopTabPipelineMonitor()
    if (!isTabCaptureSource) {
      return
    }

    tabMixerHandlesRef.current = tabMixerHandles ?? null
    recordingStartedAtRef.current = performance.now()
    tabPipelineMonitorRef.current = createTabAudioPipelineMonitor({
      stream,
      streamId: tabMixerHandles ? 'mixed' : 'tab',
      meetingId,
      sessionId,
      audioContext: tabMixerHandles?.audioContext ?? audioContextRef.current,
      postGainAnalyser: tabMixerHandles?.outputAnalyser ?? audioAnalyserRef.current,
      onTrackEnded: () => onTrackEnded?.(),
      onTrackMuted: () => onCaptureError?.(RECORDING_SOURCE_ERRORS.tabTinyOrSilentAudio),
      onCaptureError: (message) => onCaptureError?.(message),
      onPipelineStalled: () => onPipelineStalled?.(),
    })
  }, [isTabCaptureSource, onCaptureError, onPipelineStalled, onTrackEnded, stopTabPipelineMonitor])

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
      void ensureAudioContextRunning(audioContext)

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

  useEffect(() => {
    audioChunksRef.current = audioChunks
  }, [audioChunks])

  const markRecordingStopped = useCallback((sessionId: number) => {
    if (recordingSessionIdRef.current !== sessionId) {
      return
    }

    pauseDurationTimer()
    if (mountedRef.current) {
      setState('stopped')
    }
  }, [pauseDurationTimer])

  const cleanupRecordingResources = useCallback(() => {
    const recorder = mediaRecorderRef.current
    stopAudioLevelDiagnostics()
    cleanupStream()
    clearRecorderHandlers(recorder)
    mediaRecorderRef.current = null
    gracefulStopInProgressRef.current = false
  }, [clearRecorderHandlers, cleanupStream, stopAudioLevelDiagnostics])

  const finishRecording = useCallback((sessionId: number) => {
    if (recordingSessionIdRef.current !== sessionId) {
      return
    }

    markRecordingStopped(sessionId)
    cleanupRecordingResources()
  }, [cleanupRecordingResources, markRecordingStopped])

  const appendRecordedChunk = useCallback((
    sessionId: number,
    blob: Blob,
    recorder: MediaRecorder,
    options?: { skipStateUpdate?: boolean },
  ) => {
    if (!mountedRef.current || recordingSessionIdRef.current !== sessionId || blob.size <= 0) {
      return
    }

    audioChunkCountRef.current += 1
    const chunkCount = audioChunkCountRef.current
    const capturedAtMs = Date.now()

    if (AUDIO_DEBUG_ENABLED) {
      try {
        // eslint-disable-next-line no-console
        console.info('[AudioRecorder] chunk diagnostics', {
          size: blob.size,
          mimeType: blob.type || recorder.mimeType || RECORDER_MIME_TYPE,
          recorderState: recorder.state,
          chunkSequence: chunkCount,
          bufferedChunks: chunkCount,
        })
      } catch {
        // ignore debug logging failures
      }
    }

    if (isTabCaptureSource) {
      const elapsedMs = recordingStartedAtRef.current === null
        ? 0
        : Math.max(0, Math.round(performance.now() - recordingStartedAtRef.current))
      tabPipelineMonitorRef.current?.notifyRecorderChunk({
        seq: chunkCount,
        bytes: blob.size,
        elapsedMs,
      })
    }

    rollingChunksRef.current = [
      ...rollingChunksRef.current,
      { blob, capturedAtMs },
    ].filter((chunk) => capturedAtMs - chunk.capturedAtMs <= preRollWindowMs)

    if (!options?.skipStateUpdate) {
      setAudioChunks((currentChunks) => {
        const nextChunks = [...currentChunks, blob]
        audioChunksRef.current = nextChunks
        return nextChunks
      })
    } else {
      const nextChunks = [...audioChunksRef.current, blob]
      audioChunksRef.current = nextChunks
      setAudioChunks(nextChunks)
    }
  }, [isTabCaptureSource, preRollWindowMs])

  const getRollingChunks = useCallback(() => {
    return rollingChunksRef.current.map((chunk) => chunk.blob)
  }, [])

  const startRecording = useCallback(async (expectedSessionId?: number): Promise<number | null> => {
    const activeRecorder = mediaRecorderRef.current
    if (state === 'connecting' || activeRecorder?.state === 'recording' || activeRecorder?.state === 'paused') {
      return recordingSessionIdRef.current
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
      const acquired = await acquireAudioSource({
        source: recordingSource,
        noiseSuppressionEnabled,
        meetingId: diagnosticMeetingId,
      })
      const stream = acquired.stream
      if (!mountedRef.current || recordingSessionIdRef.current !== sessionId) {
        acquired.cleanup()
        return null
      }

      sourceCleanupRef.current = acquired.cleanup
      if (onTrackEnded || onCaptureError) {
        trackEndedDetachRef.current = attachAudioTrackEndedHandler(stream, () => {
          if (recordingSessionIdRef.current !== sessionId) {
            return
          }
          onTrackEnded?.()
        }, {
          onMuted: () => {
            if (recordingSessionIdRef.current !== sessionId) {
              return
            }
            onCaptureError?.(RECORDING_SOURCE_ERRORS.tabTinyOrSilentAudio)
          },
        })
      }

      const recorder = new MediaRecorder(stream, { mimeType: RECORDER_MIME_TYPE })
      mediaRecorderRef.current = recorder
      streamRef.current = stream
      if (recordingSource === 'microphone') {
        logSafeMicSettings(stream)
      }
      startAudioLevelDiagnostics(stream, sessionId, diagnosticMeetingId)
      startTabPipelineMonitor(stream, sessionId, diagnosticMeetingId, acquired.tabMixerHandles)

      recorder.ondataavailable = (event) => {
        if (gracefulStopInProgressRef.current) {
          return
        }
        appendRecordedChunk(sessionId, event.data, recorder)
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
        if (gracefulStopInProgressRef.current) {
          return
        }
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
            source: recordingSource,
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
          setErrorMessage(mapAudioSourceErrorMessage(error))
        }
      }
      return null
    }
  }, [appendRecordedChunk, clearRecorderHandlers, cleanupStream, diagnosticMeetingId, finishRecording, markRecordingStopped, noiseSuppressionEnabled, onCaptureError, onTrackEnded, pauseDurationTimer, preRollWindowMs, recorderTimesliceMs, recordingSource, resetSessionState, startAudioLevelDiagnostics, startDurationTimer, startTabPipelineMonitor, state, stopAudioLevelDiagnostics])

  const stopRecordingGraceful = useCallback(async (): Promise<GracefulStopResult> => {
    const sessionId = recordingSessionIdRef.current
    const recorder = mediaRecorderRef.current

    const buildResult = (chunks: Blob[], postStopChunkCount: number): GracefulStopResult => {
      const fullBlob = new Blob(chunks.length > 0 ? chunks : [], { type: RECORDER_MIME_TYPE })
      if (AUDIO_DEBUG_ENABLED || import.meta.env.DEV) {
        console.info('[Realtime] FINAL_AUDIO_BLOB_READY', {
          meetingId: diagnosticMeetingId,
          sessionId,
          bytes: fullBlob.size,
          collectedChunkCount: chunks.length,
          postStopChunkCount,
        })
      }
      return {
        fullBlob,
        sessionId,
        collectedChunkCount: chunks.length,
        postStopChunkCount,
        chunks,
      }
    }

    if (!recorder || recorder.state === 'inactive') {
      const chunks = [...audioChunksRef.current]
      return buildResult(chunks, 0)
    }

    if (startedAtRef.current !== null) {
      accumulatedMsRef.current += Date.now() - startedAtRef.current
      startedAtRef.current = null
    }
    stopDurationTimer()
    updateDuration()

    const overallDeadline = Date.now() + OVERALL_GRACEFUL_STOP_TIMEOUT_MS
    const chunksBeforeStop = audioChunksRef.current.length
    let stopEventFired = false
    let requestDataCalled = false
    let stopCommandSent = false
    let postStopChunkCount = 0
    let timedOutOverall = false

    gracefulStopInProgressRef.current = true

    const logCollectedChunk = (blob: Blob, phase: 'pre_stop' | 'post_request_data' | 'post_stop') => {
      const postStop = phase === 'post_stop'
      if (postStop) {
        postStopChunkCount += 1
      }
      if (AUDIO_DEBUG_ENABLED || import.meta.env.DEV) {
        console.info('[Realtime] MEDIARECORDER_DATAAVAILABLE_COLLECTED', {
          meetingId: diagnosticMeetingId,
          sessionId,
          size: blob.size,
          phase,
          postStop,
        })
      }
    }

    recorder.ondataavailable = (event) => {
      if (!mountedRef.current || recordingSessionIdRef.current !== sessionId || event.data.size <= 0) {
        return
      }

      const phase: 'pre_stop' | 'post_request_data' | 'post_stop' = !requestDataCalled
        ? 'pre_stop'
        : (stopCommandSent ? 'post_stop' : 'post_request_data')
      logCollectedChunk(event.data, phase)
      appendRecordedChunk(sessionId, event.data, recorder)
    }

    recorder.onstop = () => {
      if (recordingSessionIdRef.current !== sessionId) {
        return
      }
      stopEventFired = true
      if (AUDIO_DEBUG_ENABLED || import.meta.env.DEV) {
        console.info('[Realtime] MEDIARECORDER_STOP_EVENT', {
          meetingId: diagnosticMeetingId,
          sessionId,
          timedOut: false,
        })
      }
      markRecordingStopped(sessionId)
    }

    const waitUntil = async (predicate: () => boolean, timeoutMs: number) => {
      const deadline = Math.min(Date.now() + timeoutMs, overallDeadline)
      while (Date.now() < deadline) {
        if (predicate()) {
          return true
        }
        await sleep(25)
      }
      return predicate()
    }

    try {
      if (recorder.state === 'recording' || recorder.state === 'paused') {
        if (AUDIO_DEBUG_ENABLED || import.meta.env.DEV) {
          console.info('[Realtime] MEDIARECORDER_REQUEST_DATA', {
            meetingId: diagnosticMeetingId,
            sessionId,
            recorderState: recorder.state,
          })
        }
        try {
          recorder.requestData()
        } catch {
          // ignore unsupported requestData
        }
        requestDataCalled = true

        stopCommandSent = true
        try {
          recorder.stop()
        } catch {
          stopEventFired = true
          markRecordingStopped(sessionId)
        }
      }

      const stopObserved = stopEventFired || await waitUntil(() => stopEventFired, RECORDER_STOP_TIMEOUT_MS)
      if (!stopObserved && (AUDIO_DEBUG_ENABLED || import.meta.env.DEV)) {
        console.info('[Realtime] MEDIARECORDER_STOP_EVENT', {
          meetingId: diagnosticMeetingId,
          sessionId,
          timedOut: true,
        })
        markRecordingStopped(sessionId)
      }

      const graceRemaining = Math.max(0, overallDeadline - Date.now())
      const graceMs = Math.min(REQUEST_DATA_GRACE_MS, graceRemaining)
      if (graceMs > 0) {
        await sleep(graceMs)
      }

      if (AUDIO_DEBUG_ENABLED || import.meta.env.DEV) {
        console.info('[Realtime] MEDIARECORDER_GRACE_COMPLETE', {
          meetingId: diagnosticMeetingId,
          sessionId,
          graceMs,
          collectedPostStopCount: postStopChunkCount,
        })
      }
    } catch {
      markRecordingStopped(sessionId)
    } finally {
      timedOutOverall = Date.now() >= overallDeadline
      if (timedOutOverall && (AUDIO_DEBUG_ENABLED || import.meta.env.DEV)) {
        console.warn('[Realtime] MEDIARECORDER_GRACEFUL_STOP_TIMEOUT', {
          meetingId: diagnosticMeetingId,
          sessionId,
        })
      }
      gracefulStopInProgressRef.current = false
      recorder.ondataavailable = null
      recorder.onstop = null
    }

    const finalChunks = [...audioChunksRef.current]
    if (finalChunks.length < chunksBeforeStop) {
      return buildResult(audioChunksRef.current, postStopChunkCount)
    }

    return buildResult(finalChunks, postStopChunkCount)
  }, [appendRecordedChunk, diagnosticMeetingId, markRecordingStopped, stopDurationTimer, updateDuration])

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
    stopRecordingGraceful,
    cleanupRecordingResources,
    abortRecording,
    pauseRecording,
    resumeRecording,
    duration,
    getCurrentRms,
    getRollingChunks,
  }
}
