import type { EssayQuestion } from '../../types/studyArtifacts'
import { pickStudyEvidence } from '../../types/studyArtifacts'
import { EssayRubricView } from './EssayRubricView'
import './study.css'

export type EssayQuestionCardProps = {
  question: EssayQuestion
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
}

export function EssayQuestionCard({ question, onOpenEvidence }: EssayQuestionCardProps) {
  const evidence = pickStudyEvidence(question)
  const meetingId = evidence?.meetingId
  const segmentId = evidence?.segmentId

  return (
    <article className="study-essay-card" data-testid="essay-question-card">
      <h3>{question.question}</h3>
      {question.suggestedOutline?.length ? (
        <div>
          <h4>Gợi ý dàn ý</h4>
          <ol>
            {question.suggestedOutline.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {question.keyPoints?.length ? (
        <div>
          <h4>Ý cần có</h4>
          <ul>
            {question.keyPoints.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <EssayRubricView rubric={question.rubric ?? []} />
      {meetingId != null && segmentId && onOpenEvidence ? (
        <button
          type="button"
          className="btn btn--secondary btn--compact"
          onClick={() => onOpenEvidence(meetingId, segmentId)}
        >
          Xem bằng chứng
        </button>
      ) : null}
    </article>
  )
}

export default EssayQuestionCard
