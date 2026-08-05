import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CreditCard, RefreshCw, Save, Server, UsersRound } from 'lucide-react'
import {
  deployRuntimeConfig,
  getRuntimeConfig,
  listAdminTransactions,
  listAdminUsers,
  markBillingOrderPaid,
  updateRuntimeConfig,
  updateAdminUserPlan,
  updateAdminUserRole,
  type AdminTransaction,
  type AdminUser,
  type RuntimeConfigItem,
  type RuntimeConfigView,
  type RuntimeDeployResult,
} from '../../services/admin'
import { LoadingState } from '../ui/LoadingState'
import './account-scenes.css'

type Props = {
  role?: string
}

type AdminTab = 'users' | 'runtimeConfig' | 'billing'

const formatMoney = (amount: number, currency = 'VND') => (
  currency.toUpperCase() === 'VND'
    ? `${amount.toLocaleString('vi-VN')}đ`
    : `${amount.toLocaleString('vi-VN')} ${currency}`
)

export default function AdminDashboardScene({ role = 'USER' }: Props) {
  const isAdmin = role.toUpperCase() === 'ADMIN'
  const [activeTab, setActiveTab] = useState<AdminTab>('users')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [transactions, setTransactions] = useState<AdminTransaction[]>([])
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfigView | null>(null)
  const [configDrafts, setConfigDrafts] = useState<Record<string, string>>({})
  const [deployTarget, setDeployTarget] = useState<'local' | 'vps'>('local')
  const [deployResult, setDeployResult] = useState<RuntimeDeployResult | null>(null)
  const [query, setQuery] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')
  const [transactionStatus, setTransactionStatus] = useState('')
  const [orderCode, setOrderCode] = useState('')
  const [manualNote, setManualNote] = useState('')
  const [loading, setLoading] = useState(isAdmin)
  const [busyUserId, setBusyUserId] = useState<number | null>(null)
  const [deploying, setDeploying] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const loadUsers = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    setError('')
    try {
      const loadedUsers = await listAdminUsers()
      setUsers(loadedUsers)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được danh sách user')
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  const loadBilling = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    setError('')
    try {
      const parsedUserId = Number(selectedUserId)
      setTransactions(await listAdminTransactions({
        userId: Number.isFinite(parsedUserId) && parsedUserId > 0 ? parsedUserId : undefined,
        status: transactionStatus || undefined,
        limit: 100,
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được billing')
    } finally {
      setLoading(false)
    }
  }, [isAdmin, selectedUserId, transactionStatus])

  const loadRuntimeConfig = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    setError('')
    try {
      setRuntimeConfig(await getRuntimeConfig())
      setConfigDrafts({})
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được cấu hình runtime')
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  const loadCurrentTab = useCallback(async () => {
    if (activeTab === 'runtimeConfig') {
      await loadRuntimeConfig()
      return
    }
    if (activeTab === 'billing') {
      await loadBilling()
      return
    }
    await loadUsers()
  }, [activeTab, loadBilling, loadRuntimeConfig, loadUsers])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  useEffect(() => {
    if (activeTab === 'runtimeConfig') void loadRuntimeConfig()
    if (activeTab === 'billing') void loadBilling()
  }, [activeTab, loadBilling, loadRuntimeConfig])

  const filteredUsers = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return users
    return users.filter((user) => (
      user.username.toLowerCase().includes(normalized)
      || String(user.email || '').toLowerCase().includes(normalized)
      || String(user.id).includes(normalized)
    ))
  }, [query, users])

  const userSummary = useMemo(() => {
    const total = users.length
    const pro = users.filter((user) => user.plan.toUpperCase() === 'PRO').length
    const admins = users.filter((user) => user.role.toUpperCase() === 'ADMIN').length
    return {
      total,
      visible: filteredUsers.length,
      pro,
      admins,
    }
  }, [filteredUsers.length, users])

  const applyUserUpdate = (updated: AdminUser) => {
    setUsers((items) => items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)))
  }

  const handlePlanChange = async (user: AdminUser, plan: 'FREE' | 'PRO') => {
    if (!window.confirm(`Xác nhận đổi gói user "${user.username || user.email || user.id}" sang ${plan}?`)) return
    setBusyUserId(user.id)
    setError('')
    setNotice('')
    try {
      applyUserUpdate(await updateAdminUserPlan(user.id, plan))
      setNotice('Đã cập nhật gói người dùng.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không cập nhật được gói')
    } finally {
      setBusyUserId(null)
    }
  }

  const handleRoleChange = async (user: AdminUser, nextRole: 'USER' | 'ADMIN') => {
    if (!window.confirm(`Thao tác nhạy cảm: xác nhận đổi quyền user "${user.username || user.email || user.id}" sang ${nextRole}?`)) return
    setBusyUserId(user.id)
    setError('')
    setNotice('')
    try {
      applyUserUpdate(await updateAdminUserRole(user.id, nextRole))
      setNotice('Đã cập nhật quyền người dùng.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không cập nhật được quyền')
    } finally {
      setBusyUserId(null)
    }
  }

  const handleConfigDraftChange = (key: string, value: string) => {
    setConfigDrafts((current) => ({ ...current, [key]: value }))
  }

  const nonEmptyConfigDrafts = () => Object.fromEntries(
    Object.entries(configDrafts).filter(([, value]) => value.trim().length > 0),
  )

  const handleSaveRuntimeConfig = async (deploy: boolean) => {
    const values = nonEmptyConfigDrafts()
    if (Object.keys(values).length === 0) {
      setError('Nhập ít nhất một giá trị cấu hình cần cập nhật.')
      return
    }
    if (deploy && !window.confirm(`Lưu cấu hình và deploy lại ${deployTarget.toUpperCase()} cho ai-api/celery-worker?`)) return
    setDeploying(deploy)
    setError('')
    setNotice('')
    setDeployResult(null)
    try {
      const result = await updateRuntimeConfig({ values, deploy, deployTarget })
      setRuntimeConfig(result.config)
      setConfigDrafts({})
      if (result.deploy) {
        setDeployResult(result.deploy)
      }
      setNotice(deploy ? 'Đã lưu cấu hình và chạy deploy.' : 'Đã lưu cấu hình runtime.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không lưu được cấu hình runtime')
    } finally {
      setDeploying(false)
    }
  }

  const handleDeployRuntimeConfig = async () => {
    if (!window.confirm(`Deploy lại ${deployTarget.toUpperCase()} cho ai-api/celery-worker?`)) return
    setDeploying(true)
    setError('')
    setNotice('')
    setDeployResult(null)
    try {
      const result = await deployRuntimeConfig({ target: deployTarget, services: ['ai-api', 'celery-worker'] })
      setDeployResult(result)
      setNotice(result.success ? 'Deploy hoàn tất.' : 'Deploy thất bại, xem log bên dưới.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không deploy được cấu hình runtime')
    } finally {
      setDeploying(false)
    }
  }

  const groupedRuntimeConfig = useMemo(() => {
    const groups = new Map<string, RuntimeConfigItem[]>()
    runtimeConfig?.items.forEach((item) => {
      const current = groups.get(item.group) ?? []
      current.push(item)
      groups.set(item.group, current)
    })
    return Array.from(groups.entries())
  }, [runtimeConfig])

  const handleManualPaid = async () => {
    const parsed = Number(orderCode)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('OrderCode không hợp lệ.')
      return
    }
    if (!window.confirm(`Xác nhận manual paid cho orderCode ${parsed}? Hành động này sẽ được audit.`)) return
    setError('')
    setNotice('')
    try {
      const result = await markBillingOrderPaid(parsed, manualNote.trim() || 'Manual paid from admin UI')
      setNotice(result.message || `Đã ghi nhận thanh toán thủ công cho orderCode ${result.orderCode}.`)
      setOrderCode('')
      setManualNote('')
      await loadBilling()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không ghi nhận được thanh toán thủ công')
    }
  }

  if (!isAdmin) {
    return (
      <section className="feature-scene account-scene">
        <div className="account-warning">
          <strong>Không có quyền admin.</strong> Màn này chỉ hiển thị cho tài khoản có JWT role ADMIN.
        </div>
      </section>
    )
  }

  return (
    <section className="feature-scene account-scene" data-testid="admin-dashboard-scene">
      <header className="account-scene__hero">
        <div>
          <p className="account-scene__eyebrow">Admin console</p>
          <h1>Quản trị vận hành</h1>
          <p className="account-scene__subtitle">Quản lý người dùng, cấu hình runtime Deepgram/Gemini và billing.</p>
        </div>
        <button type="button" className="btn btn--secondary" onClick={() => void loadCurrentTab()} disabled={loading}>
          <RefreshCw size={16} aria-hidden /> Làm mới
        </button>
      </header>

      <div className="account-warning">
        <AlertTriangle size={16} aria-hidden /> Các thao tác role, plan, cấu hình và billing là thao tác nhạy cảm. Backend đã ghi audit log lâu dài.
      </div>
      {notice && <div className="account-notice" role="status">{notice}</div>}
      {error && <div className="account-error" role="alert">{error}</div>}

      <div className="account-tabs" role="tablist" aria-label="Admin sections">
        <button type="button" className="account-tab" data-active={activeTab === 'users'} onClick={() => setActiveTab('users')}>
          <UsersRound size={16} aria-hidden /> Người dùng
        </button>
        <button type="button" className="account-tab" data-active={activeTab === 'runtimeConfig'} onClick={() => setActiveTab('runtimeConfig')}>
          <Server size={16} aria-hidden /> Cấu hình & deploy
        </button>
        <button type="button" className="account-tab" data-active={activeTab === 'billing'} onClick={() => setActiveTab('billing')}>
          <CreditCard size={16} aria-hidden /> Billing
        </button>
      </div>

      {activeTab === 'users' && (
        <article className="account-card account-card--wide">
          <h2>Danh sách người dùng</h2>
          <div className="account-summary-row" aria-label="Tổng quan người dùng">
            <div className="account-summary-item">
              <span className="account-summary-item__value">{userSummary.total.toLocaleString('vi-VN')}</span>
              <span className="account-summary-item__label">Tổng user</span>
            </div>
            <div className="account-summary-item">
              <span className="account-summary-item__value">{userSummary.visible.toLocaleString('vi-VN')}</span>
              <span className="account-summary-item__label">Đang hiển thị</span>
            </div>
            <div className="account-summary-item">
              <span className="account-summary-item__value">{userSummary.pro.toLocaleString('vi-VN')}</span>
              <span className="account-summary-item__label">Gói Pro</span>
            </div>
            <div className="account-summary-item">
              <span className="account-summary-item__value">{userSummary.admins.toLocaleString('vi-VN')}</span>
              <span className="account-summary-item__label">Admin</span>
            </div>
          </div>
          <div className="account-filter-row">
            <input
              className="account-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Tìm theo tên, email hoặc mã user"
            />
            <span className="account-muted">
              {userSummary.visible.toLocaleString('vi-VN')} / {userSummary.total.toLocaleString('vi-VN')} người dùng
            </span>
          </div>
          {loading ? (
            <LoadingState message="Đang tải danh sách user..." />
          ) : (
            <div className="account-table-wrap">
              <table className="account-table">
                <thead><tr><th>#</th><th>User</th><th>Email</th><th>Role</th><th>Plan</th><th>Thao tác</th></tr></thead>
                <tbody>
                  {filteredUsers.map((user, index) => (
                    <tr key={user.id}>
                      <td className="account-table__index">{index + 1}</td>
                      <td>{user.username || `User #${user.id}`}</td>
                      <td>{user.email || 'Chưa có email'}</td>
                      <td><span className="account-badge">{user.role}</span></td>
                      <td><span className="account-badge">{user.plan}</span></td>
                      <td>
                        <div className="account-actions">
                          <button type="button" className="btn btn--secondary" disabled={busyUserId === user.id || user.plan === 'PRO'} onClick={() => void handlePlanChange(user, 'PRO')}>Set Pro</button>
                          <button type="button" className="btn btn--secondary" disabled={busyUserId === user.id || user.plan === 'FREE'} onClick={() => void handlePlanChange(user, 'FREE')}>Set Free</button>
                          <button type="button" className="btn btn--secondary" disabled={busyUserId === user.id || user.role === 'ADMIN'} onClick={() => void handleRoleChange(user, 'ADMIN')}>Make Admin</button>
                          <button type="button" className="btn btn--secondary" disabled={busyUserId === user.id || user.role === 'USER'} onClick={() => void handleRoleChange(user, 'USER')}>Make User</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredUsers.length === 0 && <div className="account-empty">Không có user phù hợp.</div>}
            </div>
          )}
        </article>
      )}

      {activeTab === 'runtimeConfig' && (
        <article className="account-card account-card--wide">
          <h2><Server size={18} aria-hidden /> Cấu hình runtime</h2>
          <p className="account-muted">
            Lưu vào {runtimeConfig?.envFile || 'infra/.env'} rồi deploy lại đúng container nhận Deepgram/Gemini.
          </p>
          <div className="account-filter-row">
            <label className="account-inline-control">
              <span>Môi trường</span>
              <select className="account-select" value={deployTarget} onChange={(event) => setDeployTarget(event.target.value as 'local' | 'vps')}>
                <option value="local">Local</option>
                <option value="vps">VPS</option>
              </select>
            </label>
            <button type="button" className="btn btn--secondary" onClick={() => void loadRuntimeConfig()} disabled={loading || deploying}>
              <RefreshCw size={16} aria-hidden /> Tải lại
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => void handleSaveRuntimeConfig(false)} disabled={loading || deploying}>
              <Save size={16} aria-hidden /> Lưu env
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void handleSaveRuntimeConfig(true)} disabled={loading || deploying}>
              Lưu & deploy
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => void handleDeployRuntimeConfig()} disabled={loading || deploying}>
              Deploy lại
            </button>
          </div>
          {loading ? <LoadingState message="Đang tải cấu hình runtime..." /> : (
            <div className="account-config-groups">
              {groupedRuntimeConfig.map(([group, items]) => (
                <section key={group} className="account-config-group">
                  <h3>{group === 'STT' ? 'Deepgram / STT' : 'Gemini / AI'}</h3>
                  <div className="account-config-grid">
                    {items.map((item) => (
                      <label key={item.key} className="account-config-field">
                        <span>{item.label}</span>
                        <input
                          className="account-input"
                          type={item.secret ? 'password' : 'text'}
                          value={configDrafts[item.key] ?? ''}
                          onChange={(event) => handleConfigDraftChange(item.key, event.target.value)}
                          placeholder={item.secret && item.configured ? item.value : (item.value || item.key)}
                        />
                        <small>{item.key}{item.configured ? ' - đang có cấu hình' : ' - chưa cấu hình'}</small>
                      </label>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          {deployResult && (
            <div className="account-deploy-log" data-success={deployResult.success}>
              <strong>{deployResult.success ? 'Deploy thành công' : 'Deploy chưa thành công'}: {deployResult.services.join(', ')}</strong>
              {deployResult.commands.map((command, index) => (
                <pre key={`${command.exitCode}-${index}`}>{`$ ${command.command.join(' ')}\nexit ${command.exitCode}\n${command.output || ''}`}</pre>
              ))}
            </div>
          )}
        </article>
      )}

      {activeTab === 'billing' && (
        <div className="account-grid">
          <article className="account-card">
            <h2><CreditCard size={18} aria-hidden /> Manual paid</h2>
            <label className="account-setting">
              <span>OrderCode</span>
              <input className="account-input" value={orderCode} onChange={(event) => setOrderCode(event.target.value)} inputMode="numeric" />
            </label>
            <label className="account-setting">
              <span>Ghi chú audit</span>
              <textarea className="account-textarea" value={manualNote} onChange={(event) => setManualNote(event.target.value)} />
            </label>
            <button type="button" className="btn btn--primary" onClick={() => void handleManualPaid()}>
              Xác nhận paid
            </button>
          </article>
          <article className="account-card account-card--wide">
            <h2>Giao dịch / hóa đơn</h2>
            <div className="account-filter-row">
              <select className="account-select" value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)}>
                <option value="">Tất cả billing</option>
                {users.map((user) => <option key={user.id} value={user.id}>{user.username || user.email || `User #${user.id}`}</option>)}
              </select>
              <select className="account-select" value={transactionStatus} onChange={(event) => setTransactionStatus(event.target.value)}>
                <option value="">Tất cả trạng thái</option>
                <option value="PENDING">Pending</option>
                <option value="PAID">Paid</option>
                <option value="CANCELLED">Cancelled</option>
                <option value="EXPIRED">Expired</option>
              </select>
              <button type="button" className="btn btn--secondary" onClick={() => void loadBilling()} disabled={loading}>Lọc</button>
            </div>
            {loading ? <LoadingState message="Đang tải billing..." /> : (
              <div className="account-table-wrap">
                <table className="account-table">
                  <thead><tr><th>Order</th><th>User</th><th>Số tiền</th><th>Trạng thái</th><th>Provider</th><th>Tạo lúc</th><th>Paid</th><th>Ghi chú</th></tr></thead>
                  <tbody>
                    {transactions.map((tx) => (
                      <tr key={tx.id}>
                        <td>#{tx.orderCode}</td>
                        <td>{tx.userId}</td>
                        <td>{formatMoney(tx.amountVnd, tx.currency)}</td>
                        <td><span className="account-badge">{tx.status}</span></td>
                        <td>{tx.provider}</td>
                        <td>{tx.createdAt ? new Date(tx.createdAt).toLocaleString('vi-VN') : ''}</td>
                        <td>{tx.paidAt ? new Date(tx.paidAt).toLocaleString('vi-VN') : ''}</td>
                        <td>{tx.manualNote || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {transactions.length === 0 && <div className="account-empty">Không có giao dịch phù hợp.</div>}
              </div>
            )}
          </article>
        </div>
      )}

    </section>
  )
}
