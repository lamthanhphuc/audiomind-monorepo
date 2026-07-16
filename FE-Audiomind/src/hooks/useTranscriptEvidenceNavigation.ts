import { useCallback } from 'react'
import type { TranscriptSegment } from './useRealtimeMeetingStream'
import { resolveTranscriptEvidenceRange, type EvidenceClickHandler } from '../utils/transcriptEvidence'
import { scrollTranscriptToHighlight, type TranscriptHighlightRange } from '../utils/transcriptJump'

type UseTranscriptEvidenceNavigationOptions = {
  segments: TranscriptSegment[]
  onHighlightChange?: (range: TranscriptHighlightRange | null) => void
  /** Fired only after evidence successfully resolves to a transcript range. */
  onNavigateSuccess?: () => void
  onMissingSegment?: (segmentIds: string[]) => void
}

export const useTranscriptEvidenceNavigation = ({
  segments,
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
    const range = resolveTranscriptEvidenceRange(normalizedIds, segments)
    if (!range) {
      onMissingSegment?.(normalizedIds)
      return
    }
    onNavigateSuccess?.()
    onHighlightChange?.(range)
    scrollTranscriptToHighlight(range)
  }, [onHighlightChange, onMissingSegment, onNavigateSuccess, segments])

  return { navigateToSegment }
}
