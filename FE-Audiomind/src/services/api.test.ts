import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMeetingDetail, getSavedAnalysis, listMeetings, startProcessingByPath, uploadToMeetingApi } from './api'

describe('upload language request wiring', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 1, audioPath: '/tmp/a.wav', title: 'a' }),
      headers: new Headers(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('includes language in meeting upload form data', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'sample.wav', { type: 'audio/wav' })
    await uploadToMeetingApi('sample', file, 'en')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const form = init.body as FormData
    expect(form.get('language')).toBe('en')
  })

  it('includes language query when starting processing by path', async () => {
    await startProcessingByPath(42, 'multi')
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/processing/start/42?language=multi')
  })

  it('loads meeting history from the runtime meeting endpoint', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ([{ id: 7, title: 'History item', audioPath: '/tmp/a.wav', createdAt: '2026-05-28T00:00:00Z' }]),
      headers: new Headers(),
    })

    const meetings = await listMeetings()
    expect(meetings).toHaveLength(1)

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/meetings')
  })

  it('loads meeting detail and saved analysis from read-only endpoints', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 7, title: 'History item', audioPath: '/tmp/a.wav', createdAt: '2026-05-28T00:00:00Z' }),
      headers: new Headers(),
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ meeting_id: 7, status: 'NOT_FOUND' }),
      headers: new Headers(),
    })

    const meeting = await getMeetingDetail(7)
    expect(meeting.id).toBe(7)

    const analysis = await getSavedAnalysis(7)
    expect(analysis.status).toBe('NOT_FOUND')

    const urls = fetchMock.mock.calls.map((call) => call[0] as string)
    expect(urls.some((url) => url.includes('/meetings/7'))).toBe(true)
    expect(urls.some((url) => url.includes('/processing/7/analysis/saved'))).toBe(true)
  })
})
