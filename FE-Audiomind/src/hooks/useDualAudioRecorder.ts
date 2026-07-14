import { useCallback, useEffect, useRef, useState } from 'react'
import {
  acquireDualTabMicSources,
  attachAudioTrackEndedHandler,
  createTabMicMixFromStreams,
  mapAudioSourceErrorMessage,
  type DualTabMicStreamId,
  type TabMicMixerHandles,
} from '../utils/audioSourceAcquisition'
import { REALTIME_RECORDER_TIMESLICE_MS } from '../services/config'
import {
  buildMediaRecorderOptions,
  getSupportedMediaRecorderFormat,
  resolveRecordedAudioResult,
  type MediaRecorderFormat,
} from '../utils/mediaRecorderFormat'
import {
  createTabAudioPipelineMonitor,
  ensureAudioContextRunning,
  measureAnalyserRms,
  type TabAudioPipelineMonitor,
} from '../utils/tabAudioPipeline'
import { realtimeInfo, realtimeWarn } from '../utils/realtimeTelemetry'
import {
  compareRequestedMicrophoneSettings,
  readMicrophoneAudioSettings,
  toSafeMicTelemetry,
} from '../utils/microphoneSettings'
import {
  MIC_HEALTH_MESSAGES,
  createMicrophoneHealthTracker,
  type MicrophoneHealthIssue,
} from '../constants/micHealthConstants'
import {
  REQUEST_DATA_GRACE_MS,
  RECORDER_STOP_TIMEOUT_MS,
  type AudioRecorderState,
  type GracefulStopResult,
  type UseAudioRecorderReturn,
} from './useAudioRecorder'

type StreamRecorder = {
  streamId: DualTabMicStreamId
  recorder: MediaRecorder
  chunks: Blob[]
}

type FallbackRecorderState = {
  recorder: MediaRecorder
  chunks: Blob[]
  format: MediaRecorderFormat
  mixer: TabMicMixerHandles
}

export type UseDualAudioRecorderOptions = {
  timesliceMs?: number
  noiseSuppressionEnabled?: boolean
  onTrackEnded?: () => void
  onCaptureError?: (message: string) => void
  onPipelineStalled?: (streamId: DualTabMicStreamId) => void
  diagnosticMeetingId?: number | null
  onChunkReady?: (chunk: Blob, streamId: DualTabMicStreamId, sessionId: number) => void | Promise<void>
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, ms)
})

const stopRecorderGraceful = async (
  recorder: MediaRecorder,
): Promise<void> => {
  if (recorder.state !== 'recording' && recorder.state !== 'paused') {
    return
  }
  try {
    recorder.requestData()
  } catch {
    // ignore
  }
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, RECORDER_STOP_TIMEOUT_MS)
    recorder.addEventListener('stop', () => {
      window.clearTimeout(timeout)
      resolve()
    }, { once: true })
    try {
      recorder.stop()
    } catch {
      window.clearTimeout(timeout)
      resolve()
    }
  })
  await sleep(REQUEST_DATA_GRACE_MS)
}

export const useDualAudioRecorder = (
  options: UseDualAudioRecorderOptions = {},
): UseAudioRecorderReturn => {
  const [state, setState] = useState<AudioRecorderState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [audioChunks, setAudioChunks] = useState<Blob[]>([])
  const [duration, setDuration] = useState(0)
  const [micHealthIssue, setMicHealthIssue] = useState<MicrophoneHealthIssue | null>(null)

  const recordingSessionIdRef = useRef(0)
  const dispatchSessionIdRef = useRef(0)
  const streamRecordersRef = useRef<StreamRecorder[]>([])
  const fallbackRecorderRef = useRef<FallbackRecorderState | null>(null)
  const activeStreamIdsRef = useRef<DualTabMicStreamId[]>(['tab'])
  const dualCleanupRef = useRef<(() => void) | null>(null)
  const trackEndedDetachRef = useRef<(() => void) | null>(null)
  const tabTrackTerminalHandledRef = useRef(false)
  const durationTimerRef = useRef<number | null>(null)
  const startedAtRef = useRef<number | null>(null)
  const tabPipelineMonitorRef = useRef<TabAudioPipelineMonitor | null>(null)
  const tabChunkSeqRef = useRef(0)
  const micAnalyserRef = useRef<AnalyserNode | null>(null)
  const micAnalyserDataRef = useRef<Uint8Array | null>(null)
  const micHealthTimerRef = useRef<number | null>(null)
  const healthTrackerRef = useRef(createMicrophoneHealthTracker())
  const constraintIssuesRef = useRef<MicrophoneHealthIssue[]>([])
  const gracefulStopInProgressRef = useRef(false)
  const timesliceMs = Math.max(100, Math.floor(options.timesliceMs ?? REALTIME_RECORDER_TIMESLICE_MS))
  const noiseSuppressionEnabled = options.noiseSuppressionEnabled ?? true

  const stopDurationTimer = useCallback(() => {
    if (durationTimerRef.current !== null) {
      window.clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }
  }, [])

  const stopMicHealthMonitor = useCallback(() => {
    if (micHealthTimerRef.current !== null) {
      window.clearInterval(micHealthTimerRef.current)
      micHealthTimerRef.current = null
    }
    setMicHealthIssue(null)
    constraintIssuesRef.current = []
    healthTrackerRef.current.reset()
  }, [])

  const startMicHealthMonitor = useCallback((
    micStream: MediaStream,
    analyser: AnalyserNode | null,
    sessionId: number,
  ) => {
    stopMicHealthMonitor()
    const settings = readMicrophoneAudioSettings(micStream)
    const telemetry = toSafeMicTelemetry(settings)
    if (telemetry) {
      realtimeInfo('[Realtime] MIC_SETTINGS', telemetry)
    }
    const issues: MicrophoneHealthIssue[] = []
    for (const issue of compareRequestedMicrophoneSettings(
      {
        noiseSuppressionEnabled,
        echoCancellationEnabled: true,
        autoGainControlEnabled: true,
      },
      settings,
    )) {
      if (issue === 'noise_suppression_unavailable' || issue === 'echo_cancellation_unavailable') {
        issues.push(issue)
      }
    }
    constraintIssuesRef.current = issues
    healthTrackerRef.current.reset()
    setMicHealthIssue(null)

    if (!analyser) {
      if (issues[0]) {
        setMicHealthIssue(issues[0])
      }
      return
    }

    micAnalyserRef.current = analyser
    micAnalyserDataRef.current = new Uint8Array(analyser.fftSize)

    const tick = () => {
      if (recordingSessionIdRef.current !== sessionId || gracefulStopInProgressRef.current) {
        return
      }
      const buffer = micAnalyserDataRef.current
      if (!buffer || buffer.length !== analyser.fftSize) {
        micAnalyserDataRef.current = new Uint8Array(analyser.fftSize)
      }
      const samples = micAnalyserDataRef.current
      if (!samples) {
        return
      }
      analyser.getByteTimeDomainData(samples as Uint8Array<ArrayBuffer>)
      let sumSquares = 0
      let peak = 0
      let clippingSamples = 0
      for (const sample of samples) {
        const normalized = (sample - 128) / 128
        sumSquares += normalized * normalized
        peak = Math.max(peak, Math.abs(normalized))
        if (Math.abs(normalized) >= 0.98) {
          clippingSamples += 1
        }
      }
      const rms = Math.sqrt(sumSquares / samples.length)
      const health = healthTrackerRef.current.update(
        {
          rms,
          peak,
          clippingRatio: samples.length > 0 ? clippingSamples / samples.length : 0,
        },
        Date.now(),
        constraintIssuesRef.current,
      )
      setMicHealthIssue(health.activeIssue)
    }

    tick()
    micHealthTimerRef.current = window.setInterval(tick, 120)
  }, [noiseSuppressionEnabled, stopMicHealthMonitor])

  const cleanupRecordingResources = useCallback(() => {
    // Invalidate chunk dispatch without bumping recordingSessionId (kept for graceful result).
    dispatchSessionIdRef.current = 0

    trackEndedDetachRef.current?.()
    trackEndedDetachRef.current = null
    tabPipelineMonitorRef.current?.cleanup()
    tabPipelineMonitorRef.current = null
    tabChunkSeqRef.current = 0
    stopMicHealthMonitor()
    stopDurationTimer()

    streamRecordersRef.current.forEach(({ recorder }) => {
      try {
        recorder.ondataavailable = null
        if (recorder.state !== 'inactive') {
          recorder.stop()
        }
      } catch {
        // ignore
      }
    })
    streamRecordersRef.current = []

    const fallback = fallbackRecorderRef.current
    if (fallback) {
      try {
        fallback.recorder.ondataavailable = null
        if (fallback.recorder.state !== 'inactive') {
          fallback.recorder.stop()
        }
      } catch {
        // ignore
      }
      try {
        fallback.mixer.cleanupGraph()
      } catch {
        // ignore
      }
      fallbackRecorderRef.current = null
    }

    micAnalyserRef.current = null
    micAnalyserDataRef.current = null

    try {
      dualCleanupRef.current?.()
    } catch {
      // ignore
    }
    dualCleanupRef.current = null
    tabTrackTerminalHandledRef.current = false
    gracefulStopInProgressRef.current = false
  }, [stopDurationTimer, stopMicHealthMonitor])

  const abortRecording = useCallback(() => {
    recordingSessionIdRef.current += 1
    dispatchSessionIdRef.current = recordingSessionIdRef.current
    cleanupRecordingResources()
    setState('idle')
    setAudioChunks([])
    setDuration(0)
    setErrorMessage(null)
    startedAtRef.current = null
  }, [cleanupRecordingResources])

  const startRecording = useCallback(async (expectedSessionId?: number) => {
    setState('connecting')
    setErrorMessage(null)
    setAudioChunks([])
    setDuration(0)
    setMicHealthIssue(null)

    const sessionId = expectedSessionId ?? (recordingSessionIdRef.current + 1)
    recordingSessionIdRef.current = sessionId
    dispatchSessionIdRef.current = sessionId
    tabTrackTerminalHandledRef.current = false
    gracefulStopInProgressRef.current = false

    const notifyTabTrackEnded = () => {
      if (tabTrackTerminalHandledRef.current) {
        return
      }
      tabTrackTerminalHandledRef.current = true
      options.onTrackEnded?.()
    }

    try {
      const acquired = await acquireDualTabMicSources({
        meetingId: options.diagnosticMeetingId ?? null,
        noiseSuppressionEnabled,
      })
      dualCleanupRef.current = acquired.cleanup

      const streams: Array<{ streamId: DualTabMicStreamId; stream: MediaStream }> = [
        { streamId: 'tab', stream: acquired.tab.stream },
      ]
      if (acquired.micIncluded && acquired.mic) {
        streams.push({ streamId: 'mic', stream: acquired.mic.stream })
      }
      activeStreamIdsRef.current = streams.map((entry) => entry.streamId)

      trackEndedDetachRef.current = attachAudioTrackEndedHandler(acquired.tab.stream, () => {
        notifyTabTrackEnded()
      })

      tabPipelineMonitorRef.current = createTabAudioPipelineMonitor({
        stream: acquired.tab.stream,
        streamId: 'tab',
        meetingId: options.diagnosticMeetingId ?? null,
        sessionId,
        onTrackEnded: () => notifyTabTrackEnded(),
        onTrackMuted: () => {
          realtimeWarn('[Realtime] TAB_AUDIO_TRACK_MUTED_DIAGNOSTIC', {
            meetingId: options.diagnosticMeetingId ?? null,
            sessionId,
          })
        },
        onPipelineStalled: () => options.onPipelineStalled?.('tab'),
      })
      startedAtRef.current = performance.now()

      const format = getSupportedMediaRecorderFormat()
      const recorderOptions = buildMediaRecorderOptions(format)

      // Required: dual realtime recorders first.
      const recorders: StreamRecorder[] = streams.map(({ streamId, stream }) => {
        const recorder = new MediaRecorder(stream, recorderOptions)
        const chunks: Blob[] = []
        recorder.ondataavailable = (event) => {
          if (event.data.size <= 0) {
            return
          }
          if (recordingSessionIdRef.current !== sessionId || dispatchSessionIdRef.current !== sessionId) {
            return
          }
          chunks.push(event.data)
          setAudioChunks((prev) => [...prev, event.data])
          if (streamId === 'tab') {
            tabChunkSeqRef.current += 1
            const elapsedMs = startedAtRef.current === null
              ? 0
              : Math.max(0, Math.round(performance.now() - startedAtRef.current))
            tabPipelineMonitorRef.current?.notifyRecorderChunk({
              seq: tabChunkSeqRef.current,
              bytes: event.data.size,
              elapsedMs,
            })
          }
          void options.onChunkReady?.(event.data, streamId, sessionId)
        }
        recorder.start(timesliceMs)
        return { streamId, recorder, chunks }
      })

      streamRecordersRef.current = recorders

      // Optional: fallback mixed recorder — never fail dual realtime if this fails.
      fallbackRecorderRef.current = null
      micAnalyserRef.current = null
      micAnalyserDataRef.current = null
      if (acquired.micIncluded && acquired.mic) {
        try {
          const mixer = await createTabMicMixFromStreams(acquired.tab.stream, acquired.mic.stream, {
            stopMicTracksOnCleanup: false,
          })
          await ensureAudioContextRunning(mixer.audioContext)
          const fallbackChunks: Blob[] = []
          const fallbackRecorder = new MediaRecorder(mixer.mixedStream, recorderOptions)
          fallbackRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
              fallbackChunks.push(event.data)
            }
          }
          fallbackRecorder.start(timesliceMs)
          fallbackRecorderRef.current = {
            recorder: fallbackRecorder,
            chunks: fallbackChunks,
            format,
            mixer,
          }
          startMicHealthMonitor(acquired.mic.stream, mixer.micAnalyser, sessionId)
        } catch (fallbackError) {
          realtimeWarn('[Realtime] DUAL_FALLBACK_MIXER_UNAVAILABLE', {
            meetingId: options.diagnosticMeetingId ?? null,
            sessionId,
            error: fallbackError instanceof Error ? fallbackError.name : 'unknown',
          })
          try {
            // Best-effort: still expose mic health from a one-off analyser if mixer failed.
            startMicHealthMonitor(acquired.mic.stream, null, sessionId)
          } catch {
            // ignore
          }
        }
      }

      startedAtRef.current = Date.now()
      durationTimerRef.current = window.setInterval(() => {
        if (startedAtRef.current) {
          setDuration(Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000)))
        }
      }, 250)
      setState('recording')
      return sessionId
    } catch (error) {
      const message = mapAudioSourceErrorMessage(error)
      setErrorMessage(message)
      setState('error')
      cleanupRecordingResources()
      throw error
    }
  }, [cleanupRecordingResources, noiseSuppressionEnabled, options, startMicHealthMonitor, timesliceMs])

  const stopRecording = useCallback(() => {
    // Non-graceful: stop + full privacy cleanup immediately (logout / leave scene).
    cleanupRecordingResources()
    stopDurationTimer()
    setState('stopped')
  }, [cleanupRecordingResources, stopDurationTimer])

  const stopRecordingGraceful = useCallback(async (): Promise<GracefulStopResult> => {
    const sessionId = recordingSessionIdRef.current
    const recorders = [...streamRecordersRef.current]
    const fallback = fallbackRecorderRef.current
    gracefulStopInProgressRef.current = true

    const chunksBeforeByStream = new Map<DualTabMicStreamId, number>(
      recorders.map(({ streamId, chunks }) => [streamId, chunks.length]),
    )

    const stopTargets: MediaRecorder[] = [
      ...recorders.map(({ recorder }) => recorder),
      ...(fallback ? [fallback.recorder] : []),
    ]

    // Start requestData + stop for all recorders in the same phase, await in parallel.
    const settled = await Promise.allSettled(stopTargets.map((recorder) => stopRecorderGraceful(recorder)))
    void settled

    let postStopChunkCount = 0
    for (const { streamId, chunks } of recorders) {
      const before = chunksBeforeByStream.get(streamId) ?? 0
      postStopChunkCount += Math.max(0, chunks.length - before)
      // Chunks already dispatched once via ondataavailable — do not re-send.
    }

    let fullBlob: Blob
    let mimeType = 'audio/webm'
    let extension: 'webm' | 'm4a' = 'webm'
    let collectedChunkCount = 0
    let resultChunks: Blob[] = []

    if (fallback) {
      const resolved = resolveRecordedAudioResult({
        blob: new Blob(fallback.chunks, { type: fallback.recorder.mimeType || fallback.format.mimeType || 'audio/webm' }),
        recorderMimeType: fallback.recorder.mimeType,
        requestedFormat: fallback.format,
        chunks: fallback.chunks,
        sessionId,
        collectedChunkCount: fallback.chunks.length,
        postStopChunkCount: 0,
      })
      fullBlob = resolved.fullBlob
      mimeType = resolved.mimeType
      extension = resolved.extension
      collectedChunkCount = fallback.chunks.length
      resultChunks = fallback.chunks
    } else {
      // Degraded: tab-only encoder when fallback unavailable — never concat tab+mic.
      const tabRecorder = recorders.find((entry) => entry.streamId === 'tab')
      const tabChunks = tabRecorder?.chunks ?? []
      const format = getSupportedMediaRecorderFormat()
      const resolved = resolveRecordedAudioResult({
        blob: new Blob(tabChunks, { type: tabRecorder?.recorder.mimeType || format.mimeType || 'audio/webm' }),
        recorderMimeType: tabRecorder?.recorder.mimeType,
        requestedFormat: format,
        chunks: tabChunks,
        sessionId,
        collectedChunkCount: tabChunks.length,
        postStopChunkCount,
      })
      fullBlob = resolved.fullBlob
      mimeType = resolved.mimeType
      extension = resolved.extension
      collectedChunkCount = tabChunks.length
      resultChunks = tabChunks
    }

    stopDurationTimer()
    setState('stopped')
    // Drain complete — now safe to disconnect mixer and stop source tracks.
    cleanupRecordingResources()

    return {
      fullBlob,
      sessionId,
      collectedChunkCount,
      postStopChunkCount,
      chunks: resultChunks,
      mimeType,
      extension,
      recorded: {
        blob: fullBlob,
        mimeType,
        extension,
      },
    }
  }, [cleanupRecordingResources, stopDurationTimer])

  const pauseRecording = useCallback(() => {
    streamRecordersRef.current.forEach(({ recorder }) => {
      if (recorder.state === 'recording') {
        recorder.pause()
      }
    })
    const fallback = fallbackRecorderRef.current
    if (fallback?.recorder.state === 'recording') {
      fallback.recorder.pause()
    }
    setState('paused')
  }, [])

  const resumeRecording = useCallback(() => {
    streamRecordersRef.current.forEach(({ recorder }) => {
      if (recorder.state === 'paused') {
        recorder.resume()
      }
    })
    const fallback = fallbackRecorderRef.current
    if (fallback?.recorder.state === 'paused') {
      fallback.recorder.resume()
    }
    setState('recording')
  }, [])

  const getCurrentRms = useCallback((): number | null => {
    const analyser = micAnalyserRef.current
    const buffer = micAnalyserDataRef.current
    if (!analyser || !buffer) {
      return null
    }
    if (buffer.length !== analyser.fftSize) {
      micAnalyserDataRef.current = new Uint8Array(analyser.fftSize)
    }
    const samples = micAnalyserDataRef.current
    if (!samples) {
      return null
    }
    return measureAnalyserRms(analyser, samples)
  }, [])

  useEffect(() => () => {
    recordingSessionIdRef.current += 1
    dispatchSessionIdRef.current = recordingSessionIdRef.current
    cleanupRecordingResources()
  }, [cleanupRecordingResources])

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
    getRollingChunks: () => audioChunks,
    getActiveStreamIds: () => [...activeStreamIdsRef.current],
    micHealthIssue,
    micHealthMessage: micHealthIssue ? MIC_HEALTH_MESSAGES[micHealthIssue] : null,
  }
}

export const getDualStreamRecorderChunks = (
  recorders: StreamRecorder[],
): Array<{ streamId: DualTabMicStreamId; chunk: Blob }> => {
  return recorders.flatMap(({ streamId, chunks }) =>
    chunks.map((chunk) => ({ streamId, chunk })),
  )
}

export type { DualTabMicStreamId }
