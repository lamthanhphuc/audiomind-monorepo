import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../services/api'
import FeatureAnalysis from './FeatureAnalysis'

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('FeatureAnalysis', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
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

  it('renders structured analysis sections', () => {
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
          transcriptSegments={[]}
          transcriptText=""
        />,
      )
    })

    expect(container.textContent).toContain('Tong hop')
    expect(container.textContent).toContain('API')
    expect(container.textContent).toContain('Giao dien')
    expect(container.textContent).toContain('Do tre')
    expect(container.textContent).toContain('Toi uu cache')
    expect(container.textContent).toContain('it')
  })

  it('renders legacy snake_case analysis payloads', () => {
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

    expect(container.textContent).toContain('Legacy summary')
    expect(container.textContent).toContain('Webhook')
    expect(container.textContent).toContain('Retry webhook')
  })

  it('uses analysis scroll layout structure without nested transcript max height', () => {
    act(() => {
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

    expect(container.querySelector('.feature-analysis-page')).toBeTruthy()
    expect(container.querySelector('.analysis-main-content')).toBeTruthy()
    expect(container.querySelector('.analysis-left-panel')).toBeTruthy()
    expect(container.querySelector('.analysis-right-panel')).toBeTruthy()

    const transcriptContainer = container.querySelector('.transcript-display__container') as HTMLElement | null
    expect(transcriptContainer?.style.maxHeight).toBe('none')
  })

  it('shows empty states for summary-only analysis', () => {
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

    expect(container.textContent).toContain('Only summary')
    expect(container.textContent).toContain('Không có')
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
    expect(container.textContent).toContain('Hydrated summary')
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
    expect(container.textContent).toContain('Phân tích AI chưa sẵn sàng')
  })

  it('ignores stale hydration responses when meetingId changes quickly', async () => {
    let resolveFirstTranscript: (value: unknown) => void = () => {}
    const firstTranscriptPromise = new Promise((resolve) => {
      resolveFirstTranscript = resolve
    })

    vi.spyOn(api, 'getTranscript')
      .mockImplementationOnce(() => firstTranscriptPromise as Promise<any>)
      .mockResolvedValue({
        meeting_id: 9,
        transcripts: [{ speaker: 'Speaker 2', start_time: 0, end_time: 1, text: 'Fresh transcript' }],
      } as any)
    vi.spyOn(api, 'getSavedAnalysis')
      .mockResolvedValueOnce({
        summary: 'Stale summary',
        keywords: [],
        technicalTerms: [],
        painPoints: [],
        actionItems: [],
        domainMode: 'it',
        status: 'COMPLETED',
        analysisStatus: 'COMPLETED',
      } as any)
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
    expect(container.textContent).toContain('Fresh summary')
    expect(container.textContent).not.toContain('Stale transcript')
    expect(container.textContent).not.toContain('Stale summary')
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
    expect(container.textContent).toContain('Không tìm thấy meeting hoặc transcript.')
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

  it('shows retryable analysis failure while keeping transcript visible in hydrate mode', async () => {
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

    const modelTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Phân tích AI',
    )
    await act(async () => {
      modelTab?.click()
    })
    await flush()

    expect(container.textContent).toContain('Phân tích AI tạm thời chưa sẵn sàng')
    expect(container.querySelector('[data-testid="feature-analysis-hydrate-error"]')).toBeNull()
  })
})
