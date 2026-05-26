type SidebarProps = {
  meetingTitle?: string
  meetingId?: number | null
}

const menuItems = [
  'File ghi âm',
  'Môn học',
  'Tài liệu học tập',
  'Hồ sơ cá nhân',
  'Cài đặt',
]

const recentCourses = [
  'Triết học Mác-Lênin',
  'Kinh tế vi mô',
  'Marketing',
  'Thiết kế đồ họa',
  'Quản trị kinh doanh',
]

export default function Sidebar({ meetingTitle, meetingId }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-card">
        <ul className="sidebar-menu">
          {menuItems.map((item) => (
            <li key={item}>
              <span className="menu-dot" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div className="sidebar-card sidebar-card--compact">
        <h3>Môn học gần đây</h3>
        <ul className="recent-list">
          {recentCourses.map((course) => (
            <li key={course}>
              <span>{course}</span>
              <span className="badge">100+</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="sidebar-card sidebar-card--accent">
        <h4>Phiên làm việc</h4>
        <p>{meetingTitle || 'Chưa có phiên ghi âm'}</p>
        <span className="pill">ID: {meetingId ?? '--'}</span>
      </div>
    </aside>
  )
}
