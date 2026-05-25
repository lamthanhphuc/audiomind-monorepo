import type { AnalysisTechnicalTerm } from '../../types'
import './analysis-panel.css'

type TechnicalTermCardProps = {
  term: AnalysisTechnicalTerm
}

export const TechnicalTermCard = ({ term }: TechnicalTermCardProps) => (
  <article className="technical-term-card">
    <div className="technical-term-card__header">
      <strong className="technical-term-card__term">{term.term}</strong>
      <span className="technical-term-card__category">{term.category || 'uncategorized'}</span>
    </div>
    <p className="technical-term-card__meaning">{term.meaning || 'Chưa có mô tả'}</p>
  </article>
)
