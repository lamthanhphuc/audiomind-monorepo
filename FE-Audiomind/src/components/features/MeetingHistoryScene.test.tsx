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
    vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue(baseAnalysis as any)
    vi.spyOn(api, 'downloadMeetingReport').mockResolvedValue({
      blob: new Blob(['fake-docx'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      filename: 'meeting-7-report.docx',
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
