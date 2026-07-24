import { useCallback, useEffect, useState } from 'react'
import { Bell, CheckCheck, ExternalLink } from 'lucide-react'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  resolveNotificationMeetingId,
  type UserNotification,
} from '../../services/notifications'
import { LoadingState } from '../ui/LoadingState'
import './account-scenes.css'

type Props = {
  onOpenMeeting: (meetingId: number) => void
}

const formatType = (type: string): string => {
  const normalized = type.toUpperCase()
  if (normalized.includes('INVITE')) return 'Lời mời'
  if (normalized.includes('SHARE')) return 'Chia sẻ'
  if (normalized.includes('FAILED')) return 'Job lỗi'
  if (normalized.includes('TASK')) return 'Công việc'
  return 'Thông báo'
}

export default function NotificationsScene({ onOpenMeeting }: Props) {
  const [items, setItems] = useState<UserNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await listNotifications({ unreadOnly, limit: 100 })
      setItems(response.items)
      setUnreadCount(response.unreadCount)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được thông báo')
    } finally {
      setLoading(false)
    }
  }, [unreadOnly])

  useEffect(() => {
    void load()
  }, [load])

  const handleRead = async (notification: UserNotification) => {
    setError('')
    try {
      const updated = await markNotificationRead(notification.id)
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setUnreadCount((count) => Math.max(0, count - (notification.read ? 0 : 1)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không cập nhật được thông báo')
    }
  }

  const handleReadAll = async () => {
    setError('')
    try {
      await markAllNotificationsRead()
      setItems((current) => current.map((item) => ({ ...item, read: true, readAt: new Date().toISOString() })))
      setUnreadCount(0)
      setNotice('Đã đánh dấu tất cả là đã đọc.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không cập nhật được thông báo')
    }
  }

  return (
    <section className="feature-scene account-scene" data-testid="notifications-scene">
      <header className="account-scene__hero">
        <div>
          <p className="account-scene__eyebrow">Thông báo</p>
          <h1>Notification Center</h1>
          <p className="account-scene__subtitle">Theo dõi invite, share, task và job failed ở dạng đầy đủ thay vì chỉ popover.</p>
        </div>
        <div className="account-actions">
          <button type="button" className="btn btn--secondary" onClick={() => setUnreadOnly((value) => !value)}>
            {unreadOnly ? 'Xem tất cả' : 'Chỉ chưa đọc'}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void handleReadAll()} disabled={unreadCount === 0}>
            <CheckCheck size={16} aria-hidden /> Đọc tất cả
          </button>
        </div>
      </header>

      {notice && <div className="account-notice" role="status">{notice}</div>}
      {error && <div className="account-error" role="alert">{error}</div>}

      <article className="account-card account-card--wide">
        <div className="account-row">
          <h2><Bell size={18} aria-hidden /> Danh sách thông báo</h2>
          <span className="account-badge">{unreadCount} chưa đọc</span>
        </div>
        {loading ? (
          <LoadingState message="Đang tải thông báo..." />
        ) : (
          <ul className="account-list">
            {items.map((item) => {
              const meetingId = resolveNotificationMeetingId(item)
              return (
                <li key={item.id}>
                  <div className="account-row">
                    <div>
                      <span className="account-badge">{formatType(item.type)}</span>
                      {!item.read && <span className="account-badge">Mới</span>}
                    </div>
                    <span className="account-label">{item.createdAt ? new Date(item.createdAt).toLocaleString('vi-VN') : ''}</span>
                  </div>
                  <h3>{item.title || 'Thông báo'}</h3>
                  {item.body && <p className="account-muted">{item.body}</p>}
                  <div className="account-actions">
                    {!item.read && (
                      <button type="button" className="btn btn--secondary" onClick={() => void handleRead(item)}>
                        Đánh dấu đã đọc
                      </button>
                    )}
                    {meetingId != null && (
                      <button type="button" className="btn btn--primary" onClick={() => onOpenMeeting(meetingId)}>
                        <ExternalLink size={16} aria-hidden /> Mở meeting
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
            {items.length === 0 && <li className="account-empty">Không có thông báo phù hợp.</li>}
          </ul>
        )}
      </article>
    </section>
  )
}
