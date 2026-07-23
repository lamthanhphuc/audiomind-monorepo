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

  it('toggles theme from Night to Light via sidebar button', async () => {
    const onToggleTheme = vi.fn()
    await act(async () => {
      root.render(
        <DashboardLayout
          user={{ name: 'Test User', email: 'test@example.com', plan: 'FREE' }}
          onLogout={() => {}}
          activeMenu="upload"
          onNavigate={() => {}}
          theme="night"
          onToggleTheme={onToggleTheme}
        >
          <div>content</div>
        </DashboardLayout>,
      )
    })

    const toggle = container.querySelector('[data-testid="theme-mode-toggle"]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-testid="theme-mode-toggle-label"]')?.textContent).toBe('Chế độ sáng')

    await act(async () => {
      toggle.click()
    })
    expect(onToggleTheme).toHaveBeenCalledTimes(1)
  })

  it('shows Night label when currently in light mode', async () => {
    await act(async () => {
      root.render(
        <DashboardLayout
          user={{ name: 'Test User', email: 'test@example.com', plan: 'FREE' }}
          onLogout={() => {}}
          activeMenu="upload"
          onNavigate={() => {}}
          theme="light"
          onToggleTheme={() => {}}
        >
          <div>content</div>
        </DashboardLayout>,
      )
    })

    const toggle = container.querySelector('[data-testid="theme-mode-toggle"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('[data-testid="theme-mode-toggle-label"]')?.textContent).toBe('Chế độ tối')
  })
})

