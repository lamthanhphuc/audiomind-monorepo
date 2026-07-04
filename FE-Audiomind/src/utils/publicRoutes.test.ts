import { describe, expect, it } from 'vitest'
import {
  PUBLIC_LEGAL_PATHS,
  isPublicLegalPath,
  resolvePublicLegalKind,
} from './publicRoutes'

describe('publicRoutes', () => {
  it('resolves privacy and terms paths', () => {
    expect(resolvePublicLegalKind('/privacy')).toBe('privacy')
    expect(resolvePublicLegalKind('/terms')).toBe('terms')
    expect(resolvePublicLegalKind('/')).toBeNull()
    expect(resolvePublicLegalKind('/register')).toBeNull()
    expect(resolvePublicLegalKind('/studio/upload')).toBeNull()
  })

  it('exposes stable public legal paths', () => {
    expect(PUBLIC_LEGAL_PATHS.privacy).toBe('/privacy')
    expect(PUBLIC_LEGAL_PATHS.terms).toBe('/terms')
    expect(isPublicLegalPath('/privacy')).toBe(true)
    expect(isPublicLegalPath('/terms')).toBe(true)
    expect(isPublicLegalPath('/login')).toBe(false)
  })
})
