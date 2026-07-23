import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Copy, KeyRound, RefreshCw } from 'lucide-react'
import {
  createUserApiKey,
  listAdminTransactions,
  listAdminUsers,
  listUserApiKeys,
  markBillingOrderPaid,
  revokeUserApiKey,
  updateAdminUserPlan,
  updateAdminUserRole,
  type AdminApiKey,
  type AdminTransaction,
  type AdminUser,
} from '../../services/admin'
import { LoadingState } from '../ui/LoadingState'
import './account-scenes.css'

type Props = {
  role?: string
}

type AdminTab = 'users' | 'apiKeys' | 'transactions' | 'manualPaid'

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
  const [apiKeys, setApiKeys] = useState<AdminApiKey[]>([])
  const [query, setQuery] = useState('')
  const [selectedUserId, setSelectedUserId] = useState('')
  const [transactionStatus, setTransactionStatus] = useState('')
  const [loading, setLoading] = useState(isAdmin)
  const [busyUserId, setBusyUserId] = useState<number | null>(null)
  const [busyKeyId, setBusyKeyId] = useState<number | null>(null)
  const [keyName, setKeyName] = useState('')
  const [keyScopes, setKeyScopes] = useState('read')
  const [newApiKey, setNewApiKey] = useState('')
  const [orderCode, setOrderCode] = useState('')
  const [manualNote, setManualNote] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const selectedUser = useMemo(
    () => users.find((user) => user.id === Number(selectedUserId)) ?? null,
    [selectedUserId, users],
  )

  const loadUsers = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    setError('')
    try {
      const loadedUsers = await listAdminUsers()
      setUsers(loadedUsers)
      if (!selectedUserId && loadedUsers.length > 0) {
        setSelectedUserId(String(loadedUsers[0].id))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được danh sách user')
    } finally {
      setLoading(false)
    }
  }, [isAdmin, selectedUserId])

  const loadApiKeys = useCallback(async () => {
    if (!isAdmin || !selectedUser) return
    setLoading(true)
    setError('')
    try {
      setApiKeys(await listUserApiKeys(selectedUser.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được API key')
    } finally {
      setLoading(false)
    }
  }, [isAdmin, selectedUser])

  const loadTransactions = useCallback(async () => {
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
      setError(cause instanceof Error ? cause.message : 'Không tải được giao dịch')
    } finally {
      setLoading(false)
    }
  }, [isAdmin, selectedUserId, transactionStatus])

  const loadCurrentTab = useCallback(async () => {
    if (activeTab === 'transactions') {
      await loadTransactions()
      return
    }
    if (activeTab === 'apiKeys') {
      await loadApiKeys()
      return
    }
    await loadUsers()
  }, [activeTab, loadApiKeys, loadTransactions, loadUsers])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  useEffect(() => {
    if (activeTab === 'apiKeys') void loadApiKeys()
    if (activeTab === 'transactions') void loadTransactions()
  }, [activeTab, loadApiKeys, loadTransactions])

  const filteredUsers = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return users
    return users.filter((user) => (
      user.username.toLowerCase().includes(normalized)
      || String(user.email || '').toLowerCase().includes(normalized)
      || String(user.id).includes(normalized)
    ))
  }, [query, users])

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

  const handleCreateApiKey = async () => {
    if (!selectedUser) {
      setError('Hãy chọn user trước khi tạo API key.')
      return
    }
    if (!keyName.trim()) {
      setError('Tên API key không được trống.')
      return
    }
    if (!window.confirm(`Tạo API key mới cho ${selectedUser.username || selectedUser.email}? Key chỉ hiển thị một lần.`)) return
    setError('')
    setNotice('')
    try {
      const created = await createUserApiKey(selectedUser.id, { name: keyName.trim(), scopes: keyScopes.trim() || 'read' })
      setApiKeys((items) => [created, ...items])
      setNewApiKey(created.apiKey || '')
      setKeyName('')
      setKeyScopes('read')
      setNotice('Đã tạo API key. Sao chép ngay vì key chỉ hiển thị một lần.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tạo được API key')
    }
  }

  const handleRevokeApiKey = async (key: AdminApiKey) => {
    if (!selectedUser || !window.confirm(`Thu hồi API key "${key.name}"?`)) return
    setBusyKeyId(key.id)
    setError('')
    setNotice('')
    try {
      const revoked = await revokeUserApiKey(selectedUser.id, key.id)
      setApiKeys((items) => items.map((item) => (item.id === revoked.id ? revoked : item)))
      setNotice('Đã thu hồi API key.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thu hồi được API key')
    } finally {
      setBusyKeyId(null)
    }
  }

  const handleCopyApiKey = async () => {
    if (!newApiKey) return
    await navigator.clipboard?.writeText(newApiKey)
    setNotice('Đã sao chép API key.')
  }

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
      if (activeTab === 'transactions') {
        await loadTransactions()
      }
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
          <p className="account-scene__eyebrow">Admin dashboard</p>
          <h1>Quản lý hệ thống</h1>
          <p className="account-scene__subtitle">Quản lý user, API key, giao dịch và thao tác thanh toán thủ công có audit.</p>
        </div>
        <button type="button" className="btn btn--secondary" onClick={() => void loadCurrentTab()} disabled={loading}>
          <RefreshCw size={16} aria-hidden /> Làm mới
        </button>
      </header>

      <div className="account-warning">
        <AlertTriangle size={16} aria-hidden /> Các thao tác role, plan, API key và manual paid là thao tác nhạy cảm. Backend đã ghi audit log lâu dài.
      </div>
      {notice && <div className="account-notice" role="status">{notice}</div>}
      {error && <div className="account-error" role="alert">{error}</div>}

      <div className="account-tabs" role="tablist" aria-label="Admin sections">
        <button type="button" className="account-tab" data-active={activeTab === 'users'} onClick={() => setActiveTab('users')}>Users</button>
        <button type="button" className="account-tab" data-active={activeTab === 'apiKeys'} onClick={() => setActiveTab('apiKeys')}>API keys</button>
        <button type="button" className="account-tab" data-active={activeTab === 'transactions'} onClick={() => setActiveTab('transactions')}>Giao dịch</button>
        <button type="button" className="account-tab" data-active={activeTab === 'manualPaid'} onClick={() => setActiveTab('manualPaid')}>Manual paid</button>
      </div>

      {activeTab === 'users' && (
        <article className="account-card account-card--wide">
          <h2>Danh sách users</h2>
          <div className="account-filter-row">
            <input
              className="account-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Tìm theo tên, email hoặc mã user"
            />
            <span className="account-muted">{filteredUsers.length} user</span>
          </div>
          {loading ? (
            <LoadingState message="Đang tải danh sách user..." />
          ) : (
            <div className="account-table-wrap">
              <table className="account-table">
                <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Plan</th><th>Thao tác</th></tr></thead>
                <tbody>
                  {filteredUsers.map((user) => (
                    <tr key={user.id}>
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

      {activeTab === 'apiKeys' && (
        <div className="account-grid">
          <article className="account-card">
            <h2><KeyRound size={18} aria-hidden /> Tạo API key</h2>
            <label className="account-setting">
              <span>User</span>
              <select className="account-select" value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)}>
                {users.map((user) => <option key={user.id} value={user.id}>{user.username || user.email || `User #${user.id}`}</option>)}
              </select>
            </label>
            <label className="account-setting">
              <span>Tên key</span>
              <input className="account-input" value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="VD: Local automation" />
            </label>
            <label className="account-setting">
              <span>Scopes</span>
              <input className="account-input" value={keyScopes} onChange={(event) => setKeyScopes(event.target.value)} placeholder="read,write" />
            </label>
            <button type="button" className="btn btn--primary" onClick={() => void handleCreateApiKey()}>Tạo key</button>
            {newApiKey && (
              <div className="account-secret-box">
                <span>{newApiKey}</span>
                <button type="button" className="btn btn--secondary" onClick={() => void handleCopyApiKey()}>
                  <Copy size={16} aria-hidden /> Sao chép
                </button>
              </div>
            )}
          </article>
          <article className="account-card account-card--wide">
            <h2>API key của {selectedUser?.username || selectedUser?.email || 'user đã chọn'}</h2>
            {loading ? <LoadingState message="Đang tải API key..." /> : (
              <div className="account-table-wrap">
                <table className="account-table">
                  <thead><tr><th>Tên</th><th>Key</th><th>Scopes</th><th>Tạo lúc</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
                  <tbody>
                    {apiKeys.map((key) => (
                      <tr key={key.id}>
                        <td>{key.name}</td>
                        <td>{key.prefix}...{key.suffix}</td>
                        <td>{key.scopes}</td>
                        <td>{key.createdAt ? new Date(key.createdAt).toLocaleString('vi-VN') : ''}</td>
                        <td>{key.revokedAt ? 'Đã thu hồi' : 'Đang hoạt động'}</td>
                        <td>
                          <button type="button" className="btn btn--secondary" disabled={busyKeyId === key.id || Boolean(key.revokedAt)} onClick={() => void handleRevokeApiKey(key)}>
                            Thu hồi
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {apiKeys.length === 0 && <div className="account-empty">User này chưa có API key.</div>}
              </div>
            )}
          </article>
        </div>
      )}

      {activeTab === 'transactions' && (
        <article className="account-card account-card--wide">
          <h2>Giao dịch / hóa đơn</h2>
          <div className="account-filter-row">
            <select className="account-select" value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)}>
              <option value="">Tất cả user</option>
              {users.map((user) => <option key={user.id} value={user.id}>{user.username || user.email || `User #${user.id}`}</option>)}
            </select>
            <select className="account-select" value={transactionStatus} onChange={(event) => setTransactionStatus(event.target.value)}>
              <option value="">Tất cả trạng thái</option>
              <option value="PENDING">Pending</option>
              <option value="PAID">Paid</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="EXPIRED">Expired</option>
            </select>
            <button type="button" className="btn btn--secondary" onClick={() => void loadTransactions()} disabled={loading}>Lọc</button>
          </div>
          {loading ? <LoadingState message="Đang tải giao dịch..." /> : (
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
      )}

      {activeTab === 'manualPaid' && (
        <article className="account-card">
          <h2>Manual mark paid</h2>
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
      )}
    </section>
  )
}
