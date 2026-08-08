import { getAccessToken } from './auth'
import { USER_API_BASE } from './config'
import { normalizeSubscriptionPlan, type SubscriptionPlan } from './billing'
import { type AdvertisementItem } from './advertisements'

export type AdminUser = {
  id: number
  username: string
  email?: string | null
  plan: string
  role: string
  createdAt?: string | null
}

export type ManualPaidResult = {
  orderCode: number
  status?: string
  message?: string
}

export type AuditEvent = {
  id: number
  actorUserId?: number | null
  eventType: string
  targetType?: string | null
  targetId?: string | null
  summary: string
  metadata?: Record<string, unknown>
  createdAt?: string | null
}

export type AdminTransaction = {
  id: number
  userId: number
  provider: string
  orderCode: number
  paymentLinkId?: string | null
  planCode?: string | null
  amountVnd: number
  currency: string
  status: string
  description?: string | null
  createdAt?: string | null
  paidAt?: string | null
  cancelledAt?: string | null
  expiredAt?: string | null
  manualNote?: string | null
}

export type AdminApiKey = {
  id: number
  userId: number
  name: string
  prefix: string
  suffix: string
  scopes: string
  createdAt?: string | null
  revokedAt?: string | null
  lastUsedAt?: string | null
  apiKey?: string
}

export type RuntimeConfigItem = {
  key: string
  label: string
  group: string
  secret: boolean
  configured: boolean
  value: string
}

export type RuntimeConfigView = {
  envFile: string
  workdir: string
  items: RuntimeConfigItem[]
}

export type RuntimeDeployCommand = {
  command: string[]
  exitCode: number
  output: string
}

export type RuntimeDeployResult = {
  target: 'local' | 'vps'
  services: string[]
  commands: RuntimeDeployCommand[]
  success: boolean
}

export type RuntimeConfigUpdateResult = {
  updatedKeys: string[]
  config: RuntimeConfigView
  deploy?: RuntimeDeployResult | null
}

export type AuditEventFilters = {
  actorUserId?: number
  eventType?: string
  from?: string
  to?: string
  limit?: number
}

const authHeaders = (): HeadersInit => {
  const token = getAccessToken()
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn')
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

const readMessage = async (response: Response, fallback: string): Promise<string> => {
  const payload = await response.json().catch(() => null) as { message?: string; error?: string } | null
  return payload?.message || payload?.error || fallback
}

const normalizeUser = (raw: unknown): AdminUser => {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    id: Number(record.id ?? record.userId ?? record.user_id ?? 0),
    username: String(record.username ?? record.name ?? ''),
    email: record.email == null ? null : String(record.email),
    plan: String(record.plan ?? 'FREE').toUpperCase(),
    role: String(record.role ?? 'USER').toUpperCase(),
    createdAt: record.createdAt == null
      ? (record.created_at == null ? null : String(record.created_at))
      : String(record.createdAt),
  }
}

export const listAdminUsers = async (): Promise<AdminUser[]> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/users`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không tải được danh sách người dùng'))
  }
  const body = await response.json()
  const rawUsers: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as Record<string, unknown>)?.items)
      ? ((body as Record<string, unknown>).items as unknown[])
      : []
  return rawUsers.map(normalizeUser)
}

export type AdminPlan = string

export const updateAdminUserPlan = async (userId: number, plan: AdminPlan): Promise<AdminUser> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/users/${userId}/plan`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ plan }),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không cập nhật được gói người dùng'))
  }
  return normalizeUser(await response.json())
}

export type AdminPlanPayload = Omit<SubscriptionPlan, 'id'> & { id?: number }

export type AdminAdvertisementPayload = {
  brandName: string
  title: string
  description?: string | null
  mediaUrl?: string | null
  thumbnailUrl?: string | null
  targetUrl?: string | null
  type: string
  placement: string
  duration?: number | null
  status: string
  targetPlans: string[]
  startAt?: string | null
  endAt?: string | null
}

export const listAdminPlans = async (): Promise<SubscriptionPlan[]> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/plans`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không tải được danh sách gói'))
  }
  const body = await response.json() as { items?: unknown[] }
  return Array.isArray(body.items) ? body.items.map(normalizeSubscriptionPlan) : []
}

export const saveAdminPlan = async (payload: AdminPlanPayload): Promise<SubscriptionPlan> => {
  const isUpdate = payload.id != null && payload.id > 0
  const response = await fetch(`${USER_API_BASE}/api/admin/plans${isUpdate ? `/${payload.id}` : ''}`, {
    method: isUpdate ? 'PUT' : 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không lưu được gói'))
  }
  return normalizeSubscriptionPlan(await response.json())
}

export const updateAdminPlanStatus = async (planId: number, active: boolean): Promise<SubscriptionPlan> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/plans/${planId}/status`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ active }),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không cập nhật trạng thái gói'))
  }
  return normalizeSubscriptionPlan(await response.json())
}

const normalizeAdvertisement = (raw: unknown): AdvertisementItem => {
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
    targetPlans: Array.isArray(record.targetPlans) ? record.targetPlans.map(String) : [],
    label: String(record.brandName ?? 'Sponsored'),
    title: String(record.title ?? ''),
    body: String(record.description ?? record.body ?? ''),
    ctaLabel: 'Mở quảng cáo',
  }
}

export const listAdminAdvertisements = async (): Promise<AdvertisementItem[]> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/advertisements`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không tải được danh sách quảng cáo'))
  }
  const body = await response.json() as { items?: unknown[] }
  return Array.isArray(body.items) ? body.items.map(normalizeAdvertisement) : []
}

export const saveAdminAdvertisement = async (payload: AdminAdvertisementPayload & { id?: number }): Promise<AdvertisementItem> => {
  const isUpdate = payload.id != null && Number(payload.id) > 0
  const response = await fetch(`${USER_API_BASE}/api/admin/advertisements${isUpdate ? `/${payload.id}` : ''}`, {
    method: isUpdate ? 'PUT' : 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      ...payload,
      startAt: normalizeInstantInput(payload.startAt),
      endAt: normalizeInstantInput(payload.endAt),
    }),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không lưu được quảng cáo'))
  }
  return normalizeAdvertisement(await response.json())
}

const normalizeInstantInput = (value?: string | null): string | null => {
  if (!value?.trim()) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

export const updateAdminAdvertisementStatus = async (adId: number, status: string): Promise<AdvertisementItem> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/advertisements/${adId}/status`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ status }),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không cập nhật trạng thái quảng cáo'))
  }
  return normalizeAdvertisement(await response.json())
}

export const updateAdminUserRole = async (userId: number, role: 'USER' | 'ADMIN'): Promise<AdminUser> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/users/${userId}/role`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ role }),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không cập nhật được quyền người dùng'))
  }
  return normalizeUser(await response.json())
}

export const markBillingOrderPaid = async (orderCode: number, note: string): Promise<ManualPaidResult> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/billing/manual-paid`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ orderCode, note }),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không ghi nhận được thanh toán thủ công'))
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  return {
    orderCode: Number(body.orderCode ?? body.order_code ?? orderCode),
    status: body.status == null ? undefined : String(body.status),
    message: body.message == null ? undefined : String(body.message),
  }
}

export const listAdminTransactions = async (filters: {
  userId?: number
  status?: string
  limit?: number
} = {}): Promise<AdminTransaction[]> => {
  const params = new URLSearchParams()
  params.set('limit', String(filters.limit ?? 100))
  if (filters.userId != null) params.set('userId', String(filters.userId))
  if (filters.status?.trim()) params.set('status', filters.status.trim().toUpperCase())
  const response = await fetch(`${USER_API_BASE}/api/admin/billing/transactions?${params.toString()}`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không tải được danh sách giao dịch'))
  }
  const body = await response.json() as { items?: unknown[] }
  return Array.isArray(body.items) ? body.items.map(normalizeTransaction) : []
}

const normalizeTransaction = (raw: unknown): AdminTransaction => {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    id: Number(record.id ?? 0),
    userId: Number(record.userId ?? record.user_id ?? 0),
    provider: String(record.provider ?? 'PAYOS'),
    orderCode: Number(record.orderCode ?? record.order_code ?? 0),
    paymentLinkId: record.paymentLinkId == null
      ? (record.payment_link_id == null ? null : String(record.payment_link_id))
      : String(record.paymentLinkId),
    planCode: record.planCode == null
      ? (record.plan_code == null ? null : String(record.plan_code))
      : String(record.planCode),
    amountVnd: Number(record.amountVnd ?? record.amount_vnd ?? 0),
    currency: String(record.currency ?? 'VND'),
    status: String(record.status ?? 'PENDING'),
    description: record.description == null ? null : String(record.description),
    createdAt: record.createdAt == null
      ? (record.created_at == null ? null : String(record.created_at))
      : String(record.createdAt),
    paidAt: record.paidAt == null ? (record.paid_at == null ? null : String(record.paid_at)) : String(record.paidAt),
    cancelledAt: record.cancelledAt == null
      ? (record.cancelled_at == null ? null : String(record.cancelled_at))
      : String(record.cancelledAt),
    expiredAt: record.expiredAt == null
      ? (record.expired_at == null ? null : String(record.expired_at))
      : String(record.expiredAt),
    manualNote: record.manualNote == null
      ? (record.manual_note == null ? null : String(record.manual_note))
      : String(record.manualNote),
  }
}

export const listUserApiKeys = async (userId: number): Promise<AdminApiKey[]> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/users/${userId}/api-keys`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không tải được API key của user'))
  }
  const body = await response.json() as { items?: AdminApiKey[] }
  return Array.isArray(body.items) ? body.items : []
}

export const createUserApiKey = async (
  userId: number,
  payload: { name: string; scopes?: string },
): Promise<AdminApiKey> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/users/${userId}/api-keys`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không tạo được API key'))
  }
  return response.json() as Promise<AdminApiKey>
}

export const revokeUserApiKey = async (userId: number, keyId: number): Promise<AdminApiKey> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/users/${userId}/api-keys/${keyId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không thu hồi được API key'))
  }
  return response.json() as Promise<AdminApiKey>
}

export const getRuntimeConfig = async (): Promise<RuntimeConfigView> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/runtime-config`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không tải được cấu hình runtime'))
  }
  return response.json() as Promise<RuntimeConfigView>
}

export const updateRuntimeConfig = async (payload: {
  values: Record<string, string>
  deployTarget: 'local' | 'vps'
  deploy: boolean
}): Promise<RuntimeConfigUpdateResult> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/runtime-config`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không lưu được cấu hình runtime'))
  }
  return response.json() as Promise<RuntimeConfigUpdateResult>
}

export const deployRuntimeConfig = async (payload: {
  target: 'local' | 'vps'
  services?: string[]
}): Promise<RuntimeDeployResult> => {
  const response = await fetch(`${USER_API_BASE}/api/admin/runtime-config/deploy`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không deploy được cấu hình runtime'))
  }
  return response.json() as Promise<RuntimeDeployResult>
}

export const listAuditEvents = async (filters: AuditEventFilters | number = 100): Promise<AuditEvent[]> => {
  const normalizedFilters: AuditEventFilters = typeof filters === 'number' ? { limit: filters } : filters
  const params = new URLSearchParams()
  params.set('limit', String(normalizedFilters.limit ?? 100))
  if (normalizedFilters.actorUserId != null) params.set('actorUserId', String(normalizedFilters.actorUserId))
  if (normalizedFilters.eventType?.trim()) params.set('eventType', normalizedFilters.eventType.trim().toUpperCase())
  if (normalizedFilters.from) params.set('from', normalizedFilters.from)
  if (normalizedFilters.to) params.set('to', normalizedFilters.to)

  const response = await fetch(`${USER_API_BASE}/api/admin/audit-events?${params.toString()}`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    throw new Error(await readMessage(response, 'Không tải được audit log'))
  }
  const body = await response.json() as { items?: AuditEvent[] }
  return Array.isArray(body.items) ? body.items : []
}
