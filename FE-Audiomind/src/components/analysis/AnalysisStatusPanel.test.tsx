import { createRoot } from 'react-dom/client'
import { act } from 'react'
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

  it('renders verified evidence block when matches provided', () => {
    renderPanel({
      metadata: { analysisStatus: 'COMPLETED' },
      evidenceMatches: [
        {
          verificationStatus: 'verified',
          score: 0.9,
          snippet: 'Hợp đồng đã ký',
          speaker: 'SPEAKER_1',
          startTime: 10,
          endTime: 15,
        },
      ],
      onReanalyze: vi.fn(),
    })

    expect(container.querySelector('[data-testid="verified-evidence-block"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="evidence-verification-badge"]')?.textContent).toBe('Đã xác minh')
    expect(container.textContent).toContain('Hợp đồng đã ký')
  })

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

    expect(container.querySelector('[data-testid="analysis-status-badge"]')?.textContent).toBe('Hoàn tất')
    expect(container.textContent).toContain('gemini')
    expect(container.textContent).toContain('gemini-2.5-flash')
    expect(container.textContent).toContain('Có')
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

    expect(container.querySelector('[data-testid="analysis-status-badge"]')?.textContent).toBe('Dữ liệu cũ')
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
    expect(container.textContent).toContain('Thử lại sau 30 giây')
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
    expect(container.querySelector('[data-testid="analysis-error-metadata"]')?.textContent).toContain('AI đang bận')
    expect(container.textContent).toContain('Thử lại sau 45 giây')
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

  it('shows Vietnamese re-analyze CTA label', () => {
    renderPanel({
      metadata: {
        analysisStatus: 'COMPLETED',
      },
      onReanalyze: vi.fn(),
    })

    expect(container.querySelector('[data-testid="analysis-reanalyze-button"]')?.textContent)
      .toContain('Thử phân tích lại')
  })

  it('shows Vietnamese retryable overload banner', () => {
    renderPanel({
      metadata: {
        analysisStatus: 'ANALYSIS_FAILED_RETRYABLE',
        retryable: true,
        retryAfterSeconds: 30,
        errorCode: 'GEMINI_QUOTA_EXHAUSTED',
      },
      onReanalyze: vi.fn(),
    })

    expect(container.querySelector('[data-testid="analysis-status-banner"]')?.textContent)
      .toContain('AI đang quá tải, hệ thống sẽ tự thử lại.')
  })

  it('shows short transcript skip message', () => {
    renderPanel({
      metadata: {
        analysisStatus: 'NO_ANALYSIS',
        errorCode: 'ANALYSIS_SKIPPED_SHORT_TRANSCRIPT',
      },
      onReanalyze: vi.fn(),
    })

    expect(container.querySelector('[data-testid="analysis-status-banner"]')?.textContent)
      .toContain('Bản ghi quá ngắn hoặc chưa có đủ nội dung để phân tích.')
  })

  it('shows 7U retry metadata rows', () => {
    renderPanel({
      metadata: {
        analysisStatus: 'COMPLETED',
        canonicalTranscriptHash: 'abc123hash',
        canonicalTranscriptVersion: 'canonical-transcript-v2',
        analysisRetryCount: 2,
        retryExhausted: false,
        analysisNextRetryAt: '2026-06-01T01:00:00Z',
        analysisTraceId: 'trace-7u-1',
      },
      onReanalyze: vi.fn(),
    })

    expect(container.textContent).toContain('abc123hash')
    expect(container.textContent).toContain('canonical-transcript-v2')
    expect(container.textContent).toContain('Lần thử lại')
    expect(container.textContent).not.toContain('trace-7u-1')
  })
})

