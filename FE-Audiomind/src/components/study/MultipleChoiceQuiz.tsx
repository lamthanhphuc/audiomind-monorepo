import { useMemo, useState } from 'react'
import type { McqQuestion } from '../../types/studyArtifacts'
import { scoreQuizAnswers, type QuizAnswerMap } from '../../utils/flashcardQuizHelpers'
import { EmptyState } from '../ui/EmptyState'
import { QuizQuestion } from './QuizQuestion'
import { QuizResult } from './QuizResult'
import './study.css'

export type MultipleChoiceQuizProps = {
  questions: McqQuestion[]
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
}

export function MultipleChoiceQuiz({ questions, onOpenEvidence }: MultipleChoiceQuizProps) {
  const [answers, setAnswers] = useState<QuizAnswerMap>({})
  const [submitted, setSubmitted] = useState(false)

  const score = useMemo(() => scoreQuizAnswers(questions, answers), [answers, questions])

  if (!questions.length) {
    return <EmptyState message="Chưa có câu hỏi trắc nghiệm." />
  }

  return (
    <div className="study-quiz" data-testid="multiple-choice-quiz">
      {questions.map((question) => (
        <QuizQuestion
          key={question.id}
          question={question}
          selectedOptionId={answers[question.id]}
          showResult={submitted}
          disabled={submitted}
          onSelect={(optionId) =>
            setAnswers((prev) => ({
              ...prev,
              [question.id]: optionId,
            }))
          }
          onOpenEvidence={onOpenEvidence}
        />
      ))}
      {!submitted ? (
        <button
          type="button"
          className="btn btn--primary btn--compact"
          data-testid="quiz-submit"
          onClick={() => setSubmitted(true)}
          disabled={Object.keys(answers).length < questions.length}
        >
          Nộp bài
        </button>
      ) : (
        <QuizResult
          score={score}
          onRetry={() => {
            setAnswers({})
            setSubmitted(false)
          }}
        />
      )}
    </div>
  )
}

export default MultipleChoiceQuiz
