import { useCallback, useEffect, useMemo, useState } from 'react'
import { Filter, ShieldAlert } from 'lucide-react'
import { listAuditEvents, type AuditEvent, type AuditEventFilters } from '../../services/admin'
import { LoadingState } from '../ui/LoadingState'
import './account-scenes.css'

type Props = {
  role?: string
  onNavigateAdmin: () => void
}

const EVENT_OPTIONS = [
  { value: '', label: 'Tất cả sự kiện' },
  { value: 'ADMIN_USER_ROLE_CHANGED', label: 'Đổi quyền user' },
  { value: 'ADMIN_USER_PLAN_CHANGED', label: 'Đổi gói user' },
  { value: 'ADMIN_BILLING_MANUAL_PAID', label: 'Manual paid billing' },
  { value: 'ADMIN_USER_API_KEY_CREATED', label: 'Tạo API key' },
  { value: 'ADMIN_USER_API_KEY_REVOKED', label: 'Thu hồi API key' },
  { value: 'ADMIN_RUNTIME_CONFIG_UPDATED', label: 'Cập nhật cấu hình' },
  { value: 'ADMIN_RUNTIME_CONFIG_DEPLOYED', label: 'Deploy cấu hình' },
  { value: 'ACCOUNT_PASSWORD_CHANGED', label: 'Đổi mật khẩu' },
  { value: 'ACCOUNT_LOGOUT_ALL', label: 'Đăng xuất mọi thiết bị' },
]

const toIsoBoundary = (date: string, endOfDay = false): string | undefined => {
  if (!date) return undefined
  return `${date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
}

const eventLabel = (eventType: string) => (
  EVENT_OPTIONS.find((option) => option.value === eventType)?.label || eventType
)

export default function AuditLogScene({ role = 'USER', onNavigateAdmin }: Props) {
  const isAdmin = role.toUpperCase() === 'ADMIN'
  const [items, setItems] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(isAdmin)
  const [error, setError] = useState('')
  const [actorFilter, setActorFilter] = useState('')
  const [eventFilter, setEventFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  const filters = useMemo<AuditEventFilters>(() => {
    const parsedActor = Number(actorFilter)
    return {
      actorUserId: Number.isFinite(parsedActor) && parsedActor > 0 ? parsedActor : undefined,
      eventType: eventFilter || undefined,
      from: toIsoBoundary(fromDate),
      to: toIsoBoundary(toDate, true),
      limit: 150,
    }
  }, [actorFilter, eventFilter, fromDate, toDate])

  const load = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    setError('')
    try {
      setItems(await listAuditEvents(filters))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được audit log')
    } finally {
      setLoading(false)
    }
  }, [filters, isAdmin])

  useEffect(() => {
    void load()
  }, [load])

  const resetFilters = () => {
    setActorFilter('')
    setEventFilter('')
    setFromDate('')
    setToDate('')
  }

  if (!isAdmin) {
    return <section className="feature-scene account-scene"><div className="account-warning"><strong>Không có quyền admin.</strong></div></section>
  }

  return (
    <section className="feature-scene account-scene" data-testid="audit-log-scene">
      <header className="account-scene__hero">
        <div>
          <p className="account-scene__eyebrow">Audit / Activity Log</p>
          <h1>Log quản trị</h1>
          <p className="account-scene__subtitle">Theo dõi thao tác admin, cấu hình runtime, API key và bảo mật tài khoản.</p>
        </div>
        <button type="button" className="btn btn--secondary" onClick={onNavigateAdmin}>Mở Admin Dashboard</button>
      </header>
      {error && <div className="account-error" role="alert">{error}</div>}
      <article className="account-card account-card--wide">
        <h2><Filter size={18} aria-hidden /> Bộ lọc</h2>
        <div className="account-filter-row">
          <input
            className="account-input"
            inputMode="numeric"
            value={actorFilter}
            onChange={(event) => setActorFilter(event.target.value)}
            placeholder="Mã actor"
          />
          <select className="account-select" value={eventFilter} onChange={(event) => setEventFilter(event.target.value)}>
            {EVENT_OPTIONS.map((option) => <option key={option.value || 'all'} value={option.value}>{option.label}</option>)}
          </select>
          <input className="account-input" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} aria-label="Từ ngày" />
          <input className="account-input" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} aria-label="Đến ngày" />
          <button type="button" className="btn btn--secondary" onClick={() => void load()} disabled={loading}>
            Lọc
          </button>
          <button type="button" className="btn btn--secondary" onClick={resetFilters} disabled={loading}>
            Xóa lọc
          </button>
        </div>
      </article>
      <article className="account-card account-card--wide">
        <h2><ShieldAlert size={18} aria-hidden /> Sự kiện quản trị</h2>
        {loading ? <LoadingState message="Đang tải audit log..." /> : (
          <div className="account-table-wrap">
            <table className="account-table">
              <thead><tr><th>Thời gian</th><th>Actor</th><th>Sự kiện</th><th>Target</th><th>Tóm tắt</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.createdAt ? new Date(item.createdAt).toLocaleString('vi-VN') : ''}</td>
                    <td>{item.actorUserId ?? ''}</td>
                    <td>{eventLabel(item.eventType)}</td>
                    <td>{[item.targetType, item.targetId].filter(Boolean).join(':')}</td>
                    <td>{item.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {items.length === 0 && <div className="account-empty">Chưa có audit event phù hợp.</div>}
          </div>
        )}
      </article>
    </section>
  )
}
