import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRealtimeMeeting,
  deleteMeeting,
  downloadMeetingActionPlanDocx,
  downloadMeetingReport,
  downloadMeetingTranscript,
  getMeetingActionPlan,
  getMeetingDetail,
  getSavedAnalysis,
  getTranscript,
  getUserProfile,
  listMeetings,
  listMeetingsWithParams,
  reanalyzeMeetingAnalysis,
  renameMeeting,
  searchMeetingTranscriptEvidence,
  startProcessingByPath,
  uploadToMeetingApi,
} from './api'

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

  it('creates realtime meetings through the non-upload endpoint', async () => {
    await createRealtimeMeeting('Live recording session', 'en')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/meetings/realtime')
    expect(url).not.toContain('/meetings/upload')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({
      title: 'Live recording session',
      language: 'en',
    })
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

  it('forwards abort signal to saved analysis and transcript read endpoints', async () => {
    const controller = new AbortController()
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ meeting_id: 7, transcripts: [] }),
        headers: new Headers(),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ meetingId: 7, data: { status: 'NOT_FOUND' } }),
        headers: new Headers(),
      })

    await getTranscript(7, { signal: controller.signal })
    await getSavedAnalysis(7, { signal: controller.signal })

    const urls = fetchMock.mock.calls.map((call) => call[0] as string)
    expect(urls[0]).toContain('/processing/7/transcript')
    const inits = fetchMock.mock.calls.map((call) => call[1] as RequestInit)
    expect(inits[0]?.signal).toBe(controller.signal)
    expect(inits[1]?.signal).toBe(controller.signal)
  })

  it('adds attempt scope to transcript reads when both provenance ids are provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ meeting_id: 7, transcripts: [] }),
      headers: new Headers(),
    })

    await getTranscript(7, { recordingSessionId: 9001, attemptId: 2 })

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/processing/7/transcript?')
    expect(url).toContain('recording_session_id=9001')
    expect(url).toContain('attempt_id=2')
  })

  it('rejects partial transcript provenance before fetch', async () => {
    await expect(getTranscript(7, { recordingSessionId: 9001 })).rejects.toMatchObject({
      status: 422,
      errorCode: 'INVALID_PROVENANCE',
    })
    expect(fetchMock).not.toHaveBeenCalled()
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

  it('preserves saved analysis metadata from the read-only endpoint', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        meetingId: 7,
        data: {
          status: 'COMPLETED',
          analysisStatus: 'COMPLETED',
          summary: 'Done',
          keywords: ['cache'],
          technicalTerms: [],
          painPoints: [],
          actionItems: [],
          domainMode: 'it',
          cacheHit: true,
          stale: false,
          staleReason: 'canonical_hash_changed',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          promptVersion: 'prompt-v7',
          schemaVersion: 'schema-v7',
          canonicalTranscriptHash: 'canonical-hash',
          canonicalTranscriptVersion: 'canonical-transcript-v1',
          analysisInputMode: 'canonical',
          lastAnalyzedAt: '2026-06-01T00:00:00Z',
          retryAfterSeconds: 12,
        },
      }),
      headers: new Headers(),
    })

    const analysis = await getSavedAnalysis(7)

    expect(analysis.analysisStatus).toBe('COMPLETED')
    expect(analysis.cacheHit).toBe(true)
    expect(analysis.stale).toBe(false)
    expect(analysis.staleReason).toBe('canonical_hash_changed')
    expect(analysis.provider).toBe('gemini')
    expect(analysis.model).toBe('gemini-2.5-flash')
    expect(analysis.promptVersion).toBe('prompt-v7')
    expect(analysis.schemaVersion).toBe('schema-v7')
    expect(analysis.canonicalTranscriptHash).toBe('canonical-hash')
    expect(analysis.canonicalTranscriptVersion).toBe('canonical-transcript-v1')
    expect(analysis.analysisInputMode).toBe('canonical')
    expect(analysis.lastAnalyzedAt).toBe('2026-06-01T00:00:00Z')
    expect(analysis.retryAfterSeconds).toBe(12)
  })

  it('reanalyzes meeting analysis through the processing rerun endpoint', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        meetingId: 7,
        data: {
          status: 'ANALYZING',
          analysisStatus: 'ANALYZING',
          summary: '',
          keywords: [],
          technicalTerms: [],
          painPoints: [],
          actionItems: [],
          domainMode: 'it',
        },
      }),
      headers: new Headers(),
    })

    const analysis = await reanalyzeMeetingAnalysis(7, { mode: 'force', reason: 'manual_reanalyze' })

    expect(analysis.analysisStatus).toBe('ANALYZING')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/processing/7/analysis/rerun')
    expect(url).not.toContain('/api/meeting/7/analysis/rerun')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'force', reason: 'manual_reanalyze' })
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

  it('searches transcript evidence with encoded query and default context options', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        meetingId: 7,
        query: 'api deadline',
        normalizedQuery: 'api deadline',
        transcriptMode: 'canonical',
        matches: [],
      }),
      headers: new Headers(),
    })

    const result = await searchMeetingTranscriptEvidence(7, 'api deadline')

    expect(result.meetingId).toBe(7)
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/processing/7/transcript/search?')
    expect(url).toContain('q=api+deadline')
    expect(url).toContain('limit=20')
    expect(url).toContain('context=1')
  })

  it('searches transcript evidence with caller-provided limit/context and URL encoding', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        meetingId: 7,
        query: 'kế hoạch & api',
        normalizedQuery: 'ke hoach api',
        transcriptMode: 'raw',
        matches: [],
      }),
      headers: new Headers(),
    })

    await searchMeetingTranscriptEvidence(7, 'kế hoạch & api', { limit: 5, context: 0 })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('q=k%E1%BA%BF+ho%E1%BA%A1ch+%26+api')
    expect(url).toContain('limit=5')
    expect(url).toContain('context=0')
  })

  it('loads meeting action plan preview', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        meeting: { meetingId: 7, title: 'History item' },
        summary: 'Summary',
        domainMode: 'it',
        actionItems: [],
        painPoints: [],
        risks: [],
        blockers: [],
        grouped_action_plan: {
          version: 'grouped-action-plan-v1',
          language: 'vi',
          intro: 'Intro',
          sections: [
            {
              id: 'section-1',
              order: 1,
              title: 'Thanh toán',
              items: [{ id: 'item-1', title: 'Đối soát MoMo', subtasks: ['Gửi log cho FPT'] }],
            },
          ],
        },
        generatedAt: '2026-06-11T00:00:00Z',
        note: 'No action items available in saved analysis',
        analysisMetadata: {
          analysisSource: 'saved',
          cacheOnly: false,
          stale: false,
          analysis_feature_set: 'grouped-action-plan-v1',
        },
      }),
      headers: new Headers(),
    })

    const plan = await getMeetingActionPlan(7)

    expect(plan.meeting.meetingId).toBe(7)
    expect(plan.note).toBe('No action items available in saved analysis')
    expect(plan.groupedActionPlan?.sections[0]?.title).toBe('Thanh toán')
    expect(plan.groupedActionPlan?.sections[0]?.items[0]?.subtasks[0]?.text).toBe('Gửi log cho FPT')
    expect(plan.analysisMetadata.analysisFeatureSet).toBe('grouped-action-plan-v1')
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/processing/7/action-plan')
  })

  it('downloads action plan DOCX and uses fallback filename without content-disposition', async () => {
    const blob = new Blob(['fake-action-plan'], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      blob: async () => blob,
      headers: new Headers(),
    })

    const result = await downloadMeetingActionPlanDocx(7)

    expect(result.blob).toBe(blob)
    expect(result.filename).toBe('meeting-7-action-plan.docx')
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/processing/7/action-plan/export?format=docx')
  })

  it('downloads transcript as readable and raw txt/csv blobs', async () => {
    const txtBlob = new Blob(['meeting transcript'], { type: 'text/plain' })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      blob: async () => txtBlob,
      headers: new Headers({
        'content-disposition': 'attachment; filename="meeting-7-transcript-readable.txt"',
      }),
    })

    const txtResult = await downloadMeetingTranscript(7, 'txt')
    expect(txtResult.blob).toBe(txtBlob)
    expect(txtResult.filename).toBe('meeting-7-transcript-readable.txt')

    const csvBlob = new Blob(['index,startTime,endTime,speaker,text'], { type: 'text/csv' })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      blob: async () => csvBlob,
      headers: new Headers(),
    })

    const csvResult = await downloadMeetingTranscript(7, 'csv')
    expect(csvResult.blob).toBe(csvBlob)
    expect(csvResult.filename).toBe('meeting-7-transcript-readable.csv')

    const rawTxtBlob = new Blob(['raw transcript'], { type: 'text/plain' })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      blob: async () => rawTxtBlob,
      headers: new Headers(),
    })

    const rawTxtResult = await downloadMeetingTranscript(7, 'txt', 'raw')
    expect(rawTxtResult.blob).toBe(rawTxtBlob)
    expect(rawTxtResult.filename).toBe('meeting-7-transcript-raw.txt')

    const rawCsvBlob = new Blob(['index,startTime,endTime,speaker,text'], { type: 'text/csv' })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      blob: async () => rawCsvBlob,
      headers: new Headers(),
    })

    const rawCsvResult = await downloadMeetingTranscript(7, 'csv', 'raw')
    expect(rawCsvResult.blob).toBe(rawCsvBlob)
    expect(rawCsvResult.filename).toBe('meeting-7-transcript-raw.csv')

    const urls = fetchMock.mock.calls.map((call) => call[0] as string)
    expect(urls.some((url) => url.includes('/processing/7/transcript/export?format=txt&mode=readable'))).toBe(true)
    expect(urls.some((url) => url.includes('/processing/7/transcript/export?format=csv&mode=readable'))).toBe(true)
    expect(urls.some((url) => url.includes('/processing/7/transcript/export?format=txt&mode=raw'))).toBe(true)
    expect(urls.some((url) => url.includes('/processing/7/transcript/export?format=csv&mode=raw'))).toBe(true)
  })
})

describe('user profile', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads current user profile with domain mode', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        userId: 42,
        username: 'tester',
        email: 'tester@example.com',
        domainMode: 'business',
      }),
      headers: new Headers(),
    })

    const profile = await getUserProfile()

    expect(profile.userId).toBe(42)
    expect(profile.username).toBe('tester')
    expect(profile.domainMode).toBe('business')
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('/api/users/me')
  })
})
