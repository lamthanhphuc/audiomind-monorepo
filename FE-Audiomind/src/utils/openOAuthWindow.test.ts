// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeOAuthTab,
  completeOAuthNavigation,
  prepareOAuthTab,
} from './openOAuthWindow'

describe('openOAuthWindow', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prepareOAuthTab opens a blank tab synchronously', () => {
    const mockTab = {
      closed: false,
      location: { replace: vi.fn() },
      close: vi.fn(),
    } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(mockTab)

    expect(prepareOAuthTab()).toBe(mockTab)
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
  })

  it('completeOAuthNavigation navigates the prepared tab', () => {
    const replace = vi.fn()
    const mockTab = { closed: false, location: { replace }, close: vi.fn() } as unknown as Window

    expect(completeOAuthNavigation(mockTab, 'https://accounts.google.com/oauth')).toBe('new_tab')
    expect(replace).toHaveBeenCalledWith('https://accounts.google.com/oauth')
  })

  it('completeOAuthNavigation falls back to same-tab assign when tab is blocked', () => {
    const assign = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign },
    })

    expect(completeOAuthNavigation(null, 'https://accounts.google.com/oauth')).toBe('same_tab')
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/oauth')

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    })
  })

  it('completeOAuthNavigation closes blank tab before same-tab fallback when navigation fails', () => {
    const close = vi.fn()
    const mockTab = {
      closed: false,
      opener: null,
      location: {
        replace: vi.fn(() => {
          throw new Error('blocked')
        }),
        get href() {
          return ''
        },
        set href(_value: string) {
          throw new Error('blocked')
        },
      },
      close,
    } as unknown as Window
    const assign = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign },
    })

    expect(completeOAuthNavigation(mockTab, 'https://accounts.google.com/oauth')).toBe('same_tab')
    expect(close).toHaveBeenCalled()
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/oauth')

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    })
  })

  it('closeOAuthTab closes the prepared tab', () => {
    const close = vi.fn()
    const mockTab = { closed: false, location: { replace: vi.fn() }, close } as unknown as Window

    closeOAuthTab(mockTab)
    expect(close).toHaveBeenCalled()
  })
})
