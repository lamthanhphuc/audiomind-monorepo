// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useThemeMode } from './useThemeMode'
import { THEME_STORAGE_KEY } from '../utils/themeMode'

function ThemeProbe() {
  const { theme, toggleTheme } = useThemeMode()
  return (
    <button type="button" data-testid="theme-probe" onClick={toggleTheme}>
      {theme}
    </button>
  )
}

describe('useThemeMode', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    window.localStorage.removeItem(THEME_STORAGE_KEY)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    window.localStorage.removeItem(THEME_STORAGE_KEY)
  })

  it('persists toggle to localStorage and document', async () => {
    await act(async () => {
      root.render(<ThemeProbe />)
    })
    const button = container.querySelector('[data-testid="theme-probe"]') as HTMLButtonElement
    expect(button.textContent).toBe('night')

    await act(async () => {
      button.click()
    })
    expect(button.textContent).toBe('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('hydrates from stored light preference', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    await act(async () => {
      root.render(<ThemeProbe />)
    })
    const button = container.querySelector('[data-testid="theme-probe"]') as HTMLButtonElement
    expect(button.textContent).toBe('light')
  })
})
