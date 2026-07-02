import { useCallback, useRef, useState } from 'react'
import {
  acquireDualTabMicSources,
  attachAudioTrackEndedHandler,
  mapAudioSourceErrorMessage,
  type DualTabMicStreamId,
} from '../utils/audioSourceAcquisition'
import {
  REALTIME_RECORDER_TIMESLICE_MS,
} from '../services/config'
import type { AudioRecorderState, GracefulStopResult, UseAudioRecorderReturn } from './useAudioRecorder'
import {
  RECORDER_STOP_TIMEOUT_MS,
  REQUEST_DATA_GRACE_MS,
} from './useAudioRecorder'
import {
  createTabAudioPipelineMonitor,
  type TabAudioPipelineMonitor,
} from '../utils/tabAudioPipeline'

const RECORDER_MIME_TYPE = 'audio/webm; codecs=opus'

type StreamRecorder = {
  streamId: DualTabMicStreamId
  recorder: MediaRecorder
  chunks: Blob[]
}

export type UseDualAudioRecorderOptions = {
  timesliceMs?: number
  onTrackEnded?: () => void
  onCaptureError?: (message: string) => void
  onPipelineStalled?: (streamId: DualTabMicStreamId) => void
  diagnosticMeetingId?: number | null
  onChunkReady?: (chunk: Blob, streamId: DualTabMicStreamId, sessionId: number) => void | Promise<void>
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, ms)
})

export const useDualAudioRecorder = (
  options: UseDualAudioRecorderOptions = {},
): UseAudioRecorderReturn => {
  const [state, setState] = useState<AudioRecorderState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [audioChunks, setAudioChunks] = useState<Blob[]>([])
  const [duration, setDuration] = useState(0)

  const recordingSessionIdRef = useRef(0)
  const streamRecordersRef = useRef<StreamRecorder[]>([])
  const activeStreamIdsRef = useRef<DualTabMicStreamId[]>(['tab'])
  const dualCleanupRef = useRef<(() => void) | null>(null)
  const trackEndedDetachRef = useRef<(() => void) | null>(null)
  const tabTrackTerminalHandledRef = useRef(false)
  const durationTimerRef = useRef<number | null>(null)
  const startedAtRef = useRef<number | null>(null)
  const tabPipelineMonitorRef = useRef<TabAudioPipelineMonitor | null>(null)
  const tabChunkSeqRef = useRef(0)
  const timesliceMs = Math.max(100, Math.floor(options.timesliceMs ?? REALTIME_RECORDER_TIMESLICE_MS))

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
      const acquired = await acquireDualTabMicSources({ meetingId: options.diagnosticMeetingId ?? null })
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
      }, {
        onMuted: () => {
          console.warn('[Realtime] TAB_AUDIO_TRACK_MUTED_DIAGNOSTIC', {
            meetingId: options.diagnosticMeetingId ?? null,
            sessionId,
          })
        },
      })

      tabPipelineMonitorRef.current = createTabAudioPipelineMonitor({
        stream: acquired.tab.stream,
        streamId: 'tab',
        meetingId: options.diagnosticMeetingId ?? null,
        sessionId,
        onTrackEnded: () => notifyTabTrackEnded(),
        onTrackMuted: () => {
          console.warn('[Realtime] TAB_AUDIO_TRACK_MUTED_DIAGNOSTIC', {
            meetingId: options.diagnosticMeetingId ?? null,
            sessionId,
          })
        },
        onPipelineStalled: () => options.onPipelineStalled?.('tab'),
      })
      startedAtRef.current = performance.now()

      const recorders: StreamRecorder[] = streams.map(({ streamId, stream }) => {
        const recorder = new MediaRecorder(stream, { mimeType: RECORDER_MIME_TYPE })
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
  }, [cleanupRecordingResources, options, timesliceMs])

  const stopRecording = useCallback(() => {
    streamRecordersRef.current.forEach(({ recorder }) => {
      if (recorder.state === 'recording' || recorder.state === 'paused') {
        recorder.stop()
      }
    })
    stopDurationTimer()
    setState('stopped')
    dualCleanupRef.current?.()
    dualCleanupRef.current = null
  }, [stopDurationTimer])

  const stopRecordingGraceful = useCallback(async (): Promise<GracefulStopResult> => {
    const sessionId = recordingSessionIdRef.current
    const recorders = [...streamRecordersRef.current]
    const postStopChunks: Blob[] = []

    await Promise.all(recorders.map(async ({ streamId, recorder, chunks }) => {
      const chunksBefore = chunks.length
      if (recorder.state === 'recording' || recorder.state === 'paused') {
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
        for (let index = chunksBefore; index < chunks.length; index += 1) {
          const chunk = chunks[index]
          postStopChunks.push(chunk)
          void options.onChunkReady?.(chunk, streamId, sessionId)
        }
      }
    }))

    stopDurationTimer()
    setState('stopped')
    dualCleanupRef.current?.()
    dualCleanupRef.current = null

    const allChunks = recorders.flatMap(({ chunks }) => chunks)
    const fullBlob = new Blob(allChunks, { type: RECORDER_MIME_TYPE })
    return {
      fullBlob,
      sessionId,
      collectedChunkCount: allChunks.length,
      postStopChunkCount: postStopChunks.length,
      chunks: allChunks,
    }
  }, [stopDurationTimer])

  const pauseRecording = useCallback(() => {
    streamRecordersRef.current.forEach(({ recorder }) => {
      if (recorder.state === 'recording') {
        recorder.pause()
      }
    })
    setState('paused')
  }, [])

  const resumeRecording = useCallback(() => {
    streamRecordersRef.current.forEach(({ recorder }) => {
      if (recorder.state === 'paused') {
        recorder.resume()
      }
    })
    setState('recording')
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
    getCurrentRms: () => null,
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
