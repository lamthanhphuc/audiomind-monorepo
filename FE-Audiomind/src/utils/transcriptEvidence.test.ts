import { describe, expect, it } from 'vitest'

import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'
import {
  canonicalizeSegmentId,
  resolveFirstSegmentTimeRange,
  resolveTranscriptEvidenceRange,
} from './transcriptEvidence'

const makeSegment = (overrides: Partial<TranscriptSegment>): TranscriptSegment => ({
  id: 'meeting-1-start-1.500-alice',
  speaker: 'alice',
  text: 'hello',
  start: 1.5,
  end: 3.5,
  ...overrides,
})

describe('canonicalizeSegmentId', () => {
  it('converts a legacy segment id into canonical form', () => {
    expect(canonicalizeSegmentId('meeting-42-12.5-alice-3')).toBe('meeting-42-start-12.500-alice')
  })

  it('lowercases the speaker slug', () => {
    expect(canonicalizeSegmentId('meeting-42-12.5-ALICE-3')).toBe('meeting-42-start-12.500-alice')
  })

  it('leaves an already-canonical id unchanged', () => {
    expect(canonicalizeSegmentId('meeting-42-start-12.500-alice')).toBe('meeting-42-start-12.500-alice')
  })

  it('returns malformed ids unchanged instead of throwing', () => {
    expect(canonicalizeSegmentId('not-a-segment-id')).toBe('not-a-segment-id')
    expect(canonicalizeSegmentId('')).toBe('')
  })

  it('never throws on non-string input', () => {
    expect(() => canonicalizeSegmentId(null)).not.toThrow()
    expect(() => canonicalizeSegmentId(undefined)).not.toThrow()
    expect(() => canonicalizeSegmentId(123)).not.toThrow()
    expect(() => canonicalizeSegmentId({ foo: 'bar' })).not.toThrow()
    expect(canonicalizeSegmentId(null)).toBe('')
  })
})

describe('resolveTranscriptEvidenceRange', () => {
  it('resolves a single segment id', () => {
    const segments = [makeSegment({ id: 'meeting-1-start-1.500-alice', start: 1.5, end: 3.5 })]
    const range = resolveTranscriptEvidenceRange(['meeting-1-start-1.500-alice'], segments)
    expect(range).toEqual({ startTime: 1.5, endTime: 3.5 })
  })

  it('groups multiple segment ids using min start and max end', () => {
    const segments = [
      makeSegment({ id: 'meeting-1-start-1.500-alice', start: 1.5, end: 3.5 }),
      makeSegment({ id: 'meeting-1-start-5.000-bob', start: 5, end: 8 }),
      makeSegment({ id: 'meeting-1-start-20.000-carol', start: 20, end: 22 }),
    ]
    const range = resolveTranscriptEvidenceRange(
      ['meeting-1-start-1.500-alice', 'meeting-1-start-5.000-bob'],
      segments,
    )
    expect(range).toEqual({ startTime: 1.5, endTime: 8 })
  })

  it('matches legacy ids against canonical transcript segment ids', () => {
    const segments = [makeSegment({ id: 'meeting-1-start-12.500-alice', start: 12.5, end: 14 })]
    const range = resolveTranscriptEvidenceRange(['meeting-1-12.5-alice-3'], segments)
    expect(range).toEqual({ startTime: 12.5, endTime: 14 })
  })

  it('matches canonical requested ids against legacy transcript segment ids', () => {
    const segments = [makeSegment({ id: 'meeting-1-12.5-alice-3', start: 12.5, end: 14 })]
    const range = resolveTranscriptEvidenceRange(['meeting-1-start-12.500-alice'], segments)
    expect(range).toEqual({ startTime: 12.5, endTime: 14 })
  })

  it('dedupes requested ids that resolve to the same segment', () => {
    const segments = [makeSegment({ id: 'meeting-1-start-1.500-alice', start: 1.5, end: 3.5 })]
    const range = resolveTranscriptEvidenceRange(
      ['meeting-1-start-1.500-alice', 'meeting-1-1.5-alice-3', 'meeting-1-start-1.500-alice'],
      segments,
    )
    expect(range).toEqual({ startTime: 1.5, endTime: 3.5 })
  })

  it('returns null when no segment ids are provided', () => {
    const segments = [makeSegment({})]
    expect(resolveTranscriptEvidenceRange([], segments)).toBeNull()
  })

  it('returns null when there are no transcript segments', () => {
    expect(resolveTranscriptEvidenceRange(['meeting-1-start-1.500-alice'], [])).toBeNull()
  })

  it('returns null when the segment id is missing entirely', () => {
    const segments = [makeSegment({ id: 'meeting-1-start-1.500-alice' })]
    expect(resolveTranscriptEvidenceRange(['meeting-99-start-1.500-nobody'], segments)).toBeNull()
  })

  it('resolves partial matches when some ids are missing', () => {
    const segments = [makeSegment({ id: 'meeting-1-start-1.500-alice', start: 1.5, end: 3.5 })]
    const range = resolveTranscriptEvidenceRange(
      ['meeting-1-start-1.500-alice', 'meeting-99-start-1.500-nobody'],
      segments,
    )
    expect(range).toEqual({ startTime: 1.5, endTime: 3.5 })
  })

  it('ignores malformed ids without throwing', () => {
    const segments = [makeSegment({ id: 'meeting-1-start-1.500-alice', start: 1.5, end: 3.5 })]
    expect(() => resolveTranscriptEvidenceRange(['   ', '', 'garbage-id'], segments)).not.toThrow()
    expect(resolveTranscriptEvidenceRange(['   ', '', 'garbage-id'], segments)).toBeNull()
  })

  it('never throws when given non-array input', () => {
    const segments = [makeSegment({})]
    // @ts-expect-error intentionally exercising defensive runtime guard
    expect(resolveTranscriptEvidenceRange(null, segments)).toBeNull()
    // @ts-expect-error intentionally exercising defensive runtime guard
    expect(resolveTranscriptEvidenceRange(undefined, segments)).toBeNull()
  })

  it('falls back to timestamp when start is not finite', () => {
    const segments = [makeSegment({ id: 'meeting-1-start-1.500-alice', start: Number.NaN, timestamp: 4, end: Number.NaN })]
    const range = resolveTranscriptEvidenceRange(['meeting-1-start-1.500-alice'], segments)
    expect(range?.startTime).toBe(4)
  })
})

describe('resolveFirstSegmentTimeRange (grouped-from-raw compatibility)', () => {
  it('resolves the range for a single raw segment id the same way resolveTranscriptEvidenceRange does', () => {
    const segments = [makeSegment({ id: 'meeting-1-start-1.500-alice', start: 1.5, end: 3.5 })]
    expect(resolveFirstSegmentTimeRange('meeting-1-start-1.500-alice', segments)).toEqual(
      resolveTranscriptEvidenceRange(['meeting-1-start-1.500-alice'], segments),
    )
  })
})
