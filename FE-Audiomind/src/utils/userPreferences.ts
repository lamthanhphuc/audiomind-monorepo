import { DEFAULT_DOMAIN_MODE, normalizeDomainMode, type DomainMode } from '../constants/domainMode'

const STORAGE_KEY = 'audiomind_user_preferences'
const ONBOARDING_KEY = 'audiomind_onboarding_dismissed'

export type UserPreferences = {
  domainMode: DomainMode
}

const defaultPreferences = (): UserPreferences => ({
  domainMode: DEFAULT_DOMAIN_MODE,
})

export const loadUserPreferences = (): UserPreferences => {
  if (typeof window === 'undefined') {
    return defaultPreferences()
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return defaultPreferences()
    }
    const parsed = JSON.parse(raw) as Partial<UserPreferences>
    return {
      domainMode: normalizeDomainMode(parsed.domainMode),
    }
  } catch {
    return defaultPreferences()
  }
}

export const saveUserPreferences = (preferences: Partial<UserPreferences>): UserPreferences => {
  const next = {
    ...loadUserPreferences(),
    ...preferences,
    domainMode: normalizeDomainMode(preferences.domainMode ?? loadUserPreferences().domainMode),
  }
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

export const applyServerDomainMode = (domainMode?: string | null): DomainMode | null => {
  if (!domainMode?.trim()) {
    return null
  }
  const normalized = normalizeDomainMode(domainMode)
  saveUserPreferences({ domainMode: normalized })
  return normalized
}

export const isOnboardingDismissed = (): boolean => {
  if (typeof window === 'undefined') {
    return true
  }
  return window.localStorage.getItem(ONBOARDING_KEY) === '1'
}

export const dismissOnboarding = (): void => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(ONBOARDING_KEY, '1')
  }
}

export const resetOnboarding = (): void => {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(ONBOARDING_KEY)
  }
}
