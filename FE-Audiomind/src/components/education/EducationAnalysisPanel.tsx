import type { AiAnalysis, EducationImportance } from '../../types'
import type { EvidenceClickHandler } from '../../utils/transcriptEvidence'
import { EducationEvidenceButton } from './EducationEvidenceButton'
import './education-panel.css'

export type EducationAnalysisPanelProps = {
  analysis: AiAnalysis
  onEvidenceClick?: EvidenceClickHandler
}

const importanceLabel = (importance: EducationImportance): string => {
  if (importance === 'HIGH') return 'Cao'
  if (importance === 'LOW') return 'Thấp'
  return 'Trung bình'
}

const importanceClass = (importance: EducationImportance): string => {
  if (importance === 'HIGH') return 'education-importance--high'
  if (importance === 'LOW') return 'education-importance--low'
  return 'education-importance--medium'
}

export function EducationAnalysisPanel({
  analysis,
  onEvidenceClick,
}: EducationAnalysisPanelProps) {
  const study = analysis.educationStudy
  if (!study) {
    return null
  }
  const evidenceUnavailable = analysis.evidenceUnavailable === true

  return (
    <section className="education-panel" data-testid="education-analysis-panel">
      <header className="education-panel__header">
        <div>
          <h2 className="education-panel__title">
            {study.title?.trim() || 'Nội dung học tập'}
          </h2>
        </div>
        <span className="education-panel__badge">Education</span>
      </header>

      {study.overview?.trim() ? (
        <div className="education-section">
          <h3 className="education-section__title">Tổng quan</h3>
          <p className="education-panel__overview">{study.overview}</p>
        </div>
      ) : null}

      {study.learningObjectives.length > 0 ? (
        <div className="education-section">
          <h3 className="education-section__title">Mục tiêu học tập</h3>
          <ul className="education-list">
            {study.learningObjectives.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {study.sections.length > 0 ? (
        <div className="education-section">
          <h3 className="education-section__title">Các phần nội dung</h3>
          <div className="education-section" style={{ gap: 12 }}>
            {study.sections.map((section) => (
              <article key={section.id} className="education-item">
                <div className="education-item__meta">
                  <h4 className="education-section__heading">{section.title}</h4>
                  <EducationEvidenceButton
                    sourceSegmentIds={section.sourceSegmentIds}
                    onEvidenceClick={onEvidenceClick}
                    evidenceUnavailable={evidenceUnavailable}
                  />
                </div>
                {section.summary ? <p className="education-panel__overview">{section.summary}</p> : null}
                {section.keyPoints.length > 0 ? (
                  <ul className="education-list">
                    {section.keyPoints.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                ) : null}
                {section.keywords.length > 0 ? (
                  <div className="education-chips">
                    {section.keywords.map((keyword) => (
                      <span key={keyword} className="education-chip">{keyword}</span>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {study.keyPoints.length > 0 ? (
        <div className="education-section">
          <h3 className="education-section__title">Điểm chính</h3>
          <div className="education-section" style={{ gap: 8 }}>
            {study.keyPoints.map((item) => (
              <article key={item.content} className="education-item">
                <div className="education-item__meta">
                  <span className={`education-importance ${importanceClass(item.importance)}`}>
                    {importanceLabel(item.importance)}
                  </span>
                  <EducationEvidenceButton
                    sourceSegmentIds={item.sourceSegmentIds}
                    onEvidenceClick={onEvidenceClick}
                    evidenceUnavailable={evidenceUnavailable}
                  />
                </div>
                <p className="education-panel__overview">{item.content}</p>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {study.keywords.length > 0 ? (
        <div className="education-section">
          <h3 className="education-section__title">Từ khóa</h3>
          <div className="education-chips">
            {study.keywords.map((keyword) => (
              <span key={keyword} className="education-chip">{keyword}</span>
            ))}
          </div>
        </div>
      ) : null}

      {study.glossary.length > 0 ? (
        <div className="education-section">
          <h3 className="education-section__title">Thuật ngữ</h3>
          <div className="education-section" style={{ gap: 8 }}>
            {study.glossary.map((item) => (
              <article key={`${item.term}-${item.definition}`} className="education-item">
                <div className="education-item__meta">
                  <p className="education-glossary-term">{item.term}</p>
                  <EducationEvidenceButton
                    sourceSegmentIds={item.sourceSegmentIds}
                    onEvidenceClick={onEvidenceClick}
                    evidenceUnavailable={evidenceUnavailable}
                  />
                </div>
                <p className="education-glossary-def">{item.definition}</p>
                {item.example ? (
                  <p className="education-item__example">Ví dụ: {item.example}</p>
                ) : null}
                {item.category ? (
                  <p className="education-item__category">Nhóm: {item.category}</p>
                ) : null}
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {study.mustRemember.length > 0 ? (
        <div className="education-section">
          <h3 className="education-section__title">Cần nhớ</h3>
          <div className="education-section" style={{ gap: 8 }}>
            {study.mustRemember.map((item) => (
              <article key={item.content} className="education-item">
                <div className="education-item__meta">
                  <span className={`education-importance ${importanceClass(item.importance)}`}>
                    {importanceLabel(item.importance)}
                  </span>
                  <EducationEvidenceButton
                    sourceSegmentIds={item.sourceSegmentIds}
                    onEvidenceClick={onEvidenceClick}
                    evidenceUnavailable={evidenceUnavailable}
                  />
                </div>
                <p className="education-panel__overview">{item.content}</p>
                {item.reason ? <p className="education-item__reason">{item.reason}</p> : null}
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {study.unclearPoints.length > 0 ? (
        <div className="education-section">
          <h3 className="education-section__title">Điểm chưa rõ</h3>
          <div className="education-section" style={{ gap: 8 }}>
            {study.unclearPoints.map((item) => (
              <article key={item.content} className="education-item">
                <div className="education-item__meta">
                  <EducationEvidenceButton
                    sourceSegmentIds={item.sourceSegmentIds}
                    onEvidenceClick={onEvidenceClick}
                    evidenceUnavailable={evidenceUnavailable}
                  />
                </div>
                <p className="education-panel__overview">{item.content}</p>
                <p className="education-item__reason">{item.reason}</p>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default EducationAnalysisPanel
