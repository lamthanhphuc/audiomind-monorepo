import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../services/api'
import App from './App'

const baseMeeting = {
  id: 7,
  title: 'History item',
  audioPath: '/tmp/a.wav',
  createdAt: '2026-05-28T00:00:00Z',
  language: 'vi',
  status: 'completed',
}

const mockMeetingListPage = (items: typeof baseMeeting[]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 10,
  totalPages: items.length > 0 ? 1 : 0,
})

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('App history analysis navigation', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    localStorage.setItem('audiomind.access_token', 'dummy-token')

    vi.spyOn(api, 'listMeetingsWithParams').mockResolvedValue([baseMeeting])
    vi.spyOn(api, 'listMeetingsPage').mockResolvedValue(mockMeetingListPage([baseMeeting]))
    vi.spyOn(api, 'getMeetingDetail').mockResolvedValue(baseMeeting)
    vi.spyOn(api, 'listMeetingResultScopes').mockResolvedValue([{ scopeKind: 'legacy' }])
    vi.spyOn(api, 'resolveMeetingResultScope').mockImplementation(async (meetingId) => ({
      scopeKind: 'legacy',
      meetingId,
      recordingSessionId: null,
      attemptId: null,
    }))
    vi.spyOn(api, 'getTranscript').mockResolvedValue({
      meeting_id: 7,
      transcripts: [{ speaker: 'Speaker 1', start_time: 0, end_time: 1, text: 'History transcript line' }],
    } as any)
    vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue({
      summary: 'History analysis summary',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
      status: 'COMPLETED',
      analysisStatus: 'COMPLETED',
    } as any)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('shows recent meetings in sidebar and opens analysis when clicked', async () => {
    await act(async () => {
      root.render(<App />)
    })
    await flush()

    expect(container.textContent).not.toContain('Chưa có file gần đây')
    const recentItem = Array.from(container.querySelectorAll('[data-testid="dashboard-recent-item"]'))
      .find((item) => item.textContent?.includes('History item')) as HTMLLIElement | undefined
    expect(recentItem).toBeTruthy()

    await act(async () => {
      recentItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(container.textContent).toContain('History transcript line')
    expect(container.querySelector('[data-testid="e2e-transcript"]')).toBeTruthy()
  })

  it('returns to History after opening analysis from History and clicking back', async () => {
    await act(async () => {
      root.render(<App />)
    })
    await flush()

    const historyMenu = container.querySelector('[data-testid="dashboard-nav-history"]') as HTMLButtonElement | null
    expect(historyMenu).toBeTruthy()

    await act(async () => {
      historyMenu?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    await flush()

    expect(container.textContent).toContain('Lịch sử cuộc họp')

    const meetingButton = container.querySelector('[data-testid="meeting-list"] button') as HTMLButtonElement | null
    expect(meetingButton).toBeTruthy()

    await act(async () => {
      meetingButton?.click()
    })
    await flush()

    const openAnalysisButton = container.querySelector('[data-testid="meeting-open-analysis"]') as HTMLButtonElement
    expect(openAnalysisButton).toBeTruthy()

    await act(async () => {
      openAnalysisButton.click()
    })
    await flush()

    expect(container.textContent).toContain('History transcript line')
    expect(container.querySelector('[data-testid="e2e-transcript"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="feature-analysis-back"]')).toBeTruthy()

    const backButton = container.querySelector('[data-testid="feature-analysis-back"]') as HTMLButtonElement
    await act(async () => {
      backButton.click()
    })
    await flush()

    expect(container.textContent).toContain('Lịch sử cuộc họp')
    expect(container.querySelector('[data-testid="feature-analysis-back"]')).toBeNull()
    expect(container.querySelector('[data-testid="meeting-list"]')).toBeTruthy()
  })
})

