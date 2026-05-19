import { afterEach, describe, expect, it, vi } from 'vitest'
import { hydrateLiveTranscriptSegments } from './App'

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
})
