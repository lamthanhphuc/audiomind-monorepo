const GOOGLE_TECHNICAL_USERNAME = /^google_[a-z0-9_-]{10,}$/i

export const isTechnicalUsername = (value?: string | null): boolean => {
  const normalized = value?.trim() ?? ''
  return GOOGLE_TECHNICAL_USERNAME.test(normalized)
}

export const emailPrefix = (email?: string | null): string => {
  const normalized = email?.trim() ?? ''
  const [prefix] = normalized.split('@')
  return prefix?.trim() || ''
}

export const resolveDisplayName = (
  username?: string | null,
  email?: string | null,
  fallback = 'Người dùng',
): string => {
  const normalizedUsername = username?.trim() ?? ''
  if (normalizedUsername && !isTechnicalUsername(normalizedUsername)) {
    return normalizedUsername
  }
  return emailPrefix(email) || fallback
}
