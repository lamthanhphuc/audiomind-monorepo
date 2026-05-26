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
          <button className="icon-btn">🔔</button>
          <div className="user-avatar-small">J</div>
        </div>
      </header>

      <div style={{ padding: '32px 40px', flex: 1, overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: '600', color: '#1a1a1a', margin: 0 }}>Tất cả Môn học</h1>
          <button className="btn-primary" style={{ width: 'auto', padding: '8px 16px', borderRadius: '8px', fontSize: '14px' }}>
            + Thêm môn học
          </button>
        </div>

        <div style={{ display: 'flex', gap: '24px', borderBottom: '2px solid #eef0f6', marginBottom: '24px' }}>
          <button style={{ background: 'none', border: 'none', padding: '12px 0', fontSize: '15px', color: '#666', fontWeight: '500', cursor: 'pointer' }}>
            Gần đây
          </button>
          <button style={{ background: 'none', border: 'none', padding: '12px 0', fontSize: '15px', color: '#3b4eb3', fontWeight: '600', borderBottom: '2px solid #3b4eb3', cursor: 'pointer' }}>
            Tất cả
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '20px' }}>
          {subjects.map((sub, i) => (
            <div key={i} style={{ 
              background: 'white', 
              border: '1px solid #e1e4f0', 
              borderRadius: '12px', 
              padding: '24px 20px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0,0,0,0.02)'
            }}>
              <div style={{ fontSize: '40px', marginBottom: '12px' }}>📁</div>
              <h3 style={{ fontSize: '16px', margin: '0 0 8px', color: '#111', fontWeight: '600' }}>{sub.name}</h3>
              <p style={{ margin: 0, fontSize: '13px', color: '#666' }}>{sub.count} file</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
