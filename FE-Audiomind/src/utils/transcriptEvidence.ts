import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'
import { highlightRangeFromTime, type TranscriptHighlightRange } from './transcriptJump'

export const resolveSegmentTimeRange = (
  segmentIds: string[],
  segments: TranscriptSegment[],
): TranscriptHighlightRange | null => {
  if (segmentIds.length === 0 || segments.length === 0) {
    return null
  }

  const idSet = new Set(segmentIds.map((id) => id.trim()).filter(Boolean))
  const matched = segments.filter((segment) => idSet.has(String(segment.id).trim()))
  if (matched.length === 0) {
    return null
  }

  let startTime = Number.POSITIVE_INFINITY
  let endTime = 0
  for (const segment of matched) {
    const start = Number.isFinite(segment.start) ? segment.start : segment.timestamp ?? 0
    const end = Number.isFinite(segment.end) && segment.end > start ? segment.end : start
    if (start < startTime) {
      startTime = start
    }
    if (end > endTime) {
      endTime = end
    }
  }

  if (!Number.isFinite(startTime)) {
    return null
  }

  return highlightRangeFromTime(startTime, endTime)
}

export const resolveFirstSegmentTimeRange = (
  segmentId: string,
  segments: TranscriptSegment[],
): TranscriptHighlightRange | null => {
  return resolveSegmentTimeRange([segmentId], segments)
}
