import type { ReactNode } from 'react'

type DashboardLayoutProps = {
  children: ReactNode
  user: any
  onLogout: () => void
  activeMenu: string
  onNavigate: (scene: 'upload' | 'files' | 'subjects') => void
}

export default function DashboardLayout({ children, user, onLogout, activeMenu, onNavigate }: DashboardLayoutProps) {
  return (
    <div className="dashboard-layout">
      <aside className="dashboard-sidebar">
        <div className="dashboard-sidebar__header">
          <div className="dashboard-user">
            <div className="dashboard-user__avatar">{user?.name?.[0] || 'J'}</div>
            <div className="dashboard-user__info">
              <span className="dashboard-user__name">{user?.name || 'John Doe'}</span>
              <span className="dashboard-user__email">john@example.com</span>
            </div>
          </div>
          <button className="dashboard-btn-new" onClick={() => onNavigate('upload')}>
            <span className="icon">＋</span> New chat
          </button>
        </div>

        <div className="dashboard-sidebar__section">
          <div className="dashboard-sidebar__title">LIBRARY</div>
          <ul className="dashboard-nav-list">
            <li className={activeMenu === 'favorites' ? 'active' : ''}><span className="icon">★</span> Favorites</li>
            <li className={activeMenu === 'files' ? 'active' : ''} onClick={() => onNavigate('files')}><span className="icon">⏱</span> Recents (File ghi âm)</li>
            <li className={activeMenu === 'subjects' ? 'active' : ''} onClick={() => onNavigate('subjects')}><span className="icon">📁</span> Môn học</li>
          </ul>
        </div>

        <div className="dashboard-sidebar__section dashboard-sidebar__scroll">
          <div className="dashboard-sidebar__title">GẦN ĐÂY</div>
          <ul className="dashboard-recents-list">
            <li className="active"><span className="icon">🎵</span> thuyet-trinh.mp3</li>
            <li><span className="icon">📁</span> Triết học Mác-Lênin</li>
            <li><span className="icon">📁</span> Kinh tế vi mô</li>
            <li><span className="icon">📁</span> Marketing</li>
            <li><span className="icon">📁</span> Thiết kế đồ họa</li>
            <li><span className="icon">📁</span> Quản trị kinh doanh</li>
          </ul>
        </div>

        <div className="dashboard-sidebar__footer">
          <ul className="dashboard-nav-list">
            <li><span className="icon">👤</span> Profile</li>
            <li><span className="icon">⚙</span> Settings</li>
            <li><span className="icon">❓</span> Support</li>
            <li><span className="icon">🔄</span> Update version</li>
            <li onClick={onLogout} style={{ cursor: 'pointer', color: '#ef4444' }}>
              <span className="icon">🚪</span> Log out
            </li>
          </ul>
        </div>
      </aside>
      
      <main className="dashboard-main">
        {children}
      </main>
    </div>
  )
}
