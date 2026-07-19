import { useCallback, useEffect, useState } from 'react'
import {
  applyDocumentTheme,
  nextThemeMode,
  readStoredTheme,
  type ThemeMode,
  writeStoredTheme,
} from '../utils/themeMode'

export type UseThemeModeReturn = {
  theme: ThemeMode
  setTheme: (mode: ThemeMode) => void
  toggleTheme: () => void
}

export function useThemeMode(initial?: ThemeMode): UseThemeModeReturn {
  const [theme, setThemeState] = useState<ThemeMode>(() => initial ?? readStoredTheme())

  useEffect(() => {
    applyDocumentTheme(theme)
    writeStoredTheme(theme)
  }, [theme])

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode)
  }, [])

  const toggleTheme = useCallback(() => {
    setThemeState((current) => nextThemeMode(current))
  }, [])

  return { theme, setTheme, toggleTheme }
}
