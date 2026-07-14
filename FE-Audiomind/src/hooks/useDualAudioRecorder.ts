import { useCallback, useRef, useState } from 'react'
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
import { realtimeWarn } from '../utils/realtimeTelemetry'
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
  chunks: Blob[],
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
  void chunks
}

export const useDualAudioRecorder = (
  options: UseDualAudioRecorderOptions = {},
): UseAudioRecorderReturn => {
  const [state, setState] = useState<AudioRecorderState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [audioChunks, setAudioChunks] = useState<Blob[]>([])
  const [duration, setDuration] = useState(0)

  const recordingSessionIdRef = useRef(0)
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
  const timesliceMs = Math.max(100, Math.floor(options.timesliceMs ?? REALTIME_RECORDER_TIMESLICE_MS))
  const noiseSuppressionEnabled = options.noiseSuppressionEnabled ?? true

  const stopDurationTimer = useCallback(() => {
    if (durationTimerRef.current !== null) {
      window.clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }
  }, [])

  const cleanupRecordingResources = useCallback(() => {
    trackEndedDetachRef.current?.()
    trackEndedDetachRef.current = null
    tabPipelineMonitorRef.current?.cleanup()
    tabPipelineMonitorRef.current = null
    tabChunkSeqRef.current = 0
    streamRecordersRef.current.forEach(({ recorder }) => {
      try {
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
        if (fallback.recorder.state !== 'inactive') {
          fallback.recorder.stop()
        }
      } catch {
        // ignore
      }
      fallback.mixer.cleanupGraph()
      fallbackRecorderRef.current = null
    }
    micAnalyserRef.current = null
    micAnalyserDataRef.current = null

    dualCleanupRef.current?.()
    dualCleanupRef.current = null
    tabTrackTerminalHandledRef.current = false
    stopDurationTimer()
  }, [stopDurationTimer])

  const abortRecording = useCallback(() => {
    recordingSessionIdRef.current += 1
    cleanupRecordingResources()
    setState('idle')
    setAudioChunks([])
    setDuration(0)
    startedAtRef.current = null
  }, [cleanupRecordingResources])

  const startRecording = useCallback(async (expectedSessionId?: number) => {
    setState('connecting')
    setErrorMessage(null)
    setAudioChunks([])
    setDuration(0)

    const sessionId = expectedSessionId ?? (recordingSessionIdRef.current + 1)
    recordingSessionIdRef.current = sessionId
    tabTrackTerminalHandledRef.current = false

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

      if (acquired.micIncluded && acquired.mic) {
        const mixer = await createTabMicMixFromStreams(acquired.tab.stream, acquired.mic.stream, {
          stopMicTracksOnCleanup: false,
        })
        await ensureAudioContextRunning(mixer.audioContext)
        micAnalyserRef.current = mixer.micAnalyser
        if (mixer.micAnalyser) {
          micAnalyserDataRef.current = new Uint8Array(mixer.micAnalyser.fftSize)
        }
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
      } else {
        fallbackRecorderRef.current = null
        micAnalyserRef.current = null
        micAnalyserDataRef.current = null
      }

      const recorders: StreamRecorder[] = streams.map(({ streamId, stream }) => {
        const recorder = new MediaRecorder(stream, recorderOptions)
        const chunks: Blob[] = []
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
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
        }
        recorder.start(timesliceMs)
        return { streamId, recorder, chunks }
      })

      streamRecordersRef.current = recorders
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
  }, [cleanupRecordingResources, noiseSuppressionEnabled, options, timesliceMs])

  const stopRecording = useCallback(() => {
    streamRecordersRef.current.forEach(({ recorder }) => {
      if (recorder.state === 'recording' || recorder.state === 'paused') {
        recorder.stop()
      }
    })
    const fallback = fallbackRecorderRef.current
    if (fallback && (fallback.recorder.state === 'recording' || fallback.recorder.state === 'paused')) {
      try {
        fallback.recorder.stop()
      } catch {
        // ignore
      }
    }
    stopDurationTimer()
    setState('stopped')
  }, [stopDurationTimer])

  const stopRecordingGraceful = useCallback(async (): Promise<GracefulStopResult> => {
    const sessionId = recordingSessionIdRef.current
    const recorders = [...streamRecordersRef.current]
    const fallback = fallbackRecorderRef.current
    const postStopChunks: Blob[] = []

    await Promise.all(recorders.map(async ({ streamId, recorder, chunks }) => {
      const chunksBefore = chunks.length
      await stopRecorderGraceful(recorder, chunks)
      for (let index = chunksBefore; index < chunks.length; index += 1) {
        const chunk = chunks[index]
        postStopChunks.push(chunk)
        void options.onChunkReady?.(chunk, streamId, sessionId)
      }
    }))

    let fullBlob: Blob
    let mimeType = 'audio/webm'
    let extension: 'webm' | 'm4a' = 'webm'
    let collectedChunkCount = 0

    if (fallback) {
      await stopRecorderGraceful(fallback.recorder, fallback.chunks)
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
      fallback.mixer.cleanupGraph()
      fallbackRecorderRef.current = null
    } else {
      // Tab-only dual fallback when mic unavailable: use tab recorder alone (single encoder).
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
        postStopChunkCount: postStopChunks.length,
      })
      fullBlob = resolved.fullBlob
      mimeType = resolved.mimeType
      extension = resolved.extension
      collectedChunkCount = tabChunks.length
    }

    stopDurationTimer()
    setState('stopped')
    // Drain complete — now safe to stop source tracks.
    dualCleanupRef.current?.()
    dualCleanupRef.current = null
    micAnalyserRef.current = null
    micAnalyserDataRef.current = null

    return {
      fullBlob,
      sessionId,
      collectedChunkCount,
      postStopChunkCount: postStopChunks.length,
      chunks: fallback?.chunks ?? recorders.find((entry) => entry.streamId === 'tab')?.chunks ?? [],
      mimeType,
      extension,
      recorded: {
        blob: fullBlob,
        mimeType,
        extension,
      },
    }
  }, [options, stopDurationTimer])

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
