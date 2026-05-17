import React, { useEffect, useRef } from 'react'
import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'
import './RealtimeTranscript.css'

interface RealtimeTranscriptProps {
  segments: TranscriptSegment[]
  isPaused?: boolean
  onPauseToggle?: (paused: boolean) => void
  highlightKeywords?: string[]
  maxHeight?: string
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

export const RealtimeTranscript: React.FC<RealtimeTranscriptProps> = ({
  segments,
  isPaused = false,
  onPauseToggle,
  highlightKeywords = [],
  maxHeight = '400px',
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const animationFrameRef = useRef<number | null>(null)

  useEffect(() => {
    if (isPaused || segments.length === 0) {
      return
    }

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
    }

    animationFrameRef.current = requestAnimationFrame(() => {
      const container = scrollContainerRef.current
      if (!container) {
        return
      }

      container.scrollTop = container.scrollHeight
    })

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [segments, isPaused])

  const highlightText = (text: string, keywords: string[]) => {
    if (keywords.length === 0) {
      return escapeHtml(text)
    }

    let highlighted = escapeHtml(text)
    keywords.forEach((keyword) => {
      const safeKeyword = escapeRegExp(keyword)
      if (!safeKeyword) {
        return
      }
      const regex = new RegExp(`(${safeKeyword})`, 'gi')
      highlighted = highlighted.replace(regex, '<span class="keyword-highlight">$1</span>')
    })
    return highlighted
  }

  if (segments.length === 0) {
    return (
      <div className="realtime-transcript-empty">
        <p>Waiting for transcript...</p>
      </div>
    )
  }

  return (
    <div className="realtime-transcript">
      <div className="transcript-controls">
        {onPauseToggle && (
          <button
            className="pause-button"
            onClick={() => onPauseToggle(!isPaused)}
            title={isPaused ? 'Resume' : 'Pause'}
          >
            {isPaused ? '▶' : '⏸'}
          </button>
        )}
        <span className="segment-count">{segments.length} segments</span>
      </div>

      <div
        className="transcript-container"
        style={{ maxHeight }}
        ref={scrollContainerRef}
      >
        {segments.map((segment) => {
          const startMs = segment.start ?? segment.timestamp ?? 0
          const endMs = segment.end ?? startMs
          const timestampLabel = endMs > startMs
            ? `${formatTimestamp(startMs)} - ${formatTimestamp(endMs)}`
            : formatTimestamp(startMs)

          return (
            <div
              key={segment.id}
              className="transcript-segment"
            >
              <div className="segment-speaker">{segment.speaker}</div>
              <div className="segment-text">
                {segment.text && segment.text.trim().length > 0 ? (
                  <div
                    dangerouslySetInnerHTML={{
                      __html: highlightText(segment.text, highlightKeywords),
                    }}
                  />
                ) : (
                  <div className="listening-placeholder">Đang lắng nghe...</div>
                )}
                {segment.confidence !== undefined && segment.confidence < 0.9 && (
                  <span className="confidence-badge">
                    {Math.round(segment.confidence * 100)}%
                  </span>
                )}
              </div>
              <div className="segment-timestamp">
                {timestampLabel}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function formatTimestamp(secondsValue: number): string {
  const totalSeconds = Math.max(0, Math.floor(secondsValue))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
