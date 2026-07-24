export type ThemeMode = 'night' | 'light'

export const THEME_STORAGE_KEY = 'audiomind.uiTheme'

export const DEFAULT_THEME_MODE: ThemeMode = 'night'

export const isThemeMode = (value: unknown): value is ThemeMode =>
  value === 'night' || value === 'light'

export const readStoredTheme = (): ThemeMode => {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (isThemeMode(raw)) {
      return raw
    }
  } catch {
    // ignore storage access errors (private mode / SSR)
  }
  return DEFAULT_THEME_MODE
}

export const writeStoredTheme = (mode: ThemeMode): void => {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // ignore storage access errors
  }
}

/** Dashboard root modifier classes for the active mode. */
export const themeClassName = (mode: ThemeMode): string =>
  mode === 'night' ? 'app--studio' : 'app--light'

export const applyDocumentTheme = (mode: ThemeMode): void => {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = mode
  root.style.colorScheme = mode === 'night' ? 'dark' : 'light'
}

export const nextThemeMode = (mode: ThemeMode): ThemeMode =>
  mode === 'night' ? 'light' : 'night'

/** Label shown on the toggle = the mode you switch *to*. */
export const themeToggleLabel = (mode: ThemeMode): string =>
  mode === 'night' ? 'Chế độ sáng' : 'Chế độ tối'
