import { useEffect, useState, type ReactNode } from 'react'
import {
  AudioLines,
  BarChart3,
  Bell,
  BrainCircuit,
  CreditCard,
  History,
  Lightbulb,
  LogOut,
  Moon,
  Network,
  Plus,
  Puzzle,
  Radio,
  Search,
  Settings,
  Shield,
  Sparkles,
  Sun,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react'
import SubjectSidebarSection from '../subjects/SubjectSidebarSection'
import GlobalMeetingSearch from './GlobalMeetingSearch'
import { StudioAmbientBackground } from '../ui/StudioAmbientBackground'
import ActiveJobsBanner from './ActiveJobsBanner'
import NotificationCenter from './NotificationCenter'
import type { HistoryLanguageFilter, HistoryStatusFilter } from '../../app/useHistorySearchFilters'
import type { ThemeMode } from '../../utils/themeMode'
import { themeToggleLabel } from '../../utils/themeMode'

export type DashboardScene = 'upload' | 'realtime' | 'analysis' | 'files' | 'mindmap' | 'knowledge' | 'insights' | 'integrations' | 'billing' | 'subjects' | 'subjectDetail' | 'unclassified' | 'profile' | 'settings' | 'admin' | 'notifications' | 'usage' | 'team' | 'audit'

type DashboardUser = {
  name: string
  email?: string
  plan?: string
  role?: string
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
  globalStatusFilter?: HistoryStatusFilter
  onGlobalStatusFilterChange?: (value: HistoryStatusFilter) => void
  globalLanguageFilter?: HistoryLanguageFilter
  onGlobalLanguageFilterChange?: (value: HistoryLanguageFilter) => void
  selectedSubjectId?: number | null
  onNavigateSubjects?: () => void
  onNavigateSubjectDetail?: (subjectId: number) => void
  onNavigateUnclassified?: () => void
  theme?: ThemeMode
  onToggleTheme?: () => void
}

type DashboardNavItem = {
  scene: DashboardScene
  label: string
  icon: LucideIcon
  testId?: string
}

type DashboardNavGroup = {
  title: string
  items: DashboardNavItem[]
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
  globalStatusFilter = '',
  onGlobalStatusFilterChange,
  globalLanguageFilter = '',
  onGlobalLanguageFilterChange,
  selectedSubjectId = null,
  onNavigateSubjects,
  onNavigateSubjectDetail,
  onNavigateUnclassified,
  theme = 'night',
  onToggleTheme,
}: DashboardLayoutProps) {
  const initial = user.name.trim()[0]?.toUpperCase() || 'A'
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const themeActionLabel = themeToggleLabel(theme)
  const ThemeIcon = theme === 'night' ? Sun : Moon
  const isAdmin = user.role?.toUpperCase() === 'ADMIN'

  const handleNavigate = (scene: DashboardScene) => {
    onNavigate(scene)
    setSidebarOpen(false)
  }

  const navGroups: DashboardNavGroup[] = isAdmin
    ? [{
      title: 'Quản trị',
      items: [
        { scene: 'admin', label: 'Admin dashboard', icon: Shield, testId: 'dashboard-nav-admin' },
        { scene: 'audit', label: 'Log', icon: Shield, testId: 'dashboard-nav-audit' },
      ],
    }]
    : [
      {
        title: 'Tạo mới',
        items: [
          { scene: 'upload', label: 'Tải & phân tích', icon: AudioLines },
          ...(showRealtime
            ? [{ scene: 'realtime' as const, label: 'Ghi âm trực tiếp', icon: Radio, testId: 'dashboard-nav-realtime' }]
            : []),
        ],
      },
      {
        title: 'Lịch sử',
        items: [
          { scene: 'files', label: 'Lịch sử cuộc họp', icon: History, testId: 'dashboard-nav-history' },
          { scene: 'analysis', label: 'Kết quả phân tích', icon: BrainCircuit },
        ],
      },
      {
        title: 'Tri thức',
        items: [
          { scene: 'mindmap', label: 'Sơ đồ mindmap', icon: Network },
          { scene: 'knowledge', label: 'Kho tri thức', icon: Search, testId: 'dashboard-nav-knowledge' },
          { scene: 'insights', label: 'Insights', icon: Lightbulb, testId: 'dashboard-nav-insights' },
        ],
      },
      {
        title: 'Tài khoản',
        items: [
          { scene: 'profile', label: 'Hồ sơ cá nhân', icon: User, testId: 'dashboard-nav-profile' },
          { scene: 'settings', label: 'Cài đặt', icon: Settings, testId: 'dashboard-nav-settings' },
          { scene: 'notifications', label: 'Thông báo', icon: Bell, testId: 'dashboard-nav-notifications' },
          { scene: 'usage', label: 'Usage & quota', icon: BarChart3, testId: 'dashboard-nav-usage' },
          { scene: 'team', label: 'Team / Workspace', icon: Users, testId: 'dashboard-nav-team' },
        ],
      },
    ]

  const footerItems: DashboardNavItem[] = isAdmin ? [] : [
      { scene: 'billing', label: 'Gói & thanh toán', icon: CreditCard, testId: 'dashboard-nav-billing' },
      { scene: 'integrations', label: 'Tích hợp', icon: Puzzle, testId: 'dashboard-nav-integrations' },
    ]

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
          {!isAdmin && (
            <>
              <div className="studio-engine-badge">
                <span className="studio-engine-badge__dot" />
                Neural pipeline · trực tuyến
              </div>
              <button type="button" className="dashboard-btn-new" onClick={() => handleNavigate('upload')}>
                <Plus size={16} aria-hidden /> Tải file mới
              </button>
            </>
          )}
        </div>

        <div className="dashboard-sidebar__body">
          {navGroups.map((group) => (
            <div className="dashboard-sidebar__section" key={group.title}>
              <div className="dashboard-sidebar__title">{group.title}</div>
              <ul className="dashboard-nav-list">
                {group.items.map((item) => {
                  const Icon = item.icon
                  return (
                    <li key={item.scene} className={activeMenu === item.scene ? 'active' : ''}>
                      <button
                        type="button"
                        className="dashboard-nav-button"
                        onClick={() => handleNavigate(item.scene)}
                        data-testid={item.testId}
                        aria-current={activeMenu === item.scene ? 'page' : undefined}
                      >
                        <span className="dashboard-icon-badge" aria-hidden>
                          <Icon size={16} strokeWidth={2.2} />
                        </span>
                        <span>{item.label}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}

          {!isAdmin && onNavigateSubjects && onNavigateSubjectDetail && onNavigateUnclassified ? (
            <SubjectSidebarSection
              activeScene={activeMenu}
              selectedSubjectId={selectedSubjectId}
              onNavigateSubjects={onNavigateSubjects}
              onNavigateSubjectDetail={onNavigateSubjectDetail}
              onNavigateUnclassified={onNavigateUnclassified}
            />
          ) : null}

        {!isAdmin && (
        <div className="dashboard-sidebar__section dashboard-sidebar__recents">
          <div className="dashboard-sidebar__title">Gần đây</div>
          <ul className="dashboard-recents-list">
            {recentFiles.length > 0 ? (
              recentFiles.map((item) => (
                <li
                  key={item.id}
                  className={item.active ? 'active' : ''}
                >
                  <button
                    type="button"
                    className="dashboard-nav-button"
                    onClick={() => onRecentFileClick?.(item.id)}
                    data-testid="dashboard-recent-item"
                  >
                    <span className="dashboard-icon-badge" aria-hidden>
                      <Sparkles size={16} strokeWidth={2.2} />
                    </span>
                    <span>{item.label}</span>
                  </button>
                </li>
              ))
            ) : (
              <li className="dashboard-recents-list__empty">Chưa có file gần đây</li>
            )}
          </ul>
        </div>
        )}
        </div>

        <div className="dashboard-sidebar__footer">
          <ul className="dashboard-nav-list">
            {footerItems.map((item) => (
              <li key={item.scene} className={activeMenu === item.scene ? 'active' : ''}>
                <button
                  type="button"
                  className="dashboard-nav-button"
                  onClick={() => handleNavigate(item.scene)}
                  data-testid={item.testId}
                  aria-current={activeMenu === item.scene ? 'page' : undefined}
                >
                  <span className="dashboard-icon-badge" aria-hidden>
                    <item.icon size={16} strokeWidth={2.2} />
                  </span>
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
            {onToggleTheme ? (
              <li className="dashboard-theme-toggle">
                <button
                  type="button"
                  className="dashboard-nav-button"
                  onClick={onToggleTheme}
                  data-testid="theme-mode-toggle"
                  aria-pressed={theme === 'night'}
                  aria-label={`Chuyển sang ${themeActionLabel.toLowerCase()}`}
                  title={`Chuyển sang ${themeActionLabel.toLowerCase()}`}
                >
                  <span className="dashboard-icon-badge" aria-hidden>
                    <ThemeIcon size={16} strokeWidth={2.2} />
                  </span>
                  <span data-testid="theme-mode-toggle-label">{themeActionLabel}</span>
                </button>
              </li>
            ) : null}
            <li className="dashboard-logout">
              <button type="button" className="dashboard-nav-button" onClick={onLogout}>
                <span className="dashboard-icon-badge" aria-hidden>
                  <LogOut size={16} strokeWidth={2.2} />
                </span>
                <span>Đăng xuất</span>
              </button>
            </li>
          </ul>
        </div>
      </aside>

      <main className="dashboard-main">
        <StudioAmbientBackground variant="dashboard" muted={theme === 'light'} />
        <div className="dashboard-main__topbar">
          {!isAdmin && onGlobalMeetingSearchSubmit && (
            <GlobalMeetingSearch
              value={globalMeetingSearch}
              onValueChange={onGlobalMeetingSearchChange}
              onSubmit={onGlobalMeetingSearchSubmit}
              statusFilter={globalStatusFilter}
              onStatusFilterChange={onGlobalStatusFilterChange}
              languageFilter={globalLanguageFilter}
              onLanguageFilterChange={onGlobalLanguageFilterChange}
            />
          )}
          {!isAdmin && onOpenMeeting && <ActiveJobsBanner onOpenMeeting={onOpenMeeting} />}
          {!isAdmin && onOpenMeeting && <NotificationCenter onOpenMeeting={onOpenMeeting} />}
        </div>
        <div className="dashboard-main__content studio-reveal">
          {children}
        </div>
      </main>
    </div>
  )
}
