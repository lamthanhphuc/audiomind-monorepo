import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'
import { highlightRangeFromTime, type TranscriptHighlightRange } from './transcriptJump'

/** Handler signature shared by every "Xem bằng chứng" evidence button across the app. */
export type EvidenceClickHandler = (segmentIds: string[]) => void

// Mirrors LEGACY_SEGMENT_ID_PATTERN in
// demoRecordAUDIOMID/ai-service/app/services/segment_identity.py
const LEGACY_SEGMENT_ID_PATTERN = /^meeting-(\d+)-(\d+(?:\.\d+)?)-([a-z0-9_]+)-\d+$/i
const CANONICAL_SEGMENT_ID_PATTERN = /^meeting-(\d+)-start-(\d+(?:\.\d+)?)-([a-z0-9_]+)$/i

type TranscriptEvidenceContext = {
  meetingId?: number | null
}

const parseCanonicalEvidenceIdentity = (
  segmentId: string,
): { meetingId: number; startTime: number; speaker: string } | null => {
  const match = CANONICAL_SEGMENT_ID_PATTERN.exec(canonicalizeSegmentId(segmentId))
  if (!match) {
    return null
  }
  const meetingId = Number(match[1])
  const startTime = Number(match[2])
  if (!Number.isFinite(meetingId) || !Number.isFinite(startTime)) {
    return null
  }
  return { meetingId, startTime, speaker: match[3].toLowerCase() }
}

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
  context: TranscriptEvidenceContext = {},
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

  // Upload/saved transcript APIs may return a visually consolidated row with
  // a synthetic `time-*` id while analysis evidence retains canonical raw
  // ids. In that narrow case, resolve the canonical evidence start against
  // the containing transcript time range. The caller must provide meetingId
  // so evidence from another meeting can never match by timestamp alone.
  if (context.meetingId != null) {
    for (const rawId of segmentIds) {
      const canonicalId = canonicalizeSegmentId(String(rawId ?? '').trim())
      const hasExactMatch = matched.some((segment) => {
        const segmentId = String(segment.id ?? '').trim()
        return segmentId === rawId || canonicalizeSegmentId(segmentId) === canonicalId
      })
      if (hasExactMatch) {
        continue
      }
      const identity = parseCanonicalEvidenceIdentity(String(rawId ?? '').trim())
      if (!identity || identity.meetingId !== context.meetingId) {
        continue
      }
      const containing = segments.find((segment) => {
        const segmentStart = Number.isFinite(segment.start) ? segment.start : segment.timestamp ?? 0
        const segmentEnd = Number.isFinite(segment.end) && segment.end > segmentStart
          ? segment.end
          : segmentStart
        const segmentMeetingId = Number(segment.meetingId)
        if (Number.isFinite(segmentMeetingId) && segmentMeetingId !== identity.meetingId) {
          return false
        }
        return segmentStart <= identity.startTime && segmentEnd >= identity.startTime
      })
      if (containing && !matched.includes(containing)) {
        matched.push(containing)
      }
    }
  }

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
