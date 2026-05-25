export default function FilesList() {
  const files = [
    { title: 'Thuyết trình môn AI cho các bạn sinh viên', subject: 'Trí tuệ nhân tạo', date: '24/10/2023', duration: '45:30' },
    { title: 'Bài giảng Triết học Mác Lê-nin chương 1', subject: 'Triết học Mác-Lênin', date: '22/10/2023', duration: '1:20:15' },
    { title: 'Kinh tế vi mô - Cơ bản', subject: 'Kinh tế vi mô', date: '20/10/2023', duration: '50:00' },
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

      <div className="table-page-content" style={{ padding: '32px 40px', flex: 1, overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: '600', color: '#1a1a1a', margin: 0 }}>File đã tải lên</h1>
          <div style={{ display: 'flex', gap: '12px' }}>
            <select className="filter-select"><option>Tất cả môn học</option></select>
            <select className="filter-select"><option>Mới nhất</option></select>
            <select className="filter-select"><option>Tất cả thời gian</option></select>
          </div>
        </div>

        <div className="table-container" style={{ background: 'white', borderRadius: '12px', border: '1px solid #e1e4f0' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e1e4f0', color: '#666', fontSize: '13px' }}>
                <th style={{ padding: '16px 20px', width: '40px' }}><input type="checkbox" /></th>
                <th style={{ padding: '16px 20px' }}>Tên file</th>
                <th style={{ padding: '16px 20px' }}>Môn học</th>
                <th style={{ padding: '16px 20px' }}>Ngày tải lên</th>
                <th style={{ padding: '16px 20px' }}>Thời lượng</th>
                <th style={{ padding: '16px 20px', width: '40px' }}></th>
              </tr>
            </thead>
            <tbody>
              {files.map((f, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f0f2f5', fontSize: '14px', color: '#111' }}>
                  <td style={{ padding: '16px 20px' }}><input type="checkbox" /></td>
                  <td style={{ padding: '16px 20px', fontWeight: '500', color: '#3b4eb3' }}>
                    <span style={{ marginRight: '8px' }}>🎵</span>{f.title}
                  </td>
                  <td style={{ padding: '16px 20px', color: '#444' }}>{f.subject}</td>
                  <td style={{ padding: '16px 20px', color: '#666' }}>{f.date}</td>
                  <td style={{ padding: '16px 20px', color: '#666' }}>{f.duration}</td>
                  <td style={{ padding: '16px 20px', color: '#999', cursor: 'pointer' }}>⋮</td>
                </tr>
              ))}
            </tbody>
          </table>
          
          <div style={{ padding: '16px 20px', borderTop: '1px solid #e1e4f0', display: 'flex', justifyContent: 'center' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="pagination-btn active">1</button>
              <button className="pagination-btn">2</button>
              <button className="pagination-btn">3</button>
              <span style={{ padding: '4px 8px' }}>...</span>
              <button className="pagination-btn">10</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
