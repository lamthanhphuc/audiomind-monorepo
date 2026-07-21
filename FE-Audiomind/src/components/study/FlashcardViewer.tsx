import type { Flashcard } from '../../types/studyArtifacts'
import { pickStudyEvidence } from '../../types/studyArtifacts'
import './study.css'

export type FlashcardViewerProps = {
  card: Flashcard
  flipped: boolean
  onFlip: () => void
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
}

export function FlashcardViewer({ card, flipped, onFlip, onOpenEvidence }: FlashcardViewerProps) {
  const evidence = pickStudyEvidence(card)
  const meetingId = evidence?.meetingId
  const segmentId = evidence?.segmentId

  return (
    <button
      type="button"
      className={`study-flashcard ${flipped ? 'study-flashcard--flipped' : ''}`}
      onClick={onFlip}
      data-testid="flashcard-viewer"
      aria-pressed={flipped}
    >
      <span className="study-flashcard__face">
        {flipped ? card.back : card.front}
      </span>
      {card.hint && !flipped ? <span className="study-muted">Gợi ý: {card.hint}</span> : null}
      {meetingId != null && segmentId && onOpenEvidence ? (
        <span
          className="study-flashcard__evidence"
          role="link"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation()
            onOpenEvidence(meetingId, segmentId)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation()
              onOpenEvidence(meetingId, segmentId)
            }
          }}
        >
          Bằng chứng
        </span>
      ) : null}
    </button>
  )
}

export default FlashcardViewer
