// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardLayout from './DashboardLayout'

describe('DashboardLayout global meeting search', () => {
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

  it('submits global search query to parent handler', async () => {
    const onSubmit = vi.fn()
    await act(async () => {
      root.render(
        <DashboardLayout
          user={{ name: 'Test User', email: 'test@example.com', plan: 'FREE' }}
          onLogout={() => {}}
          activeMenu="upload"
          onNavigate={() => {}}
          globalMeetingSearch="weekly sync"
          onGlobalMeetingSearchChange={() => {}}
          onGlobalMeetingSearchSubmit={onSubmit}
        >
          <div>content</div>
        </DashboardLayout>,
      )
    })

    const input = container.querySelector('[data-testid="global-meeting-search"]') as HTMLInputElement
    expect(input?.value).toBe('weekly sync')

    const form = input.closest('form')
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onSubmit).toHaveBeenCalledWith('weekly sync')
  })
})

