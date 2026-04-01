type TopNavProps = {
  user: { name: string; role: string } | null
  onLogout: () => void
  onTry?: () => void
  isGuest?: boolean
  activeNav?: string
  onNavChange?: (next: string) => void
}

const navItems = ['Trang chủ', 'Tính năng', 'Hỗ trợ', 'Tin tức', 'Ưu đãi']

export default function TopNav({
  user,
  onLogout,
  onTry,
  isGuest,
  activeNav,
  onNavChange,
}: TopNavProps) {
  return (
    <header className="top-nav">
      <div className="brand">
        <div className="brand__logo">M</div>
        <div>
          <div className="brand__name">mind</div>
          <div className="brand__tag">Audio Learning</div>
        </div>
      </div>

      <nav className="top-nav__links">
        {navItems.map((item) => (
          <button
            key={item}
            className={`nav-link ${item === (activeNav ?? 'Trang chủ') ? 'nav-link--active' : ''}`}
            type="button"
            onClick={() => onNavChange?.(item)}
          >
            {item}
          </button>
        ))}
      </nav>

      <div className="top-nav__user">
        {isGuest ? (
          <>
            <button className="primary-pill" type="button" onClick={onTry}>
              Dùng thử miễn phí
            </button>
            <span className="bell">🔔</span>
          </>
        ) : (
          <>
            <span className="user-icon">◦</span>
            <span className="user-name">{user ? user.name : 'Đăng nhập'}</span>
            {user && (
              <button className="ghost-button" type="button" onClick={onLogout}>
                Thoát
              </button>
            )}
          </>
        )}
      </div>
    </header>
  )
}
