import CrossMeetingPanel from './CrossMeetingPanel'
import OrgMemoryPanel from './OrgMemoryPanel'

type ExpansionDashboardSceneProps = {
  onOpenMeeting?: (meetingId: number) => void
  embeddingSearchEnabled?: boolean
}

const ROADMAP_CARDS = [
  {
    title: 'Bộ nhớ tổ chức',
    description: 'Tổng hợp glossary và speaker đã lưu xuyên suốt các cuộc họp của bạn.',
    status: 'đã có',
  },
  {
    title: 'Hồ sơ speaker xuyên meeting',
    description: 'Đổi tên speaker và gợi ý từ lịch sử rename; nhận diện giọng ML là nâng cấp tùy chọn.',
    status: 'một phần',
  },
  {
    title: 'Tìm kiếm vector',
    description: 'Embedding Gemini được index khi phân tích xong; cross-meeting search ưu tiên vector khi bật.',
    status: 'đã có',
  },
  {
    title: 'Sơ đồ chủ đề nâng cao',
    description: 'Mindmap React Flow có drag/zoom, thu gọn nhánh và export PNG chất lượng cao.',
    status: 'một phần',
  },
] as const

export default function ExpansionDashboardScene({
  onOpenMeeting,
  embeddingSearchEnabled = true,
}: ExpansionDashboardSceneProps) {
  const cards = ROADMAP_CARDS.map((card) => {
    if (card.title === 'Tìm kiếm vector' && !embeddingSearchEnabled) {
      return { ...card, status: 'sắp có' as const, description: 'Bật EMBEDDING_SEARCH_ENABLED trên server để kích hoạt chỉ mục vector.' }
    }
    return card
  })

  return (
    <div className="feature-scene studio-page" data-testid="expansion-dashboard-scene">
      <header>
        <h1 className="studio-page-title">Insights</h1>
        <p className="studio-page-subtitle">
          Hỏi xuyên suốt nhiều cuộc họp, xem bộ nhớ tổ chức và các hướng mở rộng.
        </p>
      </header>

      <CrossMeetingPanel onOpenMeeting={onOpenMeeting} />

      <section className="studio-card">
        <h2 className="studio-page-head">Bộ nhớ tổ chức</h2>
        <OrgMemoryPanel onOpenMeeting={onOpenMeeting} />
      </section>

      <section className="studio-card">
        <h2 className="studio-page-head">Tính năng & roadmap</h2>
        <div className="expansion-roadmap-grid">
          {cards.map((card) => (
            <article key={card.title} className="expansion-roadmap-card">
              <div className="expansion-roadmap-card__head">
                <strong className="expansion-roadmap-card__title">{card.title}</strong>
                <span className="meta-pill">{card.status}</span>
              </div>
              <p className="studio-muted-text">{card.description}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
