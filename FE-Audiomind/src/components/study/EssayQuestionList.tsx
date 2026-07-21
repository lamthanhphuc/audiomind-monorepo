import type { EssayQuestion } from '../../types/studyArtifacts'
import { EmptyState } from '../ui/EmptyState'
import { EssayQuestionCard } from './EssayQuestionCard'
import './study.css'

export type EssayQuestionListProps = {
  questions: EssayQuestion[]
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
}

export function EssayQuestionList({ questions, onOpenEvidence }: EssayQuestionListProps) {
  if (!questions.length) {
    return <EmptyState message="Chưa có câu hỏi tự luận." />
  }
  return (
    <div className="study-essay-list" data-testid="essay-question-list">
      {questions.map((question) => (
        <EssayQuestionCard
          key={question.id || question.question}
          question={question}
          onOpenEvidence={onOpenEvidence}
        />
      ))}
    </div>
  )
}

export default EssayQuestionList
