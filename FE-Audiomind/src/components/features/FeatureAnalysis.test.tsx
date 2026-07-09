import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../services/api'
import * as knowledgeLayer from '../../services/knowledgeLayer'
import FeatureAnalysis from './FeatureAnalysis'

vi.mock('../../services/knowledgeLayer', () => ({
  listKnowledgeNotes: vi.fn().mockResolvedValue([]),
  createKnowledgeNote: vi.fn(),
  updateKnowledgeNote: vi.fn(),
  deleteKnowledgeNote: vi.fn(),
  listSpeakerProfiles: vi.fn().mockResolvedValue([]),
  upsertSpeakerProfiles: vi.fn(),
}))

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const clickMindmapTab = async (container: HTMLElement) => {
  const mindmapTab = container.querySelector('[data-testid="feature-analysis-mindmap-tab"]') as HTMLButtonElement
  await act(async () => {
    mindmapTab.click()
  })
  await flush()
}

const clickModelTab = async (container: HTMLElement) => {
  const modelTab = container.querySelector('[data-testid="feature-analysis-model-tab"]') as HTMLButtonElement
  await act(async () => {
    modelTab.click()
  })
  await flush()
}

describe('FeatureAnalysis', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    vi.mocked(knowledgeLayer.listSpeakerProfiles).mockResolvedValue([])
    vi.mocked(knowledgeLayer.listKnowledgeNotes).mockResolvedValue([])
    vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue({
      summary: '',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
      status: 'NOT_FOUND',
      analysisStatus: 'NOT_FOUND',
    } as any)
    vi.spyOn(api, 'resolveMeetingResultScope').mockImplementation(async (meetingId) => ({
      scopeKind: 'legacy',
      meetingId,
      recordingSessionId: null,
      attemptId: null,
    }))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
  })

  it('renders transcript tab without topic graph or sidebar glossary panel', async () => {
    act(() => {
      root.render(
        <FeatureAnalysis
          meetingId={42}
          meetingTitle="Structured session"
          busy={false}
          analysis={{
            summary: 'Tong hop',
            keywords: ['api', 'cache'],
            technicalTerms: [
              { term: 'API', meaning: 'Giao dien', category: 'protocol' },
            ],
            painPoints: [
              { title: 'Do tre', evidence: 'API cham', severity: 'high' },
            ],
            actionItems: ['Toi uu cache'],
            domainMode: 'it',
          } as any}
          transcriptSegments={[
            { id: 'seg-1', speaker: 'Speaker 1', text: 'Hello API', start: 0, end: 1 },
          ]}
          transcriptText=""
        />,
      )
    })

    expect(container.querySelector('[data-testid="e2e-transcript"]')).toBeTruthy()
    expect(container.textContent).toContain('Hello API')
    expect(container.querySelector('[data-testid="topic-graph"]')).toBeNull()
    expect(container.querySelector('[data-testid="glossary-notes-panel"]')).toBeNull()

    await clickModelTab(container)
    expect(container.querySelector('[data-testid="analysis-term-notes"]')).toBeTruthy()
    expect(container.textContent).toContain('API')
    expect(container.textContent).toContain('Giao dien')
  })

  it('renders mindmap tab with legacy snake_case analysis payloads', async () => {
    act(() => {
      root.render(
        <FeatureAnalysis
          meetingId={7}
          meetingTitle="Legacy session"
          busy={false}
          analysis={{
            summary: 'Legacy summary',
            technical_terms: ['Webhook'],
            action_items: [{ task: 'Retry webhook' }],
          } as any}
          transcriptSegments={[]}
          transcriptText=""
        />,
      )
    })

    await clickMindmapTab(container)

    expect(container.querySelector('[data-testid="mindmap-flow"]')).toBeTruthy()
    expect(container.textContent).toContain('Webhook')
    expect(container.textContent).toContain('Retry webhook')
  })

  it('uses analysis scroll layout structure without nested transcript max height', async () => {
    await act(async () => {
      root.render(
        <FeatureAnalysis
          meetingId={42}
          meetingTitle="Scroll layout session"
          busy={false}
          analysis={{ summary: 'Long summary' } as any}
          transcriptSegments={[
            { id: 'seg-1', speaker: 'Speaker 1', text: 'Long transcript line', start: 0, end: 1 },
          ]}
          transcriptText=""
        />,
      )
    })
    await flush()

    expect(container.querySelector('.feature-analysis-page')).toBeTruthy()
    expect(container.querySelector('.analysis-main-content')).toBeTruthy()
    expect(container.querySelector('.analysis-left-panel')).toBeTruthy()
    expect(container.querySelector('.analysis-right-panel')).toBeTruthy()

    const transcriptContainer = container.querySelector('.transcript-display__container') as HTMLElement | null
    expect(transcriptContainer?.style.getPropertyValue('--scroll-max-height')).toBe('none')
  })

  it('does not render audio player or right-side summary panel', async () => {
    act(() => {
      root.render(
        <FeatureAnalysis
          meetingId={99}
          meetingTitle="Summary only"
          busy={false}
          analysis={{ summary: 'Only summary' } as any}
          transcriptSegments={[]}
          transcriptText=""
        />,
      )
    })

    expect(container.querySelector('[data-testid="meeting-audio-player"]')).toBeNull()
    expect(container.querySelector('[data-testid="feature-analysis-model-tab"]')).toBeTruthy()
    expect(container.textContent).not.toContain('Tóm tắt')

    await clickModelTab(container)
    expect(container.querySelector('[data-testid="e2e-summary"]')?.textContent).toContain('Only summary')
  })

  it('hydrates transcript and saved analysis when opened from history', async () => {
    vi.spyOn(api, 'getTranscript').mockResolvedValue({
      meeting_id: 42,
      transcripts: [{ speaker: 'Speaker 1', start_time: 0, end_time: 1, text: 'Hydrated transcript' }],
    } as any)
    vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue({
      summary: 'Hydrated summary',
      keywords: ['cache'],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
      status: 'COMPLETED',
      analysisStatus: 'COMPLETED',
    } as any)

    await act(async () => {
      root.render(
        <FeatureAnalysis
          meetingId={42}
          meetingTitle="History session"
          hydrateFromApi
        />,
      )
    })
    await flush()

    expect(api.getTranscript).toHaveBeenCalledWith(42, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(api.getSavedAnalysis).toHaveBeenCalledWith(42, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(container.textContent).toContain('Hydrated transcript')

    await clickMindmapTab(container)
    expect(container.textContent).toContain('cache')
  })

  it('shows transcript with missing analysis state without redirecting', async () => {
    vi.spyOn(api, 'getTranscript').mockResolvedValue({
      meeting_id: 55,
      transcripts: [{ speaker: 'Speaker 1', start_time: 0, end_time: 1, text: 'Only transcript' }],
    } as any)
    vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue({
      status: 'NOT_FOUND',
      summary: '',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
    } as any)

    await act(async () => {
      root.render(
        <FeatureAnalysis
          meetingId={55}
          meetingTitle="Missing analysis"
          hydrateFromApi
        />,
      )
    })
    await flush()

    expect(container.querySelector('[data-testid="feature-analysis-hydrate-error"]')).toBeNull()
    expect(container.textContent).toContain('Only transcript')
    await clickModelTab(container)
    expect(container.textContent).toContain('Phân tích AI chưa sẵn sàng')
  })

  it('ignores stale hydration responses when meetingId changes quickly', async () => {
    let resolveFirstTranscript: (value: unknown) => void = () => {}
    const firstTranscriptPromise = new Promise((resolve) => {
      resolveFirstTranscript = resolve
    })

    vi.mocked(api.getSavedAnalysis).mockReset()
    vi.mocked(api.getSavedAnalysis)
      .mockResolvedValue({
        summary: 'Fresh summary',
        keywords: [],
        technicalTerms: [],
        painPoints: [],
        actionItems: [],
        domainMode: 'it',
        status: 'COMPLETED',
        analysisStatus: 'COMPLETED',
      } as any)

    vi.spyOn(api, 'getTranscript')
      .mockImplementationOnce(() => firstTranscriptPromise as Promise<any>)
      .mockResolvedValue({
        meeting_id: 9,
        transcripts: [{ speaker: 'Speaker 2', start_time: 0, end_time: 1, text: 'Fresh transcript' }],
      } as any)

    await act(async () => {
      root.render(
        <FeatureAnalysis
          meetingId={1}
          meetingTitle="Stale guard"
          hydrateFromApi
        />,
      )
    })
    await flush()

    await act(async () => {
      root.render(
        <FeatureAnalysis
          meetingId={9}
          meetingTitle="Fresh session"
          hydrateFromApi
        />,
      )
    })
    await flush()

    await act(async () => {
      resolveFirstTranscript({
        meeting_id: 1,
        transcripts: [{ speaker: 'Speaker 1', start_time: 0, end_time: 1, text: 'Stale transcript' }],
      })
      await firstTranscriptPromise
    })
    await flush()

    expect(container.textContent).toContain('Fresh transcript')
    expect(container.textContent).not.toContain('Stale transcript')
  })

  it('shows friendly hydrate error for not found meetings', async () => {
    vi.spyOn(api, 'getTranscript').mockRejectedValue(new api.ApiError('Meeting not found', 404))
    vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue({
      status: 'NOT_FOUND',
      summary: '',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
    } as any)

    await act(async () => {
      root.render(
        <FeatureAnalysis
          meetingId={999}
          meetingTitle="Missing meeting"
          hydrateFromApi
        />,
      )
    })
    await flush()

    expect(container.querySelector('[data-testid="feature-analysis-hydrate-error"]')).toBeTruthy()
    expect(container.textContent).toContain('Không tìm thấy transcript cho phiên ghi đã chọn')
  })

  it('calls onBackToHistory when back button is clicked in hydrate mode', async () => {
    const onBackToHistory = vi.fn()
    vi.spyOn(api, 'getTranscript').mockResolvedValue({
      meeting_id: 42,
      transcripts: [{ speaker: 'Speaker 1', start_time: 0, end_time: 1, text: 'Back test transcript' }],
    } as any)
    vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue({
      summary: 'Back test summary',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
      status: 'COMPLETED',
      analysisStatus: 'COMPLETED',
    } as any)

    await act(async () => {
      root.render(
        <FeatureAnalysis
          meetingId={42}
          meetingTitle="Back test"
          hydrateFromApi
          onBackToHistory={onBackToHistory}
        />,
      )
    })
    await flush()

    const backButton = container.querySelector('[data-testid="feature-analysis-back"]') as HTMLButtonElement
    expect(backButton).toBeTruthy()

    await act(async () => {
      backButton.click()
    })
    await flush()

    expect(onBackToHistory).toHaveBeenCalledTimes(1)
  })

  it('keeps transcript visible when saved analysis is retryable', async () => {
    vi.spyOn(api, 'getTranscript').mockResolvedValue({
      meeting_id: 77,
      transcripts: [{ speaker: 'Speaker 1', start_time: 0, end_time: 1, text: 'Saved transcript line' }],
    } as any)
    vi.spyOn(api, 'getSavedAnalysis').mockResolvedValue({
      analysisStatus: 'ANALYSIS_FAILED_RETRYABLE',
      errorCode: 'CIRCUIT_OPEN',
      retryable: true,
      transcriptSaved: true,
      retryAfterSeconds: 10,
      summary: '',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
    } as any)

    await act(async () => {
      root.render(
        <FeatureAnalysis
          meetingId={77}
          meetingTitle="Retryable failure"
          hydrateFromApi
        />,
      )
    })
    await flush()

    expect(container.textContent).toContain('Saved transcript line')
    expect(container.querySelector('[data-testid="feature-analysis-hydrate-error"]')).toBeNull()
    await clickModelTab(container)
    expect(container.textContent).toContain('Phân tích AI tạm thời chưa sẵn sàng')
  })
})

