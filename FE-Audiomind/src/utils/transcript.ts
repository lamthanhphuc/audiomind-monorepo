import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'

type TranscriptSource = Record<string, unknown>
const SPEAKER_MARKER_PATTERN = /(SPEAKER_\d+|Speaker\s+\d+):/gi
const LEGACY_SEGMENT_ID_PATTERN = /^meeting-(\d+)-(\d+(?:\.\d+)?)-([a-z0-9_]+)-\d+$/i
const CANONICAL_SEGMENT_ID_PATTERN = /^meeting-(\d+)-start-(\d+(?:\.\d+)?)-([a-z0-9_]+)$/i
const SENTENCE_END_PUNCTUATION_PATTERN = /[.!?;…]\s*$/
const CONNECTOR_PREFIX_PATTERN = /^(và|hoặc|hay|nhưng|nên|thì|mà|and|or|but|so)\b/i
const BOUNDARY_PUNCTUATION_PATTERN = /[,:-]\s*$/

const SHORT_SEGMENT_MAX_WORDS = 3
const SHORT_SEGMENT_MAX_CHARS = 20
const SHORT_SEGMENT_MAX_DURATION_SECONDS = 1.5
const MERGE_MAX_GAP_SECONDS = 5
const MERGE_MAX_TEXT_CHARS = 700
const MERGE_MAX_DURATION_SECONDS = 90

const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()

export type DualStreamTranscriptId = 'tab' | 'mic'

export const inferStreamIdFromSpeaker = (speaker: string): DualStreamTranscriptId | undefined => {
  const upper = speaker.trim().toUpperCase()
  if (upper.startsWith('TAB_')) {
    return 'tab'
  }
  if (upper.startsWith('MIC_')) {
    return 'mic'
  }
  return undefined
}

const resolveStreamId = (
  data: TranscriptSource,
  speaker: string,
): DualStreamTranscriptId | undefined => {
  const raw = toStringValue(data.streamId, data.stream_id).toLowerCase()
  if (raw === 'tab' || raw === 'mic') {
    return raw
  }
  return inferStreamIdFromSpeaker(speaker)
}

export const formatDualStreamSpeakerLabel = (
  speaker: string,
  streamId?: DualStreamTranscriptId,
): string => {
  const normalized = speaker.trim().toUpperCase()
  const effectiveStream = streamId ?? inferStreamIdFromSpeaker(speaker)
  const speakerNumber = normalized.match(/SPEAKER_(\d+)/)?.[1]

  if (effectiveStream === 'tab') {
    return speakerNumber ? `Tab ${speakerNumber}` : 'Tab'
  }
  if (effectiveStream === 'mic') {
    return speakerNumber ? `Mic ${speakerNumber}` : 'Mic'
  }

  return normalizeSpeakerBadge(speaker)
}

const streamKeySuffix = (streamId?: DualStreamTranscriptId): string =>
  streamId ? `|${streamId}` : ''

const toScopeSuffix = (
  meetingId?: number,
  recordingSessionId?: number,
  attemptId?: number,
  seq?: number,
): string => {
  if (recordingSessionId === undefined && attemptId === undefined) {
    return ''
  }
  if (recordingSessionId !== undefined && attemptId !== undefined) {
    const meetingPart = meetingId === undefined ? 'meeting' : String(meetingId)
    const seqPart = seq === undefined ? 'seq' : String(seq)
    return `|scope:v2:${meetingPart}:${recordingSessionId}:${attemptId}:${seqPart}`
  }
  return '|scope:invalid'
}

const resolveScopeSuffix = (data: TranscriptSource): string =>
  toScopeSuffix(
    toOptionalNumber(data.meetingId, data.meeting_id),
    toOptionalNumber(data.recordingSessionId, data.recording_session_id),
    toOptionalNumber(data.attemptId, data.attempt_id),
    toOptionalNumber(data.seq),
  )

const canonicalSpeakerKey = (value: string): string => {
  const normalized = normalizeText(value)
  if (!normalized || normalized === 'unknown' || normalized === 'system') {
    return 'speaker_1'
  }
  return normalized
}

export const normalizeSpeaker = (value: string, fallbackSpeaker?: string): string => {
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === 'system') {
    return fallbackSpeaker ?? trimmed
  }

  return trimmed
}

export const normalizeSpeakerBadge = (value: string, fallbackSpeaker = 'SPEAKER_1'): string => {
  const trimmed = value.trim()
  if (!trimmed) {
    return fallbackSpeaker
  }

  const canonicalUpperMatch = trimmed.match(/^SPEAKER_(\d+)$/i)
  if (canonicalUpperMatch) {
    return `SPEAKER_${canonicalUpperMatch[1]}`
  }

  const canonicalSpelledMatch = trimmed.match(/^Speaker\s+(\d+)$/i)
  if (canonicalSpelledMatch) {
    return `SPEAKER_${canonicalSpelledMatch[1]}`
  }

  return normalizeSpeaker(trimmed, fallbackSpeaker)
}

const toNumber = (...values: unknown[]): number => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }

  return 0
}

const toOptionalNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }

  return undefined
}

const toStringValue = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }

  return ''
}

const toStringArray = (...values: unknown[]): string[] | undefined => {
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue
    }
    const normalized = value
      .map((item) => toStringValue(item))
      .filter((item) => item.length > 0)
    if (normalized.length > 0) {
      return normalized
    }
  }

  return undefined
}

const isLikelySequenceId = (value: string): boolean => /^seq-\d+$/i.test(value) || /^-?\d+$/.test(value)

export const canonicalizeSegmentId = (value: string): string => {
  const raw = String(value || '').trim()
  if (!raw) {
    return raw
  }
  const canonicalMatch = raw.match(CANONICAL_SEGMENT_ID_PATTERN)
  if (canonicalMatch) {
    return `meeting-${canonicalMatch[1]}-start-${Number(canonicalMatch[2]).toFixed(3)}-${canonicalMatch[3].toLowerCase()}`
  }
  const legacyMatch = raw.match(LEGACY_SEGMENT_ID_PATTERN)
  if (legacyMatch) {
    return `meeting-${legacyMatch[1]}-start-${Number(legacyMatch[2]).toFixed(3)}-${legacyMatch[3].toLowerCase()}`
  }
  return raw
}

const resolveSegmentStartForSort = (segment: TranscriptSegment): number => {
  const start = toOptionalNumber(segment.start, segment.timestamp)
  return start ?? 0
}

const resolveSegmentEndForSort = (segment: TranscriptSegment, start: number): number => {
  const end = toOptionalNumber(segment.end)
  return end ?? start
}

const resolveSegmentOriginalIndexForSort = (segment: TranscriptSegment): number => {
  return toOptionalNumber(segment.originalIndex) ?? Number.POSITIVE_INFINITY
}

export const sortTranscriptSegmentsByTimeline = (segments: TranscriptSegment[]): TranscriptSegment[] => {
  if (!Array.isArray(segments) || segments.length === 0) {
    return []
  }

  return segments
    .map((segment, inputIndex) => ({ segment, inputIndex }))
    .sort((left, right) => {
      const leftStart = resolveSegmentStartForSort(left.segment)
      const rightStart = resolveSegmentStartForSort(right.segment)
      if (leftStart !== rightStart) {
        return leftStart - rightStart
      }

      const leftEnd = resolveSegmentEndForSort(left.segment, leftStart)
      const rightEnd = resolveSegmentEndForSort(right.segment, rightStart)
      if (leftEnd !== rightEnd) {
        return leftEnd - rightEnd
      }

      const leftOriginalIndex = resolveSegmentOriginalIndexForSort(left.segment)
      const rightOriginalIndex = resolveSegmentOriginalIndexForSort(right.segment)
      if (leftOriginalIndex !== rightOriginalIndex) {
        return leftOriginalIndex - rightOriginalIndex
      }

      return left.inputIndex - right.inputIndex
    })
    .map(({ segment }) => segment)
}

const resolveTiming = (data: TranscriptSource): { start: number; end: number } | null => {
  const start = toNumber(data.startTime, data.start_time, data.start)
  const end = toNumber(data.endTime, data.end_time, data.end)
  const duration = toNumber(data.duration, data.duration_ms, data.durationMs)

  const resolvedEnd = end > 0 ? end : start > 0 && duration > 0 ? start + duration : 0
  if (start <= 0 && resolvedEnd <= 0) {
    return null
  }

  return {
    start,
    end: resolvedEnd > 0 ? resolvedEnd : start,
  }
}

const resolveDisplayId = (data: TranscriptSource, timing: { start: number; end: number } | null): string => {
  const explicitId = toStringValue(data.segmentId, data.segment_id, data.id)
  const dedupeKey = toStringValue(data.dedupeKey, data.dedupe_key)
  const speaker = canonicalSpeakerKey(toStringValue(data.speaker))

  if (explicitId && !isLikelySequenceId(explicitId)) {
    return canonicalizeSegmentId(explicitId)
  }

  if (dedupeKey) {
    return dedupeKey
  }

  if (timing) {
    const speakerPart = speaker ? `-${speaker}` : ''
    return `time-${timing.start.toFixed(3)}${speakerPart}`
  }

  if (explicitId) {
    return explicitId
  }

  const seq = toNumber(data.seq)
  if (seq > 0) {
    return `seq-${seq}`
  }

  return `seg-${Date.now()}`
}

const resolveMergeKey = (data: TranscriptSource, timing: { start: number; end: number } | null): string => {
  const explicitId = toStringValue(data.segmentId, data.segment_id, data.id)
  const dedupeKey = toStringValue(data.dedupeKey, data.dedupe_key)
  const speaker = canonicalSpeakerKey(toStringValue(data.speaker))
  const streamSuffix = streamKeySuffix(resolveStreamId(data, toStringValue(data.speaker)))
  const scopeSuffix = resolveScopeSuffix(data)

  if (explicitId && !isLikelySequenceId(explicitId)) {
    return `segment:${canonicalizeSegmentId(explicitId)}${streamSuffix}${scopeSuffix}`
  }

  if (dedupeKey) {
    return `dedupe:${dedupeKey}${streamSuffix}${scopeSuffix}`
  }

  if (timing) {
    return `semantic:${timing.start.toFixed(3)}|${speaker}${streamSuffix}${scopeSuffix}`
  }

  const fallbackText = normalizeText(toStringValue(data.text, data.transcript))
  if (fallbackText) {
    return `text:${speaker}${streamSuffix}${scopeSuffix}|${fallbackText}`
  }

  return resolveDisplayId(data, timing)
}

const getComparableText = (segment: TranscriptSegment): string => normalizeText(segment.text)

const getSemanticKey = (segment: TranscriptSegment): string => {
  const speaker = canonicalSpeakerKey(segment.speaker)
  return `semantic:${segment.start.toFixed(3)}|${speaker}${streamKeySuffix(segment.streamId)}${toScopeSuffix(segment.meetingId, segment.recordingSessionId, segment.attemptId, segment.seq)}`
}

const isFallbackDisplayId = (value: string): boolean =>
  value.startsWith('time-') || value.startsWith('semantic:') || value.startsWith('text:') || value.startsWith('seq-') || value.startsWith('seg-')

const isSpecificMergeKey = (value?: string): boolean => !!value && (value.startsWith('segment:') || value.startsWith('dedupe:'))
const HYDRATION_START_TIME_TOLERANCE_SECONDS = 0.4
const FINAL_SMOOTHING_START_TIME_TOLERANCE_SECONDS = 0.75

const hasSpecificIdentity = (segment: TranscriptSegment): boolean => {
  if (isSpecificMergeKey(segment.mergeKey)) {
    return true
  }

  return Boolean(segment.id) && !isFallbackDisplayId(segment.id) && !isLikelySequenceId(segment.id)
}

const isHydrationSegment = (segment: TranscriptSegment): boolean => segment.source === 'hydration'

type TranscriptIdentityStream = DualStreamTranscriptId | 'default'

const getIdentityStream = (segment: Pick<TranscriptSegment, 'streamId'>): TranscriptIdentityStream =>
  segment.streamId ?? 'default'

const getIdentityScope = (segment: Pick<TranscriptSegment, 'meetingId' | 'recordingSessionId' | 'attemptId' | 'seq'>): string =>
  toScopeSuffix(segment.meetingId, segment.recordingSessionId, segment.attemptId, segment.seq)

const streamsCompatible = (existing: TranscriptSegment, incoming: TranscriptSegment): boolean =>
  getIdentityStream(existing) === getIdentityStream(incoming)
  && getIdentityScope(existing) === getIdentityScope(incoming)

const findExactSegmentById = (current: TranscriptSegment[], incoming: TranscriptSegment): number => {
  if (incoming.mergeKey && isSpecificMergeKey(incoming.mergeKey)) {
    const byMergeKey = current.findIndex((segment) => segment.mergeKey === incoming.mergeKey)
    if (byMergeKey >= 0) {
      return byMergeKey
    }
  }

  if (incoming.id) {
    const byId = current.findIndex((segment) => segment.id === incoming.id && streamsCompatible(segment, incoming))
    if (byId >= 0) {
      return byId
    }
  }

  return -1
}

const findHydrationMatchByTiming = (current: TranscriptSegment[], incoming: TranscriptSegment): number => {
  if (!isHydrationSegment(incoming)) {
    return -1
  }

  if (!Number.isFinite(incoming.start) || incoming.start <= 0) {
    return -1
  }

  const incomingSpeaker = canonicalSpeakerKey(incoming.speaker)
  if (!incomingSpeaker) {
    return -1
  }

  let matchedIndex = -1
  let smallestDelta = Number.POSITIVE_INFINITY

  current.forEach((segment, index) => {
    if (!streamsCompatible(segment, incoming)) {
      return
    }

    if (!hasSpecificIdentity(segment)) {
      return
    }

    const existingSpeaker = canonicalSpeakerKey(segment.speaker)
    if (!existingSpeaker || existingSpeaker !== incomingSpeaker) {
      return
    }

    if (!Number.isFinite(segment.start) || segment.start <= 0) {
      return
    }

    const startDelta = Math.abs(segment.start - incoming.start)
    if (startDelta > HYDRATION_START_TIME_TOLERANCE_SECONDS || startDelta >= smallestDelta) {
      return
    }

    smallestDelta = startDelta
    matchedIndex = index
  })

  return matchedIndex
}

const findFinalSmoothingMatch = (current: TranscriptSegment[], incoming: TranscriptSegment): number => {
  if (!Boolean(incoming.isFinal)) {
    return -1
  }

  if (!Number.isFinite(incoming.start) || incoming.start <= 0) {
    return -1
  }

  const incomingText = getComparableText(incoming)
  if (!incomingText) {
    return -1
  }

  let matchedIndex = -1
  let smallestDelta = Number.POSITIVE_INFINITY

  current.forEach((segment, index) => {
    if (!streamsCompatible(segment, incoming)) {
      return
    }

    const existingText = getComparableText(segment)
    if (!existingText) {
      return
    }

    if (!Number.isFinite(segment.start) || segment.start <= 0) {
      return
    }

    const startDelta = Math.abs(segment.start - incoming.start)
    if (startDelta > FINAL_SMOOTHING_START_TIME_TOLERANCE_SECONDS || startDelta > smallestDelta) {
      return
    }

    const textsOverlap =
      existingText === incomingText
      || existingText.includes(incomingText)
      || incomingText.includes(existingText)

    if (!textsOverlap) {
      return
    }

    if (startDelta < smallestDelta || (startDelta === smallestDelta && index > matchedIndex)) {
      smallestDelta = startDelta
      matchedIndex = index
    }
  })

  return matchedIndex
}

const chooseDisplayId = (existing: TranscriptSegment, incoming: TranscriptSegment): string => {
  if (!isFallbackDisplayId(incoming.id) && isFallbackDisplayId(existing.id)) {
    return incoming.id
  }

  if (!isFallbackDisplayId(existing.id) && isFallbackDisplayId(incoming.id)) {
    return existing.id
  }

  return incoming.id || existing.id
}

const chooseMergeKey = (existing: TranscriptSegment, incoming: TranscriptSegment): string | undefined => {
  if (isSpecificMergeKey(incoming.mergeKey) && !isSpecificMergeKey(existing.mergeKey)) {
    return incoming.mergeKey
  }

  if (isSpecificMergeKey(existing.mergeKey) && !isSpecificMergeKey(incoming.mergeKey)) {
    return existing.mergeKey
  }

  return incoming.mergeKey || existing.mergeKey
}

const sharesTranscriptIdentity = (existing: TranscriptSegment, incoming: TranscriptSegment): boolean => {
  const existingSpecific = hasSpecificIdentity(existing)
  const incomingSpecific = hasSpecificIdentity(incoming)

  if (existing.mergeKey && incoming.mergeKey && existing.mergeKey === incoming.mergeKey) {
    return true
  }

  if (existingSpecific && incomingSpecific) {
    return false
  }

  if (existing.id === incoming.id && streamsCompatible(existing, incoming)) {
    return true
  }

  if (existingSpecific || incomingSpecific) {
    return false
  }

  if (getSemanticKey(existing) === getSemanticKey(incoming)) {
    return true
  }

  const existingText = getComparableText(existing)
  const incomingText = getComparableText(incoming)
  if (!existingText || !incomingText) {
    return false
  }

  return existingText.startsWith(incomingText) || incomingText.startsWith(existingText)
}

const resolvePreferredSegment = (existing: TranscriptSegment, incoming: TranscriptSegment): TranscriptSegment => {
  const existingFinal = Boolean(existing.isFinal)
  const incomingFinal = Boolean(incoming.isFinal)
  if (existingFinal !== incomingFinal) {
    return incomingFinal ? incoming : existing
  }

  const existingText = getComparableText(existing)
  const incomingText = getComparableText(incoming)
  if (incomingText.length !== existingText.length) {
    return incomingText.length > existingText.length ? incoming : existing
  }

  const existingConfidence = existing.confidence ?? -1
  const incomingConfidence = incoming.confidence ?? -1
  if (incomingConfidence !== existingConfidence) {
    return incomingConfidence > existingConfidence ? incoming : existing
  }

  const existingEnd = Number.isFinite(existing.end) ? existing.end : 0
  const incomingEnd = Number.isFinite(incoming.end) ? incoming.end : 0
  if (incomingEnd !== existingEnd) {
    return incomingEnd > existingEnd ? incoming : existing
  }

  return incoming
}

export const normalizeTranscriptEvent = (
  data: TranscriptSource,
  messageType?: string,
  options?: { fallbackSpeaker?: string; source?: 'live' | 'hydration' },
): TranscriptSegment | null => {
  const text = toStringValue(data.text, data.transcript)
  if (text.trim().length === 0) {
    return null
  }

  const timing = resolveTiming(data)
  const explicitId = toStringValue(data.segmentId, data.segment_id, data.id)
  const seq = toNumber(data.seq)
  const hasRealSegmentId = Boolean(explicitId) && !isLikelySequenceId(explicitId)
  const isAggregateSentinel = seq === -1 || explicitId === '-1'

  if (isAggregateSentinel && !hasRealSegmentId && timing === null) {
    return null
  }

  const start = timing?.start ?? toNumber(data.startTime, data.start_time, data.timestamp)
  const end = timing?.end ?? toNumber(data.endTime, data.end_time, start)
  const isFinal = messageType === 'transcript.final' || Boolean(data.isFinal || data.is_final)
  const speaker = normalizeSpeaker(toStringValue(data.speaker), options?.fallbackSpeaker)
  const streamId = resolveStreamId(data, speaker)
  const meetingId = toOptionalNumber(data.meetingId, data.meeting_id)
  const recordingSessionId = toOptionalNumber(data.recordingSessionId, data.recording_session_id)
  const attemptId = toOptionalNumber(data.attemptId, data.attempt_id)

  return {
    id: resolveDisplayId(data, timing),
    mergeKey: resolveMergeKey(data, timing),
    meetingId,
    speaker,
    text,
    start,
    end,
    timestamp: start,
    confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
    language: toStringValue(data.language) || undefined,
    isFinal,
    source: options?.source ?? 'live',
    streamId,
    recordingSessionId,
    attemptId,
    seq: seq > 0 ? seq : undefined,
    providerSpeaker: toStringValue(data.providerSpeaker, data.provider_speaker) || undefined,
    originalSpeaker: toStringValue(data.originalSpeaker, data.original_speaker) || undefined,
    providerSpeakers: toStringArray(data.providerSpeakers, data.provider_speakers),
    originalSpeakers: toStringArray(data.originalSpeakers, data.original_speakers),
    originalIndex: toOptionalNumber(data.originalIndex, data.original_index),
  }
}

export const normalizePersistedTranscriptSegments = (
  segments: TranscriptSource[],
  options?: { fallbackSpeaker?: string },
): TranscriptSegment[] => {
  return segments
    .map((segment) => {
      const explicitId = toStringValue(segment.segment_id, segment.segmentId, segment.id)
      const hasMeaningfulTiming =
        toNumber(segment.start_time, segment.start) > 0 || toNumber(segment.end_time, segment.end) > 0

      if (!hasMeaningfulTiming && !explicitId) {
        return null
      }

      const normalized = normalizeTranscriptEvent({
        segmentId: explicitId,
        speaker: normalizeSpeaker(toStringValue(segment.speaker), options?.fallbackSpeaker),
        text: segment.text,
        startTime: segment.start_time,
        endTime: segment.end_time,
        start: segment.start_time,
        end: segment.end_time,
        meetingId: segment.meetingId ?? segment.meeting_id,
        recordingSessionId: segment.recordingSessionId ?? segment.recording_session_id,
        attemptId: segment.attemptId ?? segment.attempt_id,
        seq: segment.seq,
        streamId: segment.streamId ?? segment.stream_id,
        isFinal: segment.is_final ?? segment.isFinal ?? true,
        providerSpeaker: segment.providerSpeaker ?? segment.provider_speaker,
        originalSpeaker: segment.originalSpeaker ?? segment.original_speaker,
        providerSpeakers: segment.providerSpeakers ?? segment.provider_speakers,
        originalSpeakers: segment.originalSpeakers ?? segment.original_speakers,
        originalIndex: segment.originalIndex ?? segment.original_index,
      }, undefined, { fallbackSpeaker: options?.fallbackSpeaker, source: 'hydration' })

      if (!normalized) {
        return null
      }

      return normalized
    })
    .filter((segment): segment is TranscriptSegment => segment !== null)
}

export const upsertTranscriptSegment = (
  current: TranscriptSegment[],
  incoming: TranscriptSegment,
): { segments: TranscriptSegment[]; segment: TranscriptSegment } => {
  const isHydrationIncoming = isHydrationSegment(incoming)
  let existingIndex = findExactSegmentById(current, incoming)
  if (isHydrationIncoming && existingIndex < 0) {
    existingIndex = findHydrationMatchByTiming(current, incoming)
  }
  if (isHydrationIncoming && existingIndex < 0) {
    existingIndex = current.findIndex((segment) => sharesTranscriptIdentity(segment, incoming))
  }
  if (!isHydrationIncoming && existingIndex < 0 && Boolean(incoming.isFinal)) {
    existingIndex = findFinalSmoothingMatch(current, incoming)
  }
  if (existingIndex < 0) {
    console.info('[Realtime] LIVE_SEGMENT_UPSERT', {
      action: 'insert',
      segmentId: incoming.id,
      mergeKey: incoming.mergeKey,
      isFinal: Boolean(incoming.isFinal),
    })
    return {
      segments: [...current, incoming],
      segment: incoming,
    }
  }

  const existing = current[existingIndex]
  const existingFinal = Boolean(existing.isFinal)
  const incomingFinal = Boolean(incoming.isFinal)
  const existingText = getComparableText(existing)
  const incomingText = getComparableText(incoming)

  if (existingFinal && !incomingFinal) {
    console.info('[Realtime] LIVE_SEGMENT_DUPLICATE_IGNORED', {
      reason: 'stale_partial_after_final',
      segmentId: existing.id,
      mergeKey: existing.mergeKey,
    })
    return {
      segments: current,
      segment: existing,
    }
  }

  if (existingText.length > 0 && existingText === incomingText && existingFinal === incomingFinal) {
    if (!incomingFinal || canonicalSpeakerKey(existing.speaker) === canonicalSpeakerKey(incoming.speaker)) {
      console.info('[Realtime] LIVE_SEGMENT_DUPLICATE_IGNORED', {
        reason: 'same_segment_same_text',
        segmentId: existing.id,
        mergeKey: existing.mergeKey,
        isFinal: existingFinal,
      })
      return {
        segments: current,
        segment: existing,
      }
    }
  }

  if (existingFinal && incomingFinal && existingText.length > 0 && existingText === incomingText) {
    console.info('[Realtime] LIVE_SEGMENT_DUPLICATE_IGNORED', {
      reason: 'final_text_match_requires_speaker_update',
      segmentId: existing.id,
      mergeKey: existing.mergeKey,
    })
  }

  if (!existingFinal && incomingFinal) {
    console.info('[Realtime] LIVE_SEGMENT_FINAL_UPGRADE', {
      segmentId: incoming.id,
      mergeKey: incoming.mergeKey,
    })
  }

  const preferred = resolvePreferredSegment(existing, incoming)
  const sourceSegment = preferred === incoming ? incoming : existing
  const mergedSegment: TranscriptSegment = {
    ...existing,
    ...incoming,
    ...preferred,
    id: chooseDisplayId(existing, incoming),
    mergeKey: chooseMergeKey(existing, incoming),
    speaker: Boolean(incoming.isFinal) && !isHydrationIncoming
      ? (incoming.speaker.trim().length > 0 ? incoming.speaker : existing.speaker)
      : (sourceSegment.speaker.trim().length > 0 ? sourceSegment.speaker : (preferred === incoming ? existing.speaker : incoming.speaker)),
    text: sourceSegment.text,
    start: sourceSegment.start,
    end: sourceSegment.end,
    timestamp: sourceSegment.timestamp,
    confidence: sourceSegment.confidence,
    language: sourceSegment.language,
    isFinal: sourceSegment.isFinal,
  }

  const updated = [...current]
  updated[existingIndex] = mergedSegment
  console.info('[Realtime] LIVE_SEGMENT_UPSERT', {
    action: 'update',
    segmentId: mergedSegment.id,
    mergeKey: mergedSegment.mergeKey,
    isFinal: Boolean(mergedSegment.isFinal),
  })
  return {
    segments: updated,
    segment: mergedSegment,
  }
}

export const mergeTranscriptSegments = (segments: TranscriptSegment[]): TranscriptSegment[] => {
  return segments.reduce<TranscriptSegment[]>((current, incoming) => {
    return upsertTranscriptSegment(current, incoming).segments
  }, [])
}

const hasComparableTextOverlap = (left: string, right: string): boolean => {
  const normalizedLeft = normalizeText(left)
  const normalizedRight = normalizeText(right)
  if (!normalizedLeft || !normalizedRight) {
    return false
  }
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)
}

const segmentsShareConsistencyIdentity = (left: TranscriptSegment, right: TranscriptSegment): boolean => {
  if (left.mergeKey && right.mergeKey && left.mergeKey === right.mergeKey) {
    return true
  }

  if (left.id && right.id && left.id === right.id) {
    return true
  }

  return getSemanticKey(left) === getSemanticKey(right)
}

const sameStartSpeakerForConsistency = (left: TranscriptSegment, right: TranscriptSegment): boolean => (
  canonicalSpeakerKey(left.speaker) === canonicalSpeakerKey(right.speaker)
  && Math.abs((left.start ?? 0) - (right.start ?? 0)) <= HYDRATION_START_TIME_TOLERANCE_SECONDS
)

const hasHeavyTimingOverlap = (left: TranscriptSegment, right: TranscriptSegment): boolean => {
  const overlap = Math.min(left.end ?? left.start ?? 0, right.end ?? right.start ?? 0)
    - Math.max(left.start ?? 0, right.start ?? 0)
  return overlap > 1.0
}

const resolveSignatureIdentity = (segment: TranscriptSegment): string => {
  const mergeKey = segment.mergeKey ?? ''
  if (mergeKey.startsWith('segment:')) {
    const segmentPart = mergeKey.slice('segment:'.length)
    const canonicalMatch = segmentPart.match(/^meeting-\d+-start-(\d+(?:\.\d+)?)-([a-z0-9_]+)$/i)
    if (canonicalMatch) {
      return `semantic:${Number(canonicalMatch[1]).toFixed(3)}|${canonicalMatch[2].toLowerCase()}`
    }
    return segmentPart
  }

  if (mergeKey.startsWith('semantic:')) {
    return mergeKey
  }

  if (mergeKey.startsWith('dedupe:')) {
    return mergeKey
  }

  return getSemanticKey(segment)
}

export const buildTranscriptEquivalenceSignature = (segments: TranscriptSegment[]): string => {
  return sortTranscriptSegmentsByTimeline(segments)
    .map((segment) => [
      resolveSignatureIdentity(segment),
      Number(segment.start ?? 0).toFixed(3),
      Number(segment.end ?? segment.start ?? 0).toFixed(3),
      normalizeText(segment.text),
      segment.isFinal ? '1' : '0',
      canonicalSpeakerKey(segment.speaker),
    ].join(':'))
    .join('|')
}

export const dedupePartialFinalTranscriptSegments = (segments: TranscriptSegment[]): TranscriptSegment[] => {
  return segments.filter((segment) => {
    if (segment.isFinal) {
      return true
    }

    const cleanerFinal = segments.find((candidate) => {
      if (!candidate.isFinal) {
        return false
      }

      if (segmentsShareConsistencyIdentity(segment, candidate)) {
        return true
      }

      if (canonicalSpeakerKey(candidate.speaker) !== canonicalSpeakerKey(segment.speaker)) {
        return false
      }

      if (sameStartSpeakerForConsistency(segment, candidate)) {
        return true
      }

      return hasHeavyTimingOverlap(segment, candidate)
        && hasComparableTextOverlap(segment.text, candidate.text)
    })

    return !cleanerFinal
  })
}

export const normalizeTranscriptSegmentsForConsistency = (segments: TranscriptSegment[]): TranscriptSegment[] => {
  const merged = mergeTranscriptSegments(segments)
  const deduped = dedupePartialFinalTranscriptSegments(merged)
  return sortTranscriptSegmentsByTimeline(deduped)
}

export const normalizePersistedTranscriptForView = (
  segments: TranscriptSource[],
  options?: { fallbackSpeaker?: string },
): TranscriptSegment[] => {
  return normalizeTranscriptSegmentsForConsistency(
    normalizePersistedTranscriptSegments(segments, options),
  )
}

export const mergeHydratedTranscriptWithLive = (
  liveSegments: TranscriptSegment[],
  hydratedSegments: TranscriptSegment[],
): TranscriptSegment[] => {
  const merged = mergeTranscriptSegments([
    ...liveSegments,
    ...hydratedSegments,
  ])
  const deduped = dedupePartialFinalTranscriptSegments(merged)
  if (hydratedSegments.length < liveSegments.length) {
    console.info('[Realtime] HYDRATION_MERGE_KEEP_LIVE_SEGMENT', {
      persistedFragments: hydratedSegments.length,
      liveFragments: liveSegments.length,
      mergedFragments: deduped.length,
    })
  }
  return sortTranscriptSegmentsByTimeline(deduped)
}

type UploadTranscriptDisplayGroupingOptions = {
  shortSegmentMaxWords?: number
  shortSegmentMaxChars?: number
  shortSegmentMaxDurationSeconds?: number
  mergeMaxGapSeconds?: number
  mergeMaxTextChars?: number
  mergeMaxDurationSeconds?: number
}

const countWords = (text: string): number => {
  const trimmed = text.trim()
  if (!trimmed) {
    return 0
  }
  return trimmed.split(/\s+/).filter(Boolean).length
}

const hasSentenceEndingPunctuation = (text: string): boolean => SENTENCE_END_PUNCTUATION_PATTERN.test(text.trim())

const isLikelyContinuationStart = (text: string): boolean => {
  const trimmed = text.trim()
  if (!trimmed) {
    return false
  }

  if (CONNECTOR_PREFIX_PATTERN.test(trimmed)) {
    return true
  }

  const first = trimmed.charAt(0)
  return first === first.toLowerCase() && first !== first.toUpperCase()
}

const isValidTimestamp = (value: number): boolean => Number.isFinite(value) && value > 0

const hasValidSegmentTiming = (segment: TranscriptSegment): boolean =>
  isValidTimestamp(segment.start) && isValidTimestamp(segment.end) && segment.end >= segment.start

const segmentDurationSeconds = (segment: TranscriptSegment): number | null => {
  if (!hasValidSegmentTiming(segment)) {
    return null
  }
  return segment.end - segment.start
}

const mergeDisplayTexts = (left: string, right: string): string => {
  const merged = `${left.trim()} ${right.trim()}`
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/([(\[{])\s+/g, '$1')
    .trim()

  return merged
}

type MergeCandidate = {
  valid: boolean
  mergedSegment?: TranscriptSegment
  naturalScore?: number
  gapScore?: number
}

const evaluateUploadDisplayMergeCandidate = (
  left: TranscriptSegment,
  right: TranscriptSegment,
  triggerSegment: TranscriptSegment,
  direction: 'prev' | 'next',
  limits: Required<UploadTranscriptDisplayGroupingOptions>,
): MergeCandidate => {
  const sameSpeaker = canonicalSpeakerKey(left.speaker) === canonicalSpeakerKey(right.speaker)
  if (!sameSpeaker) {
    return { valid: false }
  }

  const triggerText = triggerSegment.text.trim()
  const triggerDuration = segmentDurationSeconds(triggerSegment)
  const isVeryShort =
    countWords(triggerText) <= limits.shortSegmentMaxWords
    || triggerText.length <= limits.shortSegmentMaxChars
    || (triggerDuration !== null && triggerDuration <= limits.shortSegmentMaxDurationSeconds)
  const continuationSignal =
    direction === 'next'
    && !hasSentenceEndingPunctuation(triggerText)
    && isLikelyContinuationStart(right.text)

  if (!isVeryShort && !continuationSignal) {
    return { valid: false }
  }

  const mergedText = mergeDisplayTexts(left.text, right.text)
  if (mergedText.length > limits.mergeMaxTextChars) {
    return { valid: false }
  }

  const pairHasTiming = hasValidSegmentTiming(left) && hasValidSegmentTiming(right)
  let gapScore = Number.POSITIVE_INFINITY
  if (pairHasTiming) {
    const gapSeconds = right.start - left.end
    if (gapSeconds > limits.mergeMaxGapSeconds) {
      return { valid: false }
    }

    const combinedDuration = right.end - left.start
    if (combinedDuration < 0 || combinedDuration > limits.mergeMaxDurationSeconds) {
      return { valid: false }
    }

    gapScore = Math.abs(gapSeconds)
  } else if (!isVeryShort) {
    // Missing timestamps are only safe for adjacent same-speaker very-short merges.
    return { valid: false }
  }

  const naturalScore =
    (hasSentenceEndingPunctuation(left.text) ? 0 : 2)
    + (isLikelyContinuationStart(right.text) ? 1 : 0)
    + (BOUNDARY_PUNCTUATION_PATTERN.test(left.text.trim()) ? 1 : 0)

  const mergedSegment: TranscriptSegment = {
    ...left,
    text: mergedText,
    start: left.start,
    end: right.end,
    timestamp: isValidTimestamp(left.start) ? left.start : left.timestamp,
    isFinal: Boolean(left.isFinal) && Boolean(right.isFinal),
    confidence:
      typeof left.confidence === 'number' && typeof right.confidence === 'number'
        ? (left.confidence + right.confidence) / 2
        : left.confidence ?? right.confidence,
  }

  return {
    valid: true,
    mergedSegment,
    naturalScore,
    gapScore,
  }
}

export const groupUploadTranscriptSegmentsForDisplay = (
  segments: TranscriptSegment[],
  options: UploadTranscriptDisplayGroupingOptions = {},
): TranscriptSegment[] => {
  const limits: Required<UploadTranscriptDisplayGroupingOptions> = {
    shortSegmentMaxWords: options.shortSegmentMaxWords ?? SHORT_SEGMENT_MAX_WORDS,
    shortSegmentMaxChars: options.shortSegmentMaxChars ?? SHORT_SEGMENT_MAX_CHARS,
    shortSegmentMaxDurationSeconds: options.shortSegmentMaxDurationSeconds ?? SHORT_SEGMENT_MAX_DURATION_SECONDS,
    mergeMaxGapSeconds: options.mergeMaxGapSeconds ?? MERGE_MAX_GAP_SECONDS,
    mergeMaxTextChars: options.mergeMaxTextChars ?? MERGE_MAX_TEXT_CHARS,
    mergeMaxDurationSeconds: options.mergeMaxDurationSeconds ?? MERGE_MAX_DURATION_SECONDS,
  }

  if (!Array.isArray(segments) || segments.length === 0) {
    return []
  }

  try {
    const source = sortTranscriptSegmentsByTimeline(
      segments
        .filter((segment): segment is TranscriptSegment => Boolean(segment) && typeof segment === 'object')
        .map((segment) => ({ ...segment })),
    )

    const grouped: TranscriptSegment[] = []
    let index = 0

    while (index < source.length) {
      const current = source[index]
      if (!current) {
        index += 1
        continue
      }

      const previous = grouped[grouped.length - 1]
      const next = source[index + 1]

      const mergeWithPrevious = previous
        ? evaluateUploadDisplayMergeCandidate(previous, current, current, 'prev', limits)
        : { valid: false }
      const mergeWithNext = next
        ? evaluateUploadDisplayMergeCandidate(current, next, current, 'next', limits)
        : { valid: false }

      if (mergeWithPrevious.valid && mergeWithNext.valid) {
        const prevNaturalScore = mergeWithPrevious.naturalScore ?? 0
        const nextNaturalScore = mergeWithNext.naturalScore ?? 0
        const prevGapScore = mergeWithPrevious.gapScore ?? Number.POSITIVE_INFINITY
        const nextGapScore = mergeWithNext.gapScore ?? Number.POSITIVE_INFINITY

        const shouldMergeWithPrevious =
          prevNaturalScore > nextNaturalScore
          || (prevNaturalScore === nextNaturalScore && prevGapScore <= nextGapScore)

        if (shouldMergeWithPrevious) {
          grouped[grouped.length - 1] = mergeWithPrevious.mergedSegment as TranscriptSegment
          index += 1
          continue
        }

        grouped.push(mergeWithNext.mergedSegment as TranscriptSegment)
        index += 2
        continue
      }

      if (mergeWithPrevious.valid) {
        grouped[grouped.length - 1] = mergeWithPrevious.mergedSegment as TranscriptSegment
        index += 1
        continue
      }

      if (mergeWithNext.valid) {
        grouped.push(mergeWithNext.mergedSegment as TranscriptSegment)
        index += 2
        continue
      }

      grouped.push({ ...current })
      index += 1
    }

    return sortTranscriptSegmentsByTimeline(grouped)
  } catch {
    return sortTranscriptSegmentsByTimeline(
      segments
        .filter((segment): segment is TranscriptSegment => Boolean(segment) && typeof segment === 'object')
        .map((segment) => ({ ...segment })),
    )
  }
}

export const mergeTranscriptSegmentsForDisplay = (
  segments: TranscriptSegment[],
  options: {
    maxGapSeconds?: number
    maxOverlapSeconds?: number
    maxDurationSeconds?: number
    maxChars?: number
    maxSegmentsPerMerge?: number
    shortSegmentSeconds?: number
    shortSegmentChars?: number
  } = {},
): TranscriptSegment[] => {
  const maxGapSeconds = options.maxGapSeconds ?? 1.0
  const maxOverlapSeconds = options.maxOverlapSeconds ?? 1.2
  const maxDurationSeconds = options.maxDurationSeconds ?? 10.0
  const maxChars = options.maxChars ?? 220
  const maxSegmentsPerMerge = options.maxSegmentsPerMerge ?? 3
  const shortSegmentSeconds = options.shortSegmentSeconds ?? 4.0
  const shortSegmentChars = options.shortSegmentChars ?? 100
  const ordered = sortTranscriptSegmentsByTimeline(segments)
  const merged: TranscriptSegment[] = []
  const mergedSegmentCounts: number[] = []
  const hasStrongPunctuationEnd = (text: string): boolean => /[.!?;]\s*$/.test(text.trim())
  const findOverlapChars = (left: string, right: string): number => {
    const max = Math.min(left.length, right.length)
    for (let size = max; size >= 4; size -= 1) {
      if (left.slice(-size) === right.slice(0, size)) {
        return size
      }
    }
    return 0
  }

  const mergeDisplayText = (prev: string, next: string): string => {
    const previous = prev.trim()
    const incoming = next.trim()
    const previousNorm = normalizeText(previous)
    const incomingNorm = normalizeText(incoming)
    if (!previousNorm) {
      return incoming
    }
    if (!incomingNorm) {
      return previous
    }
    if (previousNorm.includes(incomingNorm)) {
      return previous
    }
    if (incomingNorm.includes(previousNorm)) {
      return incoming
    }
    const overlapChars = findOverlapChars(previousNorm, incomingNorm)
    if (overlapChars > 0) {
      const trimTarget = incomingNorm.slice(0, overlapChars)
      const trimIndex = incoming.toLowerCase().indexOf(trimTarget)
      if (trimIndex === 0) {
        return `${previous} ${incoming.slice(overlapChars).trim()}`.replace(/\s+/g, ' ').trim()
      }
    }
    return `${previous} ${incoming}`.replace(/\s+/g, ' ').trim()
  }

  for (const segment of ordered) {
    const text = (segment.text || '').trim()
    if (!text) {
      continue
    }
    const previous = merged[merged.length - 1]
    if (!previous) {
      merged.push(segment)
      mergedSegmentCounts.push(1)
      continue
    }

    const prevText = normalizeText(previous.text)
    const nextText = normalizeText(text)
    if (prevText === nextText) {
      continue
    }

    const sameSpeaker = canonicalSpeakerKey(previous.speaker) === canonicalSpeakerKey(segment.speaker)
    const sameStream = !previous.streamId
      || !segment.streamId
      || previous.streamId === segment.streamId
    const previousEnd = previous.end ?? previous.start ?? 0
    const previousStart = previous.start ?? 0
    const nextEnd = segment.end ?? segment.start ?? 0
    const nextStart = segment.start ?? 0
    const gap = nextStart - previousEnd
    const overlap = previousEnd - nextStart
    const mergedDuration = Math.max(previousEnd, nextEnd) - Math.min(previousStart, nextStart)
    const mergedTextCandidate = mergeDisplayText(previous.text, text)
    const mergedCharCount = mergedTextCandidate.length
    const currentCount = mergedSegmentCounts[mergedSegmentCounts.length - 1] ?? 1
    const withinSegmentCount = currentCount < maxSegmentsPerMerge
    const withinDuration = mergedDuration <= maxDurationSeconds
    const withinChars = mergedCharCount <= maxChars
    const previousIsShort = (previousEnd - previousStart) <= shortSegmentSeconds || previous.text.trim().length <= shortSegmentChars
    const currentIsShort = (nextEnd - nextStart) <= shortSegmentSeconds || text.length <= shortSegmentChars
    const shouldMergeByLength = previousIsShort || currentIsShort
    const punctuationBoundary = hasStrongPunctuationEnd(previous.text)
    const canMerge =
      sameSpeaker &&
      sameStream &&
      gap <= maxGapSeconds &&
      overlap <= maxOverlapSeconds &&
      withinSegmentCount &&
      withinDuration &&
      withinChars &&
      shouldMergeByLength &&
      !punctuationBoundary

    if (!canMerge) {
      merged.push(segment)
      mergedSegmentCounts.push(1)
      continue
    }

    merged[merged.length - 1] = {
      ...previous,
      start: Math.min(previous.start ?? 0, segment.start ?? 0),
      text: mergedTextCandidate,
      end: Math.max(previousEnd, segment.end ?? segment.start ?? 0),
      isFinal: Boolean(previous.isFinal) && Boolean(segment.isFinal),
      confidence:
        typeof previous.confidence === 'number' && typeof segment.confidence === 'number'
          ? Math.max(previous.confidence, segment.confidence)
          : previous.confidence ?? segment.confidence,
    }
    mergedSegmentCounts[mergedSegmentCounts.length - 1] = currentCount + 1
  }

  return sortTranscriptSegmentsByTimeline(merged)
}

export const formatTranscriptTimestamp = (secondsValue: number): string => {
  const totalSeconds = Math.max(0, Math.floor(secondsValue))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export const parsePlainTranscriptText = (
  transcriptText: string,
  fallbackSpeaker = 'SPEAKER_1',
): TranscriptSegment[] => {
  const normalizedText = transcriptText.replace(/\r\n/g, '\n').trim()
  if (!normalizedText) {
    return []
  }

  const matches = Array.from(normalizedText.matchAll(SPEAKER_MARKER_PATTERN))
  if (matches.length === 0) {
    return [{
      id: 'plain-transcript-0',
      mergeKey: 'plain-transcript:0',
      speaker: fallbackSpeaker,
      text: normalizedText,
      start: 0,
      end: 0,
      timestamp: undefined,
      isFinal: true,
      source: 'hydration',
    }]
  }

  const segments: TranscriptSegment[] = []
  const firstMatchIndex = matches[0]?.index ?? 0
  if (firstMatchIndex > 0) {
    const leadingText = normalizedText.slice(0, firstMatchIndex).trim()
    if (leadingText) {
      segments.push({
        id: 'plain-transcript-0',
        mergeKey: 'plain-transcript:0',
        speaker: fallbackSpeaker,
        text: leadingText,
        start: 0,
        end: 0,
        timestamp: undefined,
        isFinal: true,
        source: 'hydration',
      })
    }
  }

  matches.forEach((match, index) => {
    const markerStart = match.index ?? 0
    const markerEnd = markerStart + match[0].length
    const nextMarkerStart = matches[index + 1]?.index ?? normalizedText.length
    const text = normalizedText.slice(markerEnd, nextMarkerStart).trim()

    if (!text) {
      return
    }

    segments.push({
      id: `plain-transcript-${segments.length}`,
      mergeKey: `plain-transcript:${segments.length}`,
      speaker: normalizeSpeakerBadge(match[1], fallbackSpeaker),
      text,
      start: 0,
      end: 0,
      timestamp: undefined,
      isFinal: true,
      source: 'hydration',
    })
  })

  if (segments.length === 0) {
    return [{
      id: 'plain-transcript-0',
      mergeKey: 'plain-transcript:0',
      speaker: fallbackSpeaker,
      text: normalizedText,
      start: 0,
      end: 0,
      timestamp: undefined,
      isFinal: true,
      source: 'hydration',
    }]
  }

  return segments
}
