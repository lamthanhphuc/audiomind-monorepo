import type { AnalysisPainPoint } from '../../types'
import './analysis-panel.css'

const severityClass = (severity: AnalysisPainPoint['severity']) => {
  if (severity === 'high') return 'pain-point-card__severity--high'
  if (severity === 'medium') return 'pain-point-card__severity--medium'
  return 'pain-point-card__severity--low'
}

type PainPointCardProps = {
  item: AnalysisPainPoint
}

export const PainPointCard = ({ item }: PainPointCardProps) => (
  <article className="pain-point-card">
    <div className="pain-point-card__header">
      <strong className="pain-point-card__title">{item.title}</strong>
      <span className={`pain-point-card__severity ${severityClass(item.severity)}`}>
        {item.severity}
      </span>
    </div>
    <p className="pain-point-card__evidence">{item.evidence || 'Không có dẫn chứng'}</p>
  </article>
)
