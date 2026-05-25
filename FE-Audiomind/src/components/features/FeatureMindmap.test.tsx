import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FeatureMindmap from './FeatureMindmap'

describe('FeatureMindmap', () => {
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

  it('renders structured analysis nodes', () => {
    act(() => {
      root.render(
        <FeatureMindmap
          meetingId={42}
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
          onLoadAnalysis={async () => {}}
        />,
      )
    })

    expect(container.textContent).toContain('Meeting ID: 42')
    expect(container.textContent).toContain('API')
    expect(container.textContent).toContain('Do tre')
    expect(container.textContent).toContain('Toi uu cache')
    expect(container.textContent).toContain('it')
  })

  it('renders legacy technical_terms and action_items payloads', () => {
    act(() => {
      root.render(
        <FeatureMindmap
          meetingId={7}
          busy={false}
          analysis={{
            summary: 'Legacy summary',
            technical_terms: ['Webhook'],
            action_items: [{ task: 'Retry webhook' }],
          } as any}
          onLoadAnalysis={async () => {}}
        />,
      )
    })

    expect(container.textContent).toContain('Webhook')
    expect(container.textContent).toContain('Retry webhook')
  })
})
