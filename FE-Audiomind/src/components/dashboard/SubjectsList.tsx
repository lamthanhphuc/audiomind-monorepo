export default function SubjectsList() {
  const subjects = [
    { name: 'Trí tuệ nhân tạo', count: 12 },
    { name: 'Triết học Mác-Lênin', count: 5 },
    { name: 'Kinh tế vi mô', count: 8 },
    { name: 'Marketing', count: 3 },
    { name: 'Toán rời rạc', count: 14 },
    { name: 'Lập trình web', count: 7 },
    { name: 'Quản trị kinh doanh', count: 10 },
    { name: 'Thiết kế đồ hoạ', count: 4 },
  ]

  return (
    <div className="dashboard-page bg-gray-light">
      <header className="dashboard-header border-b">
        <div className="search-bar">
          <span className="icon">🔍</span>
          <input type="text" placeholder="Tìm bài giảng, môn học, ghi chú..." />
        </div>
        <div className="header-actions">
          <button type="button" className="icon-btn" aria-label="Thông báo">🔔</button>
          <div className="user-avatar-small">J</div>
        </div>
      </header>

      <div className="subjects-page">
        <div className="subjects-page__head">
          <div className="studio-page-head">
            <h1>Tất cả Môn học</h1>
          </div>
          <button type="button" className="btn-primary" style={{ width: 'auto', padding: '8px 16px', fontSize: '14px' }}>
            + Thêm môn học
          </button>
        </div>

        <div className="subjects-page__tabs">
          <button type="button" className="subjects-page__tab">Gần đây</button>
          <button type="button" className="subjects-page__tab subjects-page__tab--active">Tất cả</button>
        </div>

        <div className="subjects-grid">
          {subjects.map((sub) => (
            <div key={sub.name} className="subject-card">
              <div style={{ fontSize: '40px', marginBottom: '12px', textAlign: 'center' }}>📁</div>
              <h3>{sub.name}</h3>
              <p>{sub.count} file</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
