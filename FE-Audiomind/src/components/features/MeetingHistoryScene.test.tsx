import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../services/api'
import * as meetingShare from '../../services/meetingShare'
import MeetingHistoryScene from './MeetingHistoryScene'

const HISTORY_LAST_SELECTED_KEY = 'audiomind.history.lastSelectedMeetingId'

const baseMeeting = {
  id: 7,
  title: 'History item',
  audioPath: '/tmp/a.wav',
  createdAt: '2026-05-28T00:00:00Z',
  language: 'vi',
  status: 'processing',
}

const mockMeetingListPage = (
  items: typeof baseMeeting[],
  options?: { total?: number; page?: number; pageSize?: number },
) => {
  const total = options?.total ?? items.length
  const pageSize = options?.pageSize ?? 10
  return {
    items,
    total,
    page: options?.page ?? 1,
    pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  }
}

const baseAnalysis = {
  status: 'NOT_FOUND',
  summary: '',
  keywords: [],
  technicalTerms: [],
  painPoints: [],
  actionItems: [],
  domainMode: 'it' as const,
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const setNativeValue = (element: HTMLInputElement | HTMLSelectElement, value: string) => {
  const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set
  const prototype = Object.getPrototypeOf(element)
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
    prototypeValueSetter.call(element, value)
    return
  }
  valueSetter?.call(element, value)
}

describe('MeetingHistoryScene', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const mountHistoryScene = async (options?: { focusMeetingId?: number | null }) => {
    await act(async () => {
      root.render(<MeetingHistoryScene focusMeetingId={options?.focusMeetingId ?? null} />)
    })
    await flush()
  }

  const mountWithStoredSelection = async (meetingId = 7) => {
    sessionStorage.setItem(HISTORY_LAST_SELECTED_KEY, String(meetingId))
    await mountHistoryScene()
  }

  const selectMeetingById = async (meetingId: number) => {
    const button = Array.from(container.querySelectorAll('[data-testid="meeting-list"] button'))
      .find((item) => item.textContent?.includes(`#${meetingId}`)) as HTMLButtonElement | undefined
    if (!button) {
      throw new Error(`Meeting ${meetingId} not found in list`)
    }
    await act(async () => {
      button.click()
    })
    await flush()
  }

  const openDetailTab = async (label: string) => {
    const button = Array.from(container.querySelectorAll('button'))
      .find((item) => item.textContent?.trim() === label) as HTMLButtonElement | undefined
    if (!button) {
      throw new Error(`Detail tab ${label} not found`)
    }
    await act(async () => {
      button.click()
    })
    await flush()
  }

  const openExportsTab = async () => {
    await openDetailTab('Xuất file')
    const moreButton = container.querySelector('[data-testid="meeting-export-more"]') as HTMLButtonElement | null
    if (moreButton && moreButton.getAttribute('aria-expanded') !== 'true') {
      await act(async () => {
        moreButton.click()
      })
      await flush()
    }
  }
  const openTranscriptTab = async () => openDetailTab('Tìm trong transcript')

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    sessionStorage.clear()

    vi.spyOn(api, 'listMeetingsPage').mockResolvedValue(mockMeetingListPage([baseMeeting]))
    vi.spyOn(api, 'getMeetingDetail').mockResolvedValue(baseMeeting)
    vi.spyOn(api, 'listMeetingResultScopes').mockResolvedValue([{ scopeKind: 'legacy' }])
    vi.spyOn(api, 'resolveMeetingResultScope').mockImplementation(async (meetingId) => ({
      scopeKind: 'legacy',
      meetingId,
      recordingSessionId: null,
      attemptId: null,
    }))
    vi.spyOn(meetingShare, 'listMeetingShares').mockResolvedValue([])
    vi.spyOn(api, 'getTranscript').mockResolvedValue({ meeting_id: 7, transcripts: [] } as any)
    vi.spyOn(api, 'getAnalysis').mockResolvedValue(baseAnalysis as any)
    vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue(baseAnalysis as any)
    vi.spyOn(api, 'reanalyzeMeetingAnalysis').mockResolvedValue({ ...baseAnalysis, status: 'ANALYZING', analysisStatus: 'ANALYZING' } as any)
    vi.spyOn(api, 'downloadMeetingReport').mockResolvedValue({
      blob: new Blob(['fake-docx'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      filename: 'meeting-7-report.docx',
    } as any)
    vi.spyOn(api, 'downloadMeetingTranscript').mockResolvedValue({
      blob: new Blob(['meeting transcript'], { type: 'text/plain' }),
      filename: 'meeting-7-transcript.txt',
    } as any)
    vi.spyOn(api, 'searchMeetingTranscriptEvidence').mockResolvedValue({
      meetingId: 7,
      query: 'deadline',
      normalizedQuery: 'deadline',
      transcriptMode: 'raw',
      matches: [],
    } as any)
    vi.spyOn(api, 'getMeetingActionPlan').mockResolvedValue({
      meeting: { meetingId: 7, title: 'History item' },
      summary: 'Action summary',
      domainMode: 'it',
      actionItems: [{ task: 'Scale workers', status: 'open', evidenceKeywords: [] }],
      painPoints: [],
      risks: [],
      blockers: [],
      generatedAt: '2026-06-11T00:00:00Z',
      note: null,
      analysisMetadata: { analysisSource: 'saved', cacheOnly: false, stale: false },
    } as any)
    vi.spyOn(api, 'downloadMeetingActionPlan').mockResolvedValue({
      blob: new Blob(['action-plan'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      filename: 'meeting-7-action-plan.docx',
    } as any)
    vi.spyOn(api, 'renameMeeting').mockResolvedValue({ ...baseMeeting, title: 'Renamed item' } as any)
    vi.spyOn(api, 'deleteMeeting').mockResolvedValue({ id: 7, deleted: true })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:mock-report'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('cold open loads only meeting list without auto-selecting detail', async () => {
    await mountHistoryScene()

    expect(api.listMeetingsPage).toHaveBeenCalledTimes(1)
    expect(api.getTranscript).not.toHaveBeenCalled()
    expect(api.getSavedAnalysis).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Chọn một meeting để xem transcript và analysis đã lưu')
  })

  it('restores stored selection after list load and loads detail from list summary only', async () => {
    await mountWithStoredSelection(7)

    expect(api.listMeetingsPage).toHaveBeenCalledTimes(1)
    expect(api.getTranscript).toHaveBeenCalledWith(7, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(api.getSavedAnalysis).toHaveBeenCalledWith(7, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(container.textContent).toContain('History item')
  })

  it('copies existing-user invite link with openMeeting on root path', async () => {
    await mountWithStoredSelection(7)

    const shareButton = container.querySelector('[data-testid="meeting-share-link"]') as HTMLButtonElement
    expect(shareButton).toBeTruthy()

    await act(async () => {
      shareButton.click()
    })
    await flush()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringMatching(/\?openMeeting=7$/),
    )
    const copied = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string
    expect(copied).toMatch(/\/\?openMeeting=7$/)
  })

  it('loads detail on row click without getMeetingDetail and uses cache on second click', async () => {
    const secondMeeting = { ...baseMeeting, id: 8, title: 'Second item' }
    ;(api.listMeetingsPage as any).mockResolvedValue(mockMeetingListPage([baseMeeting, secondMeeting], { total: 2 }))

    await mountHistoryScene()
    expect(api.getTranscript).not.toHaveBeenCalled()

    await selectMeetingById(7)
    expect(api.getTranscript).toHaveBeenCalledTimes(1)
    expect(api.getSavedAnalysis).toHaveBeenCalledTimes(1)

    await selectMeetingById(8)
    expect(api.getTranscript).toHaveBeenCalledTimes(2)
    expect(api.getSavedAnalysis).toHaveBeenCalledTimes(2)

    await selectMeetingById(7)
    expect(api.getTranscript).toHaveBeenCalledTimes(2)
    expect(api.getSavedAnalysis).toHaveBeenCalledTimes(2)
  })

  it('debounces search input before reloading meetings', async () => {
    vi.useFakeTimers()
    await mountHistoryScene()
    const initialCalls = (api.listMeetingsPage as any).mock.calls.length

    const searchInput = container.querySelector('[data-testid="meeting-search-input"]') as HTMLInputElement
    for (const char of 'abcdefghij') {
      await act(async () => {
        setNativeValue(searchInput, `${searchInput.value}${char}`)
        searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299)
    })
    expect((api.listMeetingsPage as any).mock.calls.length).toBe(initialCalls)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    await flush()

    expect((api.listMeetingsPage as any).mock.calls.length - initialCalls).toBeLessThanOrEqual(2)
  })

  it('restores focusMeetingId after list load when provided as prop', async () => {
    await mountHistoryScene({ focusMeetingId: 7 })

    expect(api.getTranscript).toHaveBeenCalledWith(7, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(api.getSavedAnalysis).toHaveBeenCalledWith(7, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('applies search/filter/sort params when querying meetings', async () => {
    vi.useFakeTimers()
    await mountHistoryScene()

    const searchInput = container.querySelector('[data-testid="meeting-search-input"]') as HTMLInputElement
    const statusFilter = container.querySelector('[data-testid="meeting-status-filter"]') as HTMLSelectElement
    const languageFilter = container.querySelector('[data-testid="meeting-language-filter"]') as HTMLSelectElement
    const sortSelect = container.querySelector('[data-testid="meeting-sort-select"]') as HTMLSelectElement

    await act(async () => {
      setNativeValue(searchInput, 'retro')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      searchInput.dispatchEvent(new Event('change', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(300)
    })
    await flush()

    await act(async () => {
      setNativeValue(statusFilter, 'completed')
      statusFilter.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    await act(async () => {
      setNativeValue(languageFilter, 'en')
      languageFilter.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    await act(async () => {
      setNativeValue(sortSelect, 'created_asc')
      sortSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    const calls = (api.listMeetingsPage as any).mock.calls
    const latestArgs = calls[calls.length - 1][0]
    expect(latestArgs).toMatchObject({
      query: 'retro',
      status: 'completed',
      language: 'en',
      sort: 'created_asc',
    })
  })

  it('renames a meeting and updates the displayed list title', async () => {
    await mountWithStoredSelection()

    const renameInput = container.querySelector('[data-testid="meeting-rename-input"]') as HTMLInputElement
    const renameSubmit = container.querySelector('[data-testid="meeting-rename-submit"]') as HTMLButtonElement

    await act(async () => {
      setNativeValue(renameInput, 'Renamed item')
      renameInput.dispatchEvent(new Event('input', { bubbles: true }))
      renameInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    await act(async () => {
      renameSubmit.click()
    })
    await flush()

    expect(api.renameMeeting).toHaveBeenCalledWith(7, 'Renamed item')
    expect(container.textContent).toContain('Renamed item')
  })

  it('soft deletes selected meeting and hides it from list', async () => {
    ;(api.listMeetingsPage as any)
      .mockResolvedValueOnce(mockMeetingListPage([baseMeeting]))
      .mockResolvedValue(mockMeetingListPage([]))
    await mountWithStoredSelection()

    const deleteButton = container.querySelector('[data-testid="meeting-delete-submit"]') as HTMLButtonElement
    await act(async () => {
      deleteButton.click()
    })
    await flush()

    expect(api.deleteMeeting).toHaveBeenCalledWith(7)
    expect(container.textContent).toContain('Chưa có meeting phù hợp')
  })

  it('renders loading, empty, and error states', async () => {
    let resolveList: ((value: any) => void) | null = null
    vi.spyOn(api, 'listMeetingsPage').mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveList = resolve
      }),
    )

    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    expect(container.textContent).toContain('Đang tải danh sách meeting')

    await act(async () => {
      resolveList?.(mockMeetingListPage([]))
    })
    await flush()
    expect(container.textContent).toContain('Chưa có meeting phù hợp')

    ;(api.listMeetingsPage as any).mockRejectedValueOnce(new Error('boom'))
    const reloadButton = container.querySelector('button[aria-label="Tải lại danh sách"]') as HTMLButtonElement
    await act(async () => {
      reloadButton.click()
    })
    await flush()
    expect(container.textContent).toContain('Không thể tải lịch sử')
  })

  it('loads meeting detail without calling provider-triggering getAnalysis', async () => {
    const getMeetingDetailSpy = vi.spyOn(api, 'getMeetingDetail')
    await mountWithStoredSelection()

    expect(api.getSavedAnalysis).toHaveBeenCalledWith(7, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(api.getAnalysis).not.toHaveBeenCalled()
    expect(getMeetingDetailSpy).not.toHaveBeenCalled()
  })

  it('shows only completed meetings when completed filter is selected', async () => {
    const dataset = [
      { ...baseMeeting, id: 1, title: 'Processing one', status: 'processing' },
      { ...baseMeeting, id: 2, title: 'Completed one', status: 'completed' },
      { ...baseMeeting, id: 3, title: 'Unknown one', status: undefined as any },
    ]
    ;(api.listMeetingsPage as any).mockImplementation(async (params?: { status?: string }) => {
      if (params?.status === 'completed') {
        const items = dataset.filter((meeting) => meeting.status === 'completed')
        return mockMeetingListPage(items, { total: items.length })
      }
      if (params?.status === 'processing') {
        const items = dataset.filter((meeting) => meeting.status === 'processing')
        return mockMeetingListPage(items, { total: items.length })
      }
      return mockMeetingListPage(dataset, { total: dataset.length })
    })

    await mountHistoryScene()

    const statusFilter = container.querySelector('[data-testid="meeting-status-filter"]') as HTMLSelectElement
    await act(async () => {
      setNativeValue(statusFilter, 'completed')
      statusFilter.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    expect(container.textContent).toContain('Completed one')
    expect(container.textContent).not.toContain('Processing one')
    expect(container.textContent).not.toContain('Unknown one')
  })

  it('does not treat unknown or missing status as processing in history list', async () => {
    const unknownOnly = [{ ...baseMeeting, id: 8, title: 'Legacy row', status: undefined as any }]
    ;(api.listMeetingsPage as any).mockResolvedValue(mockMeetingListPage(unknownOnly))

    await mountHistoryScene()
    await selectMeetingById(8)

    expect(container.textContent).toContain('Legacy row')
    expect(container.textContent).toContain('Không rõ')
    expect(container.textContent).not.toContain('Legacy row•vi•processing')
  })

  it('renders export report button in detail actions', async () => {
    await mountWithStoredSelection()
    await openExportsTab()

    const exportButton = container.querySelector('[data-testid="meeting-export-report-pdf"]') as HTMLButtonElement
    expect(exportButton).toBeTruthy()
  })

  it('renders transcript export menu and downloads readable or raw TXT/CSV', async () => {
    (api.getTranscript as any).mockResolvedValueOnce({
      meeting_id: 7,
      transcripts: [{ speaker: 'SPEAKER_1', start_time: 0, end_time: 1, text: 'row 1' }],
    })
    const startProcessingSpy = vi.spyOn(api, 'startProcessingByPath')

    await mountWithStoredSelection()
    await openExportsTab()
    expect(container.textContent).toContain('Bản dễ đọc phù hợp để chia sẻ; bản dữ liệu gốc dùng cho kiểm tra và audit.')

    const exportButton = container.querySelector('[data-testid="meeting-export-transcript"]') as HTMLButtonElement
    await act(async () => {
      exportButton.click()
    })
    await flush()

    const menu = container.querySelector('[data-testid="meeting-export-transcript-menu"]')
    expect(menu).toBeTruthy()

    const readableTxtButton = container.querySelector('[data-testid="meeting-export-transcript-readable-txt"]') as HTMLButtonElement
    await act(async () => {
      readableTxtButton.click()
    })
    await flush()

    expect(api.downloadMeetingTranscript).toHaveBeenCalledWith(7, 'txt', 'readable')

    await act(async () => {
      exportButton.click()
    })
    await flush()

    const readableCsvButton = container.querySelector('[data-testid="meeting-export-transcript-readable-csv"]') as HTMLButtonElement
    await act(async () => {
      readableCsvButton.click()
    })
    await flush()

    expect(api.downloadMeetingTranscript).toHaveBeenCalledWith(7, 'csv', 'readable')

    await act(async () => {
      exportButton.click()
    })
    await flush()

    const rawTxtButton = container.querySelector('[data-testid="meeting-export-transcript-raw-txt"]') as HTMLButtonElement
    await act(async () => {
      rawTxtButton.click()
    })
    await flush()

    expect(api.downloadMeetingTranscript).toHaveBeenCalledWith(7, 'txt', 'raw')

    await act(async () => {
      exportButton.click()
    })
    await flush()

    const rawCsvButton = container.querySelector('[data-testid="meeting-export-transcript-raw-csv"]') as HTMLButtonElement
    await act(async () => {
      rawCsvButton.click()
    })
    await flush()

    expect(api.downloadMeetingTranscript).toHaveBeenCalledWith(7, 'csv', 'raw')
    expect(startProcessingSpy).not.toHaveBeenCalled()
  })

  it('shows transcript export error state when the download fails', async () => {
    (api.getTranscript as any).mockResolvedValueOnce({
      meeting_id: 7,
      transcripts: [{ speaker: 'SPEAKER_1', start_time: 0, end_time: 1, text: 'row 1' }],
    })
    ;(api.downloadMeetingTranscript as any).mockRejectedValueOnce(new Error('cannot-export'))

    await mountWithStoredSelection()
    await openExportsTab()

    const exportButton = container.querySelector('[data-testid="meeting-export-transcript"]') as HTMLButtonElement
    await act(async () => {
      exportButton.click()
    })
    await flush()

    const txtButton = container.querySelector('[data-testid="meeting-export-transcript-readable-txt"]') as HTMLButtonElement
    await act(async () => {
      txtButton.click()
    })
    await flush()

    expect(container.textContent).toContain('Xuất transcript thất bại')
    expect(container.textContent).toContain('cannot-export')
  })

  it('clicking export calls meeting report download helper', async () => {
    ;(api.getTranscript as any).mockResolvedValueOnce({
      meeting_id: 7,
      transcripts: [{ speaker: 'SPEAKER_1', start_time: 0, end_time: 1, text: 'row 1' }],
    })

    await mountWithStoredSelection()
    await openExportsTab()

    const exportButton = container.querySelector('[data-testid="meeting-export-report"]') as HTMLButtonElement
    await act(async () => {
      exportButton.click()
    })
    await flush()

    expect(api.downloadMeetingReport).toHaveBeenCalledWith(7, 'docx')
  })

  it('shows loading state while exporting report', async () => {
    ;(api.getTranscript as any).mockResolvedValueOnce({
      meeting_id: 7,
      transcripts: [{ speaker: 'SPEAKER_1', start_time: 0, end_time: 1, text: 'row 1' }],
    })

    let resolveExport: ((value: any) => void) | null = null
    ;(api.downloadMeetingReport as any).mockImplementationOnce(() => new Promise((resolve) => {
      resolveExport = resolve
    }))

    await mountWithStoredSelection()
    await openExportsTab()

    const exportButton = container.querySelector('[data-testid="meeting-export-report"]') as HTMLButtonElement
    await act(async () => {
      exportButton.click()
    })

    expect(container.textContent).toContain('Đang xuất...')

    await act(async () => {
      resolveExport?.({
        blob: new Blob(['done']),
        filename: 'meeting-7-report.docx',
      })
    })
    await flush()
  })

  it('shows error state when export fails', async () => {
    ;(api.getTranscript as any).mockResolvedValueOnce({
      meeting_id: 7,
      transcripts: [{ speaker: 'SPEAKER_1', start_time: 0, end_time: 1, text: 'row 1' }],
    })
    ;(api.downloadMeetingReport as any).mockRejectedValueOnce(new Error('cannot-export'))

    await mountWithStoredSelection()
    await openExportsTab()

    const exportButton = container.querySelector('[data-testid="meeting-export-report"]') as HTMLButtonElement
    await act(async () => {
      exportButton.click()
    })
    await flush()

    expect(container.textContent).toContain('Xuất report thất bại')
    expect(container.textContent).toContain('cannot-export')
  })

  it('does not call transcript evidence search for one-character query', async () => {
    ;(api.getTranscript as any).mockResolvedValueOnce({
      meeting_id: 7,
      transcripts: [{ speaker: 'SPEAKER_1', start_time: 0, end_time: 1, text: 'row 1' }],
    })

    await mountWithStoredSelection()
    await openTranscriptTab()

    const input = container.querySelector('[data-testid="transcript-evidence-search-input"]') as HTMLInputElement
    const submit = container.querySelector('[data-testid="transcript-evidence-search-submit"]') as HTMLButtonElement
    await act(async () => {
      setNativeValue(input, 'a')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    await act(async () => {
      submit.click()
    })
    await flush()

    expect(api.searchMeetingTranscriptEvidence).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Nhập ít nhất 2 ký tự')
  })

  it('renders transcript evidence search results with context without clearing detail', async () => {
    ;(api.getTranscript as any).mockResolvedValueOnce({
      meeting_id: 7,
      transcripts: [{ speaker: 'SPEAKER_1', start_time: 0, end_time: 1, text: 'deadline row' }],
    })
    ;(api.searchMeetingTranscriptEvidence as any).mockResolvedValueOnce({
      meetingId: 7,
      query: 'deadline',
      normalizedQuery: 'deadline',
      transcriptMode: 'raw',
      matches: [{
        evidenceId: 'evidence-1',
        segmentId: 'segment-1',
        index: 0,
        speaker: 'Speaker 1',
        startTime: 2,
        endTime: 5,
        text: 'The API deadline is Friday.',
        textTruncated: false,
        contextBefore: [{ segmentId: 'segment-0', index: 0, speaker: 'Speaker 2', startTime: 0, endTime: 2, text: 'Planning context', textTruncated: false }],
        contextAfter: [{ segmentId: 'segment-2', index: 2, speaker: 'Speaker 3', startTime: 5, endTime: 8, text: 'Follow-up context', textTruncated: true }],
        score: 10,
        rank: 1,
        matchType: 'phrase',
      }],
    })

    await mountWithStoredSelection()
    await openTranscriptTab()

    const input = container.querySelector('[data-testid="transcript-evidence-search-input"]') as HTMLInputElement
    const submit = container.querySelector('[data-testid="transcript-evidence-search-submit"]') as HTMLButtonElement
    await act(async () => {
      setNativeValue(input, 'deadline')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    await act(async () => {
      submit.click()
    })
    await flush()

    expect(api.searchMeetingTranscriptEvidence).toHaveBeenCalledWith(7, 'deadline', { limit: 10, context: 1 })
    expect(container.textContent).toContain('The API deadline is Friday.')
    expect(container.textContent).toContain('Planning context')
    expect(container.textContent).toContain('Follow-up context')
    expect(container.textContent).toContain('đã rút gọn')
    expect(container.textContent).toContain('History item')
  })

  it('search error does not clear loaded transcript detail', async () => {
    ;(api.getTranscript as any).mockResolvedValueOnce({
      meeting_id: 7,
      transcripts: [{ speaker: 'SPEAKER_1', start_time: 0, end_time: 1, text: 'loaded transcript row' }],
    })
    ;(api.searchMeetingTranscriptEvidence as any).mockRejectedValueOnce(new Error('search failed'))

    await mountWithStoredSelection()
    await openTranscriptTab()

    const input = container.querySelector('[data-testid="transcript-evidence-search-input"]') as HTMLInputElement
    const submit = container.querySelector('[data-testid="transcript-evidence-search-submit"]') as HTMLButtonElement
    await act(async () => {
      setNativeValue(input, 'deadline')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    await act(async () => {
      submit.click()
    })
    await flush()

    expect(container.textContent).toContain('search failed')
    expect(container.textContent).toContain('loaded transcript row')
  })

  it('exports action plan after loading preview without triggering analysis', async () => {
    await mountWithStoredSelection()
    await openExportsTab()

    const button = container.querySelector('[data-testid="meeting-export-action-plan"]') as HTMLButtonElement
    await act(async () => {
      button.click()
    })
    await flush()

    expect(api.getMeetingActionPlan).toHaveBeenCalledWith(7)
    expect(api.downloadMeetingActionPlan).toHaveBeenCalledWith(7, 'docx')
    expect(api.reanalyzeMeetingAnalysis).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Action summary')
    expect(container.textContent).toContain('Công việc chung')
    expect(container.textContent).toContain('Scale workers')

    const copyButton = container.querySelector('[data-testid="meeting-action-plan-copy"]') as HTMLButtonElement
    await act(async () => {
      copyButton.click()
    })
    await flush()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('### 1. Công việc chung'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('* **Scale workers:**'))
  })

  it('renders grouped action plan sections and copies markdown without verified evidence claims', async () => {
    ;(api.getMeetingActionPlan as any).mockResolvedValueOnce({
      meeting: { meetingId: 7, title: 'History item' },
      summary: 'Grouped summary',
      domainMode: 'it',
      actionItems: [{ task: 'Fallback task', status: 'open', evidenceKeywords: [] }],
      painPoints: [],
      risks: [],
      blockers: [],
      groupedActionPlan: {
        version: 'grouped-action-plan-v1',
        language: 'vi',
        intro: 'Dựa trên nội dung cuộc thảo luận trong file audio, dưới đây là danh sách các công việc cần thực hiện, được phân chia theo các nhóm chức năng chính:',
        sections: [
          {
            id: 'section-payment',
            order: 1,
            title: 'Thanh toán',
            summary: 'Các việc liên quan đến đối soát.',
            items: [
              {
                id: 'item-momo',
                title: 'Đối soát MoMo',
                description: 'Kiểm tra giao dịch treo với FPT Pay.',
                confidence: 'INFERRED',
                evidenceKeywords: ['MoMo', 'FPT Pay'],
                subtasks: [{ text: 'Gửi log lỗi cho FPT Pay.', confidence: 'NEEDS_REVIEW' }],
              },
            ],
          },
        ],
        notes: [],
      },
      generatedAt: '2026-06-11T00:00:00Z',
      note: null,
      analysisMetadata: { analysisSource: 'saved', cacheOnly: false, stale: false, analysisFeatureSet: 'grouped-action-plan-v1' },
    })

    await mountWithStoredSelection()
    await openExportsTab()

    const button = container.querySelector('[data-testid="meeting-export-action-plan"]') as HTMLButtonElement
    await act(async () => {
      button.click()
    })
    await flush()

    expect(container.textContent).toContain('Công việc cần làm theo nhóm chức năng')
    expect(container.textContent).toContain('Thanh toán')
    expect(container.textContent).toContain('Đối soát MoMo')
    expect(container.textContent).toContain('Gửi log lỗi cho FPT Pay.')

    const copyButton = container.querySelector('[data-testid="meeting-action-plan-copy"]') as HTMLButtonElement
    await act(async () => {
      copyButton.click()
    })
    await flush()

    const copied = (navigator.clipboard.writeText as any).mock.calls.at(-1)?.[0] as string
    expect(copied).toContain('### 1. Thanh toán')
    expect(copied).toContain('* **Đối soát MoMo:** Kiểm tra giao dịch treo với FPT Pay. (Suy luận)')
    expect(copied).toContain('  * Gửi log lỗi cho FPT Pay. (Cần xác minh)')
    expect(copied).not.toContain('MoMo, FPT Pay')
  })

  it('shows analysis-required message for action plan export without triggering re-analysis', async () => {
    ;(api.getMeetingActionPlan as any).mockRejectedValueOnce(new api.ApiError('ANALYSIS_REQUIRED', 409))

    await mountWithStoredSelection()
    await openExportsTab()

    const button = container.querySelector('[data-testid="meeting-export-action-plan"]') as HTMLButtonElement
    await act(async () => {
      button.click()
    })
    await flush()

    expect(container.textContent).toContain('Cần có phân tích cuộc họp trước khi xuất action plan.')
    expect(api.downloadMeetingActionPlan).not.toHaveBeenCalled()
    expect(api.reanalyzeMeetingAnalysis).not.toHaveBeenCalled()
  })

  it('dedupes persisted partial/final rows to a single final transcript line', async () => {
    ;(api.getTranscript as any).mockResolvedValueOnce({
      meeting_id: 7,
      transcripts: [
        { speaker: 'SPEAKER_1', start_time: 19.45, end_time: 24.42, text: 'partial row', is_final: false },
        { speaker: 'SPEAKER_1', start_time: 19.45, end_time: 22.47, text: 'final row', is_final: true },
      ],
    })

    await mountWithStoredSelection()
    await openTranscriptTab()

    expect(container.textContent).toContain('final row')
    expect(container.textContent?.match(/partial row/g)?.length ?? 0).toBe(0)
  })

  it('does not show open-analysis CTA on cold open without selection', async () => {
    const onOpenAnalysis = vi.fn()
    await act(async () => {
      root.render(<MeetingHistoryScene onOpenAnalysis={onOpenAnalysis} />)
    })
    await flush()

    expect(container.querySelector('[data-testid="meeting-open-analysis"]')).toBeNull()
    expect(container.querySelector('[data-testid="meeting-open-mindmap"]')).toBeNull()
    expect(onOpenAnalysis).not.toHaveBeenCalled()
  })

  it('does not render topic graph in meeting detail', async () => {
    await mountWithStoredSelection()
    expect(container.querySelector('[data-testid="topic-graph"]')).toBeNull()
  })

  it('does not render inline saved analysis panel in meeting detail', async () => {
    await mountWithStoredSelection()
    expect(container.querySelector('[data-testid="e2e-saved-analysis"]')).toBeNull()
    expect(container.textContent).not.toContain('Phân tích đã lưu')
  })

  it('shows open-analysis CTA when a meeting is selected and calls callback with meetingId', async () => {
    const onOpenAnalysis = vi.fn()
    await act(async () => {
      root.render(<MeetingHistoryScene onOpenAnalysis={onOpenAnalysis} />)
    })
    await flush()

    await selectMeetingById(7)

    const openButton = container.querySelector('[data-testid="meeting-open-analysis"]') as HTMLButtonElement
    expect(openButton).toBeTruthy()
    expect(openButton.textContent).toContain('Xem kết quả')

    await act(async () => {
      openButton.click()
    })
    await flush()

    expect(onOpenAnalysis).toHaveBeenCalledTimes(1)
    expect(onOpenAnalysis).toHaveBeenCalledWith(7, {
      title: 'History item',
      scope: {
        scopeKind: 'legacy',
        meetingId: 7,
        recordingSessionId: null,
        attemptId: null,
        finalized: true,
        updatedAt: null,
      },
    })
  })

  it('shows open-mindmap CTA when a meeting is selected and calls callback with meetingId', async () => {
    const onOpenMindmap = vi.fn()
    await act(async () => {
      root.render(<MeetingHistoryScene onOpenMindmap={onOpenMindmap} />)
    })
    await flush()

    await selectMeetingById(7)

    const openButton = container.querySelector('[data-testid="meeting-open-mindmap"]') as HTMLButtonElement
    expect(openButton).toBeTruthy()
    expect(openButton.textContent).toContain('mindmap')

    await act(async () => {
      openButton.click()
    })
    await flush()

    expect(onOpenMindmap).toHaveBeenCalledTimes(1)
    expect(onOpenMindmap).toHaveBeenCalledWith(7, {
      title: 'History item',
      scope: {
        scopeKind: 'legacy',
        meetingId: 7,
        recordingSessionId: null,
        attemptId: null,
        finalized: true,
        updatedAt: null,
      },
    })
  })
})

