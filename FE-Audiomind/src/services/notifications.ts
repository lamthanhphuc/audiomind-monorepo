import { getAccessToken } from './auth'
import { USER_API_BASE } from './config'

export type UserNotificationPayload = {
  meetingId?: number
  inviterUserId?: number
  role?: string
  meetingTitle?: string
}

export type UserNotification = {
  id: number
  type: string
  title: string
  body?: string | null
  payload: UserNotificationPayload
  read: boolean
  readAt?: string | null
  createdAt?: string | null
}

export type NotificationListResponse = {
  items: UserNotification[]
  unreadCount: number
}

const authHeaders = (): HeadersInit => {
  const token = getAccessToken()
  if (!token) throw new Error('Phiên đăng nhập đã hết hạn')
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

const normalizeNotification = (raw: unknown): UserNotification => {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const payloadRaw = record.payload
  const payload =
    payloadRaw && typeof payloadRaw === 'object' ? (payloadRaw as UserNotificationPayload) : {}
  return {
    id: Number(record.id ?? 0),
    type: String(record.type ?? ''),
    title: String(record.title ?? ''),
    body: record.body == null ? null : String(record.body),
    payload,
    read: Boolean(record.read),
    readAt: record.readAt == null ? null : String(record.readAt),
    createdAt: record.createdAt == null ? null : String(record.createdAt),
  }
}

export async function listNotifications(options?: {
  unreadOnly?: boolean
  limit?: number
}): Promise<NotificationListResponse> {
  const params = new URLSearchParams()
  if (options?.unreadOnly) params.set('unreadOnly', 'true')
  if (options?.limit) params.set('limit', String(options.limit))
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(`${USER_API_BASE}/api/users/me/notifications${suffix}`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    throw new Error('Không tải được thông báo')
  }
  const body = (await response.json()) as Record<string, unknown>
  const items = Array.isArray(body.items) ? body.items.map(normalizeNotification) : []
  return {
    items,
    unreadCount: Number(body.unreadCount ?? 0),
  }
}

export async function getUnreadNotificationCount(): Promise<number> {
  const response = await fetch(`${USER_API_BASE}/api/users/me/notifications/unread-count`, {
    headers: authHeaders(),
  })
  if (!response.ok) {
    return 0
  }
  const body = (await response.json()) as Record<string, unknown>
  return Number(body.unreadCount ?? 0)
}

export async function markNotificationRead(notificationId: number): Promise<UserNotification> {
  const response = await fetch(
    `${USER_API_BASE}/api/users/me/notifications/${notificationId}/read`,
    { method: 'PATCH', headers: authHeaders() },
  )
  if (!response.ok) {
    throw new Error('Không cập nhật được thông báo')
  }
  return normalizeNotification(await response.json())
}

export async function markAllNotificationsRead(): Promise<void> {
  const response = await fetch(`${USER_API_BASE}/api/users/me/notifications/read-all`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!response.ok) {
    throw new Error('Không cập nhật được thông báo')
  }
}

export function resolveNotificationMeetingId(notification: UserNotification): number | null {
  const meetingId = notification.payload?.meetingId
  if (typeof meetingId === 'number' && Number.isFinite(meetingId) && meetingId > 0) {
    return meetingId
  }
  return null
}

export type NotificationStreamEvent = {
  notification: UserNotification
  unreadCount: number
}

export function subscribeNotificationStream(handlers: {
  onEvent?: (event: NotificationStreamEvent) => void
  onConnected?: () => void
  onError?: () => void
}): () => void {
  const token = getAccessToken()
  if (!token || typeof EventSource === 'undefined') {
    return () => {}
  }

  const url = `${USER_API_BASE}/api/users/me/notifications/stream?access_token=${encodeURIComponent(token)}`
  const eventSource = new EventSource(url)

  eventSource.addEventListener('connected', () => {
    handlers.onConnected?.()
  })

  eventSource.addEventListener('notification', (message) => {
    try {
      const raw = JSON.parse(message.data) as Record<string, unknown>
      const notification = normalizeNotification(raw.notification)
      const unreadCount = Number(raw.unreadCount ?? 0)
      handlers.onEvent?.({ notification, unreadCount })
    } catch {
      handlers.onError?.()
    }
  })

  eventSource.onerror = () => {
    handlers.onError?.()
  }

  return () => {
    eventSource.close()
  }
}
