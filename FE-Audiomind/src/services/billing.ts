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
  description?: string
  checkoutUrl?: string | null
  createdAt?: string
  paidAt?: string | null
}

export type BillingOverview = {
  userId: number
  plan: string
  quota: QuotaSnapshot
  invoices: BillingInvoice[]
  proPriceVnd?: number
  payosEnabled?: boolean
  trialActive?: boolean
  planExpiresAt?: string | null
}

export type CheckoutProResult = {
  orderCode: number
  checkoutUrl: string | null
  paymentLinkId?: string | null
  status: string
  amountVnd: number
}

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
  return {
    userId: Number(data.userId ?? data.user_id ?? 0),
    plan: String(data.plan ?? 'FREE'),
    quota: normalizeQuota(data.quota),
    invoices: invoicesRaw.map(normalizeInvoice),
    proPriceVnd: Number(data.proPriceVnd ?? data.pro_price_vnd ?? 79000),
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

export const checkoutProPlan = async (): Promise<CheckoutProResult> => {
  const response = await fetch(`${USER_API_BASE}/api/billing/checkout/pro`, {
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
  }
}

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
