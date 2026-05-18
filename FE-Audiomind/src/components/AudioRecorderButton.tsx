import { useEffect, useMemo, useRef, useState } from 'react'
import type { UseAudioRecorderReturn } from '../hooks/useAudioRecorder'
import './AudioRecorderButton.css'

interface AudioRecorderButtonProps {
  recorder: UseAudioRecorderReturn
  onChunkReady?: (chunk: Blob) => void
  onRecordingComplete?: (fullAudio: Blob) => void
  onBeforeStartRecording?: () => Promise<void> | void
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
}: AudioRecorderButtonProps) {
  const emittedChunkCountRef = useRef(0)
  const completionEmittedRef = useRef(false)
  const [isBusy, setIsBusy] = useState(false)

  useEffect(() => {
    if (recorder.audioChunks.length < emittedChunkCountRef.current) {
      emittedChunkCountRef.current = 0
    }

    if (recorder.audioChunks.length > emittedChunkCountRef.current) {
      for (let index = emittedChunkCountRef.current; index < recorder.audioChunks.length; index += 1) {
        onChunkReady?.(recorder.audioChunks[index])
      }
      emittedChunkCountRef.current = recorder.audioChunks.length
    }
  }, [onChunkReady, recorder.audioChunks])

  useEffect(() => {
    if (recorder.state === 'recording' || recorder.state === 'paused' || recorder.state === 'requesting-permission') {
      completionEmittedRef.current = false
    }

    if (
      recorder.state === 'stopped' &&
      !completionEmittedRef.current &&
      recorder.audioChunks.length > 0 &&
      emittedChunkCountRef.current >= recorder.audioChunks.length
    ) {
      completionEmittedRef.current = true
      onRecordingComplete?.(new Blob(recorder.audioChunks, { type: RECORDING_MIME_TYPE }))
    }
  }, [onRecordingComplete, recorder.audioChunks, recorder.state])

  const statusLabel = useMemo(() => {
    switch (recorder.state) {
      case 'requesting-permission':
        return 'Đang xin quyền...'
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
  }, [recorder.duration, recorder.errorMessage, recorder.state])

  const buttonLabel = useMemo(() => {
    switch (recorder.state) {
      case 'recording':
        return 'Dừng ghi âm'
      case 'paused':
        return 'Tiếp tục'
      case 'requesting-permission':
        return 'Đang xin quyền...'
      case 'error':
        return 'Thử lại'
      default:
        return 'Bắt đầu ghi âm'
    }
  }, [recorder.state])

  const handleClick = async () => {
    if (isBusy || recorder.state === 'requesting-permission') {
      return
    }

    if (recorder.state === 'recording') {
      recorder.stopRecording()
      return
    }

    if (recorder.state === 'paused') {
      recorder.resumeRecording()
      return
    }

    setIsBusy(true)
    try {
      await onBeforeStartRecording?.()
      await recorder.startRecording()
    } catch (error) {
      console.error('[AudioRecorderButton] Failed to start recording:', error)
    } finally {
      setIsBusy(false)
    }
  }

  const isActive = recorder.state === 'recording'
  const isPaused = recorder.state === 'paused'
  const isError = recorder.state === 'error'
  const disabled = recorder.state === 'requesting-permission' || isBusy

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
          {isActive ? 'Nhấn để dừng' : isPaused ? 'Nhấn để tiếp tục' : 'Nhấn để bắt đầu'}
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
