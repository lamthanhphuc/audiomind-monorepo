import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { getUserProfile, updateUserProfile, type UserProfile } from '../../services/api'
import { setAccessToken } from '../../services/auth'
import { getBillingOverview, type BillingOverview } from '../../services/billing'
import {
  changeAccountPassword,
  getAccountSecurityOverview,
  logoutAllDevices,
  type AccountSecurityOverview,
} from '../../services/accountSecurity'
import { formatDomainModeLabel } from '../../constants/domainMode'
import { emailPrefix, isTechnicalUsername, resolveDisplayName } from '../../utils/userDisplay'
import { LoadingState } from '../ui/LoadingState'
import './account-scenes.css'

type Props = {
  fallbackUser: {
    name: string
    email?: string
    plan?: string
    role?: string
  }
  domainMode: string
  onRefreshJwt: () => Promise<void>
  onProfileUpdated?: (profile: UserProfile) => void
}

const planLabel = (plan?: string | null) => (String(plan || 'FREE').toUpperCase() === 'PRO' ? 'Pro' : 'Free')
const roleLabel = (role?: string | null) => (String(role || 'USER').toUpperCase() === 'ADMIN' ? 'Admin' : 'User')

export default function ProfileScene({
  fallbackUser,
  domainMode,
  onRefreshJwt,
  onProfileUpdated,
}: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [billing, setBilling] = useState<BillingOverview | null>(null)
  const [security, setSecurity] = useState<AccountSecurityOverview | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [displayNameInput, setDisplayNameInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [profileResult, billingResult, securityResult] = await Promise.allSettled([
        getUserProfile(),
        getBillingOverview(),
        getAccountSecurityOverview(),
      ])
      if (profileResult.status === 'fulfilled') setProfile(profileResult.value)
      if (billingResult.status === 'fulfilled') setBilling(billingResult.value)
      if (securityResult.status === 'fulfilled') setSecurity(securityResult.value)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được hồ sơ tài khoản')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const preferred = profile
      ? resolveDisplayName(profile.username, profile.email)
      : fallbackUser.name
    setDisplayNameInput(preferred)
  }, [fallbackUser.name, profile])

  const handleUpdateDisplayName = async () => {
    const normalized = displayNameInput.trim()
    if (normalized.length < 3) {
      setError('Tên hiển thị cần ít nhất 3 ký tự.')
      return
    }
    setBusy(true)
    setNotice('')
    setError('')
    try {
      const updated = await updateUserProfile(normalized)
      if (updated.accessToken) {
        setAccessToken(updated.accessToken, updated.expiresInSeconds)
      }
      const nextProfile: UserProfile = {
        userId: updated.userId,
        username: updated.username,
        email: updated.email,
        domainMode: updated.domainMode,
      }
      setProfile(nextProfile)
      onProfileUpdated?.(nextProfile)
      setNotice('Đã cập nhật tên hiển thị.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không cập nhật được tên hiển thị')
    } finally {
      setBusy(false)
    }
  }

  const handleRefreshJwt = async () => {
    setBusy(true)
    setNotice('')
    setError('')
    try {
      await onRefreshJwt()
      setNotice('Đã đồng bộ token đăng nhập với server.')
    } catch {
      setError('Không đồng bộ được token. Hãy đăng xuất và đăng nhập lại.')
    } finally {
      setBusy(false)
    }
  }

  const handleChangePassword = async () => {
    setBusy(true)
    setNotice('')
    setError('')
    try {
      await changeAccountPassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      await onRefreshJwt()
      await load()
      setNotice('Đã đổi mật khẩu. Các phiên cũ đã bị thu hồi.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không đổi được mật khẩu')
    } finally {
      setBusy(false)
    }
  }

  const handleLogoutAll = async () => {
    if (!window.confirm('Đăng xuất khỏi tất cả thiết bị?')) return
    setBusy(true)
    setNotice('')
    setError('')
    try {
      await logoutAllDevices()
      await onRefreshJwt()
      await load()
      setNotice('Đã thu hồi tất cả phiên đăng nhập cũ.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không đăng xuất được mọi thiết bị')
    } finally {
      setBusy(false)
    }
  }

  const rawUsername = profile?.username || fallbackUser.name
  const email = profile?.email || fallbackUser.email || 'Chưa có email'
  const displayName = resolveDisplayName(rawUsername, email, fallbackUser.name)
  const needsDisplayName = isTechnicalUsername(profile?.username) || displayName === emailPrefix(email)
  const plan = billing?.plan || fallbackUser.plan || 'FREE'
  const role = fallbackUser.role || 'USER'

  return (
    <section className="feature-scene account-scene" data-testid="profile-scene">
      <header className="account-scene__hero">
        <div>
          <p className="account-scene__eyebrow">Tài khoản cá nhân</p>
          <h1>{displayName}</h1>
          <p className="account-scene__subtitle">Quản lý hồ sơ, quyền truy cập và trạng thái kết nối dịch vụ.</p>
        </div>
        <div className="account-actions">
          <button type="button" className="btn btn--secondary" onClick={() => void load()} disabled={loading || busy}>
            Làm mới
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void handleRefreshJwt()} disabled={busy}>
            <RefreshCw size={16} aria-hidden /> Đồng bộ JWT
          </button>
        </div>
      </header>

      {notice && <div className="account-notice" role="status">{notice}</div>}
      {error && <div className="account-error" role="alert">{error}</div>}

      {loading ? (
        <LoadingState message="Đang tải hồ sơ tài khoản..." />
      ) : (
        <div className="account-grid">
          <article className="account-card">
            <h2>Thông tin chính</h2>
            {needsDisplayName ? (
              <p className="account-inline-hint">
                Tài khoản Google đang dùng tên kỹ thuật. Đặt tên dễ nhớ để hiển thị trong sidebar và hồ sơ.
              </p>
            ) : null}
            <div className="account-row account-row--stack">
              <span className="account-label">Tên hiển thị</span>
              <div className="account-edit-line">
                <input
                  className="account-input"
                  value={displayNameInput}
                  onChange={(event) => setDisplayNameInput(event.target.value)}
                  placeholder="Tên hiển thị"
                  maxLength={50}
                />
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={busy || displayNameInput.trim().length < 3 || (!needsDisplayName && displayNameInput.trim() === displayName)}
                  onClick={() => void handleUpdateDisplayName()}
                >
                  Lưu tên
                </button>
              </div>
            </div>
            <div className="account-row"><span className="account-label">Email</span><span className="account-value">{email}</span></div>
            <div className="account-row"><span className="account-label">Gói</span><span className="account-badge">{planLabel(plan)}</span></div>
            <div className="account-row"><span className="account-label">Vai trò</span><span className="account-badge">{roleLabel(role)}</span></div>
          </article>

          <article className="account-card">
            <h2>Mặc định xử lý</h2>
            <div className="account-row">
              <span className="account-label">Domain mode</span>
              <span className="account-value">{formatDomainModeLabel(profile?.domainMode || domainMode)}</span>
            </div>
            <p className="account-muted">Có thể đổi domain mặc định chi tiết trong màn Cài đặt.</p>
          </article>

          <article className="account-card account-card--wide">
            <h2><ShieldCheck size={18} aria-hidden /> Bảo mật tài khoản</h2>
            <div className="account-row">
              <span>Mật khẩu cục bộ</span>
              <span className="account-status" data-state={security?.localPasswordEnabled ? 'ok' : 'warn'}>
                {security?.localPasswordEnabled ? 'Đang bật' : 'Tài khoản OAuth'}
              </span>
            </div>
            {security?.localPasswordEnabled ? (
              <div className="account-row">
                <input className="account-input" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="Mật khẩu hiện tại" />
                <input className="account-input" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="Mật khẩu mới" />
                <button type="button" className="btn btn--secondary" disabled={busy || currentPassword.length === 0 || newPassword.length < 8} onClick={() => void handleChangePassword()}>
                  Đổi mật khẩu
                </button>
              </div>
            ) : null}
            <div className="account-row">
              <span>Phiên hiện tại</span>
              <span className="account-label">
                Hết hạn: {security?.currentSession?.expiresAt ? new Date(security.currentSession.expiresAt).toLocaleString('vi-VN') : 'Không rõ'}
              </span>
            </div>
            <div className="account-row">
              <span>Đăng xuất từ mọi thiết bị</span>
              <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void handleLogoutAll()}>
                Đăng xuất mọi thiết bị
              </button>
            </div>
          </article>

          <article className="account-card account-card--wide">
            <h2><Trash2 size={18} aria-hidden /> Vùng nguy hiểm</h2>
            <div className="account-row">
              <div>
                <div className="account-value">Xóa tài khoản</div>
                <div className="account-label">
                  Chưa bật vì cần chính sách rõ ràng cho meeting, billing và audit log. UI giữ disabled để không tạo thao tác nguy hiểm nửa vời.
                </div>
              </div>
              <button type="button" className="btn btn--secondary" disabled>
                Chưa hỗ trợ
              </button>
            </div>
          </article>
        </div>
      )}
    </section>
  )
}
