import { useEffect, useState, type ReactNode } from 'react'
import {
  AudioLines,
  BarChart3,
  Bell,
  BrainCircuit,
  CreditCard,
  History,
  LogOut,
  Moon,
  Network,
  Plus,
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
import { SponsoredAdPanel } from '../ui/SponsoredAdPanel'
import type { HistoryLanguageFilter, HistoryStatusFilter } from '../../app/useHistorySearchFilters'
import type { ThemeMode } from '../../utils/themeMode'
import { themeToggleLabel } from '../../utils/themeMode'
import { canUseMindmap, canUseStudyWorkspace, normalizePlanCode } from '../../utils/planCapabilities'

export type DashboardScene = 'upload' | 'realtime' | 'analysis' | 'files' | 'mindmap' | 'knowledge' | 'integrations' | 'billing' | 'subjects' | 'subjectDetail' | 'unclassified' | 'profile' | 'settings' | 'admin' | 'notifications' | 'usage' | 'audit'

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
  description?: string
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
  const normalizedPlan = normalizePlanCode(user.plan)
  const planLabel = user.plan
    ? normalizedPlan.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase())
    : ''
  const mindmapEnabled = canUseMindmap(normalizedPlan)
  const studyWorkspaceEnabled = canUseStudyWorkspace(normalizedPlan)

  const handleNavigate = (scene: DashboardScene) => {
    onNavigate(scene)
    setSidebarOpen(false)
  }

  const navGroups: DashboardNavGroup[] = isAdmin
    ? [{
      title: 'Quản trị',
      description: 'Dành cho vận hành hệ thống',
      items: [
        { scene: 'admin', label: 'Console admin', icon: Shield, testId: 'dashboard-nav-admin' },
        { scene: 'audit', label: 'Audit log', icon: Shield, testId: 'dashboard-nav-audit' },
      ],
    }]
    : [
      {
        title: 'Làm việc',
        description: 'Tạo, ghi âm và xem kết quả',
        items: [
          { scene: 'upload', label: 'Upload file', icon: AudioLines },
          ...(showRealtime
            ? [{ scene: 'realtime' as const, label: 'Ghi realtime', icon: Radio, testId: 'dashboard-nav-realtime' }]
            : []),
          { scene: 'files', label: 'Cuộc họp của tôi', icon: History, testId: 'dashboard-nav-history' },
          { scene: 'analysis', label: 'Phân tích gần đây', icon: BrainCircuit },
        ],
      },
      {
        title: 'Tài khoản',
        description: 'Gói, quota và hồ sơ',
        items: [
          { scene: 'billing', label: 'Gói & thanh toán', icon: CreditCard, testId: 'dashboard-nav-billing' },
          { scene: 'usage', label: 'Quota sử dụng', icon: BarChart3, testId: 'dashboard-nav-usage' },
          { scene: 'profile', label: 'Hồ sơ cá nhân', icon: User, testId: 'dashboard-nav-profile' },
        ],
      },
      {
        title: 'Nâng cao',
        description: 'Mở khi cần tổ chức và tích hợp',
        items: [
          ...(studyWorkspaceEnabled
            ? [{ scene: 'subjects' as const, label: 'Môn học / thư mục', icon: Users, testId: 'dashboard-nav-subjects' }]
            : []),
          ...(mindmapEnabled
            ? [{ scene: 'mindmap' as const, label: 'Mindmap', icon: Network }]
            : []),
          { scene: 'integrations', label: 'Google tích hợp', icon: Search, testId: 'dashboard-nav-integrations' },
          { scene: 'knowledge', label: 'Kho tri thức', icon: Search, testId: 'dashboard-nav-knowledge' },
          { scene: 'settings', label: 'Cài đặt', icon: Settings, testId: 'dashboard-nav-settings' },
          { scene: 'notifications', label: 'Thông báo', icon: Bell, testId: 'dashboard-nav-notifications' },
        ],
      },
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
                <span className="dashboard-user__name-text">{user.name}</span>
                {user.plan && (
                  <span className="dashboard-plan-badge" data-testid="dashboard-plan-badge">
                    {planLabel}
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
                Sẵn sàng xử lý
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
              {group.description ? (
                <p className="dashboard-sidebar__hint">{group.description}</p>
              ) : null}
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

          {!isAdmin && studyWorkspaceEnabled && onNavigateSubjects && onNavigateSubjectDetail && onNavigateUnclassified ? (
            <SubjectSidebarSection
              activeScene={activeMenu}
              selectedSubjectId={selectedSubjectId}
              onNavigateSubjects={onNavigateSubjects}
              onNavigateSubjectDetail={onNavigateSubjectDetail}
              onNavigateUnclassified={onNavigateUnclassified}
            />
          ) : null}

          {!isAdmin && (
            <SponsoredAdPanel
              plan={user.plan}
              placement="DASHBOARD"
              onNavigateBilling={() => handleNavigate('billing')}
            />
          )}

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
