import { describe, expect, it } from 'vitest'
import {
  canUseMindmap,
  canUseStudyWorkspace,
  isAdvertisementPlan,
  normalizePlanCode,
} from './planCapabilities'

describe('planCapabilities', () => {
  it('maps legacy paid plans to Standard', () => {
    expect(normalizePlanCode('PRO')).toBe('STANDARD')
    expect(normalizePlanCode('student')).toBe('STANDARD')
  })

  it('limits Free to the core experience with advertisements', () => {
    expect(canUseMindmap('FREE')).toBe(false)
    expect(canUseStudyWorkspace('FREE')).toBe(false)
    expect(isAdvertisementPlan('FREE')).toBe(true)
  })

  it('gives Standard mindmap without the Premium study workspace', () => {
    expect(canUseMindmap('STANDARD')).toBe(true)
    expect(canUseStudyWorkspace('STANDARD')).toBe(false)
    expect(isAdvertisementPlan('STANDARD')).toBe(false)
  })

  it('gives Premium the complete study workspace without advertisements', () => {
    expect(canUseMindmap('PREMIUM')).toBe(true)
    expect(canUseStudyWorkspace('PREMIUM')).toBe(true)
    expect(isAdvertisementPlan('PREMIUM')).toBe(false)
  })
})
