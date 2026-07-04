export type PublicLegalKind = 'privacy' | 'terms'

export const PUBLIC_LEGAL_PATHS: Record<PublicLegalKind, string> = {
  privacy: '/privacy',
  terms: '/terms',
}

export const resolvePublicLegalKind = (pathname: string): PublicLegalKind | null => {
  if (pathname === PUBLIC_LEGAL_PATHS.privacy) {
    return 'privacy'
  }
  if (pathname === PUBLIC_LEGAL_PATHS.terms) {
    return 'terms'
  }
  return null
}

export const isPublicLegalPath = (pathname: string): boolean => {
  return resolvePublicLegalKind(pathname) !== null
}
