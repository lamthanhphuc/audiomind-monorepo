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
        keywords: ['api'],
        technicalTerms: [{ term: 'API', meaning: 'Giao dien', category: 'protocol' }],
        painPoints: [{ title: 'Do tre', evidence: 'API cham', severity: 'high' }],
        actionItems: ['Toi uu cache'],
        domainMode: 'it',
      },
      status: 'ready',
    })

    expect(container.textContent).toContain('Tong hop')
    expect(container.textContent).toContain('API')
    expect(container.textContent).toContain('Do tre')
    expect(container.textContent).toContain('Toi uu cache')
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
        domainMode: 'it',
      },
      summaryTestId: 'e2e-summary',
    })

    expect(container.querySelector('[data-testid="e2e-summary"]')?.textContent).toContain('Summary line')
  })
})
