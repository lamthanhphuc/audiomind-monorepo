import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_REALTIME_LANGUAGE, REALTIME_LANGUAGE_OPTIONS, getRealtimeConnectionView, hydrateLiveTranscriptSegments, isCurrentLiveRecordingSession, isRealtimeLanguageSelectorDisabled, mergeHydratedTranscriptWithLive } from './App'
import { ApiError } from './services/api'
import { mergeTranscriptSegmentsForDisplay, normalizePersistedTranscriptSegments } from './utils/transcript'

describe('hydrateLiveTranscriptSegments', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retries when the first transcript read is empty and resolves after fragments appear', async () => {
    vi.useFakeTimers()

    const fetchTranscript = vi
      .fn()
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [] })
      .mockResolvedValueOnce({
        meeting_id: 88,
        transcripts: [
          {
            speaker: 'Speaker 1',
            start_time: 7.81,
            end_time: 8.48,
            text: 'Xin chào Audiomind',
          },
          {
            speaker: 'Speaker 2',
            start_time: 18.94,
            end_time: 19.4,
            text: 'Đây là câu hoàn chỉnh',
          },
        ],
      })
      .mockResolvedValue({
        meeting_id: 88,
        transcripts: [
          {
            speaker: 'Speaker 1',
            start_time: 7.81,
            end_time: 8.48,
            text: 'Xin chào Audiomind',
          },
          {
            speaker: 'Speaker 2',
            start_time: 18.94,
            end_time: 19.4,
            text: 'Đây là câu hoàn chỉnh',
          },
        ],
      })

    const hydrationPromise = hydrateLiveTranscriptSegments(88, fetchTranscript)
    let resolved = false
    hydrationPromise.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(1500)
    await vi.runAllTicks()

    expect(fetchTranscript).toHaveBeenCalledTimes(1)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1500 * 3)
    const hydratedSegments = await hydrationPromise

    expect(fetchTranscript).toHaveBeenCalledTimes(4)
    expect(hydratedSegments).toHaveLength(2)
    expect(hydratedSegments.map((segment) => segment.text)).toEqual([
      'Xin chào Audiomind',
      'Đây là câu hoàn chỉnh',
    ])
    expect(hydratedSegments[0]).toMatchObject({
      start: 7.81,
      end: 8.48,
    })
  })

  it('returns an empty list only after exhausting retries', async () => {
    vi.useFakeTimers()

    const fetchTranscript = vi.fn().mockResolvedValue({ meeting_id: 88, transcripts: [] })

    const hydrationPromise = hydrateLiveTranscriptSegments(88, fetchTranscript)
    let resolved = false
    hydrationPromise.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(1500)
    await vi.runAllTicks()
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1500 * 9)
    const hydratedSegments = await hydrationPromise

    expect(fetchTranscript).toHaveBeenCalledTimes(10)
    expect(hydratedSegments).toEqual([])
    expect(resolved).toBe(true)
  })

  it('ignores stale hydration success after a newer meeting becomes active', async () => {
    vi.useFakeTimers()

    const staleToken = { meetingId: 15, recordingSessionId: 1, attemptId: 1, connectionSeq: 0 }
    const activeToken = { meetingId: 18, recordingSessionId: 2, attemptId: 2, connectionSeq: 0 }
    let currentToken = staleToken

    const fetchTranscript = vi
      .fn()
      .mockResolvedValueOnce({ meeting_id: 15, transcripts: [] })
      .mockResolvedValueOnce({
        meeting_id: 15,
        transcripts: [
          {
            speaker: 'Speaker 1',
            start_time: 7.81,
            end_time: 8.48,
            text: 'Stale meeting fragment',
          },
        ],
      })

    const hydrationPromise = hydrateLiveTranscriptSegments(
      15,
      fetchTranscript,
      staleToken,
      (token) => token === currentToken,
    )

    currentToken = activeToken

    await vi.advanceTimersByTimeAsync(1500)
    await vi.runAllTicks()

    const hydratedSegments = await hydrationPromise

    expect(hydratedSegments).toEqual([])
  })

  it('ignores stale hydration errors after a newer meeting becomes active', async () => {
    vi.useFakeTimers()

    const staleToken = { meetingId: 16, recordingSessionId: 3, attemptId: 3, connectionSeq: 0 }
    const activeToken = { meetingId: 19, recordingSessionId: 4, attemptId: 4, connectionSeq: 0 }
    let currentToken = staleToken

    const fetchTranscript = vi.fn().mockImplementation(async () => {
      throw new Error('old hydration failed')
    })

    const hydrationPromise = hydrateLiveTranscriptSegments(
      16,
      fetchTranscript,
      staleToken,
      (token) => token === currentToken,
    )

    currentToken = activeToken

    await vi.advanceTimersByTimeAsync(1500)
    await vi.runAllTicks()

    const hydratedSegments = await hydrationPromise

    expect(hydratedSegments).toEqual([])
  })

  it('treats stale meeting completion as non-current when a new meeting is active', () => {
    expect(isCurrentLiveRecordingSession(13, 13, 14, 14)).toBe(false)
    expect(isCurrentLiveRecordingSession(14, 14, 14, 14)).toBe(true)
  })

  it('retries transcript 404 responses and exits with no fragments after max attempts', async () => {
    vi.useFakeTimers()

    const fetchTranscript = vi.fn().mockRejectedValue(new ApiError('No transcript found', 404))

    const hydrationPromise = hydrateLiveTranscriptSegments(88, fetchTranscript)
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(800 * 9)
    const hydratedSegments = await hydrationPromise

    expect(fetchTranscript).toHaveBeenCalledTimes(10)
    expect(hydratedSegments).toEqual([])
  })

  it('waits for stable transcript count when backend marks partial/reset_required', async () => {
    vi.useFakeTimers()

    const fetchTranscript = vi
      .fn()
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [{ speaker: 'S1', start_time: 1, end_time: 2, text: 'a' }] })
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [{ speaker: 'S1', start_time: 1, end_time: 2, text: 'a' }, { speaker: 'S2', start_time: 3, end_time: 4, text: 'b' }] })
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [{ speaker: 'S1', start_time: 1, end_time: 2, text: 'a' }, { speaker: 'S2', start_time: 3, end_time: 4, text: 'b' }] })
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [{ speaker: 'S1', start_time: 1, end_time: 2, text: 'a' }, { speaker: 'S2', start_time: 3, end_time: 4, text: 'b' }] })

    const hydrationPromise = hydrateLiveTranscriptSegments(88, fetchTranscript, null, null, {
      backendPartial: true,
      backendResetRequired: true,
    })

    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(800)
    const hydratedSegments = await hydrationPromise

    expect(fetchTranscript).toHaveBeenCalledTimes(4)
    expect(hydratedSegments).toHaveLength(2)
  })
})

describe('mergeHydratedTranscriptWithLive', () => {
  it('keeps live-only final segment when hydrated snapshot is behind', () => {
    const live = [
      { id: 'meeting-1-start-1.000-speaker_1', mergeKey: 'segment:meeting-1-start-1.000-speaker_1', speaker: 'Speaker 1', text: 'one', start: 1, end: 2, isFinal: true, source: 'live' as const },
      { id: 'meeting-1-start-3.000-speaker_1', mergeKey: 'segment:meeting-1-start-3.000-speaker_1', speaker: 'Speaker 1', text: 'two', start: 3, end: 4, isFinal: true, source: 'live' as const },
      { id: 'meeting-1-start-5.000-speaker_1', mergeKey: 'segment:meeting-1-start-5.000-speaker_1', speaker: 'Speaker 1', text: 'three', start: 5, end: 6, isFinal: true, source: 'live' as const },
      { id: 'meeting-1-start-7.000-speaker_1', mergeKey: 'segment:meeting-1-start-7.000-speaker_1', speaker: 'Speaker 1', text: 'four', start: 7, end: 8, isFinal: true, source: 'live' as const },
      { id: 'meeting-1-start-9.000-speaker_1', mergeKey: 'segment:meeting-1-start-9.000-speaker_1', speaker: 'Speaker 1', text: 'five', start: 9, end: 10, isFinal: true, source: 'live' as const },
    ]
    const hydrated = normalizePersistedTranscriptSegments([
      { speaker: 'Speaker 1', start_time: 1.0, end_time: 2.0, text: 'one' },
      { speaker: 'Speaker 1', start_time: 3.0, end_time: 4.0, text: 'two' },
      { speaker: 'Speaker 1', start_time: 5.0, end_time: 6.0, text: 'three' },
      { speaker: 'Speaker 1', start_time: 7.0, end_time: 8.0, text: 'four' },
    ])

    const merged = mergeHydratedTranscriptWithLive(live, hydrated)
    expect(merged).toHaveLength(5)
    expect(merged.map((segment) => segment.text)).toEqual(['one', 'two', 'three', 'four', 'five'])
  })

  it('reconciles hydration time-* row into live meeting-* segment by timing/speaker', () => {
    const live = [
      { id: 'meeting-2-start-7.810-speaker_1-1', mergeKey: 'segment:meeting-2-start-7.810-speaker_1-1', speaker: 'Speaker 1', text: 'Xin chào', start: 7.81, end: 8.12, isFinal: false, source: 'live' as const },
    ]
    const hydrated = normalizePersistedTranscriptSegments([
      { speaker: 'Speaker 1', start_time: 7.82, end_time: 8.48, text: 'Xin chào Audiomind' },
    ])

    const merged = mergeHydratedTranscriptWithLive(live, hydrated)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'meeting-2-start-7.810-speaker_1-1',
      text: 'Xin chào Audiomind',
      end: 8.48,
    })
  })

  it('replaces live partial overlap with hydrated final rows after stop', () => {
    const live = [
      { id: 'meeting-14-start-19.450-speaker_1', mergeKey: 'segment:meeting-14-start-19.450-speaker_1', speaker: 'Speaker 1', text: 'liệu có thể vào thời điểm hai chúng ta', start: 19.45, end: 24.42, isFinal: false, source: 'live' as const },
      { id: 'meeting-14-start-22.470-speaker_1', mergeKey: 'segment:meeting-14-start-22.470-speaker_1', speaker: 'Speaker 1', text: 'hai chúng ta thảo luận tiếp', start: 22.47, end: 26.69, isFinal: true, source: 'live' as const },
    ]
    const hydrated = [
      { id: 'meeting-14-start-19.450-speaker_1', mergeKey: 'segment:meeting-14-start-19.450-speaker_1', speaker: 'Speaker 1', text: 'liệu có thể vào thời điểm hai', start: 19.45, end: 22.47, isFinal: true, source: 'hydration' as const },
      { id: 'meeting-14-start-22.470-speaker_1', mergeKey: 'segment:meeting-14-start-22.470-speaker_1', speaker: 'Speaker 1', text: 'hai chúng ta thảo luận tiếp', start: 22.47, end: 26.69, isFinal: true, source: 'hydration' as const },
    ]

    const merged = mergeHydratedTranscriptWithLive(live, hydrated)
    expect(merged).toHaveLength(2)
    expect(merged[0].isFinal).toBe(true)
    expect(merged[1].isFinal).toBe(true)
    expect(merged.map((segment) => `${segment.start}-${segment.end}`)).toEqual([
      '19.45-22.47',
      '22.47-26.69',
    ])
  })

  it('persists final replaces live partial for same start/speaker', () => {
    const live = [
      { id: 'time-19.450-speaker_1', mergeKey: 'semantic:19.450|speaker_1', speaker: 'Speaker 1', text: 'liệu có thể vào thời điểm hai chúng ta', start: 19.45, end: 24.42, isFinal: false, source: 'live' as const },
    ]
    const hydrated = [
      { id: 'meeting-14-start-19.450-speaker_1', mergeKey: 'segment:meeting-14-start-19.450-speaker_1', speaker: 'Speaker 1', text: 'liệu có thể vào thời điểm hai', start: 19.45, end: 22.47, isFinal: true, source: 'hydration' as const },
    ]

    const merged = mergeHydratedTranscriptWithLive(live, hydrated)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'meeting-14-start-19.450-speaker_1',
      isFinal: true,
      end: 22.47,
    })
  })
})

describe('mergeTranscriptSegmentsForDisplay', () => {
  it('merges adjacent same-speaker fragments for display', () => {
    const merged = mergeTranscriptSegmentsForDisplay([
      { id: 'a', mergeKey: 'segment:a', speaker: 'Speaker 1', text: 'Xin chào', start: 1, end: 2, isFinal: true, source: 'hydration' as const },
      { id: 'b', mergeKey: 'segment:b', speaker: 'Speaker 1', text: 'mọi người', start: 2.5, end: 3.4, isFinal: true, source: 'hydration' as const },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].text).toBe('Xin chào mọi người')
  })

  it('does not merge different speakers or large gaps', () => {
    const merged = mergeTranscriptSegmentsForDisplay([
      { id: 'a', mergeKey: 'segment:a', speaker: 'Speaker 1', text: 'Xin chào', start: 1, end: 2, isFinal: true, source: 'hydration' as const },
      { id: 'b', mergeKey: 'segment:b', speaker: 'Speaker 2', text: 'hello', start: 2.3, end: 3, isFinal: true, source: 'hydration' as const },
      { id: 'c', mergeKey: 'segment:c', speaker: 'Speaker 1', text: 'kết thúc', start: 6, end: 7, isFinal: true, source: 'hydration' as const },
    ])
    expect(merged).toHaveLength(3)
  })

  it('deduplicates exact repeated fragment text in display output', () => {
    const merged = mergeTranscriptSegmentsForDisplay([
      { id: 'a', mergeKey: 'segment:a', speaker: 'Speaker 1', text: 'Xin chào', start: 1, end: 2, isFinal: true, source: 'hydration' as const },
      { id: 'b', mergeKey: 'segment:b', speaker: 'Speaker 1', text: 'Xin chào', start: 2.2, end: 2.8, isFinal: true, source: 'hydration' as const },
    ])
    expect(merged).toHaveLength(1)
  })

  it('does not merge long overlapping fragments that exceed short-fragment policy', () => {
    const merged = mergeTranscriptSegmentsForDisplay([
      { id: 'a', mergeKey: 'segment:a', speaker: 'Speaker 1', text: 'chúng ta cần cập nhật kế hoạch', start: 15, end: 19, isFinal: true, source: 'hydration' as const },
      { id: 'b', mergeKey: 'segment:b', speaker: 'Speaker 1', text: 'kế hoạch cho sprint tiếp theo', start: 18, end: 31, isFinal: true, source: 'hydration' as const },
    ])
    expect(merged).toHaveLength(2)
  })

  it('merges short overlapping same-speaker fragments and trims repeated boundary text', () => {
    const merged = mergeTranscriptSegmentsForDisplay([
      { id: 'a', mergeKey: 'segment:a', speaker: 'Speaker 1', text: 'chúng ta cần cập nhật kế hoạch', start: 15, end: 16.8, isFinal: true, source: 'hydration' as const },
      { id: 'b', mergeKey: 'segment:b', speaker: 'Speaker 1', text: 'kế hoạch cho sprint tiếp theo', start: 16.4, end: 18.2, isFinal: true, source: 'hydration' as const },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].start).toBe(15)
    expect(merged[0].end).toBe(18.2)
    expect(merged[0].text).toBe('chúng ta cần cập nhật kế hoạch cho sprint tiếp theo')
  })

  it('does not mutate raw source segments while producing display merge', () => {
    const source = [
      { id: 'a', mergeKey: 'segment:a', speaker: 'Speaker 1', text: 'one', start: 1, end: 2, isFinal: true, source: 'hydration' as const },
      { id: 'b', mergeKey: 'segment:b', speaker: 'Speaker 1', text: 'two', start: 2.2, end: 3, isFinal: true, source: 'hydration' as const },
    ]
    const snapshot = JSON.parse(JSON.stringify(source))
    void mergeTranscriptSegmentsForDisplay(source)
    expect(source).toEqual(snapshot)
  })
})

describe('getRealtimeConnectionView', () => {
  it('shows completed state as normal after successful stop', () => {
    const view = getRealtimeConnectionView(
      'stopped',
      'connected',
      'WebSocket closed (1000)',
      false,
      'WebSocket closed (1000)',
    )

    expect(view.title).toBe('Hoàn tất')
    expect(view.detail).toBe('Đã lưu transcript')
    expect(view.closeReason).toBeNull()
    expect(view.closeReasonIsError).toBe(false)
  })

  it('treats stream stopped by client as normal when lifecycle is stopping/stopped', () => {
    const view = getRealtimeConnectionView(
      'stopping',
      'stopped',
      'Stream stopped by client',
      false,
      'Stream stopped by client',
    )

    expect(view.title).toBe('Đang dừng')
    expect(view.detail).toContain('lưu transcript')
    expect(view.closeReason).toBeNull()
  })

  it('keeps unexpected close as error while recording', () => {
    const view = getRealtimeConnectionView(
      'error',
      'error',
      'network reset',
      false,
      'network reset',
    )

    expect(view.title).toBe('Lỗi')
    expect(view.detail).toBe('network reset')
    expect(view.closeReason).toBe('network reset')
    expect(view.closeReasonIsError).toBe(true)
  })

  it('clears stale close reason when a new recording starts connecting', () => {
    const view = getRealtimeConnectionView(
      'connecting',
      'connected',
      undefined,
      true,
      'Stream stopped by client',
    )

    expect(view.title).toBe('Đang kết nối')
    expect(view.closeReason).toBeNull()
    expect(view.closeReasonIsError).toBe(false)
  })
})

describe('realtime language selector helpers', () => {
  it('defaults to vi with the expected language options', () => {
    expect(DEFAULT_REALTIME_LANGUAGE).toBe('vi')
    expect(REALTIME_LANGUAGE_OPTIONS.map((option) => option.value)).toEqual(['vi', 'en', 'multi'])
  })

  it('disables language changes while active and allows them when idle', () => {
    expect(isRealtimeLanguageSelectorDisabled('idle')).toBe(false)
    expect(isRealtimeLanguageSelectorDisabled('connecting')).toBe(true)
    expect(isRealtimeLanguageSelectorDisabled('recording')).toBe(true)
    expect(isRealtimeLanguageSelectorDisabled('stopping')).toBe(true)
    expect(isRealtimeLanguageSelectorDisabled('stopped')).toBe(false)
  })
})
