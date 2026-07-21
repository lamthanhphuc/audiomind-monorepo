import React from 'react'
import type { TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import { useDomainLexiconTerms } from '../../hooks/useDomainLexiconTerms'
import { DEFAULT_IT_TERMS } from '../../constants/itTerms'
import { cssVars } from '../../utils/cssVars'
import {
  formatTranscriptTimestamp,
  groupUploadTranscriptSegmentsForDisplay,
  normalizeSpeakerBadge,
  parsePlainTranscriptText,
  sortTranscriptSegmentsByTimeline,
} from '../../utils/transcript'
import { HighlightedTranscriptText } from './HighlightedTranscriptText'
import './TranscriptDisplay.css'
import type { TranscriptHighlightRange } from '../../utils/transcriptJump'

interface TranscriptDisplayProps {
  segments: TranscriptSegment[]
  transcriptTextFallback?: string
  emptyMessage?: string
  maxHeight?: string
  enableDisplayGrouping?: boolean
  domainMode?: string | null
  onTermClick?: (term: string) => void
  speakerDisplayMap?: Record<string, string>
  /** @deprecated Prefer highlightRange */
  highlightStartTime?: number | null
  highlightRange?: TranscriptHighlightRange | null
}

const segmentOverlapsHighlight = (
  startSeconds: number,
  endSeconds: number,
  highlightRange: TranscriptHighlightRange | null | undefined,
  highlightStartTime: number | null | undefined,
): boolean => {
  if (highlightRange) {
    return startSeconds <= highlightRange.endTime && endSeconds >= highlightRange.startTime
  }
  if (highlightStartTime != null) {
    return Math.abs(startSeconds - highlightStartTime) < 1.5
  }
  return false
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
  enableDisplayGrouping = false,
  domainMode = null,
  onTermClick,
  speakerDisplayMap = {},
  highlightStartTime = null,
  highlightRange = null,
}) => {
  const lexiconTerms = useDomainLexiconTerms(domainMode)
  const highlightTerms = lexiconTerms.length > 0
    ? [...DEFAULT_IT_TERMS, ...lexiconTerms]
    : DEFAULT_IT_TERMS

  const displaySegments = sortTranscriptSegmentsByTimeline(
    segments.length > 0
      ? (enableDisplayGrouping ? groupUploadTranscriptSegmentsForDisplay(segments) : segments)
      : transcriptTextFallback
        ? parsePlainTranscriptText(transcriptTextFallback)
        : [],
  )

  if (displaySegments.length === 0) {
    return (
      <div className="transcript-display transcript-display--empty">
        <p className="transcript-display__empty">{emptyMessage}</p>
      </div>
    )
  }

  return (
    <section className="transcript-display" aria-label="Transcript readability panel">
      <div
        className="transcript-display__container"
        style={cssVars({ '--scroll-max-height': maxHeight })}
      >
        {displaySegments.map((segment) => {
          const timestampLabel = getTimestampLabel(segment)
          const speakerKey = normalizeSpeakerBadge(segment.speaker)
          const displayName = speakerDisplayMap[speakerKey]
          const speakerLabel = displayName?.trim() || normalizeSpeakerBadge(segment.speaker)
          const startSeconds = Number.isFinite(segment.start) ? segment.start : segment.timestamp ?? 0
          const endSeconds = Number.isFinite(segment.end) ? segment.end : startSeconds
          const isHighlighted = segmentOverlapsHighlight(
            startSeconds,
            endSeconds,
            highlightRange,
            highlightStartTime,
          )

          return (
            <article
              key={segment.mergeKey ?? segment.id}
              className={`transcript-display__segment${isHighlighted ? ' transcript-display__segment--highlight' : ''}`}
              data-segment-start={startSeconds}
              data-segment-end={endSeconds}
              data-transcript-segment-id={segment.id}
            >
              <div className="transcript-display__speaker-row">
                <span className="transcript-display__speaker">{speakerLabel}</span>
                {timestampLabel && (
                  <span className="transcript-display__timestamp">{timestampLabel}</span>
                )}
              </div>
              <div className="transcript-display__text">
                <HighlightedTranscriptText text={segment.text} terms={highlightTerms} onTermClick={onTermClick} />
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
