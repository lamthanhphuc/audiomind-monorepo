import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_REALTIME_LANGUAGE, REALTIME_LANGUAGE_OPTIONS, beginGracefulStopLifecycle, buildFinalAudioBlobReadyLogPayload, buildTranscriptEquivalenceSignature, getRealtimeConnectionView, getStatusBadgeClass, hydrateLiveTranscriptSegments, isCurrentLiveRecordingSession, isRealtimeLanguageSelectorDisabled, mergeHydratedTranscriptWithLive, pollRealtimeAnalysisAfterStop, resolveFreshRealtimeMeetingId, resolveTranscriptPartialState, resolveVoiceActivityLifecycleUpdate, runLiveRecordingStopSequence, shouldAttemptRealtimeFinalAudioFallback } from './App'
import { ApiError } from '../services/api'
import { mergeTranscriptSegmentsForDisplay, normalizePersistedTranscriptForView, normalizePersistedTranscriptSegments, upsertTranscriptSegment } from '../utils/transcript'

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

  it('retries scoped hydration when the transcript attempt is not ready', async () => {
    vi.useFakeTimers()

    const sessionToken = { meetingId: 88, recordingSessionId: 9001, attemptId: 2, connectionSeq: 0 }
    const fetchTranscript = vi
      .fn()
      .mockResolvedValueOnce({
        meeting_id: 88,
        status: 'NOT_READY',
        errorCode: 'TRANSCRIPT_NOT_READY',
        transcriptNotReady: true,
        transcripts: [],
      })
      .mockResolvedValue({
        meeting_id: 88,
        transcripts: [
          {
            speaker: 'Speaker 1',
            start_time: 1,
            end_time: 2,
            text: 'Attempt scoped transcript',
            recording_session_id: 9001,
            attempt_id: 2,
            stream_id: 'mic',
            seq: 1,
          },
        ],
      })

    const hydrationPromise = hydrateLiveTranscriptSegments(
      88,
      fetchTranscript,
      sessionToken,
      (token) => token === sessionToken,
    )

    await vi.advanceTimersByTimeAsync(1500)
    await vi.runAllTicks()
    expect(fetchTranscript).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1500 * 3)
    const hydratedSegments = await hydrationPromise

    expect(fetchTranscript).toHaveBeenCalledWith(88, {
      recordingSessionId: 9001,
      attemptId: 2,
    })
    expect(fetchTranscript).toHaveBeenCalledTimes(4)
    expect(hydratedSegments).toHaveLength(1)
    expect(hydratedSegments[0]).toMatchObject({
      text: 'Attempt scoped transcript',
      recordingSessionId: 9001,
      attemptId: 2,
      streamId: 'mic',
    })
  })

  it('waits for transcript content and timing to stabilize when fragment count is unchanged', async () => {
    vi.useFakeTimers()

    const rowAt = (endTime: number, text: string) => ({
      speaker: 'Speaker 1',
      start_time: 0,
      end_time: endTime,
      text,
    })
    const fetchTranscript = vi
      .fn()
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [rowAt(3, 'short')] })
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [rowAt(6, 'abc def')] })
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [rowAt(6, 'xyz uvw')] })
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [rowAt(12, 'short middle complete')] })
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [rowAt(12, 'short middle complete')] })
      .mockResolvedValue({ meeting_id: 88, transcripts: [rowAt(12, 'short middle complete')] })

    const hydrationPromise = hydrateLiveTranscriptSegments(88, fetchTranscript)

    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(800 * 5)
    const hydratedSegments = await hydrationPromise

    expect(fetchTranscript).toHaveBeenCalledTimes(6)
    expect(hydratedSegments).toHaveLength(1)
    expect(hydratedSegments[0]).toMatchObject({
      text: 'short middle complete',
      end: 12,
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

  it('does not fetch an old meeting transcript after hydration ownership changes', async () => {
    vi.useFakeTimers()

    let activeHydrationRunId = 7
    const fetchTranscript = vi.fn().mockResolvedValue({
      meeting_id: 7,
      transcripts: [{ speaker: 'Speaker 1', text: 'old meeting row' }],
    })

    const hydrationPromise = hydrateLiveTranscriptSegments(
      7,
      fetchTranscript,
      null,
      null,
      {
        hydrationRunId: 7,
        isHydrationRunActive: (hydrationRunId) => hydrationRunId === activeHydrationRunId,
      },
    )

    activeHydrationRunId = 8
    await vi.advanceTimersByTimeAsync(1500)
    const hydratedSegments = await hydrationPromise

    expect(fetchTranscript).not.toHaveBeenCalled()
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

  it('passes v2 provenance to post-stop hydration transcript reads', async () => {
    vi.useFakeTimers()

    const sessionToken = { meetingId: 88, recordingSessionId: 9001, attemptId: 2, connectionSeq: 0 }
    const fetchTranscript = vi.fn().mockResolvedValue({
      meeting_id: 88,
      transcripts: [
        {
          meeting_id: 88,
          recording_session_id: 9001,
          attempt_id: 2,
          seq: 1,
          stream_id: 'tab',
          speaker: 'SPEAKER_1',
          start_time: 1,
          end_time: 2,
          text: 'Attempt scoped row',
        },
      ],
    })

    const hydrationPromise = hydrateLiveTranscriptSegments(
      88,
      fetchTranscript,
      sessionToken,
      (token) => token === sessionToken,
    )
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(800 * 3)
    const hydratedSegments = await hydrationPromise

    expect(fetchTranscript).toHaveBeenCalledWith(88, {
      recordingSessionId: 9001,
      attemptId: 2,
    })
    expect(hydratedSegments).toHaveLength(1)
    expect(hydratedSegments[0]).toMatchObject({
      recordingSessionId: 9001,
      attemptId: 2,
      streamId: 'tab',
      seq: 1,
    })
  })

  it('does not retry old meeting transcript after 404 wait when hydration ownership changes', async () => {
    vi.useFakeTimers()

    let activeHydrationRunId = 7

    const fetchTranscript = vi
      .fn()
      .mockRejectedValue(new ApiError('No transcript found', 404))

    const hydrationPromise = hydrateLiveTranscriptSegments(
      7,
      fetchTranscript,
      null,
      null,
      {
        hydrationRunId: 7,
        isHydrationRunActive: (hydrationRunId) => hydrationRunId === activeHydrationRunId,
      },
    )

    // Initial hydration delay -> first fetch /processing/{meetingId}/transcript
    await vi.advanceTimersByTimeAsync(1500)
    await vi.runAllTicks()

    expect(fetchTranscript).toHaveBeenCalledTimes(1)

    // New realtime meeting #8 becomes active while old meeting #7 is waiting before retry.
    activeHydrationRunId = 8

    // Retry delay finishes, but hydration must detect stale ownership and exit.
    await vi.advanceTimersByTimeAsync(800)
    await vi.runAllTicks()

    const hydratedSegments = await hydrationPromise

    expect(fetchTranscript).toHaveBeenCalledTimes(1)
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

describe('resolveFreshRealtimeMeetingId', () => {
  it('accepts a fresh realtime meeting id', () => {
    expect(resolveFreshRealtimeMeetingId({ id: 25, duplicate: false, existingMeetingId: null })).toBe(25)
  })

  it('rejects reused duplicate meeting ids for new realtime recording', () => {
    expect(() => resolveFreshRealtimeMeetingId({ id: 9, duplicate: true, existingMeetingId: 5 }))
      .toThrow('Realtime meeting creation returned a reused meeting')
  })
})

describe('mergeHydratedTranscriptWithLive', () => {
  it('returns merged live and hydrated rows in timeline order', () => {
    const live = [
      { id: 'meeting-1-start-272.000-speaker_3', mergeKey: 'segment:meeting-1-start-272.000-speaker_3', speaker: 'SPEAKER_3', text: 'row at 4:32', start: 272, end: 273, isFinal: true, source: 'live' as const },
      { id: 'meeting-1-start-441.000-speaker_4', mergeKey: 'segment:meeting-1-start-441.000-speaker_4', speaker: 'SPEAKER_4', text: 'row at 7:21', start: 441, end: 442, isFinal: true, source: 'live' as const },
    ]
    const hydrated = normalizePersistedTranscriptSegments([
      { speaker: 'SPEAKER_1', start_time: 119, end_time: 120, text: 'row at 1:59' },
    ])

    const merged = mergeHydratedTranscriptWithLive(live, hydrated)

    expect(merged.map((segment) => segment.text)).toEqual(['row at 1:59', 'row at 4:32', 'row at 7:21'])
  })

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

  it('matches history equivalence signature for shared persisted fixture', () => {
    const persistedRows = [
      { speaker: 'SPEAKER_1', start_time: 1, end_time: 2, text: 'one' },
      { speaker: 'SPEAKER_1', start_time: 3, end_time: 4, text: 'two' },
    ]
    const live = [
      { id: 'meeting-1-start-1.000-speaker_1', mergeKey: 'segment:meeting-1-start-1.000-speaker_1', speaker: 'SPEAKER_1', text: 'one', start: 1, end: 2, isFinal: true, source: 'live' as const },
      { id: 'meeting-1-start-3.000-speaker_1', mergeKey: 'segment:meeting-1-start-3.000-speaker_1', speaker: 'SPEAKER_1', text: 'two partial', start: 3, end: 4, isFinal: false, source: 'live' as const },
    ]

    const historySignature = buildTranscriptEquivalenceSignature(
      normalizePersistedTranscriptForView(persistedRows),
    )
    const liveSignature = buildTranscriptEquivalenceSignature(
      mergeHydratedTranscriptWithLive(live, normalizePersistedTranscriptForView(persistedRows)),
    )

    expect(liveSignature).toBe(historySignature)
  })
})

describe('resolveTranscriptPartialState', () => {
  it('returns true when stop is incomplete', () => {
    expect(resolveTranscriptPartialState({
      stopIncomplete: true,
      resetRequired: false,
      statusMessage: null,
    })).toBe(true)
  })

  it('returns true when backend reset is required', () => {
    expect(resolveTranscriptPartialState({
      stopIncomplete: false,
      resetRequired: true,
      statusMessage: null,
    })).toBe(true)
  })

  it('returns true when backend status message indicates partial transcript', () => {
    expect(resolveTranscriptPartialState({
      stopIncomplete: false,
      resetRequired: false,
      statusMessage: 'Transcript có thể chưa đầy đủ',
    })).toBe(true)
  })

  it('returns false for complete stop with stable backend status', () => {
    expect(resolveTranscriptPartialState({
      stopIncomplete: false,
      resetRequired: false,
      statusMessage: 'connected',
    })).toBe(false)
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

  it('updates the existing final segment speaker instead of duplicating near-matching finals', () => {
    const existing = [
      { id: 'meeting-1-start-1.000-speaker_1', mergeKey: 'segment:meeting-1-start-1.000-speaker_1', speaker: 'Speaker 1', text: 'Xin chào Audiomind', start: 1, end: 2, isFinal: true, source: 'live' as const },
    ]
    const incoming = {
      id: 'meeting-1-start-1.450-speaker_2',
      mergeKey: 'segment:meeting-1-start-1.450-speaker_2',
      speaker: 'Speaker 2',
      text: 'Xin chào Audiomind',
      start: 1.45,
      end: 2.25,
      isFinal: true,
      source: 'live' as const,
    }

    const { segments, segment } = upsertTranscriptSegment(existing, incoming)
    expect(segments).toHaveLength(1)
    expect(segment).toMatchObject({
      id: 'meeting-1-start-1.450-speaker_2',
      speaker: 'Speaker 2',
      text: 'Xin chào Audiomind',
      start: 1.45,
      end: 2.25,
      isFinal: true,
    })
  })

  it('selects the closest matching final segment and prefers the most recently inserted tie', () => {
    const existing = [
      { id: 'meeting-1-start-1.000-speaker_1', mergeKey: 'segment:meeting-1-start-1.000-speaker_1', speaker: 'Speaker 1', text: 'Xin chào Audiomind', start: 1, end: 2, isFinal: true, source: 'live' as const },
      { id: 'meeting-1-start-1.400-speaker_2', mergeKey: 'segment:meeting-1-start-1.400-speaker_2', speaker: 'Speaker 2', text: 'Xin chào Audiomind', start: 1.4, end: 2.4, isFinal: true, source: 'live' as const },
    ]
    const incoming = {
      id: 'meeting-1-start-1.200-speaker_3',
      mergeKey: 'segment:meeting-1-start-1.200-speaker_3',
      speaker: 'Speaker 3',
      text: 'Xin chào Audiomind',
      start: 1.2,
      end: 2.3,
      isFinal: true,
      source: 'live' as const,
    }

    const { segments } = upsertTranscriptSegment(existing, incoming)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({
      id: 'meeting-1-start-1.000-speaker_1',
      speaker: 'Speaker 1',
      text: 'Xin chào Audiomind',
    })
    expect(segments[1]).toMatchObject({
      id: 'meeting-1-start-1.200-speaker_3',
      speaker: 'Speaker 3',
      text: 'Xin chào Audiomind',
      start: 1.4,
      end: 2.4,
    })
  })

  it('keeps meaningful existing final text when a shorter final arrives but still updates the speaker', () => {
    const existing = [
      { id: 'meeting-2-start-5.000-speaker_1', mergeKey: 'segment:meeting-2-start-5.000-speaker_1', speaker: 'Speaker 1', text: 'Xin chào Audiomind từ realtime', start: 5, end: 7, isFinal: true, source: 'live' as const },
    ]
    const incoming = {
      id: 'meeting-2-start-5.180-speaker_2',
      mergeKey: 'segment:meeting-2-start-5.180-speaker_2',
      speaker: 'Speaker 2',
      text: 'Xin chào Audiomind',
      start: 5.18,
      end: 6.1,
      isFinal: true,
      source: 'live' as const,
    }

    const { segments } = upsertTranscriptSegment(existing, incoming)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({
      id: 'meeting-2-start-5.180-speaker_2',
      speaker: 'Speaker 2',
      text: 'Xin chào Audiomind từ realtime',
      start: 5,
      end: 7,
      isFinal: true,
    })
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

describe('pollRealtimeAnalysisAfterStop', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not fetch analysis for a stale realtime session token', async () => {
    const fetchAnalysis = vi.fn()
    const staleToken = { meetingId: 80, recordingSessionId: 1, attemptId: 1, connectionSeq: 1 }

    const result = await pollRealtimeAnalysisAfterStop(
      80,
      new AbortController().signal,
      fetchAnalysis as any,
      3,
      {
        sessionToken: staleToken,
        isSessionActive: () => false,
        analysisPollRunId: 2,
      },
    )

    expect(fetchAnalysis).not.toHaveBeenCalled()
    expect(result.status).toBe('pending')
    expect(result.reason).toBe('stale_session')
    expect(result.metadata?.analysisStatus).toBe('NO_ANALYSIS')
  })

  it('returns no-analysis metadata when backend reports no transcript after finalize', async () => {
    const fetchAnalysis = vi.fn().mockResolvedValue({
      status: 'NO_TRANSCRIPT_AFTER_FINALIZE',
      analysisStatus: 'NO_ANALYSIS',
      errorCode: 'NO_TRANSCRIPT_AFTER_FINALIZE',
      transcriptRows: 0,
      summary: '',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
    })

    const result = await pollRealtimeAnalysisAfterStop(
      81,
      new AbortController().signal,
      fetchAnalysis as any,
      3,
    )

    expect(fetchAnalysis).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('pending')
    expect(result.reason).toBe('no_transcript_after_finalize')
    expect(result.metadata?.analysisStatus).toBe('NO_ANALYSIS')
    expect(result.metadata?.errorCode).toBe('NO_TRANSCRIPT_AFTER_FINALIZE')
    expect(result.metadata?.transcriptRows).toBe(0)
  })

  it('returns completed when structured analysis becomes available', async () => {
    vi.useFakeTimers()

    const fetchAnalysis = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Analysis not found', 404))
      .mockResolvedValueOnce({
        summary: '',
        keywords: [],
        technicalTerms: [],
        painPoints: [],
        actionItems: [],
        domainMode: 'it',
      })
      .mockResolvedValueOnce({
        summary: 'Realtime summary',
        keywords: ['API'],
        technicalTerms: [],
        painPoints: [],
        actionItems: ['Scale workers'],
        domainMode: 'it',
      })

    const resultPromise = pollRealtimeAnalysisAfterStop(
      77,
      new AbortController().signal,
      fetchAnalysis as any,
      4,
    )

    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    const result = await resultPromise

    expect(fetchAnalysis).toHaveBeenCalledTimes(3)
    expect(result.status).toBe('completed')
    expect(result.analysis?.summary).toBe('Realtime summary')
    expect(result.metadata?.summary).toBe('Realtime summary')
  })

  it('returns completed after earlier pending metadata', async () => {
    vi.useFakeTimers()

    const fetchAnalysis = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('Analysis not found', 404))
      .mockResolvedValueOnce({
        status: 'ANALYZING',
        analysisStatus: 'ANALYZING',
        summary: '',
        keywords: [],
        technicalTerms: [],
        painPoints: [],
        actionItems: [],
        domainMode: 'it',
      })
      .mockResolvedValueOnce({
        status: 'COMPLETED',
        analysisStatus: 'COMPLETED',
        summary: 'Saved realtime analysis',
        keywords: ['Gemini'],
        technicalTerms: [],
        painPoints: [],
        actionItems: ['Review summary'],
        domainMode: 'it',
      })

    const resultPromise = pollRealtimeAnalysisAfterStop(
      81,
      new AbortController().signal,
      fetchAnalysis as any,
      5,
    )

    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)
    const result = await resultPromise

    expect(fetchAnalysis).toHaveBeenCalledTimes(3)
    expect(result.status).toBe('completed')
    expect(result.analysis?.analysisStatus).toBe('COMPLETED')
    expect(result.analysis?.summary).toBe('Saved realtime analysis')
  })

  it('returns failed for non-retryable analysis errors', async () => {
    const fetchAnalysis = vi.fn().mockRejectedValue(new ApiError('Unauthorized', 401))

    const result = await pollRealtimeAnalysisAfterStop(
      78,
      new AbortController().signal,
      fetchAnalysis as any,
      3,
    )

    expect(result.status).toBe('failed')
    expect(result.analysis).toBeNull()
    expect(result.metadata?.analysisStatus).toBe('FAILED')
    expect(result.metadata?.errorMessage).toBe('Unauthorized')
  })

  it('returns pending metadata when analysis 404 remains not ready', async () => {
    vi.useFakeTimers()

    const fetchAnalysis = vi.fn().mockRejectedValue(new ApiError('Analysis not found', 404))

    const resultPromise = pollRealtimeAnalysisAfterStop(
      80,
      new AbortController().signal,
      fetchAnalysis as any,
      2,
    )

    await vi.advanceTimersByTimeAsync(2000)
    const result = await resultPromise

    expect(fetchAnalysis).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('pending')
    expect(result.analysis).toBeNull()
    expect(result.metadata?.analysisStatus).toBe('NO_ANALYSIS')
  })

  it('stops polling when backend marks analysis as failed', async () => {
    const fetchAnalysis = vi.fn().mockResolvedValue({
      status: 'ANALYSIS_FAILED_RETRYABLE',
      analysisStatus: 'ANALYSIS_FAILED_RETRYABLE',
      errorCode: 'GEMINI_UNAVAILABLE',
      retryable: true,
      transcriptSaved: true,
      retryAfterSeconds: 30,
      summary: '',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
    })

    const result = await pollRealtimeAnalysisAfterStop(
      79,
      new AbortController().signal,
      fetchAnalysis as any,
      3,
    )

    expect(fetchAnalysis).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('failed')
    expect(result.metadata?.errorCode).toBe('GEMINI_UNAVAILABLE')
    expect(result.metadata?.retryAfterSeconds).toBe(30)
    expect(result.reason).toContain('Phân tích AI tạm thời chưa sẵn sàng')
  })

  it('stops polling when backend marks analysis as retryable circuit open', async () => {
    const fetchAnalysis = vi.fn().mockResolvedValue({
      status: 'ANALYSIS_FAILED_RETRYABLE',
      analysisStatus: 'ANALYSIS_FAILED_RETRYABLE',
      errorCode: 'CIRCUIT_OPEN',
      retryable: true,
      transcriptSaved: true,
      retryAfterSeconds: 10,
      summary: '',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
    })

    const result = await pollRealtimeAnalysisAfterStop(
      91,
      new AbortController().signal,
      fetchAnalysis as any,
      3,
    )

    expect(fetchAnalysis).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('failed')
    expect(result.metadata?.errorCode).toBe('CIRCUIT_OPEN')
    expect(result.reason).toContain('Transcript đã lưu')
    expect(result.reason).toContain('CIRCUIT_OPEN')
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

  it('shows paused state copy during silence-driven soft pause', () => {
    const view = getRealtimeConnectionView(
      'silent_paused',
      'connected',
      undefined,
      true,
      '',
    )

    expect(view.title).toBe('Paused')
    expect(view.detail).toBe('Paused while silent — speak to continue')
    expect(view.closeReason).toBeNull()
  })

  it('shows resumed state after speech activity returns', () => {
    const view = getRealtimeConnectionView(
      'listening_resumed',
      'connected',
      undefined,
      true,
      '',
    )

    expect(view.title).toBe('Resumed')
    expect(view.detail).toContain('lắng nghe trở lại')
  })

  it('shows terminal no-transcript state without a close error', () => {
    const view = getRealtimeConnectionView(
      'stopped_no_analysis',
      'NO_TRANSCRIPT_AFTER_FINALIZE',
      undefined,
      false,
      'Stream stopped by client',
    )

    expect(view.title).toBe('Chưa có transcript')
    expect(view.detail).toBe('Không có nội dung để phân tích')
    expect(view.closeReason).toBeNull()
    expect(view.closeReasonIsError).toBe(false)
  })
})

describe('resolveVoiceActivityLifecycleUpdate', () => {
  it('transitions to silent_paused and keeps it as a soft UI-only state', () => {
    const update = resolveVoiceActivityLifecycleUpdate({
      recorderState: 'recording',
      liveLifecycleState: 'recording',
      previousVoiceActivityState: 'listening',
      voiceActivityState: 'silent_paused',
    })

    expect(update.nextLifecycleState).toBe('silent_paused')
    expect(update.nextStatusMessage).toBe('Paused while silent — speak to continue')
    expect(update.nextLifecycleState).not.toBe('stopping')
    expect(update.nextLifecycleState).not.toBe('stopped')
  })

  it('transitions to listening_resumed and never treats resume as stop/finalize', () => {
    const update = resolveVoiceActivityLifecycleUpdate({
      recorderState: 'recording',
      liveLifecycleState: 'silent_paused',
      previousVoiceActivityState: 'silent_paused',
      voiceActivityState: 'listening_resumed',
    })

    expect(update.nextLifecycleState).toBe('listening_resumed')
    expect(update.nextStatusMessage).toBe('Resumed — continuing to listen...')
    expect(update.nextLifecycleState).not.toBe('stopping')
    expect(update.nextLifecycleState).not.toBe('stopped')
  })

  it('returns from paused/resumed back to recording when speech normalizes', () => {
    const fromPaused = resolveVoiceActivityLifecycleUpdate({
      recorderState: 'recording',
      liveLifecycleState: 'silent_paused',
      previousVoiceActivityState: 'listening_resumed',
      voiceActivityState: 'listening',
    })
    const fromResumed = resolveVoiceActivityLifecycleUpdate({
      recorderState: 'recording',
      liveLifecycleState: 'listening_resumed',
      previousVoiceActivityState: 'listening_resumed',
      voiceActivityState: 'listening',
    })

    expect(fromPaused.nextLifecycleState).toBe('recording')
    expect(fromResumed.nextLifecycleState).toBe('recording')
    expect(fromPaused.nextStatusMessage).toContain('lắng nghe')
    expect(fromResumed.nextStatusMessage).toContain('lắng nghe')
  })

  it('does not update lifecycle when recorder is not actively recording', () => {
    const update = resolveVoiceActivityLifecycleUpdate({
      recorderState: 'stopped',
      liveLifecycleState: 'stopped',
      previousVoiceActivityState: 'silent_paused',
      voiceActivityState: 'silent_paused',
    })

    expect(update.nextTrackedVoiceActivityState).toBeNull()
    expect(update.nextLifecycleState).toBeNull()
    expect(update.nextStatusMessage).toBeNull()
  })

  it('ignores VAD transitions once stop/finalize flow has started', () => {
    const update = resolveVoiceActivityLifecycleUpdate({
      recorderState: 'recording',
      liveLifecycleState: 'stopping',
      previousVoiceActivityState: 'listening',
      voiceActivityState: 'silent_paused',
    })

    expect(update.nextTrackedVoiceActivityState).toBe('listening')
    expect(update.nextLifecycleState).toBeNull()
    expect(update.nextStatusMessage).toBeNull()
  })

  it('does not emit duplicate updates for the same voice activity state', () => {
    const update = resolveVoiceActivityLifecycleUpdate({
      recorderState: 'recording',
      liveLifecycleState: 'recording',
      previousVoiceActivityState: 'listening',
      voiceActivityState: 'listening',
    })

    expect(update.nextTrackedVoiceActivityState).toBe('listening')
    expect(update.nextLifecycleState).toBeNull()
    expect(update.nextStatusMessage).toBeNull()
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
    expect(isRealtimeLanguageSelectorDisabled('silent_paused')).toBe(true)
    expect(isRealtimeLanguageSelectorDisabled('listening_resumed')).toBe(true)
    expect(isRealtimeLanguageSelectorDisabled('stopping')).toBe(true)
    expect(isRealtimeLanguageSelectorDisabled('stopped')).toBe(false)
  })
})

describe('buildFinalAudioBlobReadyLogPayload', () => {
  it('includes meetingId and bytes for FINAL_AUDIO_BLOB_READY logging', () => {
    expect(buildFinalAudioBlobReadyLogPayload(42, 2048)).toEqual({
      meetingId: 42,
      bytes: 2048,
    })
  })
})

describe('shouldAttemptRealtimeFinalAudioFallback', () => {
  it('requests fallback when transcript is empty and full blob is large enough after incomplete stop', () => {
    expect(shouldAttemptRealtimeFinalAudioFallback({
      mergedTranscriptCount: 0,
      fullAudioBytes: 4096,
      minFallbackAudioBytes: 1024,
      stopIncomplete: true,
      partialState: false,
      resetRequired: false,
      streamState: 'stopped',
    })).toBe(true)
  })

  it('skips fallback when hydrated transcript rows exist', () => {
    expect(shouldAttemptRealtimeFinalAudioFallback({
      mergedTranscriptCount: 2,
      fullAudioBytes: 4096,
      minFallbackAudioBytes: 1024,
      stopIncomplete: true,
      partialState: false,
      resetRequired: false,
      streamState: 'stopped',
    })).toBe(false)
  })

  it('skips fallback when full blob is below minimum bytes', () => {
    expect(shouldAttemptRealtimeFinalAudioFallback({
      mergedTranscriptCount: 0,
      fullAudioBytes: 256,
      minFallbackAudioBytes: 1024,
      stopIncomplete: true,
      partialState: false,
      resetRequired: false,
      streamState: 'stopped',
    })).toBe(false)
  })

  it('skips fallback when stop completed cleanly without partial or error signals', () => {
    expect(shouldAttemptRealtimeFinalAudioFallback({
      mergedTranscriptCount: 0,
      fullAudioBytes: 4096,
      minFallbackAudioBytes: 1024,
      stopIncomplete: false,
      partialState: false,
      resetRequired: false,
      streamState: 'stopped',
    })).toBe(false)
  })
})

describe('getStatusBadgeClass', () => {
  it('maps processing and completed statuses to badge variants', () => {
    expect(getStatusBadgeClass('completed')).toContain('completed')
    expect(getStatusBadgeClass('processing')).toContain('processing')
    expect(getStatusBadgeClass('failed')).toContain('failed')
    expect(getStatusBadgeClass('idle')).toContain('idle')
  })
})

describe('runLiveRecordingStopSequence', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs REALTIME_STOP_REQUESTED then stopping → stopStream → finalizing_transcript in order', async () => {
    const lifecycleSteps: string[] = []
    const executionSteps: string[] = []
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    const stopStream = vi.fn(async () => {
      executionSteps.push('stopStream')
      return true
    })

    const result = await runLiveRecordingStopSequence({
      meetingId: 42,
      sessionId: 7,
      stopStream,
      setLifecycleState: (state) => {
        lifecycleSteps.push(state)
        executionSteps.push(`lifecycle:${state}`)
      },
    })

    expect(result).toEqual({ stopSent: true, stopIncomplete: false })
    expect(executionSteps).toEqual([
      'lifecycle:stopping',
      'stopStream',
      'lifecycle:finalizing_transcript',
    ])
    expect(consoleSpy).toHaveBeenCalledWith(
      '[Realtime] REALTIME_STOP_REQUESTED',
      expect.objectContaining({
        meetingId: 42,
        sessionId: 7,
        phase: 'stream_finalize',
      }),
    )
    expect(stopStream).toHaveBeenCalledTimes(1)
  })

  it('marks stopIncomplete when stopStream returns false', async () => {
    const result = await runLiveRecordingStopSequence({
      meetingId: 10,
      sessionId: 3,
      stopStream: vi.fn(async () => false),
      setLifecycleState: vi.fn(),
    })

    expect(result).toEqual({ stopSent: false, stopIncomplete: true })
  })
})

describe('beginGracefulStopLifecycle', () => {
  it('transitions stopping then finalizing_recording via deferred scheduler', () => {
    const lifecycleSteps: string[] = []
    const deferredTasks: Array<() => void> = []

    beginGracefulStopLifecycle(
      (state) => lifecycleSteps.push(state),
      (callback) => {
        deferredTasks.push(callback)
      },
    )

    expect(lifecycleSteps).toEqual(['stopping'])

    deferredTasks.forEach((task) => task())
    expect(lifecycleSteps).toEqual(['stopping', 'finalizing_recording'])
  })
})

