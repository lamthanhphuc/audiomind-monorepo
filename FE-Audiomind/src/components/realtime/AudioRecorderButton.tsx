import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UseAudioRecorderReturn } from '../../hooks/useAudioRecorder'
import { AUDIO_DEBUG_ENABLED } from '../../services/config'
import {
  RECORDING_SOURCE_LABELS,
  type RecordingSource,
  isBrowserTabRecordingSource,
} from '../../constants/recordingSource'
import './AudioRecorderButton.css'

type RecorderLifecycleState =
  | 'idle'
  | 'connecting'
  | 'recording'
  | 'stopping'
  | 'finalizing_recording'
  | 'stopped'
  | 'no_transcript_after_finalize'
  | 'stopped_no_analysis'
  | 'failed_audio_capture'
  | 'error'

interface AudioRecorderButtonProps {
  recorder: UseAudioRecorderReturn
  recordingSource?: RecordingSource
  onChunkReady?: (chunk: Blob, sessionId: number) => void | Promise<void>
  onRecordingComplete?: (fullAudio: Blob, sessionId: number) => void
  onBeforeStartRecording?: (recordingSessionId: number) => Promise<void> | void
  onStopRequested?: () => void
  gracefulStopRef?: React.MutableRefObject<(() => Promise<void>) | null>
  lifecycleState?: RecorderLifecycleState
}

const formatDuration = (durationSeconds: number): string => {
  const minutes = Math.floor(durationSeconds / 60)
  const seconds = durationSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function AudioRecorderButton({
  recorder,
  recordingSource = 'microphone',
  onChunkReady,
  onRecordingComplete,
  onBeforeStartRecording,
  onStopRequested,
  gracefulStopRef,
  lifecycleState,
}: AudioRecorderButtonProps) {
  const emittedChunkCountRef = useRef(0)
  const pendingChunkDispatchesRef = useRef<Set<Promise<void>>>(new Set())
  const completionEmittedRef = useRef(false)
  const chunkDispatchEnabledRef = useRef(true)
  const chunksAtGracefulStopRef = useRef(0)
  const [isBusy, setIsBusy] = useState(false)
  const [chunkDispatchRevision, setChunkDispatchRevision] = useState(0)
  const effectiveState = lifecycleState ?? recorder.state

  const dispatchChunk = useCallback((chunk: Blob, sessionId: number, postStop: boolean) => {
    if (AUDIO_DEBUG_ENABLED || import.meta.env.DEV) {
      console.info('[Realtime] REALTIME_FINAL_CHUNK_ENQUEUED', {
        sessionId,
        size: chunk.size,
        postStop,
      })
    }
    const maybePromise = onChunkReady?.(chunk, sessionId)
    if (maybePromise && typeof (maybePromise as Promise<void>).then === 'function') {
      const trackedPromise = Promise.resolve(maybePromise).finally(() => {
        pendingChunkDispatchesRef.current.delete(trackedPromise)
      })
      pendingChunkDispatchesRef.current.add(trackedPromise)
    }
  }, [onChunkReady])

  useEffect(() => {
    if (recorder.audioChunks.length < emittedChunkCountRef.current) {
      emittedChunkCountRef.current = 0
    }

    if (!chunkDispatchEnabledRef.current) {
      return
    }

    if (recorder.audioChunks.length > emittedChunkCountRef.current) {
      const sessionId = recorder.recordingSessionId
      for (let index = emittedChunkCountRef.current; index < recorder.audioChunks.length; index += 1) {
        const postStop = index >= chunksAtGracefulStopRef.current && chunksAtGracefulStopRef.current > 0
        dispatchChunk(recorder.audioChunks[index], sessionId, postStop)
      }
      emittedChunkCountRef.current = recorder.audioChunks.length
    }
  }, [chunkDispatchRevision, dispatchChunk, recorder.audioChunks, recorder.recordingSessionId])

  useEffect(() => {
    if (effectiveState === 'recording' || effectiveState === 'paused' || effectiveState === 'connecting') {
      completionEmittedRef.current = false
      chunksAtGracefulStopRef.current = 0
    }
  }, [effectiveState])

  const performGracefulStop = useCallback(async () => {
    if (
      isBusy
      || effectiveState === 'connecting'
      || effectiveState === 'stopping'
      || effectiveState === 'finalizing_recording'
    ) {
      return
    }

    if (effectiveState !== 'recording' && effectiveState !== 'paused') {
      return
    }

    setIsBusy(true)
    onStopRequested?.()
    chunksAtGracefulStopRef.current = recorder.audioChunks.length

    try {
      const result = await recorder.stopRecordingGraceful()
      setChunkDispatchRevision((revision) => revision + 1)
      await Promise.resolve()

      const sessionId = result.sessionId
      const collectedChunks = result.chunks
      for (let index = emittedChunkCountRef.current; index < collectedChunks.length; index += 1) {
        const postStop = index >= chunksAtGracefulStopRef.current
        dispatchChunk(collectedChunks[index], sessionId, postStop)
        emittedChunkCountRef.current = index + 1
      }

      const pending = Array.from(pendingChunkDispatchesRef.current)
      if (pending.length > 0) {
        await Promise.allSettled(pending)
      }

      if (!completionEmittedRef.current) {
        completionEmittedRef.current = true
        onRecordingComplete?.(result.fullBlob, sessionId)
      }
    } finally {
      setIsBusy(false)
    }
  }, [
    dispatchChunk,
    effectiveState,
    isBusy,
    onRecordingComplete,
    onStopRequested,
    recorder,
  ])

  useEffect(() => {
    if (!gracefulStopRef) {
      return undefined
    }
    gracefulStopRef.current = performGracefulStop
    return () => {
      gracefulStopRef.current = null
    }
  }, [gracefulStopRef, performGracefulStop])

  const isTabSource = isBrowserTabRecordingSource(recordingSource)
  const sourceLabel = RECORDING_SOURCE_LABELS[recordingSource]

  const statusLabel = useMemo(() => {
    switch (effectiveState) {
      case 'connecting':
        return 'Đang kết nối realtime...'
      case 'stopping':
        return 'Đang hoàn tất ghi âm...'
      case 'finalizing_recording':
        return 'Đang hoàn tất ghi âm...'
      case 'recording':
        return `Đang ghi âm ${formatDuration(recorder.duration)}`
      case 'paused':
        return 'Đã tạm dừng'
      case 'error':
        return recorder.errorMessage || 'Không thể ghi âm'
      case 'stopped':
        return 'Đã dừng ghi âm'
      case 'no_transcript_after_finalize':
      case 'stopped_no_analysis':
        return 'Đã dừng ghi âm (chưa có transcript)'
      default:
        return isTabSource ? `Sẵn sàng ghi âm (${sourceLabel})` : 'Sẵn sàng ghi âm'
    }
  }, [effectiveState, isTabSource, recorder.duration, recorder.errorMessage, sourceLabel])

  const buttonLabel = useMemo(() => {
    switch (effectiveState) {
      case 'recording':
        return 'Dừng ghi âm'
      case 'paused':
        return 'Tiếp tục'
      case 'connecting':
        return 'Đang kết nối realtime...'
      case 'stopping':
      case 'finalizing_recording':
        return 'Đang dừng...'
      case 'error':
        return 'Thử lại'
      case 'no_transcript_after_finalize':
      case 'stopped_no_analysis':
        return 'Bắt đầu ghi âm'
      default:
        return isTabSource ? `Bắt đầu ${sourceLabel}` : 'Bắt đầu ghi âm'
    }
  }, [effectiveState, isTabSource, sourceLabel])

  const handleClick = async () => {
    if (
      isBusy
      || effectiveState === 'connecting'
      || effectiveState === 'stopping'
      || effectiveState === 'finalizing_recording'
    ) {
      return
    }

    if (effectiveState === 'recording' || effectiveState === 'paused') {
      await performGracefulStop()
      return
    }

    setIsBusy(true)
    chunkDispatchEnabledRef.current = false
    try {
      const recordingSessionId = await recorder.startRecording()
      if (recordingSessionId === null) {
        return
      }

      await onBeforeStartRecording?.(recordingSessionId)
      chunkDispatchEnabledRef.current = true
      setChunkDispatchRevision((revision) => revision + 1)
    } catch (error) {
      console.error('[AudioRecorderButton] Failed to start recording:', error)
      recorder.abortRecording()
    } finally {
      setIsBusy(false)
    }
  }

  const isActive = effectiveState === 'recording'
  const isPaused = effectiveState === 'paused'
  const isError = effectiveState === 'error'
  const disabled =
    effectiveState === 'connecting'
    || effectiveState === 'stopping'
    || effectiveState === 'finalizing_recording'
    || isBusy

  return (
    <div className="audio-recorder-widget">
      <button
        type="button"
        className={`audio-recorder-button ${isActive ? 'audio-recorder-button--recording' : ''} ${isPaused ? 'audio-recorder-button--paused' : ''} ${isError ? 'audio-recorder-button--error' : ''}`}
        onClick={handleClick}
        disabled={disabled}
        aria-label={buttonLabel}
        title={statusLabel}
      >
        <span className="audio-recorder-button__icon" aria-hidden="true">{isTabSource ? '🖥️' : '🎤'}</span>
      </button>

      <div className="audio-recorder-widget__meta">
        <div className="audio-recorder-widget__status">{statusLabel}</div>
        <div className="audio-recorder-widget__hint">
          {effectiveState === 'stopped'
            ? 'Đã lưu transcript'
            : effectiveState === 'no_transcript_after_finalize' || effectiveState === 'stopped_no_analysis'
              ? 'Chưa có transcript'
            : isActive
              ? 'Nhấn để dừng'
              : isPaused
                ? 'Nhấn để tiếp tục'
                : isTabSource
                  ? 'Chọn tab Google Meet khi trình duyệt hỏi'
                  : 'Nhấn để bắt đầu'}
        </div>
      </div>

      {isError && recorder.errorMessage && (
        <div className="audio-recorder-widget__error" role="alert">
          {recorder.errorMessage}
        </div>
      )}

      {(isActive || isPaused) && (
        <div className="audio-recorder-widget__timer" aria-live="polite">
          {formatDuration(recorder.duration)}
        </div>
      )}
    </div>
  )
}
