import React, { useEffect, useMemo, useRef } from 'react'
import { DEFAULT_IT_TERMS } from '../../constants/itTerms'
import { useDomainLexiconTerms } from '../../hooks/useDomainLexiconTerms'
import type { TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import { cssVars } from '../../utils/cssVars'
import { formatTranscriptTimestamp, normalizeSpeaker, sortTranscriptSegmentsByTimeline } from '../../utils/transcript'
import { HighlightedTranscriptText } from './HighlightedTranscriptText'
import './RealtimeTranscript.css'

interface RealtimeTranscriptProps {
  segments: TranscriptSegment[]
  isPaused?: boolean
  onPauseToggle?: (paused: boolean) => void
  highlightKeywords?: string[]
  maxHeight?: string
  emptyMessage?: string
  domainMode?: string | null
}

export const RealtimeTranscript: React.FC<RealtimeTranscriptProps> = ({
  segments,
  isPaused = false,
  onPauseToggle,
  highlightKeywords = [],
  maxHeight = '400px',
  emptyMessage = 'Waiting for transcript...',
  domainMode = null,
}) => {
  const lexiconTerms = useDomainLexiconTerms(domainMode)
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

  const displaySegments = useMemo(() => sortTranscriptSegmentsByTimeline(segments), [segments])

  const mergedHighlightTerms = useMemo(() => {
    const normalizedKeywords = highlightKeywords
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword.length > 0)
      .map((keyword) => ({ canonical: keyword }))

    const baseTerms = lexiconTerms.length > 0
      ? [...DEFAULT_IT_TERMS, ...lexiconTerms]
      : DEFAULT_IT_TERMS

    if (normalizedKeywords.length === 0) {
      return baseTerms
    }

    return [...baseTerms, ...normalizedKeywords]
  }, [highlightKeywords, lexiconTerms])

  if (displaySegments.length === 0) {
    return (
      <div className="realtime-transcript-empty">
        <p>{emptyMessage}</p>
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
        <span className="segment-count">{displaySegments.length} segments</span>
      </div>

      <div
        className="transcript-container"
        style={cssVars({ '--scroll-max-height': maxHeight })}
        ref={scrollContainerRef}
      >
        {displaySegments.map((segment) => {
          const startSeconds = segment.start ?? segment.timestamp ?? 0
          const endSeconds = segment.end ?? startSeconds
          const timestampLabel = endSeconds > startSeconds
            ? `${formatTranscriptTimestamp(startSeconds)} - ${formatTranscriptTimestamp(endSeconds)}`
            : formatTranscriptTimestamp(startSeconds)

          return (
            <div
              key={segment.mergeKey ?? segment.id}
              className="transcript-segment"
            >
              <div className="segment-speaker">{normalizeSpeaker(segment.speaker, 'SPEAKER_1')}</div>
              <div className="segment-text">
                {segment.text && segment.text.trim().length > 0 ? (
                  <HighlightedTranscriptText
                    text={segment.text}
                    terms={mergedHighlightTerms}
                    enabled={mergedHighlightTerms.length > 0}
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
