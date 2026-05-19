import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'

type TranscriptSource = Record<string, unknown>

const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()

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
  const speaker = normalizeText(toStringValue(data.speaker))

  if (explicitId && !isLikelySequenceId(explicitId)) {
    return explicitId
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
  const speaker = normalizeText(toStringValue(data.speaker))

  if (explicitId && !isLikelySequenceId(explicitId)) {
    return `segment:${explicitId}`
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
  const speaker = normalizeText(segment.speaker)
  return `semantic:${segment.start.toFixed(3)}|${speaker}`
}

const isFallbackDisplayId = (value: string): boolean =>
  value.startsWith('time-') || value.startsWith('semantic:') || value.startsWith('text:') || value.startsWith('seq-') || value.startsWith('seg-')

const isSpecificMergeKey = (value?: string): boolean => !!value && (value.startsWith('segment:') || value.startsWith('dedupe:'))

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
  if (existing.mergeKey && incoming.mergeKey && existing.mergeKey === incoming.mergeKey) {
    return true
  }

  if (existing.id === incoming.id) {
    return true
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
    speaker: toStringValue(data.speaker),
    text,
    start,
    end,
    timestamp: start,
    confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
    language: toStringValue(data.language) || undefined,
    isFinal,
  }
}

export const normalizePersistedTranscriptSegments = (segments: TranscriptSource[]): TranscriptSegment[] => {
  return segments
    .map((segment) => {
      const explicitId = toStringValue(segment.segment_id, segment.segmentId, segment.id)
      const hasMeaningfulTiming =
        toNumber(segment.start_time, segment.start) > 0 || toNumber(segment.end_time, segment.end) > 0

      if (!hasMeaningfulTiming && !explicitId) {
        return null
      }

      const normalized = normalizeTranscriptEvent({
        speaker: segment.speaker,
        text: segment.text,
        startTime: segment.start_time,
        endTime: segment.end_time,
        start: segment.start_time,
        end: segment.end_time,
      })

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
  const existingIndex = current.findIndex((segment) => sharesTranscriptIdentity(segment, incoming))
  if (existingIndex < 0) {
    return {
      segments: [...current, incoming],
      segment: incoming,
    }
  }

  const existing = current[existingIndex]
  const preferred = resolvePreferredSegment(existing, incoming)
  const sourceSegment = preferred === incoming ? incoming : existing
  const mergedSegment: TranscriptSegment = {
    ...existing,
    ...incoming,
    ...preferred,
    id: chooseDisplayId(existing, incoming),
    mergeKey: chooseMergeKey(existing, incoming),
    speaker: sourceSegment.speaker.trim().length > 0 ? sourceSegment.speaker : (preferred === incoming ? existing.speaker : incoming.speaker),
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

export const formatTranscriptTimestamp = (secondsValue: number): string => {
  const totalSeconds = Math.max(0, Math.floor(secondsValue))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}