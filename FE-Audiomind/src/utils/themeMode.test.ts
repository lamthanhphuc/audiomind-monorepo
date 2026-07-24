// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyDocumentTheme,
  DEFAULT_THEME_MODE,
  nextThemeMode,
  readStoredTheme,
  THEME_STORAGE_KEY,
  themeClassName,
  themeToggleLabel,
  writeStoredTheme,
} from './themeMode'

describe('themeMode', () => {
  afterEach(() => {
    window.localStorage.removeItem(THEME_STORAGE_KEY)
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.colorScheme = ''
  })

  it('defaults to night when storage is empty', () => {
    expect(readStoredTheme()).toBe(DEFAULT_THEME_MODE)
    expect(DEFAULT_THEME_MODE).toBe('night')
  })

  it('reads and writes localStorage', () => {
    writeStoredTheme('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(readStoredTheme()).toBe('light')
    writeStoredTheme('night')
    expect(readStoredTheme()).toBe('night')
  })

  it('ignores invalid stored values', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    expect(readStoredTheme()).toBe('night')
  })

  it('maps theme classes and toggle labels', () => {
    expect(themeClassName('night')).toBe('app--studio')
    expect(themeClassName('light')).toBe('app--light')
    expect(themeToggleLabel('night')).toBe('Chế độ sáng')
    expect(themeToggleLabel('light')).toBe('Chế độ tối')
    expect(nextThemeMode('night')).toBe('light')
    expect(nextThemeMode('light')).toBe('night')
  })

  it('applies document theme attributes', () => {
    applyDocumentTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    applyDocumentTheme('night')
    expect(document.documentElement.dataset.theme).toBe('night')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })
})
