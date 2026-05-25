import { useEffect, useMemo, useRef, useState } from 'react'
import type { UseAudioRecorderReturn } from '../hooks/useAudioRecorder'
import './AudioRecorderButton.css'

interface AudioRecorderButtonProps {
  recorder: UseAudioRecorderReturn
  onChunkReady?: (chunk: Blob, sessionId: number) => void | Promise<void>
  onRecordingComplete?: (fullAudio: Blob, sessionId: number) => void
  onBeforeStartRecording?: () => Promise<{ expectedSessionId?: number } | void> | { expectedSessionId?: number } | void
  lifecycleState?: 'idle' | 'connecting' | 'recording' | 'stopping' | 'stopped' | 'error'
}

const RECORDING_MIME_TYPE = 'audio/webm; codecs=opus'

const formatDuration = (durationSeconds: number): string => {
  const minutes = Math.floor(durationSeconds / 60)
  const seconds = durationSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function AudioRecorderButton({
  recorder,
  onChunkReady,
  onRecordingComplete,
  onBeforeStartRecording,
  lifecycleState,
}: AudioRecorderButtonProps) {
  const emittedChunkCountRef = useRef(0)
  const pendingChunkDispatchesRef = useRef<Set<Promise<void>>>(new Set())
  const completionEmittedRef = useRef(false)
  const [isBusy, setIsBusy] = useState(false)
  const effectiveState = lifecycleState ?? recorder.state

  useEffect(() => {
    if (recorder.audioChunks.length < emittedChunkCountRef.current) {
      emittedChunkCountRef.current = 0
    }

    if (recorder.audioChunks.length > emittedChunkCountRef.current) {
      const sessionId = recorder.recordingSessionId
      for (let index = emittedChunkCountRef.current; index < recorder.audioChunks.length; index += 1) {
        const maybePromise = onChunkReady?.(recorder.audioChunks[index], sessionId)
        if (maybePromise && typeof (maybePromise as Promise<void>).then === 'function') {
          const trackedPromise = Promise.resolve(maybePromise).finally(() => {
            pendingChunkDispatchesRef.current.delete(trackedPromise)
          })
          pendingChunkDispatchesRef.current.add(trackedPromise)
        }
      }
      emittedChunkCountRef.current = recorder.audioChunks.length
    }
  }, [onChunkReady, recorder.audioChunks, recorder.recordingSessionId])

  useEffect(() => {
    if (effectiveState === 'recording' || effectiveState === 'paused' || effectiveState === 'connecting') {
      completionEmittedRef.current = false
    }

    if (
      effectiveState === 'stopped' &&
      !completionEmittedRef.current &&
      recorder.audioChunks.length > 0 &&
      emittedChunkCountRef.current >= recorder.audioChunks.length
    ) {
      completionEmittedRef.current = true
      void (async () => {
        const pending = Array.from(pendingChunkDispatchesRef.current)
        if (pending.length > 0) {
          await Promise.allSettled(pending)
        }
        onRecordingComplete?.(new Blob(recorder.audioChunks, { type: RECORDING_MIME_TYPE }), recorder.recordingSessionId)
      })()
    }
  }, [effectiveState, onRecordingComplete, recorder.audioChunks, recorder.recordingSessionId])

  const statusLabel = useMemo(() => {
    switch (effectiveState) {
      case 'connecting':
        return 'Đang kết nối realtime...'
      case 'stopping':
        return 'Đang dừng và lưu transcript...'
      case 'recording':
        return `Đang ghi âm ${formatDuration(recorder.duration)}`
      case 'paused':
        return 'Đã tạm dừng'
      case 'error':
        return recorder.errorMessage || 'Không thể ghi âm'
      case 'stopped':
        return 'Đã dừng ghi âm'
      default:
        return 'Sẵn sàng ghi âm'
    }
  }, [effectiveState, recorder.duration, recorder.errorMessage])

  const buttonLabel = useMemo(() => {
    switch (effectiveState) {
      case 'recording':
        return 'Dừng ghi âm'
      case 'paused':
        return 'Tiếp tục'
      case 'connecting':
        return 'Đang kết nối realtime...'
      case 'stopping':
        return 'Đang dừng...'
      case 'error':
        return 'Thử lại'
      default:
        return 'Bắt đầu ghi âm'
    }
  }, [effectiveState])

  const handleClick = async () => {
    if (isBusy || effectiveState === 'connecting' || effectiveState === 'stopping') {
      return
    }

    if (effectiveState === 'recording') {
      recorder.stopRecording()
      return
    }

    if (effectiveState === 'paused') {
      recorder.resumeRecording()
      return
    }

    setIsBusy(true)
    try {
      const prepareResult = await onBeforeStartRecording?.()
      await recorder.startRecording(prepareResult?.expectedSessionId)
    } catch (error) {
      console.error('[AudioRecorderButton] Failed to start recording:', error)
    } finally {
      setIsBusy(false)
    }
  }

  const isActive = effectiveState === 'recording'
  const isPaused = effectiveState === 'paused'
  const isError = effectiveState === 'error'
  const disabled = effectiveState === 'connecting' || effectiveState === 'stopping' || isBusy

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
        <span className="audio-recorder-button__icon" aria-hidden="true">🎤</span>
      </button>

      <div className="audio-recorder-widget__meta">
        <div className="audio-recorder-widget__status">{statusLabel}</div>
        <div className="audio-recorder-widget__hint">
          {effectiveState === 'stopped'
            ? 'Đã lưu transcript'
            : isActive
              ? 'Nhấn để dừng'
              : isPaused
                ? 'Nhấn để tiếp tục'
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
