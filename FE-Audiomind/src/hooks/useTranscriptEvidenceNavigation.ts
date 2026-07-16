import { useCallback } from 'react'
import type { TranscriptSegment } from './useRealtimeMeetingStream'
import { resolveFirstSegmentTimeRange } from '../utils/transcriptEvidence'
import { scrollTranscriptToHighlight, type TranscriptHighlightRange } from '../utils/transcriptJump'

type UseTranscriptEvidenceNavigationOptions = {
  segments: TranscriptSegment[]
  onHighlightChange?: (range: TranscriptHighlightRange | null) => void
  onBeforeNavigate?: () => void
  onMissingSegment?: (segmentId: string) => void
}

export const useTranscriptEvidenceNavigation = ({
  segments,
  onHighlightChange,
  onBeforeNavigate,
  onMissingSegment,
}: UseTranscriptEvidenceNavigationOptions) => {
  const navigateToSegment = useCallback((segmentId: string) => {
    const normalizedId = segmentId.trim()
    if (!normalizedId) {
      return
    }
    onBeforeNavigate?.()
    const range = resolveFirstSegmentTimeRange(normalizedId, segments)
    if (!range) {
      onMissingSegment?.(normalizedId)
      return
    }
    onHighlightChange?.(range)
    scrollTranscriptToHighlight(range)
  }, [onBeforeNavigate, onHighlightChange, onMissingSegment, segments])

  return { navigateToSegment }
}
