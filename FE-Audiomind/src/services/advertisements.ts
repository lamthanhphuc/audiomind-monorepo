import { getAccessToken, getJwtPlan } from './auth'
import { USER_API_BASE } from './config'
import { isAdvertisementPlan } from '../utils/planCapabilities'

export type AdvertisementItem = {
  id: string
  brandName?: string
  type?: string
  placement: string
  mediaUrl?: string | null
  thumbnailUrl?: string | null
  targetUrl?: string | null
  duration?: number | null
  status?: string
  targetPlans?: string[]
  label: string
  title: string
  body: string
  ctaLabel: string
  ctaRoute?: string
}

export type AdvertisementResponse = {
  plan: string
  advertisementEnabled: boolean
  items: AdvertisementItem[]
}

const authHeaders = (): HeadersInit => {
  const token = getAccessToken()
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn')
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

const normalizeAd = (raw: unknown): AdvertisementItem => {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    id: String(record.id ?? ''),
    brandName: record.brandName == null ? undefined : String(record.brandName),
    type: record.type == null ? undefined : String(record.type),
    placement: String(record.placement ?? 'DASHBOARD'),
    mediaUrl: record.mediaUrl == null ? null : String(record.mediaUrl),
    thumbnailUrl: record.thumbnailUrl == null ? null : String(record.thumbnailUrl),
    targetUrl: record.targetUrl == null ? null : String(record.targetUrl),
    duration: record.duration == null ? null : Number(record.duration),
    status: record.status == null ? undefined : String(record.status),
    targetPlans: Array.isArray(record.targetPlans) ? record.targetPlans.map(String) : undefined,
    label: String(record.label ?? record.brandName ?? 'Sponsored'),
    title: String(record.title ?? 'AudioMind Premium'),
    body: String(record.body ?? record.description ?? ''),
    ctaLabel: String(record.ctaLabel ?? record.cta_label ?? 'Xem gói nâng cấp'),
    ctaRoute: record.ctaRoute == null
      ? (record.cta_route == null ? undefined : String(record.cta_route))
      : String(record.ctaRoute),
  }
}

export const shouldRequestAdvertisements = (plan = getJwtPlan()): boolean => {
  return isAdvertisementPlan(plan)
}

export const getAdvertisements = async (): Promise<AdvertisementResponse> => {
  const response = await fetch(`${USER_API_BASE}/api/advertisements`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(payload?.message || `Không tải được quảng cáo (${response.status})`)
  }
  const data = await response.json() as Record<string, unknown>
  const items = Array.isArray(data.items) ? data.items.map(normalizeAd).filter((item) => item.id) : []
  return {
    plan: String(data.plan ?? 'FREE').toUpperCase(),
    advertisementEnabled: data.advertisementEnabled === true || data.advertisement_enabled === true,
    items,
  }
}
