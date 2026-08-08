import { getAccessToken } from './auth'
import { USER_API_BASE } from './config'

export type QuotaSnapshot = {
  plan: string
  periodYyyymm: string
  sttSecondsUsed: number
  geminiInputCharsUsed: number
  sttSecondsLimit: number
  geminiInputCharsLimit: number
}

export type BillingInvoice = {
  id?: number
  orderCode: number
  status: string
  amountVnd: number
  planCode?: string | null
  description?: string
  checkoutUrl?: string | null
  createdAt?: string
  paidAt?: string | null
}

export type SubscriptionPlan = {
  id: number
  code: string
  name: string
  description?: string | null
  priceVnd: number
  currency: string
  billingPeriod: string
  advertisementEnabled: boolean
  recordingMinutesLimit: number
  aiAnalysisLimit: number
  uploadLimit: number
  flashcardLimit: number
  quizLimit: number
  mindmapLimit: number
  exportLimit: number
  featuresJson?: string | null
  active: boolean
  sortOrder: number
}

export type BillingOverview = {
  userId: number
  plan: string
  quota: QuotaSnapshot
  invoices: BillingInvoice[]
  plans?: SubscriptionPlan[]
  standardPriceVnd?: number
  premiumPriceVnd?: number
  proPriceVnd?: number
  advertisementEnabled?: boolean
  payosEnabled?: boolean
  trialActive?: boolean
  planExpiresAt?: string | null
}

export type CheckoutPlanResult = {
  orderCode: number
  checkoutUrl: string | null
  paymentLinkId?: string | null
  status: string
  amountVnd: number
  planCode?: string | null
}

export type CheckoutProResult = CheckoutPlanResult

const authHeaders = (): HeadersInit => {
  const token = getAccessToken()
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn')
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

const normalizeQuota = (raw: unknown): QuotaSnapshot => {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    plan: String(record.plan ?? 'FREE'),
    periodYyyymm: String(record.periodYyyymm ?? record.period_yyyymm ?? ''),
    sttSecondsUsed: Number(record.sttSecondsUsed ?? record.stt_seconds_used ?? 0),
    geminiInputCharsUsed: Number(record.geminiInputCharsUsed ?? record.gemini_input_chars_used ?? 0),
    sttSecondsLimit: Number(record.sttSecondsLimit ?? record.stt_seconds_limit ?? 0),
    geminiInputCharsLimit: Number(record.geminiInputCharsLimit ?? record.gemini_input_chars_limit ?? 0),
  }
}

const normalizeInvoice = (raw: unknown): BillingInvoice => {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    id: record.id == null ? undefined : Number(record.id),
    orderCode: Number(record.orderCode ?? record.order_code ?? 0),
    status: String(record.status ?? 'PENDING'),
    amountVnd: Number(record.amountVnd ?? record.amount_vnd ?? 0),
    planCode: record.planCode == null
      ? (record.plan_code == null ? null : String(record.plan_code))
      : String(record.planCode),
    description: record.description == null ? undefined : String(record.description),
    checkoutUrl: record.checkoutUrl == null
      ? (record.checkout_url == null ? null : String(record.checkout_url))
      : String(record.checkoutUrl),
    createdAt: record.createdAt == null
      ? (record.created_at == null ? undefined : String(record.created_at))
      : String(record.createdAt),
    paidAt: record.paidAt == null
      ? (record.paid_at == null ? null : String(record.paid_at))
      : String(record.paidAt),
  }
}

export const getBillingOverview = async (): Promise<BillingOverview> => {
  const response = await fetch(`${USER_API_BASE}/api/billing/me`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(payload?.message || `Không tải được thông tin gói (${response.status})`)
  }
  const data = await response.json() as Record<string, unknown>
  const invoicesRaw = Array.isArray(data.invoices) ? data.invoices : []
  const plansRaw = Array.isArray(data.plans) ? data.plans : []
  return {
    userId: Number(data.userId ?? data.user_id ?? 0),
    plan: String(data.plan ?? 'FREE'),
    quota: normalizeQuota(data.quota),
    invoices: invoicesRaw.map(normalizeInvoice),
    plans: plansRaw.map(normalizeSubscriptionPlan),
    standardPriceVnd: Number(data.standardPriceVnd ?? data.standard_price_vnd ?? data.proPriceVnd ?? 0),
    premiumPriceVnd: Number(data.premiumPriceVnd ?? data.premium_price_vnd ?? 0),
    proPriceVnd: Number(data.proPriceVnd ?? data.pro_price_vnd ?? 0),
    advertisementEnabled: data.advertisementEnabled === true || data.advertisement_enabled === true ? true : undefined,
    payosEnabled: data.payosEnabled === true || data.payos_enabled === true ? true : undefined,
    trialActive: data.trialActive === true || data.trial_active === true ? true : undefined,
    planExpiresAt: data.planExpiresAt == null
      ? (data.plan_expires_at == null ? null : String(data.plan_expires_at))
      : String(data.planExpiresAt),
  }
}

export const getBillingOrderStatus = async (orderCode: number): Promise<BillingInvoice> => {
  const response = await fetch(`${USER_API_BASE}/api/billing/orders/${orderCode}`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(payload?.message || `Không tải được trạng thái đơn hàng (${response.status})`)
  }
  return normalizeInvoice(await response.json())
}

export const syncBillingOrder = async (orderCode: number): Promise<BillingInvoice> => {
  const response = await fetch(`${USER_API_BASE}/api/billing/orders/${orderCode}/sync`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(payload?.message || `Không đồng bộ được trạng thái thanh toán (${response.status})`)
  }
  return normalizeInvoice(await response.json())
}

const BILLING_POLL_DELAYS_MS = [1000, 2000, 4000, 8000, 12000]

export const pollBillingActivation = async (
  orderCode: number,
  options: { maxAttempts?: number } = {},
): Promise<{ invoice: BillingInvoice; overview: BillingOverview }> => {
  const maxAttempts = options.maxAttempts ?? BILLING_POLL_DELAYS_MS.length

  try {
    await syncBillingOrder(orderCode)
  } catch {
    // Webhook may have already updated the invoice; continue polling.
  }

  let invoice = await getBillingOrderStatus(orderCode)

  for (let attempt = 0; attempt < maxAttempts && invoice.status !== 'PAID'; attempt += 1) {
    const delay = BILLING_POLL_DELAYS_MS[Math.min(attempt, BILLING_POLL_DELAYS_MS.length - 1)]
    await new Promise((resolve) => window.setTimeout(resolve, delay))
    invoice = await getBillingOrderStatus(orderCode)
    if (invoice.status === 'PAID') {
      break
    }
  }

  const overview = await getBillingOverview()
  return { invoice, overview }
}

const checkoutPlan = async (plan: string): Promise<CheckoutPlanResult> => {
  const response = await fetch(`${USER_API_BASE}/api/billing/checkout/${encodeURIComponent(plan)}`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(payload?.message || `Không tạo được link thanh toán (${response.status})`)
  }
  const data = await response.json() as Record<string, unknown>
  return {
    orderCode: Number(data.orderCode ?? data.order_code ?? 0),
    checkoutUrl: data.checkoutUrl == null
      ? (data.checkout_url == null ? null : String(data.checkout_url))
      : String(data.checkoutUrl),
    paymentLinkId: data.paymentLinkId == null
      ? (data.payment_link_id == null ? null : String(data.payment_link_id))
      : String(data.paymentLinkId),
    status: String(data.status ?? 'PENDING'),
    amountVnd: Number(data.amountVnd ?? data.amount_vnd ?? 0),
    planCode: data.planCode == null
      ? (data.plan_code == null ? null : String(data.plan_code))
      : String(data.planCode),
  }
}

export const normalizeSubscriptionPlan = (raw: unknown): SubscriptionPlan => {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    id: Number(record.id ?? 0),
    code: String(record.code ?? '').toUpperCase(),
    name: String(record.name ?? record.code ?? ''),
    description: record.description == null ? null : String(record.description),
    priceVnd: Number(record.priceVnd ?? record.price_vnd ?? 0),
    currency: String(record.currency ?? 'VND').toUpperCase(),
    billingPeriod: String(record.billingPeriod ?? record.billing_period ?? 'MONTHLY').toUpperCase(),
    advertisementEnabled: record.advertisementEnabled === true || record.advertisement_enabled === true,
    recordingMinutesLimit: Number(record.recordingMinutesLimit ?? record.recording_minutes_limit ?? 0),
    aiAnalysisLimit: Number(record.aiAnalysisLimit ?? record.ai_analysis_limit ?? 0),
    uploadLimit: Number(record.uploadLimit ?? record.upload_limit ?? 0),
    flashcardLimit: Number(record.flashcardLimit ?? record.flashcard_limit ?? 0),
    quizLimit: Number(record.quizLimit ?? record.quiz_limit ?? 0),
    mindmapLimit: Number(record.mindmapLimit ?? record.mindmap_limit ?? 0),
    exportLimit: Number(record.exportLimit ?? record.export_limit ?? 0),
    featuresJson: record.featuresJson == null
      ? (record.features_json == null ? null : String(record.features_json))
      : String(record.featuresJson),
    active: record.active !== false && record.isActive !== false && record.is_active !== false,
    sortOrder: Number(record.sortOrder ?? record.sort_order ?? 0),
  }
}

export const getSubscriptionPlans = async (): Promise<SubscriptionPlan[]> => {
  const response = await fetch(`${USER_API_BASE}/api/plans`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(payload?.message || `Không tải được danh sách gói (${response.status})`)
  }
  const data = await response.json() as Record<string, unknown>
  const rawItems = Array.isArray(data.items) ? data.items : []
  return rawItems.map(normalizeSubscriptionPlan)
}

export const checkoutSubscriptionPlan = async (planCode: string): Promise<CheckoutPlanResult> => (
  checkoutPlan(planCode.trim().toLowerCase())
)

export const checkoutStandardPlan = async (): Promise<CheckoutPlanResult> => checkoutPlan('standard')

export const checkoutPremiumPlan = async (): Promise<CheckoutPlanResult> => checkoutPlan('premium')

/** Backward-compatible alias; legacy Pro is now Standard. */
export const checkoutProPlan = async (): Promise<CheckoutProResult> => checkoutStandardPlan()

export const formatQuotaPercent = (used: number, limit: number): number => {
  if (!Number.isFinite(limit) || limit <= 0) return 0
  return Math.min(100, Math.round((used / limit) * 100))
}

export const formatDurationShort = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 phút'
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  if (hours > 0) return `${hours}g ${remMin}p`
  return `${minutes} phút`
}

export const formatCharsShort = (chars: number): string => {
  if (!Number.isFinite(chars) || chars <= 0) return '0'
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M`
  if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)}K`
  return String(chars)
}
