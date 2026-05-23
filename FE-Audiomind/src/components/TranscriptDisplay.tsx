import React from 'react'
import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'
import { formatTranscriptTimestamp, normalizeSpeakerBadge, parsePlainTranscriptText } from '../utils/transcript'
import './TranscriptDisplay.css'

interface TranscriptDisplayProps {
  segments: TranscriptSegment[]
  transcriptTextFallback?: string
  emptyMessage?: string
  maxHeight?: string
}

const getTimestampLabel = (segment: TranscriptSegment): string | null => {
  const startSeconds = Number.isFinite(segment.start) ? segment.start : segment.timestamp ?? 0
  const endSeconds = Number.isFinite(segment.end) ? segment.end : startSeconds

  if (startSeconds <= 0 && endSeconds <= 0) {
    return null
  }

  if (endSeconds > startSeconds) {
    return `${formatTranscriptTimestamp(startSeconds)} - ${formatTranscriptTimestamp(endSeconds)}`
  }

  return formatTranscriptTimestamp(startSeconds)
}

export const TranscriptDisplay: React.FC<TranscriptDisplayProps> = ({
  segments,
  transcriptTextFallback,
  emptyMessage = 'Không có transcript',
  maxHeight = '480px',
}) => {
  const displaySegments = segments.length > 0
    ? segments
    : transcriptTextFallback
      ? parsePlainTranscriptText(transcriptTextFallback)
      : []

  if (displaySegments.length === 0) {
    return (
      <div className="transcript-display transcript-display--empty">
        <p className="transcript-display__empty">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <section className="transcript-display" aria-label="Transcript readability panel">
      <div className="transcript-display__container" style={{ maxHeight }}>
        {displaySegments.map((segment) => {
          const timestampLabel = getTimestampLabel(segment)

          return (
            <article key={segment.mergeKey ?? segment.id} className="transcript-display__segment">
              <div className="transcript-display__speaker-row">
                <span className="transcript-display__speaker">{normalizeSpeakerBadge(segment.speaker)}</span>
                {timestampLabel && (
                  <span className="transcript-display__timestamp">{timestampLabel}</span>
                )}
              </div>
              <div className="transcript-display__text">{segment.text}</div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
