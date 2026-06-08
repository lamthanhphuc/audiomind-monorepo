import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnalysisStatusPanel } from './AnalysisStatusPanel'

describe('AnalysisStatusPanel', () => {
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
  })

  const renderPanel = (props: Parameters<typeof AnalysisStatusPanel>[0]) => {
    act(() => {
      root.render(<AnalysisStatusPanel {...props} />)
    })
  }

  it('renders completed metadata', () => {
    renderPanel({
      metadata: {
        analysisStatus: 'COMPLETED',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        cacheHit: true,
        lastAnalyzedAt: '2026-06-01T00:00:00Z',
      },
      onReanalyze: vi.fn(),
    })

    expect(container.querySelector('[data-testid="analysis-status-badge"]')?.textContent).toBe('COMPLETED')
    expect(container.textContent).toContain('gemini')
    expect(container.textContent).toContain('gemini-2.5-flash')
    expect(container.textContent).toContain('yes')
  })

  it('renders stale status and stale reason', () => {
    renderPanel({
      metadata: {
        analysisStatus: 'COMPLETED',
        stale: true,
        staleReason: 'canonical_hash_changed',
      },
      onReanalyze: vi.fn(),
    })

    expect(container.querySelector('[data-testid="analysis-status-badge"]')?.textContent).toBe('STALE')
    expect(container.textContent).toContain('canonical_hash_changed')
  })

  it('disables re-analyze when rate limited with retry seconds', () => {
    renderPanel({
      metadata: {
        analysisStatus: 'RATE_LIMITED',
        retryAfterSeconds: 30,
      },
      onReanalyze: vi.fn(),
    })

    const button = container.querySelector('[data-testid="analysis-reanalyze-button"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(container.textContent).toContain('retryAfterSeconds: 30')
  })

  it('disables re-analyze during failed cooldown and shows error metadata', () => {
    renderPanel({
      metadata: {
        analysisStatus: 'FAILED',
        retryAfterSeconds: 45,
        errorCode: 'GEMINI_UNAVAILABLE',
        errorMessage: 'Gemini service unavailable',
      },
      onReanalyze: vi.fn(),
    })

    const button = container.querySelector('[data-testid="analysis-reanalyze-button"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(container.querySelector('[data-testid="analysis-error-metadata"]')?.textContent).toContain('GEMINI_UNAVAILABLE')
    expect(container.textContent).toContain('retryAfterSeconds: 45')
  })

  it('clicking re-analyze calls handler', () => {
    const onReanalyze = vi.fn()
    renderPanel({
      metadata: {
        analysisStatus: 'COMPLETED',
      },
      onReanalyze,
    })

    const button = container.querySelector('[data-testid="analysis-reanalyze-button"]') as HTMLButtonElement
    act(() => {
      button.click()
    })

    expect(onReanalyze).toHaveBeenCalledTimes(1)
  })
})
