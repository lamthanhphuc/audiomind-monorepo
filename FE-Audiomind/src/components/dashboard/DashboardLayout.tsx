import { useEffect, useState, type ReactNode } from 'react'
import GlobalMeetingSearch from './GlobalMeetingSearch'
import { StudioAmbientBackground } from '../ui/StudioAmbientBackground'
import ActiveJobsBanner from './ActiveJobsBanner'
import NotificationCenter from './NotificationCenter'

export type DashboardScene = 'upload' | 'realtime' | 'analysis' | 'files' | 'mindmap' | 'knowledge' | 'insights' | 'integrations' | 'billing'

type DashboardUser = {
  name: string
  email?: string
  plan?: string
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
  onOpenMeeting?: (meetingId: number) => void
  globalMeetingSearch?: string
  onGlobalMeetingSearchChange?: (value: string) => void
  onGlobalMeetingSearchSubmit?: (query: string) => void
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
  onOpenMeeting,
  globalMeetingSearch = '',
  onGlobalMeetingSearchChange,
  onGlobalMeetingSearchSubmit,
}: DashboardLayoutProps) {
  const initial = user.name.trim()[0]?.toUpperCase() || 'A'
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const handleNavigate = (scene: DashboardScene) => {
    onNavigate(scene)
    setSidebarOpen(false)
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('[data-testid="global-meeting-search"]')?.focus()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  return (
    <div className={`dashboard-layout${sidebarOpen ? ' dashboard-layout--sidebar-open' : ''}`}>
      <button
        type="button"
        className="dashboard-sidebar-toggle"
        aria-label={sidebarOpen ? 'Đóng menu' : 'Mở menu'}
        aria-expanded={sidebarOpen}
        onClick={() => setSidebarOpen((open) => !open)}
      >
        ☰
      </button>
      {sidebarOpen && (
        <button
          type="button"
          className="dashboard-sidebar-backdrop"
          aria-label="Đóng menu"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`dashboard-sidebar${sidebarOpen ? ' dashboard-sidebar--open' : ''}`}>
        <div className="dashboard-sidebar__header">
          <div className="dashboard-user">
            <div className="dashboard-user__avatar">{initial}</div>
            <div className="dashboard-user__info">
              <span className="dashboard-user__name">
                {user.name}
                {user.plan && (
                  <span className="dashboard-plan-badge" data-testid="dashboard-plan-badge">
                    {user.plan.toUpperCase() === 'PRO' ? 'Pro' : 'Free'}
                  </span>
                )}
              </span>
              <span className="dashboard-user__email">{user.email || 'audiomind@local'}</span>
            </div>
          </div>
          <div className="studio-engine-badge">
            <span className="studio-engine-badge__dot" />
            Neural pipeline · trực tuyến
          </div>
          <button type="button" className="dashboard-btn-new" onClick={() => handleNavigate('upload')}>
            <span className="icon">＋</span> Tải file mới
          </button>
        </div>

        <div className="dashboard-sidebar__body">
        <div className="dashboard-sidebar__section">
          <div className="dashboard-sidebar__title">STUDIO</div>
          <ul className="dashboard-nav-list">
            <li className={activeMenu === 'upload' ? 'active' : ''} onClick={() => handleNavigate('upload')}>
              <span className="icon">⬆</span> Tải & phân tích
            </li>
            {showRealtime && (
              <li
                className={activeMenu === 'realtime' ? 'active' : ''}
                onClick={() => handleNavigate('realtime')}
                data-testid="dashboard-nav-realtime"
              >
                <span className="icon">🎙</span> Ghi âm trực tiếp
              </li>
            )}
            <li className={activeMenu === 'analysis' ? 'active' : ''} onClick={() => handleNavigate('analysis')}>
              <span className="icon">📊</span> Kết quả phân tích
            </li>
            <li
              className={activeMenu === 'files' ? 'active' : ''}
              onClick={() => handleNavigate('files')}
              data-testid="dashboard-nav-history"
            >
              <span className="icon">⏱</span> Lịch sử meeting
            </li>
            <li className={activeMenu === 'mindmap' ? 'active' : ''} onClick={() => handleNavigate('mindmap')}>
              <span className="icon">🧠</span> Sơ đồ mindmap
            </li>
            <li
              className={activeMenu === 'knowledge' ? 'active' : ''}
              onClick={() => handleNavigate('knowledge')}
              data-testid="dashboard-nav-knowledge"
            >
              <span className="icon">📚</span> Kho tri thức
            </li>
            <li
              className={activeMenu === 'insights' ? 'active' : ''}
              onClick={() => handleNavigate('insights')}
              data-testid="dashboard-nav-insights"
            >
              <span className="icon">🔭</span> Insights
            </li>
          </ul>
        </div>

        <div className="dashboard-sidebar__section dashboard-sidebar__recents">
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
        </div>

        <div className="dashboard-sidebar__footer">
          <ul className="dashboard-nav-list">
            <li
              className={activeMenu === 'billing' ? 'active' : ''}
              onClick={() => handleNavigate('billing')}
              data-testid="dashboard-nav-billing"
            >
              <span className="icon">💳</span> Gói & thanh toán
            </li>
            <li
              className={activeMenu === 'integrations' ? 'active' : ''}
              onClick={() => handleNavigate('integrations')}
              data-testid="dashboard-nav-integrations"
            >
              <span className="icon">🔗</span> Tích hợp
            </li>
            <li className="dashboard-logout" onClick={onLogout}>
              <span className="icon">🚪</span> Đăng xuất
            </li>
          </ul>
        </div>
      </aside>

      <main className="dashboard-main">
        <StudioAmbientBackground variant="dashboard" />
        <div className="dashboard-main__topbar">
          {onGlobalMeetingSearchSubmit && (
            <GlobalMeetingSearch
              value={globalMeetingSearch}
              onValueChange={onGlobalMeetingSearchChange}
              onSubmit={onGlobalMeetingSearchSubmit}
            />
          )}
          {onOpenMeeting && <ActiveJobsBanner onOpenMeeting={onOpenMeeting} />}
          {onOpenMeeting && <NotificationCenter onOpenMeeting={onOpenMeeting} />}
        </div>
        <div className="dashboard-main__content studio-reveal">
          {children}
        </div>
      </main>
    </div>
  )
}
