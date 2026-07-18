import type { McqQuestion } from '../../types/studyArtifacts'
import './study.css'

export type QuizQuestionProps = {
  question: McqQuestion
  selectedOptionId?: string | null
  showResult?: boolean
  disabled?: boolean
  onSelect: (optionId: string) => void
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
}

export function QuizQuestion({
  question,
  selectedOptionId,
  showResult = false,
  disabled = false,
  onSelect,
  onOpenEvidence,
}: QuizQuestionProps) {
  const meetingId = question.sourceMeetingIds?.[0]
  const segmentId = question.sourceSegmentIds?.[0]

  return (
    <article className="study-quiz-question" data-testid="quiz-question">
      <h3>{question.question}</h3>
      <ul className="study-quiz-options">
        {question.options.map((option) => {
          const selected = selectedOptionId === option.id
          const isCorrect = option.id === question.correctOptionId
          let className = 'study-quiz-option'
          if (showResult && isCorrect) className += ' study-quiz-option--correct'
          if (showResult && selected && !isCorrect) className += ' study-quiz-option--wrong'
          if (selected && !showResult) className += ' study-quiz-option--selected'
          return (
            <li key={option.id}>
              <button
                type="button"
                className={className}
                disabled={disabled || showResult}
                onClick={() => onSelect(option.id)}
              >
                {option.text}
              </button>
            </li>
          )
        })}
      </ul>
      {showResult && question.explanation ? (
        <p className="study-muted">{question.explanation}</p>
      ) : null}
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

export default QuizQuestion
