import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  resolveNotificationMeetingId,
  subscribeNotificationStream,
  type UserNotification,
} from '../../services/notifications'
import { formatDateTimeVi, formatNotificationType } from '../../utils/uiLabels'

type NotificationCenterProps = {
  onOpenMeeting: (meetingId: number) => void
}

export default function NotificationCenter({ onOpenMeeting }: NotificationCenterProps) {
  const [open, setOpen] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [items, setItems] = useState<UserNotification[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const refreshUnread = useCallback(async () => {
    try {
      const count = await getUnreadNotificationCount()
      setUnreadCount(count)
    } catch {
      setUnreadCount(0)
    }
  }, [])

  const loadItems = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await listNotifications({ limit: 20 })
      setItems(response.items)
      setUnreadCount(response.unreadCount)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Không tải được thông báo')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshUnread()
    const unsubscribe = subscribeNotificationStream({
      onEvent: (event) => {
        setUnreadCount(event.unreadCount)
        setItems((current) => {
          const withoutDuplicate = current.filter((item) => item.id !== event.notification.id)
          return [event.notification, ...withoutDuplicate].slice(0, 20)
        })
      },
    })
    return () => {
      unsubscribe()
    }
  }, [refreshUnread])

  useEffect(() => {
    if (!open) return
    void loadItems()
  }, [loadItems, open])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const handleToggle = () => {
    setOpen((value) => !value)
  }

  const handleItemClick = async (notification: UserNotification) => {
    try {
      if (!notification.read) {
        await markNotificationRead(notification.id)
        setUnreadCount((count) => Math.max(0, count - 1))
        setItems((current) =>
          current.map((item) =>
            item.id === notification.id ? { ...item, read: true } : item,
          ),
        )
      }
      const meetingId = resolveNotificationMeetingId(notification)
      if (meetingId) {
        onOpenMeeting(meetingId)
        setOpen(false)
      }
    } catch (clickError) {
      setError(clickError instanceof Error ? clickError.message : 'Không mở được thông báo')
    }
  }

  const handleMarkAllRead = async () => {
    try {
      await markAllNotificationsRead()
      setUnreadCount(0)
      setItems((current) => current.map((item) => ({ ...item, read: true })))
    } catch (markError) {
      setError(markError instanceof Error ? markError.message : 'Không cập nhật được thông báo')
    }
  }

  return (
    <div className="notification-center" ref={panelRef}>
      <button
        type="button"
        className="notification-center__trigger"
        aria-label="Thông báo"
        aria-expanded={open}
        onClick={handleToggle}
        data-testid="notification-center-trigger"
      >
        <span className="notification-center__icon" aria-hidden>🔔</span>
        {unreadCount > 0 && (
          <span className="notification-center__badge" data-testid="notification-unread-badge">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="notification-center__panel" role="dialog" aria-label="Thông báo">
          <div className="notification-center__header">
            <strong>Thông báo</strong>
            {unreadCount > 0 && (
              <button type="button" className="notification-center__mark-all" onClick={() => void handleMarkAllRead()}>
                Đánh dấu đã đọc
              </button>
            )}
          </div>

          {loading && <p className="notification-center__status">Đang tải…</p>}
          {error && <p className="notification-center__error">{error}</p>}

          {!loading && items.length === 0 && (
            <p className="notification-center__empty">Chưa có thông báo mới</p>
          )}

          <ul className="notification-center__list">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`notification-center__item${item.read ? '' : ' notification-center__item--unread'}`}
                  onClick={() => void handleItemClick(item)}
                >
                  <span className="notification-center__item-type">
                    {formatNotificationType(item.type)}
                  </span>
                  <span className="notification-center__item-title">{item.title}</span>
                  {item.body && <span className="notification-center__item-body">{item.body}</span>}
                  <span className="notification-center__item-time">
                    {formatDateTimeVi(item.createdAt ?? undefined)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
