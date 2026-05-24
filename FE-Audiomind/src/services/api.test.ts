import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { startProcessingByPath, uploadToMeetingApi } from './api'

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
})
