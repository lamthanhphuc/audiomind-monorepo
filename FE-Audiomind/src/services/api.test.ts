import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteMeeting, downloadMeetingReport, getMeetingDetail, getSavedAnalysis, listMeetings, listMeetingsWithParams, renameMeeting, startProcessingByPath, uploadToMeetingApi } from './api'

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

  it('applies query filters when loading meeting history', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ([]),
      headers: new Headers(),
    })

    await listMeetingsWithParams({
      query: 'demo',
      status: 'completed',
      language: 'vi',
      sort: 'created_desc',
    })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/meetings?')
    expect(url).toContain('query=demo')
    expect(url).toContain('status=completed')
    expect(url).toContain('language=vi')
    expect(url).toContain('sort=created_desc')
  })

  it('renames and soft deletes meeting through management endpoints', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 9, title: 'Renamed', audioPath: '/tmp/a.wav', createdAt: '2026-05-28T00:00:00Z' }),
      headers: new Headers(),
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 9, deleted: true }),
      headers: new Headers(),
    })

    const renamed = await renameMeeting(9, 'Renamed')
    expect(renamed.title).toBe('Renamed')

    const deleted = await deleteMeeting(9)
    expect(deleted.deleted).toBe(true)

    const urls = fetchMock.mock.calls.map((call) => call[0] as string)
    expect(urls.some((url) => url.endsWith('/meetings/9'))).toBe(true)
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

  it('downloads meeting report as blob and reads filename from content-disposition', async () => {
    const blob = new Blob(['fake-docx'], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      blob: async () => blob,
      headers: new Headers({
        'content-disposition': 'attachment; filename=\"meeting-7-report.docx\"',
      }),
    })

    const result = await downloadMeetingReport(7, 'docx')
    expect(result.blob).toBe(blob)
    expect(result.filename).toBe('meeting-7-report.docx')

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/processing/7/report?format=docx')
  })
})
