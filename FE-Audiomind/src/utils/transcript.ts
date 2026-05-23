import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'

type TranscriptSource = Record<string, unknown>
const SPEAKER_MARKER_PATTERN = /(SPEAKER_\d+|Speaker\s+\d+):/gi
const LEGACY_SEGMENT_ID_PATTERN = /^meeting-(\d+)-(\d+(?:\.\d+)?)-([a-z0-9_]+)-\d+$/i
const CANONICAL_SEGMENT_ID_PATTERN = /^meeting-(\d+)-start-(\d+(?:\.\d+)?)-([a-z0-9_]+)$/i

const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()
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

  if (explicitId && !isLikelySequenceId(explicitId)) {
    return `segment:${canonicalizeSegmentId(explicitId)}`
  }

  if (dedupeKey) {
    return `dedupe:${dedupeKey}`
  }

  if (timing) {
    return `semantic:${timing.start.toFixed(3)}|${speaker}`
  }

  const fallbackText = normalizeText(toStringValue(data.text, data.transcript))
  if (fallbackText) {
    return `text:${speaker}|${fallbackText}`
  }

  return resolveDisplayId(data, timing)
}

const getComparableText = (segment: TranscriptSegment): string => normalizeText(segment.text)

const getSemanticKey = (segment: TranscriptSegment): string => {
  const speaker = canonicalSpeakerKey(segment.speaker)
  return `semantic:${segment.start.toFixed(3)}|${speaker}`
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

const findExactSegmentById = (current: TranscriptSegment[], incoming: TranscriptSegment): number => {
  if (incoming.mergeKey && isSpecificMergeKey(incoming.mergeKey)) {
    const byMergeKey = current.findIndex((segment) => segment.mergeKey === incoming.mergeKey)
    if (byMergeKey >= 0) {
      return byMergeKey
    }
  }

  if (incoming.id) {
    const byId = current.findIndex((segment) => segment.id === incoming.id)
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

  if (existing.id === incoming.id) {
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

  return {
    id: resolveDisplayId(data, timing),
    mergeKey: resolveMergeKey(data, timing),
    speaker: normalizeSpeaker(toStringValue(data.speaker), options?.fallbackSpeaker),
    text,
    start,
    end,
    timestamp: start,
    confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
    language: toStringValue(data.language) || undefined,
    isFinal,
    source: options?.source ?? 'live',
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
        isFinal: segment.is_final ?? segment.isFinal ?? true,
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
  const ordered = [...segments].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
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

  return merged
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
