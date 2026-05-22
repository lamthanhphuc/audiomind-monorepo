import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRealtimeConnectionView, hydrateLiveTranscriptSegments, isCurrentLiveRecordingSession } from './App'

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

    const hydrationPromise = hydrateLiveTranscriptSegments(88, fetchTranscript)
    let resolved = false
    hydrationPromise.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(1500)
    await vi.runAllTicks()

    expect(fetchTranscript).toHaveBeenCalledTimes(1)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(1500)
    const hydratedSegments = await hydrationPromise

    expect(fetchTranscript).toHaveBeenCalledTimes(2)
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

  it('waits for stable transcript count when backend marks partial/reset_required', async () => {
    vi.useFakeTimers()

    const fetchTranscript = vi
      .fn()
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [{ speaker: 'S1', start_time: 1, end_time: 2, text: 'a' }] })
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [{ speaker: 'S1', start_time: 1, end_time: 2, text: 'a' }, { speaker: 'S2', start_time: 3, end_time: 4, text: 'b' }] })
      .mockResolvedValueOnce({ meeting_id: 88, transcripts: [{ speaker: 'S1', start_time: 1, end_time: 2, text: 'a' }, { speaker: 'S2', start_time: 3, end_time: 4, text: 'b' }] })

    const hydrationPromise = hydrateLiveTranscriptSegments(88, fetchTranscript, null, null, {
      backendPartial: true,
      backendResetRequired: true,
    })

    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(800)
    const hydratedSegments = await hydrationPromise

    expect(fetchTranscript).toHaveBeenCalledTimes(3)
    expect(hydratedSegments).toHaveLength(2)
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
