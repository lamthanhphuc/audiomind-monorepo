// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GlobalMeetingSearch from './GlobalMeetingSearch'

describe('GlobalMeetingSearch', () => {
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

  it('submits trimmed query', () => {
    const onSubmit = vi.fn()
    act(() => {
      root.render(
        <GlobalMeetingSearch value="  weekly sync  " onValueChange={() => {}} onSubmit={onSubmit} />,
      )
    })

    const form = container.querySelector('form') as HTMLFormElement
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onSubmit).toHaveBeenCalledWith('weekly sync')
  })

  it('has accessible search label', () => {
    act(() => {
      root.render(<GlobalMeetingSearch onSubmit={vi.fn()} />)
    })
    const input = container.querySelector('[data-testid="global-meeting-search"]') as HTMLInputElement
    expect(input.getAttribute('aria-label')).toBe('Tìm meeting toàn cục')
  })
})
