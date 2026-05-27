import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FeatureAnalysis from './FeatureAnalysis'

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
})
