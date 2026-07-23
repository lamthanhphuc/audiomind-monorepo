import { useCallback, useEffect, useMemo, useState } from 'react'
import { Crown, KeyRound, RefreshCw, Trash2, Users } from 'lucide-react'
import { getCurrentUserId } from '../../services/auth'
import {
  getWorkspaceSummary,
  acceptWorkspaceInvite,
  inviteWorkspaceMember,
  rejectWorkspaceInvite,
  removeWorkspaceMember,
  renameWorkspace,
  transferWorkspaceOwnership,
  updateWorkspaceMemberRole,
  type WorkspaceMember,
  type WorkspaceSummary,
} from '../../services/workspace'
import { LoadingState } from '../ui/LoadingState'
import './account-scenes.css'

type Props = {
  onNavigateHistory: () => void
}

const roleLabel = (role: string) => {
  const normalized = role.toUpperCase()
  if (normalized === 'OWNER') return 'Chủ sở hữu'
  if (normalized === 'ADMIN') return 'Quản trị'
  if (normalized === 'EDITOR') return 'Có thể sửa'
  if (normalized === 'VIEWER') return 'Chỉ xem'
  return role
}

const supportCode = (id: number) => `#${String(id).slice(-6)}`

export default function TeamWorkspaceScene({ onNavigateHistory }: Props) {
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('VIEWER')

  const currentUserId = Number(getCurrentUserId() ?? 0)
  const workspace = summary?.workspace
  const currentMember = useMemo(
    () => summary?.members.find((member) => member.userId === currentUserId),
    [currentUserId, summary?.members],
  )
  const canManage = currentMember?.role === 'OWNER' || currentMember?.role === 'ADMIN'
  const isOwner = workspace?.ownerUserId === currentUserId

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const next = await getWorkspaceSummary()
      setSummary(next)
      setWorkspaceName(next.workspace?.name ?? '')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được workspace')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runAction = async (action: () => Promise<void>, success: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(success)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Thao tác workspace thất bại')
    } finally {
      setBusy(false)
    }
  }

  const handleRename = () => {
    if (!workspace || !workspaceName.trim()) return
    void runAction(async () => {
      await renameWorkspace(workspace.id, workspaceName.trim())
    }, 'Đã đổi tên workspace.')
  }

  const handleInvite = () => {
    if (!workspace || !inviteEmail.trim()) return
    void runAction(async () => {
      await inviteWorkspaceMember(workspace.id, { email: inviteEmail.trim(), role: inviteRole })
      setInviteEmail('')
    }, 'Đã thêm thành viên hoặc tạo lời mời.')
  }

  const handleRoleChange = (member: WorkspaceMember, role: string) => {
    if (!workspace || member.role === 'OWNER') return
    void runAction(async () => {
      await updateWorkspaceMemberRole(workspace.id, member.userId, role)
    }, 'Đã cập nhật quyền thành viên.')
  }

  const handleRemove = (member: WorkspaceMember) => {
    if (!workspace || member.role === 'OWNER') return
    void runAction(async () => {
      await removeWorkspaceMember(workspace.id, member.userId)
    }, 'Đã xoá thành viên khỏi workspace.')
  }

  const handleTransfer = (member: WorkspaceMember) => {
    if (!workspace || member.role === 'OWNER') return
    void runAction(async () => {
      await transferWorkspaceOwnership(workspace.id, member.userId)
    }, 'Đã chuyển quyền chủ sở hữu.')
  }

  const handleAcceptInvite = (workspaceId: number | undefined, inviteId: number | undefined) => {
    if (!workspaceId || !inviteId) return
    void runAction(async () => {
      await acceptWorkspaceInvite(workspaceId, inviteId)
    }, 'Đã nhận lời mời workspace.')
  }

  const handleRejectInvite = (workspaceId: number | undefined, inviteId: number | undefined) => {
    if (!workspaceId || !inviteId) return
    void runAction(async () => {
      await rejectWorkspaceInvite(workspaceId, inviteId)
    }, 'Đã từ chối lời mời workspace.')
  }

  return (
    <section className="feature-scene account-scene" data-testid="team-workspace-scene">
      <header className="account-scene__hero">
        <div>
          <p className="account-scene__eyebrow">Team / Workspace</p>
          <h1>Quản lý cộng tác</h1>
          <p className="account-scene__subtitle">Quản lý workspace, thành viên, lời mời và quyền sở hữu thật trong hệ thống.</p>
        </div>
        <div className="account-actions">
          <button type="button" className="btn btn--secondary" onClick={() => void load()} disabled={loading || busy}>
            <RefreshCw size={16} aria-hidden /> Tải lại
          </button>
          <button type="button" className="btn btn--primary" onClick={onNavigateHistory}>
            <Users size={16} aria-hidden /> Mở chia sẻ meeting
          </button>
        </div>
      </header>

      {error && <div className="account-error" role="alert">{error}</div>}
      {notice && <div className="account-notice" role="status">{notice}</div>}

      {loading ? <LoadingState message="Đang tải workspace..." /> : (
        <div className="account-grid">
          <article className="account-card account-card--wide">
            <h2><Crown size={18} aria-hidden /> Workspace</h2>
            <div className="account-row">
              <input
                className="account-input"
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                disabled={!canManage || busy}
                aria-label="Tên workspace"
              />
              <button type="button" className="btn btn--secondary" onClick={handleRename} disabled={!canManage || busy || !workspaceName.trim()}>
                Lưu tên
              </button>
            </div>
            <div className="account-row"><span>Meeting sở hữu</span><strong>{summary?.ownedMeetingCount ?? 0}</strong></div>
            <div className="account-row"><span>Được chia sẻ với tôi</span><strong>{summary?.sharedWithMeCount ?? 0}</strong></div>
          </article>

          <article className="account-card account-card--wide">
            <h2><Users size={18} aria-hidden /> Thành viên workspace</h2>
            <div className="account-filter-row">
              <input className="account-input" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="email@congty.com" disabled={!canManage || busy} />
              <select className="account-select" value={inviteRole} onChange={(event) => setInviteRole(event.target.value)} disabled={!canManage || busy}>
                <option value="VIEWER">Chỉ xem</option>
                <option value="EDITOR">Có thể sửa</option>
                <option value="ADMIN">Quản trị</option>
              </select>
              <button type="button" className="btn btn--primary" onClick={handleInvite} disabled={!canManage || busy || !inviteEmail.trim()}>
                Thêm / Mời
              </button>
            </div>
            <ul className="account-list">
              {(summary?.members ?? []).map((member) => (
                <li key={member.userId}>
                  <strong>{member.username || member.email || `Thành viên ${supportCode(member.userId)}`}</strong>
                  <div>{member.email || `Mã hỗ trợ user ${supportCode(member.userId)}`}</div>
                  <div className="account-actions">
                    <select
                      className="account-select"
                      value={member.role}
                      onChange={(event) => handleRoleChange(member, event.target.value)}
                      disabled={!canManage || busy || member.role === 'OWNER'}
                    >
                      <option value="OWNER">Chủ sở hữu</option>
                      <option value="ADMIN">Quản trị</option>
                      <option value="EDITOR">Có thể sửa</option>
                      <option value="VIEWER">Chỉ xem</option>
                    </select>
                    {isOwner && member.role !== 'OWNER' ? (
                      <button type="button" className="btn btn--secondary" onClick={() => handleTransfer(member)} disabled={busy}>
                        <KeyRound size={16} aria-hidden /> Chuyển owner
                      </button>
                    ) : null}
                    {canManage && member.role !== 'OWNER' ? (
                      <button type="button" className="btn btn--secondary" onClick={() => handleRemove(member)} disabled={busy}>
                        <Trash2 size={16} aria-hidden /> Xoá
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
              {(summary?.members ?? []).length === 0 && <li className="account-empty">Chưa có thành viên workspace.</li>}
            </ul>
          </article>

          <article className="account-card">
            <h2>Lời mời workspace</h2>
            <ul className="account-list">
              {(summary?.myPendingInvites ?? []).map((invite) => (
                <li key={`mine-${invite.id ?? invite.email}`}>
                  <strong>{invite.email}</strong>
                  <div>{roleLabel(invite.role)} - đang chờ phản hồi của bạn</div>
                  <div className="account-actions">
                    <button type="button" className="btn btn--primary" onClick={() => handleAcceptInvite(invite.workspaceId, invite.id)} disabled={busy}>
                      Nhận lời
                    </button>
                    <button type="button" className="btn btn--secondary" onClick={() => handleRejectInvite(invite.workspaceId, invite.id)} disabled={busy}>
                      Từ chối
                    </button>
                  </div>
                </li>
              ))}
              {(summary?.pendingInvites ?? []).map((invite) => (
                <li key={invite.id ?? invite.email}>
                  <strong>{invite.email}</strong>
                  <div>{roleLabel(invite.role)} - {invite.status || 'PENDING'}</div>
                </li>
              ))}
              {(summary?.pendingInvites ?? []).length === 0 && (summary?.myPendingInvites ?? []).length === 0 && <li className="account-empty">Không có lời mời workspace đang chờ.</li>}
            </ul>
          </article>

          <article className="account-card">
            <h2>Meeting đã chia sẻ</h2>
            <ul className="account-list">
              {(summary?.sharedMeetings ?? []).map((meeting) => (
                <li key={meeting.meetingId}>
                  <strong>{meeting.title || `Meeting ${supportCode(meeting.meetingId)}`}</strong>
                  <div>{meeting.shareCount ?? 0} lượt chia sẻ - mã hỗ trợ {supportCode(meeting.meetingId)}</div>
                </li>
              ))}
              {(summary?.sharedMeetings ?? []).length === 0 && <li className="account-empty">Chưa có meeting đã chia sẻ.</li>}
            </ul>
          </article>

          {summary?.meetingShareError ? (
            <article className="account-card account-card--wide">
              <h2>Đồng bộ meeting share</h2>
              <div className="account-label">{summary.meetingShareError}</div>
            </article>
          ) : null}
        </div>
      )}
    </section>
  )
}
