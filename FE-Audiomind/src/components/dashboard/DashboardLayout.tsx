import type { ReactNode } from 'react'
import { StudioAmbientBackground } from '../ui/StudioAmbientBackground'

export type DashboardScene = 'upload' | 'realtime' | 'analysis' | 'files'

type DashboardUser = {
  name: string
  email?: string
}

type DashboardLayoutProps = {
  children: ReactNode
  user: DashboardUser
  onLogout: () => void
  activeMenu: DashboardScene | 'favorites'
  onNavigate: (scene: DashboardScene) => void
  showRealtime?: boolean
  recentFiles?: Array<{ id: string; label: string; active?: boolean }>
  onRecentFileClick?: (id: string) => void
}

export default function DashboardLayout({
  children,
  user,
  onLogout,
  activeMenu,
  onNavigate,
  showRealtime = true,
  recentFiles = [],
  onRecentFileClick,
}: DashboardLayoutProps) {
  const initial = user.name.trim()[0]?.toUpperCase() || 'A'

  return (
    <div className="dashboard-layout">
      <aside className="dashboard-sidebar">
        <div className="dashboard-sidebar__header">
          <div className="dashboard-user">
            <div className="dashboard-user__avatar">{initial}</div>
            <div className="dashboard-user__info">
              <span className="dashboard-user__name">{user.name}</span>
              <span className="dashboard-user__email">{user.email || 'audiomind@local'}</span>
            </div>
          </div>
          <div className="studio-engine-badge">
            <span className="studio-engine-badge__dot" />
            Neural pipeline · online
          </div>
          <button type="button" className="dashboard-btn-new" onClick={() => onNavigate('upload')}>
            <span className="icon">＋</span> Tải file mới
          </button>
        </div>

        <div className="dashboard-sidebar__section">
          <div className="dashboard-sidebar__title">STUDIO</div>
          <ul className="dashboard-nav-list">
            <li className={activeMenu === 'upload' ? 'active' : ''} onClick={() => onNavigate('upload')}>
              <span className="icon">⬆</span> Tải & phân tích
            </li>
            {showRealtime && (
              <li className={activeMenu === 'realtime' ? 'active' : ''} onClick={() => onNavigate('realtime')}>
                <span className="icon">🎙</span> Ghi âm trực tiếp
              </li>
            )}
            <li className={activeMenu === 'analysis' ? 'active' : ''} onClick={() => onNavigate('analysis')}>
              <span className="icon">📊</span> Kết quả phân tích
            </li>
            <li className={activeMenu === 'files' ? 'active' : ''} onClick={() => onNavigate('files')}>
              <span className="icon">⏱</span> Lịch sử meeting
            </li>
          </ul>
        </div>

        <div className="dashboard-sidebar__section dashboard-sidebar__scroll">
          <div className="dashboard-sidebar__title">GẦN ĐÂY</div>
          <ul className="dashboard-recents-list">
            {recentFiles.length > 0 ? (
              recentFiles.map((item) => (
                <li
                  key={item.id}
                  className={item.active ? 'active' : ''}
                  onClick={() => onRecentFileClick?.(item.id)}
                  data-testid="dashboard-recent-item"
                >
                  <span className="icon">🎵</span> {item.label}
                </li>
              ))
            ) : (
              <li className="dashboard-recents-list__empty">Chưa có file gần đây</li>
            )}
          </ul>
        </div>

        <div className="dashboard-sidebar__footer">
          <ul className="dashboard-nav-list">
            <li className="dashboard-logout" onClick={onLogout}>
              <span className="icon">🚪</span> Đăng xuất
            </li>
          </ul>
        </div>
      </aside>

      <main className="dashboard-main">
        <StudioAmbientBackground variant="dashboard" />
        <div className="dashboard-main__content studio-reveal">
          {children}
        </div>
      </main>
    </div>
  )
}
