import { describe, expect, it } from 'vitest'
import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'
import {
  buildTranscriptEquivalenceSignature,
  dedupePartialFinalTranscriptSegments,
  groupUploadTranscriptSegmentsForDisplay,
  mergeHydratedTranscriptWithLive,
  mergeTranscriptSegmentsForDisplay,
  normalizeTranscriptEvent,
  normalizePersistedTranscriptForView,
  normalizeSpeakerBadge,
  parsePlainTranscriptText,
  sortTranscriptSegmentsByTimeline,
  upsertTranscriptSegment,
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

describe('sortTranscriptSegmentsByTimeline', () => {
  it('orders Phase 7S regression pairs by start and preserves stable speakers', () => {
    const sorted = sortTranscriptSegmentsByTimeline([
      makeSegment({ speaker: 'SPEAKER_1', text: 'row at 1:31', start: 91, end: 92 }),
      makeSegment({ speaker: 'SPEAKER_3', text: 'row at 4:32', start: 272, end: 273 }),
      makeSegment({ speaker: 'SPEAKER_4', text: 'row at 7:21', start: 441, end: 442 }),
      makeSegment({ speaker: 'SPEAKER_1', text: 'row at 1:59', start: 119, end: 120 }),
      makeSegment({ speaker: 'SPEAKER_2', text: 'row at 2:15', start: 135, end: 136 }),
      makeSegment({ speaker: 'SPEAKER_3', text: 'row at 5:06', start: 306, end: 307 }),
      makeSegment({ speaker: 'SPEAKER_2', text: 'row at 2:24', start: 144, end: 145 }),
      makeSegment({ speaker: 'SPEAKER_1', text: 'row at 1:02', start: 62, end: 63 }),
      makeSegment({ speaker: 'SPEAKER_5', text: 'row at 6:33', start: 393, end: 394 }),
      makeSegment({ speaker: 'SPEAKER_1', text: 'row at 1:05', start: 65, end: 66 }),
    ])

    expect(sorted.map((segment) => segment.text)).toEqual([
      'row at 1:02',
      'row at 1:05',
      'row at 1:31',
      'row at 1:59',
      'row at 2:15',
      'row at 2:24',
      'row at 4:32',
      'row at 5:06',
      'row at 6:33',
      'row at 7:21',
    ])
    expect(sorted.find((segment) => segment.text === 'row at 1:59')?.speaker).toBe('SPEAKER_1')
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

describe('buildTranscriptEquivalenceSignature', () => {
  it('builds comparable signatures from stable metadata only', () => {
    const signature = buildTranscriptEquivalenceSignature([
      makeSegment({
        id: 'meeting-1-start-1.000-speaker_1',
        mergeKey: 'segment:meeting-1-start-1.000-speaker_1',
        speaker: 'SPEAKER_1',
        text: 'Hello world',
        start: 1,
        end: 2,
        isFinal: true,
      }),
    ])

    expect(signature).toContain('semantic:1.000|speaker_1')
    expect(signature).toContain('hello world')
    expect(signature).toContain('1.000')
    expect(signature).toContain('speaker_1')
    expect(signature).not.toContain('Hello world')
  })
})

describe('dedupePartialFinalTranscriptSegments', () => {
  it('keeps only final when partial and final share mergeKey', () => {
    const deduped = dedupePartialFinalTranscriptSegments([
      makeSegment({
        id: 'seg-partial',
        mergeKey: 'segment:meeting-1-start-19.450-speaker_1',
        speaker: 'SPEAKER_1',
        text: 'partial text',
        start: 19.45,
        end: 24.42,
        isFinal: false,
        source: 'live',
      }),
      makeSegment({
        id: 'seg-final',
        mergeKey: 'segment:meeting-1-start-19.450-speaker_1',
        speaker: 'SPEAKER_1',
        text: 'final text',
        start: 19.45,
        end: 22.47,
        isFinal: true,
        source: 'hydration',
      }),
    ])

    expect(deduped).toHaveLength(1)
    expect(deduped[0].isFinal).toBe(true)
    expect(deduped[0].text).toBe('final text')
  })
})

describe('mergeHydratedTranscriptWithLive', () => {
  it('matches history signature for partial/final/persisted fixture', () => {
    const persistedRows = [
      { speaker: 'SPEAKER_1', start_time: 19.45, end_time: 22.47, text: 'liệu có thể vào thời điểm hai', is_final: true },
      { speaker: 'SPEAKER_1', start_time: 22.47, end_time: 26.69, text: 'hai chúng ta thảo luận tiếp', is_final: true },
    ]
    const live = [
      makeSegment({
        id: 'meeting-14-start-19.450-speaker_1',
        mergeKey: 'segment:meeting-14-start-19.450-speaker_1',
        speaker: 'SPEAKER_1',
        text: 'liệu có thể vào thời điểm hai chúng ta',
        start: 19.45,
        end: 24.42,
        isFinal: false,
        source: 'live',
      }),
      makeSegment({
        id: 'meeting-14-start-22.470-speaker_1',
        mergeKey: 'segment:meeting-14-start-22.470-speaker_1',
        speaker: 'SPEAKER_1',
        text: 'hai chúng ta thảo luận tiếp',
        start: 22.47,
        end: 26.69,
        isFinal: true,
        source: 'live',
      }),
    ]

    const historySignature = buildTranscriptEquivalenceSignature(
      normalizePersistedTranscriptForView(persistedRows),
    )
    const liveSignature = buildTranscriptEquivalenceSignature(
      mergeHydratedTranscriptWithLive(live, normalizePersistedTranscriptForView(persistedRows)),
    )

    expect(liveSignature).toBe(historySignature)
  })

  it('keeps newer live text when persisted hydration is behind', () => {
    const live = [
      makeSegment({
        id: 'meeting-1-start-9.000-speaker_1',
        mergeKey: 'segment:meeting-1-start-9.000-speaker_1',
        speaker: 'SPEAKER_1',
        text: 'five',
        start: 9,
        end: 10,
        isFinal: true,
        source: 'live',
      }),
    ]
    const persisted = normalizePersistedTranscriptForView([
      { speaker: 'SPEAKER_1', start_time: 1, end_time: 2, text: 'one' },
      { speaker: 'SPEAKER_1', start_time: 3, end_time: 4, text: 'two' },
      { speaker: 'SPEAKER_1', start_time: 5, end_time: 6, text: 'three' },
      { speaker: 'SPEAKER_1', start_time: 7, end_time: 8, text: 'four' },
    ])

    const merged = mergeHydratedTranscriptWithLive(live, persisted)

    expect(merged).toHaveLength(5)
    expect(merged.map((segment) => segment.text)).toEqual(['one', 'two', 'three', 'four', 'five'])
  })

  it('replaces live partial with persisted final for same mergeKey', () => {
    const live = [
      makeSegment({
        id: 'time-19.450-speaker_1',
        mergeKey: 'semantic:19.450|speaker_1',
        speaker: 'SPEAKER_1',
        text: 'liệu có thể vào thời điểm hai chúng ta',
        start: 19.45,
        end: 24.42,
        isFinal: false,
        source: 'live',
      }),
    ]
    const persisted = normalizePersistedTranscriptForView([
      { speaker: 'SPEAKER_1', start_time: 19.45, end_time: 22.47, text: 'liệu có thể vào thời điểm hai', is_final: true },
    ])

    const merged = mergeHydratedTranscriptWithLive(live, persisted)

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      isFinal: true,
      end: 22.47,
      text: 'liệu có thể vào thời điểm hai',
    })
  })
})

describe('mergeTranscriptSegmentsForDisplay', () => {
  it('returns non-decreasing timeline order after display merge', () => {
    const merged = mergeTranscriptSegmentsForDisplay([
      makeSegment({ speaker: 'SPEAKER_1', text: 'row at 1:31', start: 91, end: 92 }),
      makeSegment({ speaker: 'SPEAKER_3', text: 'row at 4:32', start: 272, end: 273 }),
      makeSegment({ speaker: 'SPEAKER_4', text: 'row at 7:21', start: 441, end: 442 }),
      makeSegment({ speaker: 'SPEAKER_1', text: 'row at 1:59', start: 119, end: 120 }),
      makeSegment({ speaker: 'SPEAKER_2', text: 'row at 2:15', start: 135, end: 136 }),
      makeSegment({ speaker: 'SPEAKER_3', text: 'row at 5:06', start: 306, end: 307 }),
      makeSegment({ speaker: 'SPEAKER_2', text: 'row at 2:24', start: 144, end: 145 }),
    ])

    expect(merged.map((segment) => segment.text)).toEqual([
      'row at 1:31',
      'row at 1:59',
      'row at 2:15',
      'row at 2:24',
      'row at 4:32',
      'row at 5:06',
      'row at 7:21',
    ])
  })
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

describe('dual-stream transcript helpers', () => {
  it('formats TAB and MIC speaker badges for display', async () => {
    const { formatDualStreamSpeakerLabel, inferStreamIdFromSpeaker } = await import('./transcript')

    expect(formatDualStreamSpeakerLabel('TAB_SPEAKER_1')).toBe('Tab 1')
    expect(formatDualStreamSpeakerLabel('MIC_SPEAKER_2')).toBe('Mic 2')
    expect(inferStreamIdFromSpeaker('TAB_SPEAKER_1')).toBe('tab')
    expect(inferStreamIdFromSpeaker('MIC_SPEAKER_1')).toBe('mic')
  })

  it('does not merge display segments across tab and mic streams', () => {
    const tabSegment: TranscriptSegment = {
      id: 'tab-1',
      speaker: 'TAB_SPEAKER_1',
      streamId: 'tab',
      text: 'Hello from tab',
      start: 1,
      end: 2,
      isFinal: true,
    }
    const micSegment: TranscriptSegment = {
      id: 'mic-1',
      speaker: 'MIC_SPEAKER_1',
      streamId: 'mic',
      text: 'Hello from mic',
      start: 1.2,
      end: 2.2,
      isFinal: true,
    }

    const merged = mergeTranscriptSegmentsForDisplay([tabSegment, micSegment], { maxGapSeconds: 5 })
    expect(merged).toHaveLength(2)
    expect(merged.map((segment) => segment.streamId)).toEqual(['tab', 'mic'])
  })

  it('uses stream-aware merge keys for explicit segment ids', () => {
    const tabSegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      meetingId: 14,
      segmentId: 'segment-12',
      streamId: 'tab',
      speaker: 'TAB_SPEAKER_1',
      text: 'Tab partial',
      startTime: 1,
      endTime: 2,
    })
    const micSegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      meetingId: 14,
      segmentId: 'segment-12',
      stream_id: 'mic',
      speaker: 'MIC_SPEAKER_1',
      text: 'Mic partial',
      startTime: 1,
      endTime: 2,
    })
    const legacySegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      meetingId: 14,
      segmentId: 'segment-12',
      speaker: 'SPEAKER_1',
      text: 'Legacy partial',
      startTime: 1,
      endTime: 2,
    })

    expect(tabSegment?.mergeKey).toBe('segment:segment-12|tab')
    expect(micSegment?.mergeKey).toBe('segment:segment-12|mic')
    expect(legacySegment?.mergeKey).toBe('segment:segment-12')
  })

  it('uses stream-aware merge keys for dedupe ids', () => {
    const tabSegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      dedupeKey: 'stable-dedupe-1',
      streamId: 'tab',
      speaker: 'SPEAKER_1',
      text: 'Tab dedupe',
      startTime: 1,
      endTime: 2,
    })
    const micSegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      dedupe_key: 'stable-dedupe-1',
      stream_id: 'mic',
      speaker: 'SPEAKER_1',
      text: 'Mic dedupe',
      startTime: 1,
      endTime: 2,
    })
    const legacySegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      dedupeKey: 'stable-dedupe-1',
      speaker: 'SPEAKER_1',
      text: 'Legacy dedupe',
      startTime: 1,
      endTime: 2,
    })

    expect(tabSegment?.mergeKey).toBe('dedupe:stable-dedupe-1|tab')
    expect(micSegment?.mergeKey).toBe('dedupe:stable-dedupe-1|mic')
    expect(legacySegment?.mergeKey).toBe('dedupe:stable-dedupe-1')
  })

  it('uses attempt-aware merge keys for v2 transcript events', () => {
    const firstAttempt = normalizeTranscriptEvent({
      type: 'transcript.partial',
      meetingId: 14,
      recordingSessionId: 9001,
      attemptId: 1,
      seq: 7,
      dedupeKey: 'stable-dedupe-1',
      streamId: 'tab',
      speaker: 'SPEAKER_1',
      text: 'Tab attempt one',
      startTime: 1,
      endTime: 2,
    })
    const secondAttempt = normalizeTranscriptEvent({
      type: 'transcript.partial',
      meetingId: 14,
      recordingSessionId: 9001,
      attemptId: 2,
      seq: 7,
      dedupeKey: 'stable-dedupe-1',
      streamId: 'tab',
      speaker: 'SPEAKER_1',
      text: 'Tab attempt two',
      startTime: 1,
      endTime: 2,
    })

    expect(firstAttempt?.mergeKey).toBe('dedupe:stable-dedupe-1|tab|scope:v2:14:9001:1:7')
    expect(secondAttempt?.mergeKey).toBe('dedupe:stable-dedupe-1|tab|scope:v2:14:9001:2:7')
  })

  it('keeps tab, mic, and legacy explicit segment ids separate during hydration', () => {
    const segments = normalizePersistedTranscriptForView([
      {
        segment_id: 'persisted-12',
        stream_id: 'tab',
        speaker: 'SPEAKER_1',
        text: 'Persisted tab',
        start_time: 1,
        end_time: 2,
      },
      {
        segment_id: 'persisted-12',
        stream_id: 'mic',
        speaker: 'SPEAKER_1',
        text: 'Persisted mic',
        start_time: 1,
        end_time: 2,
      },
      {
        segment_id: 'persisted-12',
        speaker: 'SPEAKER_1',
        text: 'Persisted legacy',
        start_time: 1,
        end_time: 2,
      },
    ])

    expect(segments).toHaveLength(3)
    expect(segments.map((segment) => segment.streamId)).toEqual(['tab', 'mic', undefined])
    expect(segments.map((segment) => segment.mergeKey)).toEqual([
      'segment:persisted-12|tab',
      'segment:persisted-12|mic',
      'segment:persisted-12',
    ])
  })

  it('does not merge legacy missing stream into tab or mic segments with the same id', () => {
    const tabSegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      segmentId: 'segment-legacy-test',
      streamId: 'tab',
      speaker: 'SPEAKER_1',
      text: 'Tab line',
      startTime: 1,
      endTime: 2,
    })
    const micSegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      segmentId: 'segment-legacy-test',
      streamId: 'mic',
      speaker: 'SPEAKER_1',
      text: 'Mic line',
      startTime: 1,
      endTime: 2,
    })
    const legacySegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      segmentId: 'segment-legacy-test',
      speaker: 'SPEAKER_1',
      text: 'Legacy line',
      startTime: 1,
      endTime: 2,
    })

    let current: TranscriptSegment[] = []
    for (const segment of [tabSegment, micSegment, legacySegment]) {
      expect(segment).not.toBeNull()
      current = upsertTranscriptSegment(current, segment as TranscriptSegment).segments
    }

    expect(current).toHaveLength(3)
    expect(current.map((segment) => segment.text)).toEqual(['Tab line', 'Mic line', 'Legacy line'])
  })

  it('does not merge legacy missing stream into tab or mic segments with the same dedupe key', () => {
    const tabSegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      dedupeKey: 'dedupe-legacy-test',
      streamId: 'tab',
      speaker: 'SPEAKER_1',
      text: 'Tab dedupe',
      startTime: 1,
      endTime: 2,
    })
    const micSegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      dedupeKey: 'dedupe-legacy-test',
      streamId: 'mic',
      speaker: 'SPEAKER_1',
      text: 'Mic dedupe',
      startTime: 1,
      endTime: 2,
    })
    const legacySegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      dedupeKey: 'dedupe-legacy-test',
      speaker: 'SPEAKER_1',
      text: 'Legacy dedupe',
      startTime: 1,
      endTime: 2,
    })

    let current: TranscriptSegment[] = []
    for (const segment of [tabSegment, micSegment, legacySegment]) {
      expect(segment).not.toBeNull()
      current = upsertTranscriptSegment(current, segment as TranscriptSegment).segments
    }

    expect(current).toHaveLength(3)
    expect(current.map((segment) => segment.mergeKey)).toEqual([
      'dedupe:dedupe-legacy-test|tab',
      'dedupe:dedupe-legacy-test|mic',
      'dedupe:dedupe-legacy-test',
    ])
  })

  it('does not merge v2 segments from different attempts with the same seq and segment id', () => {
    const firstAttempt = normalizeTranscriptEvent({
      type: 'transcript.final',
      meetingId: 44,
      recordingSessionId: 9001,
      attemptId: 1,
      seq: 4,
      segmentId: 'shared-segment',
      streamId: 'mic',
      speaker: 'SPEAKER_1',
      text: 'attempt one',
      startTime: 1,
      endTime: 2,
      isFinal: true,
    })
    const secondAttempt = normalizeTranscriptEvent({
      type: 'transcript.final',
      meetingId: 44,
      recordingSessionId: 9001,
      attemptId: 2,
      seq: 4,
      segmentId: 'shared-segment',
      streamId: 'mic',
      speaker: 'SPEAKER_1',
      text: 'attempt two',
      startTime: 1,
      endTime: 2,
      isFinal: true,
    })

    let current: TranscriptSegment[] = []
    current = upsertTranscriptSegment(current, firstAttempt as TranscriptSegment).segments
    current = upsertTranscriptSegment(current, secondAttempt as TranscriptSegment).segments

    expect(current).toHaveLength(2)
    expect(current.map((segment) => segment.text)).toEqual(['attempt one', 'attempt two'])
  })

  it('merges v2 partial and final events from the same attempt scope', () => {
    const partial = normalizeTranscriptEvent({
      type: 'transcript.partial',
      meetingId: 44,
      recordingSessionId: 9001,
      attemptId: 1,
      seq: 4,
      segmentId: 'attempt-partial-final',
      streamId: 'mic',
      speaker: 'SPEAKER_1',
      text: 'partial',
      startTime: 1,
      endTime: 2,
    })
    const final = normalizeTranscriptEvent({
      type: 'transcript.final',
      meetingId: 44,
      recordingSessionId: 9001,
      attemptId: 1,
      seq: 4,
      segmentId: 'attempt-partial-final',
      streamId: 'mic',
      speaker: 'SPEAKER_1',
      text: 'final',
      startTime: 1,
      endTime: 2,
      isFinal: true,
    })

    let current: TranscriptSegment[] = []
    current = upsertTranscriptSegment(current, partial as TranscriptSegment).segments
    current = upsertTranscriptSegment(current, final as TranscriptSegment).segments

    expect(current).toHaveLength(1)
    expect(current[0]).toMatchObject({ text: 'final', recordingSessionId: 9001, attemptId: 1, seq: 4 })
  })

  it('still merges legacy partial and final events with the same identity', () => {
    const partial = normalizeTranscriptEvent({
      type: 'transcript.partial',
      segmentId: 'legacy-partial-final',
      speaker: 'SPEAKER_1',
      text: 'partial text',
      startTime: 1,
      endTime: 2,
    })
    const final = normalizeTranscriptEvent({
      type: 'transcript.final',
      segmentId: 'legacy-partial-final',
      speaker: 'SPEAKER_1',
      text: 'final text',
      startTime: 1,
      endTime: 2,
      isFinal: true,
    })

    let current: TranscriptSegment[] = []
    current = upsertTranscriptSegment(current, partial as TranscriptSegment).segments
    current = upsertTranscriptSegment(current, final as TranscriptSegment).segments

    expect(current).toHaveLength(1)
    expect(current[0]).toMatchObject({
      text: 'final text',
      isFinal: true,
      streamId: undefined,
    })
  })
})
