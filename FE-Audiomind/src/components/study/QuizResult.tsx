import type { QuizScore } from '../../utils/flashcardQuizHelpers'
import './study.css'

export type QuizResultProps = {
  score: QuizScore
  onRetry?: () => void
}

export function QuizResult({ score, onRetry }: QuizResultProps) {
  return (
    <div className="study-quiz-result" data-testid="quiz-result">
      <h3>Kết quả</h3>
      <p>
        Đúng {score.correct}/{score.total} ({score.percent}%)
      </p>
      {onRetry ? (
        <button type="button" className="btn btn--primary btn--compact" onClick={onRetry}>
          Làm lại
        </button>
      ) : null}
    </div>
  )
}

export default QuizResult
