import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FeatureMindmap from './FeatureMindmap'

const baseMeetings = [
  {
    id: 42,
    title: 'Mindmap meeting',
    audioPath: '/tmp/a.wav',
    createdAt: '2026-05-28T00:00:00Z',
    language: 'vi',
    status: 'completed',
  },
  {
    id: 7,
    title: 'Legacy meeting',
    audioPath: '/tmp/b.wav',
    createdAt: '2026-05-28T00:00:00Z',
    language: 'vi',
    status: 'completed',
  },
]

const getMeetingLabel = (meeting: { id: number; title?: string | null }) =>
  meeting.title?.trim() || `Meeting #${meeting.id}`

describe('FeatureMindmap', () => {
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
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
  })

  it('renders meeting picker and structured analysis nodes', () => {
    act(() => {
      root.render(
        <FeatureMindmap
          meetings={baseMeetings}
          selectedMeetingId={42}
          onMeetingSelect={() => {}}
          getMeetingLabel={getMeetingLabel}
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

    expect(container.querySelector('[data-testid="mindmap-meeting-picker"]')).toBeTruthy()
    expect(container.textContent).toContain('Cuộc họp #42')
    expect(container.textContent).toContain('Tong hop')
    expect(container.textContent).toContain('API')
    expect(container.textContent).toContain('Do tre')
    expect(container.textContent).toContain('Toi uu cache')
    expect(container.textContent).toContain('CNTT')
    expect(container.querySelector('[data-testid="mindmap-flow"]')).toBeTruthy()
  })

  it('calls onMeetingSelect when picker changes', () => {
    const onMeetingSelect = vi.fn()
    act(() => {
      root.render(
        <FeatureMindmap
          meetings={baseMeetings}
          selectedMeetingId={42}
          onMeetingSelect={onMeetingSelect}
          getMeetingLabel={getMeetingLabel}
          meetingId={42}
          analysis={null}
          onLoadAnalysis={async () => {}}
        />,
      )
    })

    const select = container.querySelector('[data-testid="mindmap-meeting-picker"] select') as HTMLSelectElement
    act(() => {
      select.value = '7'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onMeetingSelect).toHaveBeenCalledWith(7)
  })

  it('renders legacy technical_terms and action_items payloads', () => {
    act(() => {
      root.render(
        <FeatureMindmap
          meetings={baseMeetings}
          selectedMeetingId={7}
          onMeetingSelect={() => {}}
          getMeetingLabel={getMeetingLabel}
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

