export type PlanCode = 'FREE' | 'STANDARD' | 'PREMIUM' | string

export const normalizePlanCode = (value?: string | null): PlanCode => {
  const code = String(value || 'FREE').trim().toUpperCase()
  if (code === 'PRO' || code === 'STUDENT') return 'STANDARD'
  return code || 'FREE'
}

export const canUseMindmap = (plan?: string | null): boolean => (
  normalizePlanCode(plan) === 'STANDARD' || normalizePlanCode(plan) === 'PREMIUM'
)

export const canUseStudyWorkspace = (plan?: string | null): boolean => (
  normalizePlanCode(plan) === 'PREMIUM'
)

export const isAdvertisementPlan = (plan?: string | null): boolean => (
  normalizePlanCode(plan) === 'FREE'
)
