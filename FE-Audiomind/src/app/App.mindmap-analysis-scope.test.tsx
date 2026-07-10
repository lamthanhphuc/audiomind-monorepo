import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../services/api'
import App from './App'

const meeting7 = {
  id: 7,
  title: 'Meeting seven',
  audioPath: '/tmp/a.wav',
  createdAt: '2026-05-28T00:00:00Z',
  language: 'vi',
  status: 'completed',
}

const meeting8 = {
  id: 8,
  title: 'Meeting eight',
  audioPath: '/tmp/b.wav',
  createdAt: '2026-05-28T00:00:00Z',
  language: 'vi',
  status: 'completed',
}

const v2Analysis = {
  summary: 'V2 mindmap analysis',
  keywords: ['scope'],
  technicalTerms: [],
  painPoints: [],
  actionItems: [],
  domainMode: 'it',
  status: 'COMPLETED',
  analysisStatus: 'COMPLETED',
} as const

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('App mindmap analysis scope', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    localStorage.setItem('audiomind.access_token', 'dummy-token')

    vi.spyOn(api, 'listMeetingsWithParams').mockResolvedValue([meeting7, meeting8])
    vi.spyOn(api, 'getUserProfile').mockResolvedValue({ id: 1, username: 'tester' } as any)
    vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue(v2Analysis as any)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const openMindmapScene = async () => {
    await act(async () => {
      root.render(<App />)
    })
    await flush()

    const mindmapMenu = Array.from(container.querySelectorAll('li')).find((item) =>
      item.textContent?.includes('Sơ đồ mindmap'),
    )
    expect(mindmapMenu).toBeTruthy()

    await act(async () => {
      mindmapMenu?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
  }

  it('resolves scope before loading mindmap analysis when no selected scope exists', async () => {
    window.history.replaceState({}, '', '/studio/mindmap?meetingId=7')
    const resolveSpy = vi.spyOn(api, 'resolveMeetingResultScope').mockResolvedValue({
      scopeKind: 'v2',
      meetingId: 7,
      recordingSessionId: 9001,
      attemptId: 2,
    })
    const savedSpy = vi.mocked(api.getSavedAnalysis)

    await openMindmapScene()
    await flush()

    expect(resolveSpy).toHaveBeenCalledWith(7, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(savedSpy).toHaveBeenCalledWith(7, expect.objectContaining({
      recordingSessionId: 9001,
      attemptId: 2,
      signal: expect.any(AbortSignal),
    }))
    expect(savedSpy.mock.calls.some(([, options]) =>
      options?.recordingSessionId == null && options?.attemptId == null,
    )).toBe(false)
  })

  it('reuses selected scope for the same meeting without resolving again', async () => {
    const scopedScope = {
      scopeKind: 'v2' as const,
      meetingId: 7,
      recordingSessionId: 9001,
      attemptId: 2,
    }
    const resolveSpy = vi.spyOn(api, 'resolveMeetingResultScope').mockResolvedValue(scopedScope)
    window.history.replaceState({}, '', '/studio/mindmap?meetingId=7&recordingSessionId=9001&attemptId=2')

    await openMindmapScene()
    await flush()

    expect(resolveSpy).not.toHaveBeenCalled()
    expect(api.getSavedAnalysis).toHaveBeenCalledWith(7, expect.objectContaining({
      recordingSessionId: 9001,
      attemptId: 2,
    }))
  })

  it('clears stale scope when switching mindmap meeting from sidebar', async () => {
    let resolveMeeting8: ((scope: api.MeetingResultScope) => void) | undefined
    const resolveSpy = vi.spyOn(api, 'resolveMeetingResultScope').mockImplementation(async (meetingId) => {
      if (meetingId === 8) {
        return await new Promise<api.MeetingResultScope>((resolve) => {
          resolveMeeting8 = resolve
        })
      }
      return {
        scopeKind: 'v2',
        meetingId,
        recordingSessionId: 9001,
        attemptId: 2,
      }
    })

    const savedSpy = vi.mocked(api.getSavedAnalysis).mockImplementation(async (meetingId) => ({
      ...v2Analysis,
      summary: meetingId === 7 ? 'Analysis seven' : 'Analysis eight',
    }) as any)

    window.history.replaceState({}, '', '/studio/mindmap?meetingId=7&recordingSessionId=9001&attemptId=2')
    await openMindmapScene()
    await flush()

    const meetingEightItem = Array.from(container.querySelectorAll('[data-testid="dashboard-recent-item"]'))
      .find((item) => item.textContent?.includes('Meeting eight')) as HTMLLIElement | undefined
    expect(meetingEightItem).toBeTruthy()

    await act(async () => {
      meetingEightItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(resolveSpy).toHaveBeenCalledWith(8, undefined, expect.any(Object))
    expect(savedSpy).not.toHaveBeenCalledWith(8, expect.objectContaining({
      recordingSessionId: 9001,
      attemptId: 2,
    }))

    await act(async () => {
      resolveMeeting8?.({
        scopeKind: 'v2',
        meetingId: 8,
        recordingSessionId: 9002,
        attemptId: 1,
      })
      await flush()
    })

    expect(savedSpy).toHaveBeenCalledWith(8, expect.objectContaining({
      recordingSessionId: 9002,
      attemptId: 1,
    }))
  })

  it('loads legacy mindmap analysis without provenance params after resolve', async () => {
    window.history.replaceState({}, '', '/studio/mindmap?meetingId=7')
    vi.spyOn(api, 'resolveMeetingResultScope').mockResolvedValue({
      scopeKind: 'legacy',
      meetingId: 7,
      recordingSessionId: null,
      attemptId: null,
    })

    await openMindmapScene()
    await flush()

    const savedSpy = vi.mocked(api.getSavedAnalysis)
    const meetingSevenCall = savedSpy.mock.calls.find(([meetingId]) => meetingId === 7)
    expect(meetingSevenCall).toBeTruthy()
    const options = meetingSevenCall?.[1] ?? {}
    expect(options.recordingSessionId).toBeUndefined()
    expect(options.attemptId).toBeUndefined()
  })
})

