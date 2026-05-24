import { describe, expect, it } from 'vitest'
import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'
import {
  groupUploadTranscriptSegmentsForDisplay,
  normalizeSpeakerBadge,
  parsePlainTranscriptText,
} from './transcript'

describe('parsePlainTranscriptText', () => {
  it('splits SPEAKER markers into display segments', () => {
    const segments = parsePlainTranscriptText('SPEAKER_1: Xin chào. SPEAKER_2: Tom, I am so tired.')

    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({
      speaker: 'SPEAKER_1',
      text: 'Xin chào.',
    })
    expect(segments[1]).toMatchObject({
      speaker: 'SPEAKER_2',
      text: 'Tom, I am so tired.',
    })
  })

  it('normalizes the spoken Speaker 1 format to a canonical badge label', () => {
    const segments = parsePlainTranscriptText('Speaker 1: Xin chào. Speaker 2: English text here.')

    expect(segments).toHaveLength(2)
    expect(segments.map((segment) => segment.speaker)).toEqual(['SPEAKER_1', 'SPEAKER_2'])
  })

  it('falls back to a single block when no speaker marker exists', () => {
    const segments = parsePlainTranscriptText('Xin chào tiếng Việt và English text vẫn giữ nguyên.')

    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({
      speaker: 'SPEAKER_1',
      text: 'Xin chào tiếng Việt và English text vẫn giữ nguyên.',
    })
  })
})

describe('normalizeSpeakerBadge', () => {
  it('keeps canonical speaker labels readable', () => {
    expect(normalizeSpeakerBadge('Speaker 1')).toBe('SPEAKER_1')
    expect(normalizeSpeakerBadge('SPEAKER_2')).toBe('SPEAKER_2')
  })
})

const makeSegment = (
  overrides: Partial<TranscriptSegment> & Pick<TranscriptSegment, 'text'>,
): TranscriptSegment => ({
  id: overrides.id ?? `seg-${Math.random()}`,
  mergeKey: overrides.mergeKey ?? undefined,
  speaker: overrides.speaker ?? 'SPEAKER_1',
  text: overrides.text,
  start: overrides.start ?? 0,
  end: overrides.end ?? 0,
  timestamp: overrides.timestamp,
  confidence: overrides.confidence,
  language: overrides.language,
  isFinal: overrides.isFinal ?? true,
  source: overrides.source ?? 'hydration',
})

describe('groupUploadTranscriptSegmentsForDisplay', () => {
  it('merges one-word segment with previous same-speaker segment when safe', () => {
    const grouped = groupUploadTranscriptSegmentsForDisplay([
      makeSegment({ id: 'a', speaker: 'SPEAKER_1', text: 'có thể mời', start: 280, end: 280.8 }),
      makeSegment({ id: 'b', speaker: 'SPEAKER_1', text: 'hoặc', start: 281, end: 281.2 }),
      makeSegment({ id: 'c', speaker: 'SPEAKER_1', text: 'giảng viên tại các trường...', start: 285, end: 303 }),
    ])

    expect(grouped).toHaveLength(2)
    expect(grouped[0]).toMatchObject({
      speaker: 'SPEAKER_1',
      start: 280,
      end: 281.2,
      text: 'có thể mời hoặc',
    })
  })

  it('merges short segment with next when previous is not valid', () => {
    const grouped = groupUploadTranscriptSegmentsForDisplay([
      makeSegment({ id: 'a', speaker: 'SPEAKER_2', text: 'khối khác', start: 270, end: 279 }),
      makeSegment({ id: 'b', speaker: 'SPEAKER_1', text: 'hoặc', start: 280, end: 281 }),
      makeSegment({ id: 'c', speaker: 'SPEAKER_1', text: 'giảng viên tại các trường...', start: 285, end: 303 }),
    ])

    expect(grouped).toHaveLength(2)
    expect(grouped[1]).toMatchObject({
      speaker: 'SPEAKER_1',
      start: 280,
      end: 303,
      text: 'hoặc giảng viên tại các trường...',
    })
  })

  it('does not merge across speakers', () => {
    const grouped = groupUploadTranscriptSegmentsForDisplay([
      makeSegment({ speaker: 'SPEAKER_1', text: 'hoặc', start: 10, end: 10.8 }),
      makeSegment({ speaker: 'SPEAKER_2', text: 'tiếp theo', start: 11, end: 12 }),
    ])

    expect(grouped).toHaveLength(2)
  })

  it('does not merge when gap is too large', () => {
    const grouped = groupUploadTranscriptSegmentsForDisplay([
      makeSegment({ speaker: 'SPEAKER_1', text: 'hoặc', start: 10, end: 10.5 }),
      makeSegment({ speaker: 'SPEAKER_1', text: 'giảng viên', start: 17, end: 20 }),
    ])

    expect(grouped).toHaveLength(2)
  })

  it('does not exceed max text length', () => {
    const longText = 'a'.repeat(699)
    const grouped = groupUploadTranscriptSegmentsForDisplay([
      makeSegment({ speaker: 'SPEAKER_1', text: 'rất ngắn', start: 10, end: 10.5 }),
      makeSegment({ speaker: 'SPEAKER_1', text: longText, start: 10.7, end: 20 }),
    ])

    expect(grouped).toHaveLength(2)
  })

  it('preserves timestamp range after merge', () => {
    const grouped = groupUploadTranscriptSegmentsForDisplay([
      makeSegment({ speaker: 'SPEAKER_1', text: 'hoặc', start: 280, end: 281 }),
      makeSegment({ speaker: 'SPEAKER_1', text: 'giảng viên tại các trường...', start: 285, end: 303 }),
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].start).toBe(280)
    expect(grouped[0].end).toBe(303)
  })

  it('does not mutate original array or segment objects', () => {
    const source = [
      makeSegment({ id: 'a', speaker: 'SPEAKER_1', text: 'hoặc', start: 280, end: 281 }),
      makeSegment({ id: 'b', speaker: 'SPEAKER_1', text: 'giảng viên tại các trường...', start: 285, end: 303 }),
    ]
    const snapshot = JSON.parse(JSON.stringify(source))

    void groupUploadTranscriptSegmentsForDisplay(source)

    expect(source).toEqual(snapshot)
  })

  it('handles missing timestamps safely using adjacent order for very-short same-speaker text', () => {
    const grouped = groupUploadTranscriptSegmentsForDisplay([
      makeSegment({ speaker: 'SPEAKER_1', text: 'hoặc', start: 0, end: 0 }),
      makeSegment({ speaker: 'SPEAKER_1', text: 'giảng viên tại các trường...', start: 0, end: 0 }),
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].text).toBe('hoặc giảng viên tại các trường...')
  })

  it('leaves non-short segments unchanged when timestamps are missing', () => {
    const grouped = groupUploadTranscriptSegmentsForDisplay([
      makeSegment({ speaker: 'SPEAKER_1', text: 'đây là một đoạn khá dài nên không phải very short', start: 0, end: 0 }),
      makeSegment({ speaker: 'SPEAKER_1', text: 'tiếp tục một đoạn dài tương tự', start: 0, end: 0 }),
    ])

    expect(grouped).toHaveLength(2)
  })

  it('keeps single long segment unchanged', () => {
    const source = [
      makeSegment({
        speaker: 'SPEAKER_1',
        text: 'đây là một đoạn dài đủ lớn để không cần merge thêm nữa',
        start: 100,
        end: 120,
      }),
    ]

    const grouped = groupUploadTranscriptSegmentsForDisplay(source)

    expect(grouped).toHaveLength(1)
    expect(grouped[0].text).toBe(source[0].text)
  })

  it('keeps Vietnamese spacing and punctuation readable', () => {
    const grouped = groupUploadTranscriptSegmentsForDisplay([
      makeSegment({ speaker: 'SPEAKER_1', text: 'Xin chào ,', start: 1, end: 1.2 }),
      makeSegment({ speaker: 'SPEAKER_1', text: 'hoặc giảng viên.', start: 1.3, end: 3 }),
    ])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].text).toBe('Xin chào, hoặc giảng viên.')
  })

  it('never throws and returns best-effort output for invalid input', () => {
    expect(() => groupUploadTranscriptSegmentsForDisplay(undefined as unknown as TranscriptSegment[])).not.toThrow()
    expect(groupUploadTranscriptSegmentsForDisplay(undefined as unknown as TranscriptSegment[])).toEqual([])
  })
})
