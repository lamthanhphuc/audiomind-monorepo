import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'
import { highlightRangeFromTime, type TranscriptHighlightRange } from './transcriptJump'

/** Handler signature shared by every "Xem bằng chứng" evidence button across the app. */
export type EvidenceClickHandler = (segmentIds: string[]) => void

// Mirrors LEGACY_SEGMENT_ID_PATTERN in
// demoRecordAUDIOMID/ai-service/app/services/segment_identity.py
const LEGACY_SEGMENT_ID_PATTERN = /^meeting-(\d+)-(\d+(?:\.\d+)?)-([a-z0-9_]+)-\d+$/i

/**
 * Ports `canonicalize_segment_id` from the AI service so the FE can match legacy
 * ("meeting-<id>-<start>-<speaker>-<index>") and canonical
 * ("meeting-<id>-start-<start>-<speaker>") segment ids interchangeably.
 * Never throws: unrecognized input is returned trimmed and unchanged.
 */
export const canonicalizeSegmentId = (segmentId: unknown): string => {
  const raw = String(segmentId ?? '').trim()
  if (!raw) {
    return raw
  }
  const match = LEGACY_SEGMENT_ID_PATTERN.exec(raw)
  if (!match) {
    return raw
  }
  const [, meeting, start, speaker] = match
  const startNumber = Number(start)
  if (!Number.isFinite(startNumber)) {
    return raw
  }
  return `meeting-${meeting}-start-${startNumber.toFixed(3)}-${speaker.toLowerCase()}`
}

/**
 * Resolves the transcript highlight range covering ALL requested segment ids
 * (not just the first match). Both the requested ids and the transcript
 * segment ids are canonicalized before matching so legacy/canonical id
 * formats interchange transparently. Requested ids are deduped; malformed or
 * unknown ids are simply ignored (never throws).
 */
export const resolveTranscriptEvidenceRange = (
  segmentIds: string[],
  segments: TranscriptSegment[],
): TranscriptHighlightRange | null => {
  if (!Array.isArray(segmentIds) || segmentIds.length === 0 || segments.length === 0) {
    return null
  }

  const canonicalTargets = new Set<string>()
  for (const rawId of segmentIds) {
    const trimmed = String(rawId ?? '').trim()
    if (!trimmed) continue
    canonicalTargets.add(trimmed)
    canonicalTargets.add(canonicalizeSegmentId(trimmed))
  }

  if (canonicalTargets.size === 0) {
    return null
  }

  const matched = segments.filter((segment) => {
    const rawId = String(segment.id ?? '').trim()
    if (!rawId) return false
    return canonicalTargets.has(rawId) || canonicalTargets.has(canonicalizeSegmentId(rawId))
  })

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

/** @deprecated Prefer {@link resolveTranscriptEvidenceRange}. Kept for backward compatibility. */
export const resolveSegmentTimeRange = resolveTranscriptEvidenceRange

export const resolveFirstSegmentTimeRange = (
  segmentId: string,
  segments: TranscriptSegment[],
): TranscriptHighlightRange | null => {
  return resolveTranscriptEvidenceRange([segmentId], segments)
}
