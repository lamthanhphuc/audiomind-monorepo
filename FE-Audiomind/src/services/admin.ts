import { getAccessToken } from './auth'
import { USER_API_BASE } from './config'

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

export const updateAdminUserPlan = async (userId: number, plan: 'FREE' | 'PRO'): Promise<AdminUser> => {
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
  const body = await response.json() as { items?: AdminTransaction[] }
  return Array.isArray(body.items) ? body.items : []
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
