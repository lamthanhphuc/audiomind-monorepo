import {
  ERROR_CATALOG,
  ERROR_CODE_ALIASES,
  type ErrorPresentation,
  resolveErrorPresentation,
} from '../constants/errorCatalog'

export type QuotaSignal = {
  httpStatus?: number
  errorCode?: string | null
  analysisStatus?: string | null
  fallbackMessage?: string
}

export type UserPlan = 'FREE' | 'PRO'

const QUOTA_PRO_MESSAGE =
  'Bạn đã vượt quota Pro tháng này. Liên hệ admin để gia hạn hoặc tăng hạn mức.'

const normalizeErrorCode = (errorCode?: string | null): string | undefined => {
  if (!errorCode) return undefined
  const normalized = errorCode.trim().toUpperCase()
  return ERROR_CODE_ALIASES[normalized] ?? normalized
}

export function isUserQuotaExceeded(signal: QuotaSignal): boolean {
  if (signal.httpStatus === 402) {
    return true
  }

  const status = (signal.analysisStatus || '').trim().toUpperCase()
  if (status === 'QUOTA_BLOCKED') {
    return true
  }

  const code = normalizeErrorCode(signal.errorCode)
  if (code === 'QUOTA_EXCEEDED') {
    return true
  }

  const fallback = (signal.fallbackMessage || '').trim().toLowerCase()
  if (fallback.includes('errorcode=quota_exceeded')) {
    return true
  }

  return false
}

export function isProviderGeminiQuota(signal: QuotaSignal): boolean {
  const code = normalizeErrorCode(signal.errorCode)
  return code === 'GEMINI_QUOTA_EXHAUSTED'
}

export function isGeminiBillingBlocked(signal: QuotaSignal): boolean {
  return normalizeErrorCode(signal.errorCode) === 'GEMINI_BILLING_CREDITS_DEPLETED'
}

export function quotaBlockedAnalysisStatus(errorCode?: string): 'QUOTA_BLOCKED' | undefined {
  const code = normalizeErrorCode(errorCode)
  return code === 'QUOTA_EXCEEDED' ? 'QUOTA_BLOCKED' : undefined
}

export function resolveQuotaPresentation(
  signal: QuotaSignal,
  plan: UserPlan,
  errorUxEnabled: boolean,
): ErrorPresentation {
  const fallbackMessage = signal.fallbackMessage || 'Usage quota exceeded'
  const presentation = resolveErrorPresentation('QUOTA_EXCEEDED', fallbackMessage, errorUxEnabled)

  if (!errorUxEnabled || !isUserQuotaExceeded(signal)) {
    return { message: fallbackMessage }
  }

  if (plan === 'PRO') {
    return {
      message: QUOTA_PRO_MESSAGE,
      ctaId: presentation.ctaId,
      ctaLabel: presentation.ctaLabel,
    }
  }

  return {
    message: ERROR_CATALOG.QUOTA_EXCEEDED.message,
    ctaId: presentation.ctaId,
    ctaLabel: presentation.ctaLabel,
  }
}

export function shouldRedirectToBilling(presentation: ErrorPresentation): boolean {
  return presentation.ctaId === 'upgrade_plan'
}
