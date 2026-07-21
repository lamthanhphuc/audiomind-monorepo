import type { RubricItem } from '../../types/studyArtifacts'
import './study.css'

export type EssayRubricViewProps = {
  rubric: RubricItem[]
}

export function EssayRubricView({ rubric }: EssayRubricViewProps) {
  if (!rubric.length) {
    return null
  }
  const total = rubric.reduce((sum, item) => sum + (item.points || 0), 0)
  return (
    <div className="study-essay-rubric" data-testid="essay-rubric">
      <h4>Rubric ({total} điểm)</h4>
      <ul>
        {rubric.map((item) => (
          <li key={`${item.criterion}-${item.points}`}>
            {item.criterion} — {item.points} điểm
          </li>
        ))}
      </ul>
    </div>
  )
}

export default EssayRubricView
