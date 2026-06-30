import { describe, expect, it } from 'vitest'
import { ERROR_CATALOG } from '../constants/errorCatalog'
import {
  isProviderGeminiQuota,
  isUserQuotaExceeded,
  quotaBlockedAnalysisStatus,
  resolveQuotaPresentation,
  shouldRedirectToBilling,
} from './quotaUx'

describe('quotaUx', () => {
  it('detects user quota from HTTP 402', () => {
    expect(isUserQuotaExceeded({ httpStatus: 402 })).toBe(true)
  })

  it('detects user quota from QUOTA_BLOCKED status', () => {
    expect(isUserQuotaExceeded({ analysisStatus: 'QUOTA_BLOCKED' })).toBe(true)
  })

  it('detects user quota from error code', () => {
    expect(isUserQuotaExceeded({ errorCode: 'QUOTA_EXCEEDED' })).toBe(true)
    expect(isUserQuotaExceeded({ errorCode: 'QUOTA_BLOCKED' })).toBe(true)
  })

  it('does not treat Gemini provider quota as user quota', () => {
    expect(isProviderGeminiQuota({ errorCode: 'GEMINI_QUOTA_EXHAUSTED' })).toBe(true)
    expect(isUserQuotaExceeded({ errorCode: 'GEMINI_QUOTA_EXHAUSTED' })).toBe(false)
  })

  it('returns Free catalog message for FREE plan', () => {
    const presentation = resolveQuotaPresentation(
      { httpStatus: 402 },
      'FREE',
      true,
    )
    expect(presentation.message).toBe(ERROR_CATALOG.QUOTA_EXCEEDED.message)
    expect(presentation.ctaId).toBe('upgrade_plan')
    expect(presentation.ctaLabel).toBe('Xem gói & thanh toán')
  })

  it('returns Pro-specific message for PRO plan', () => {
    const presentation = resolveQuotaPresentation(
      { errorCode: 'QUOTA_EXCEEDED' },
      'PRO',
      true,
    )
    expect(presentation.message).toContain('quota Pro')
    expect(presentation.ctaId).toBe('upgrade_plan')
  })

  it('shouldRedirectToBilling when upgrade_plan CTA present', () => {
    expect(shouldRedirectToBilling({ message: 'x', ctaId: 'upgrade_plan' })).toBe(true)
    expect(shouldRedirectToBilling({ message: 'x', ctaId: 'retry_later' })).toBe(false)
  })

  it('maps QUOTA_EXCEEDED to QUOTA_BLOCKED analysis status', () => {
    expect(quotaBlockedAnalysisStatus('QUOTA_EXCEEDED')).toBe('QUOTA_BLOCKED')
    expect(quotaBlockedAnalysisStatus('GEMINI_QUOTA_EXHAUSTED')).toBeUndefined()
  })
})
