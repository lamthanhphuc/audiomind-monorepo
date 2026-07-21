import { useCallback } from 'react'
import type { TranscriptSegment } from './useRealtimeMeetingStream'
import { resolveTranscriptEvidenceRange, type EvidenceClickHandler } from '../utils/transcriptEvidence'
import { scrollTranscriptToHighlight, type TranscriptHighlightRange } from '../utils/transcriptJump'

type UseTranscriptEvidenceNavigationOptions = {
  segments: TranscriptSegment[]
  meetingId?: number | null
  onHighlightChange?: (range: TranscriptHighlightRange | null) => void
  /** Fired only after evidence successfully resolves to a transcript range. */
  onNavigateSuccess?: () => void
  onMissingSegment?: (segmentIds: string[]) => void
}

export const useTranscriptEvidenceNavigation = ({
  segments,
  meetingId,
  onHighlightChange,
  onNavigateSuccess,
  onMissingSegment,
}: UseTranscriptEvidenceNavigationOptions): { navigateToSegment: EvidenceClickHandler } => {
  const navigateToSegment = useCallback<EvidenceClickHandler>((segmentIds) => {
    const normalizedIds = (segmentIds ?? [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean)
    if (normalizedIds.length === 0) {
      return
    }
    const range = resolveTranscriptEvidenceRange(normalizedIds, segments, { meetingId })
    if (!range) {
      onMissingSegment?.(normalizedIds)
      return
    }
    onNavigateSuccess?.()
    onHighlightChange?.(range)
    scrollTranscriptToHighlight(range)
  }, [meetingId, onHighlightChange, onMissingSegment, onNavigateSuccess, segments])

  return { navigateToSegment }
}
