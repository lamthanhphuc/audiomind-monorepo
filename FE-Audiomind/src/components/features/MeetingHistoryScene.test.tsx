import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../services/api'
import MeetingHistoryScene from './MeetingHistoryScene'

const baseMeeting = {
  id: 7,
  title: 'History item',
  audioPath: '/tmp/a.wav',
  createdAt: '2026-05-28T00:00:00Z',
  language: 'vi',
  status: 'processing',
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

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    vi.spyOn(api, 'listMeetingsWithParams').mockResolvedValue([baseMeeting])
    vi.spyOn(api, 'getMeetingDetail').mockResolvedValue(baseMeeting as any)
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
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('applies search/filter/sort params when querying meetings', async () => {
    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

    const searchInput = container.querySelector('[data-testid="meeting-search-input"]') as HTMLInputElement
    const statusFilter = container.querySelector('[data-testid="meeting-status-filter"]') as HTMLSelectElement
    const languageFilter = container.querySelector('[data-testid="meeting-language-filter"]') as HTMLSelectElement
    const sortSelect = container.querySelector('[data-testid="meeting-sort-select"]') as HTMLSelectElement

    await act(async () => {
      setNativeValue(searchInput, 'retro')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
      searchInput.dispatchEvent(new Event('change', { bubbles: true }))
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

    const calls = (api.listMeetingsWithParams as any).mock.calls
    const latestArgs = calls[calls.length - 1][0]
    expect(latestArgs).toMatchObject({
      query: 'retro',
      status: 'completed',
      language: 'en',
      sort: 'created_asc',
    })
  })

  it('renames a meeting and updates the displayed list title', async () => {
    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

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
    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

    const deleteButton = container.querySelector('[data-testid="meeting-delete-submit"]') as HTMLButtonElement
    await act(async () => {
      deleteButton.click()
    })
    await flush()

    expect(api.deleteMeeting).toHaveBeenCalledWith(7)
    expect(container.textContent).toContain('Không có meeting phù hợp bộ lọc hiện tại')
  })

  it('renders loading, empty, and error states', async () => {
    let resolveList: ((value: any) => void) | null = null
    vi.spyOn(api, 'listMeetingsWithParams').mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveList = resolve
      }),
    )

    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    expect(container.textContent).toContain('Đang tải danh sách meeting')

    await act(async () => {
      resolveList?.([])
    })
    await flush()
    expect(container.textContent).toContain('Không có meeting phù hợp bộ lọc hiện tại')

    ;(api.listMeetingsWithParams as any).mockRejectedValueOnce(new Error('boom'))
    const reloadButton = container.querySelector('button[aria-label="Reload list"]') as HTMLButtonElement
    await act(async () => {
      reloadButton.click()
    })
    await flush()
    expect(container.textContent).toContain('Không thể tải lịch sử')
  })

  it('loads meeting detail without calling provider-triggering getAnalysis', async () => {
    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

    expect(api.getSavedAnalysis).toHaveBeenCalledWith(7)
    expect(api.getAnalysis).not.toHaveBeenCalled()
  })

  it('keeps previous completed analysis visible and stops polling when re-analyze request fails', async () => {
    vi.useFakeTimers()
    const completedAnalysis = {
      ...baseAnalysis,
      status: 'COMPLETED',
      analysisStatus: 'COMPLETED',
      summary: 'Previous completed content',
      meetingSummary: 'Previous completed content',
    }
    ;(api.getSavedAnalysis as any).mockResolvedValueOnce(completedAnalysis)
    ;(api.reanalyzeMeetingAnalysis as any).mockRejectedValueOnce(
      new api.ApiError('Resource not found', 404),
    )

    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

    const initialSavedAnalysisCalls = (api.getSavedAnalysis as any).mock.calls.length
    const button = container.querySelector('[data-testid="analysis-reanalyze-button"]') as HTMLButtonElement
    await act(async () => {
      button.click()
    })
    await flush()

    expect(api.reanalyzeMeetingAnalysis).toHaveBeenCalledWith(7, { mode: 'force', reason: 'manual_reanalyze' })
    expect(container.querySelector('[data-testid="analysis-status-badge"]')?.textContent).toBe('COMPLETED')
    expect(container.textContent).toContain('Previous completed content')
    expect(container.textContent).toContain('Cannot re-analyze because saved transcript was not found.')
    expect(container.querySelector('[data-testid="analysis-status-badge"]')?.textContent).not.toBe('NO_ANALYSIS')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    await flush()

    expect((api.getSavedAnalysis as any).mock.calls.length).toBe(initialSavedAnalysisCalls)
  })

  it.each(['COMPLETED', 'FAILED', 'RATE_LIMITED'])('polling stops on %s after re-analyze', async (terminalStatus) => {
    vi.useFakeTimers()
    const completedAnalysis = {
      ...baseAnalysis,
      status: 'COMPLETED',
      analysisStatus: 'COMPLETED',
      summary: 'Previous completed content',
      meetingSummary: 'Previous completed content',
    }
    ;(api.getSavedAnalysis as any)
      .mockResolvedValueOnce(completedAnalysis)
      .mockResolvedValueOnce({
        ...baseAnalysis,
        status: terminalStatus,
        analysisStatus: terminalStatus,
        retryAfterSeconds: terminalStatus === 'RATE_LIMITED' ? 30 : undefined,
      })
    ;(api.reanalyzeMeetingAnalysis as any).mockResolvedValueOnce({
      ...baseAnalysis,
      status: 'ANALYZING',
      analysisStatus: 'ANALYZING',
    })

    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

    const button = container.querySelector('[data-testid="analysis-reanalyze-button"]') as HTMLButtonElement
    await act(async () => {
      button.click()
    })
    await flush()

    expect(api.reanalyzeMeetingAnalysis).toHaveBeenCalledWith(7, { mode: 'force', reason: 'manual_reanalyze' })
    expect(container.textContent).toContain('Previous completed content')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    await flush()

    expect(container.querySelector('[data-testid="analysis-status-badge"]')?.textContent).toBe(terminalStatus)
    const callCountAtTerminal = (api.getSavedAnalysis as any).mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    await flush()

    expect((api.getSavedAnalysis as any).mock.calls.length).toBe(callCountAtTerminal)
  })

  it('does not apply stale re-analyze polling updates after switching meetings', async () => {
    vi.useFakeTimers()
    const firstMeeting = { ...baseMeeting, id: 7, title: 'First meeting' }
    const secondMeeting = { ...baseMeeting, id: 8, title: 'Second meeting' }
    ;(api.listMeetingsWithParams as any).mockResolvedValue([firstMeeting, secondMeeting])
    ;(api.getMeetingDetail as any).mockImplementation(async (meetingId: number) => (
      meetingId === 8 ? secondMeeting : firstMeeting
    ))
    ;(api.getTranscript as any).mockResolvedValue({ meeting_id: 7, transcripts: [] })
    ;(api.getSavedAnalysis as any)
      .mockResolvedValueOnce({
        ...baseAnalysis,
        status: 'COMPLETED',
        analysisStatus: 'COMPLETED',
        summary: 'First saved content',
        meetingSummary: 'First saved content',
      })
      .mockResolvedValueOnce({
        ...baseAnalysis,
        meetingId: 8,
        meeting_id: 8,
        status: 'NOT_FOUND',
        analysisStatus: 'NO_ANALYSIS',
      })
      .mockResolvedValueOnce({
        ...baseAnalysis,
        meetingId: 7,
        meeting_id: 7,
        status: 'COMPLETED',
        analysisStatus: 'COMPLETED',
        summary: 'Stale first update',
        meetingSummary: 'Stale first update',
      })
    ;(api.reanalyzeMeetingAnalysis as any).mockResolvedValueOnce({
      ...baseAnalysis,
      status: 'ANALYZING',
      analysisStatus: 'ANALYZING',
    })

    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

    const button = container.querySelector('[data-testid="analysis-reanalyze-button"]') as HTMLButtonElement
    await act(async () => {
      button.click()
    })
    await flush()

    const secondMeetingButton = Array.from(container.querySelectorAll('[data-testid="meeting-list"] button'))
      .find((item) => item.textContent?.includes('Second meeting')) as HTMLButtonElement
    await act(async () => {
      secondMeetingButton.click()
    })
    await flush()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    await flush()

    expect(container.textContent).toContain('Second meeting')
    expect(container.textContent).not.toContain('Stale first update')
  })

  it('shows only completed meetings when completed filter is selected', async () => {
    const dataset = [
      { ...baseMeeting, id: 1, title: 'Processing one', status: 'processing' },
      { ...baseMeeting, id: 2, title: 'Completed one', status: 'completed' },
      { ...baseMeeting, id: 3, title: 'Unknown one', status: undefined as any },
    ]
    ;(api.listMeetingsWithParams as any).mockImplementation(async (params?: { status?: string }) => {
      if (params?.status === 'completed') {
        return dataset.filter((meeting) => meeting.status === 'completed')
      }
      if (params?.status === 'processing') {
        return dataset.filter((meeting) => meeting.status === 'processing')
      }
      return dataset
    })
    vi.spyOn(api, 'getMeetingDetail').mockResolvedValue(dataset[0] as any)

    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

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
    ;(api.listMeetingsWithParams as any).mockResolvedValue(unknownOnly)
    vi.spyOn(api, 'getMeetingDetail').mockResolvedValue(unknownOnly[0] as any)

    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

    expect(container.textContent).toContain('Legacy row')
    expect(container.textContent).toContain('unknown')
    expect(container.textContent).not.toContain('Legacy row•vi•processing')
  })

  it('renders export report button in detail actions', async () => {
    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

    const exportButton = container.querySelector('[data-testid="meeting-export-report"]') as HTMLButtonElement
    expect(exportButton).toBeTruthy()
  })

  it('renders transcript export menu and downloads readable or raw TXT/CSV', async () => {
    (api.getTranscript as any).mockResolvedValueOnce({
      meeting_id: 7,
      transcripts: [{ speaker: 'SPEAKER_1', start_time: 0, end_time: 1, text: 'row 1' }],
    })
    const startProcessingSpy = vi.spyOn(api, 'startProcessingByPath')

    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()
    expect(container.textContent).toContain('Readable is best-effort; Raw is for audit/debug.')

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

    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

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

    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

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

    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

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

    await act(async () => {
      root.render(<MeetingHistoryScene />)
    })
    await flush()

    const exportButton = container.querySelector('[data-testid="meeting-export-report"]') as HTMLButtonElement
    await act(async () => {
      exportButton.click()
    })
    await flush()

    expect(container.textContent).toContain('Xuất report thất bại')
    expect(container.textContent).toContain('cannot-export')
  })
})
