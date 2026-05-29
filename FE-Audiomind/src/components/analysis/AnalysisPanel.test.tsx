import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnalysisPanel } from './AnalysisPanel'

describe('AnalysisPanel', () => {
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

  const renderPanel = (props: Parameters<typeof AnalysisPanel>[0]) => {
    act(() => {
      root.render(<AnalysisPanel {...props} />)
    })
  }

  it('renders structured analysis sections when ready', () => {
    renderPanel({
      analysis: {
        summary: 'Tong hop',
        meetingSummary: 'Tong hop',
        keywords: ['api'],
        technicalTerms: [{ term: 'API', meaning: 'Giao dien', category: 'protocol' }],
        painPoints: [{ title: 'Do tre', evidence: 'API cham', severity: 'high' }],
        actionItems: ['Toi uu cache'],
        businessActionItems: [{ task: 'Toi uu cache', owner: 'Lan', dueDate: '2026-06-01', priority: 'high', status: 'open', evidence: 'Speaker 1: Lan chiu trach nhiem' }],
        keyDecisions: ['Uu tien cache'],
        risks: ['Co the tre release'],
        blockers: ['Cho access production'],
        nextSteps: ['Deploy sau khi smoke test'],
        confidence: 0.72,
        domainMode: 'it',
      },
      status: 'ready',
    })

    expect(container.textContent).toContain('Tong hop')
    expect(container.textContent).toContain('Uu tien cache')
    expect(container.textContent).toContain('API')
    expect(container.textContent).toContain('Do tre')
    expect(container.textContent).toContain('Toi uu cache')
    expect(container.textContent).toContain('Owner: Lan')
    expect(container.textContent).toContain('Due: 2026-06-01')
    expect(container.textContent).toContain('72%')
  })

  it('renders loading state', () => {
    renderPanel({
      analysis: null,
      status: 'loading',
      loadingMessage: 'Dang tai...',
    })

    expect(container.querySelector('.ui-state--loading')).not.toBeNull()
    expect(container.textContent).toContain('Dang tai...')
  })

  it('renders empty state', () => {
    renderPanel({
      analysis: null,
      status: 'empty',
      emptyMessage: 'Chua co phan tich',
    })

    expect(container.querySelector('.ui-state--empty')).not.toBeNull()
    expect(container.textContent).toContain('Chua co phan tich')
  })

  it('renders error state', () => {
    renderPanel({
      analysis: null,
      errorMessage: 'Khong the tai phan tich',
    })

    expect(container.querySelector('.ui-state--error')).not.toBeNull()
    expect(container.textContent).toContain('Khong the tai phan tich')
  })

  it('applies summary test id for e2e', () => {
    renderPanel({
      analysis: {
        summary: 'Summary line',
        keywords: [],
        technicalTerms: [],
        painPoints: [],
        actionItems: [],
        businessActionItems: [],
        domainMode: 'it',
      },
      summaryTestId: 'e2e-summary',
    })

    expect(container.querySelector('[data-testid="e2e-summary"]')?.textContent).toContain('Summary line')
  })

  it('renders legacy record without business fields', () => {
    renderPanel({
      analysis: {
        summary: 'Legacy summary',
        keywords: ['legacy'],
        technicalTerms: [],
        painPoints: [],
        actionItems: ['Legacy task'],
        domainMode: 'it',
      },
      status: 'ready',
    })

    expect(container.textContent).toContain('Legacy summary')
    expect(container.textContent).toContain('Legacy task')
  })

  it('does not crash when owner and due date are missing', () => {
    renderPanel({
      analysis: {
        summary: 'Business summary',
        keywords: [],
        technicalTerms: [],
        painPoints: [],
        actionItems: ['Cap nhat ke hoach'],
        businessActionItems: [{ task: 'Cap nhat ke hoach' }],
        domainMode: 'business',
      },
      status: 'ready',
    })

    expect(container.textContent).toContain('Cap nhat ke hoach')
    expect(container.textContent).not.toContain('Owner:')
    expect(container.textContent).not.toContain('Due:')
  })

  it('renders empty business arrays gracefully', () => {
    renderPanel({
      analysis: {
        summary: 'Summary',
        keywords: [],
        technicalTerms: [],
        painPoints: [],
        actionItems: [],
        businessActionItems: [],
        keyDecisions: [],
        risks: [],
        blockers: [],
        nextSteps: [],
        domainMode: 'business',
      },
      status: 'ready',
    })

    expect(container.textContent).toContain('Không có quyết định chính')
    expect(container.textContent).toContain('Không có rủi ro')
    expect(container.textContent).toContain('Không có blockers')
    expect(container.textContent).toContain('Không có bước tiếp theo')
  })
})
