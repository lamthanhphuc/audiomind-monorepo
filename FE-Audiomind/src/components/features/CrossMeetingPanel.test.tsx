// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import CrossMeetingPanel from './CrossMeetingPanel'

vi.mock('../../services/api', () => ({
  askCrossMeeting: vi.fn(),
}))

import { askCrossMeeting } from '../../services/api'

describe('CrossMeetingPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.mocked(askCrossMeeting).mockReset()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('renders example questions and ask input', () => {
    act(() => {
      root.render(<CrossMeetingPanel />)
    })
    expect(container.textContent).toContain('Hỏi qua nhiều meeting')
    expect(container.querySelector('[data-testid="cross-meeting-question"]')).toBeTruthy()
  })

  it('submits question and shows answer', async () => {
    vi.mocked(askCrossMeeting).mockResolvedValue({
      question: 'API?',
      answer: 'Có 2 quyết định về API.',
      provider: 'gemini',
      meetings: [{ meetingId: 3, title: 'Sprint planning' }],
    })

    act(() => {
      root.render(<CrossMeetingPanel />)
    })

    const exampleButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('quyết định về API'),
    )
    await act(async () => {
      exampleButton?.click()
      await Promise.resolve()
    })

    expect(askCrossMeeting).toHaveBeenCalled()
    expect(container.textContent).toContain('Có 2 quyết định về API.')
    expect(container.textContent).toContain('Sprint planning')
  })
})
