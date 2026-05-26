import { useMemo } from 'react'
import { normalizeAnalysisResponse, type AiAnalysis } from '../../types'

type FeatureMindmapProps = {
  analysis: AiAnalysis | null
  onLoadAnalysis: () => Promise<void>
  busy?: boolean
  meetingId?: number | null
}

export default function FeatureMindmap({ analysis, onLoadAnalysis, busy, meetingId }: FeatureMindmapProps) {
  const normalizedAnalysis = useMemo(() => normalizeAnalysisResponse(analysis), [analysis])
  const keywords = normalizedAnalysis.keywords.slice(0, 4)
  const actions = normalizedAnalysis.actionItems.slice(0, 3)
  const technicalTerms = normalizedAnalysis.technicalTerms.slice(0, 4)
  const painPoints = normalizedAnalysis.painPoints.slice(0, 3)

  return (
    <section className="feature-scene feature-mindmap-scene">
      <section className="hero feature-hero feature-hero--mindmap">
        <div className="hero__search">
          <input className="search-input" type="search" placeholder="Tìm bài giảng, môn học, ghi chú..." />
          <span className="search-icon">⌕</span>
        </div>
        <div className="hero__content">
          <h1>Mindmap bài giảng</h1>
          <p>Trực quan hóa bài học bằng sơ đồ nhánh để dễ dàng ôn tập.</p>
        </div>
      </section>

      <section className="feature-panel feature-mindmap">
        <header className="feature-panel__header">
          <h2>Sơ đồ tổng hợp</h2>
          <button type="button" className="secondary-cta" disabled={busy || !meetingId} onClick={onLoadAnalysis}>
            Làm mới dữ liệu
          </button>
        </header>

        <div className="mindmap-status">
          <span className="feature-chip">Meeting ID: {meetingId ?? '--'}</span>
          <span className="mindmap-status__dot" />
          <span>{analysis ? `Đã đồng bộ dữ liệu (${normalizedAnalysis.domainMode})` : 'Chưa có dữ liệu phân tích'}</span>
        </div>

        <div className="mindmap-canvas">
          <div className="mindmap-graph mindmap-graph--large">
            <div className="mindmap-graph__root">Buoi hoc</div>

            <div className="mindmap-graph__col">
              <h4>Từ khóa</h4>
              {keywords.length ? keywords.map((item) => <span key={item} className="mind-pill">{item}</span>) : <span className="mind-pill">Chờ dữ liệu...</span>}
            </div>

            <div className="mindmap-graph__col">
              <h4>Thuật ngữ</h4>
              {technicalTerms.length
                ? technicalTerms.map((item) => (
                    <span key={item.term} className="mind-pill mind-pill--muted" title={item.meaning || ''}>
                      {item.term}
                    </span>
                  ))
                : <span className="mind-pill mind-pill--muted">Chờ dữ liệu...</span>}
            </div>

            <div className="mindmap-graph__col">
              <h4>Pain points</h4>
              {painPoints.length
                ? painPoints.map((item) => (
                    <span key={`${item.title}-${item.severity}`} className="mind-pill" style={{ background: item.severity === 'high' ? '#fee2e2' : item.severity === 'medium' ? '#fef3c7' : '#dcfce7' }}>
                      {item.title}
                    </span>
                  ))
                : <span className="mind-pill">Chờ dữ liệu...</span>}
            </div>

            <div className="mindmap-graph__col mindmap-graph__col--actions">
              <h4>Hành động</h4>
              {actions.length
                ? actions.map((item) => (
                    <span key={item} className="mind-pill mind-pill--accent">
                      {item}
                    </span>
                  ))
                : <span className="mind-pill mind-pill--accent">Chờ dữ liệu...</span>}
            </div>
          </div>
        </div>
      </section>
    </section>
  )
}
