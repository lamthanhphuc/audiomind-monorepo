import { useState } from 'react'
import type { Flashcard } from '../../types/studyArtifacts'
import {
  createFlashcardFlipState,
  flipFlashcard,
  goToFlashcard,
} from '../../utils/flashcardQuizHelpers'
import { EmptyState } from '../ui/EmptyState'
import { FlashcardControls } from './FlashcardControls'
import { FlashcardViewer } from './FlashcardViewer'
import './study.css'

export type FlashcardDeckProps = {
  cards: Flashcard[]
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
}

export function FlashcardDeck({ cards, onOpenEvidence }: FlashcardDeckProps) {
  const [state, setState] = useState(createFlashcardFlipState(0))
  const card = cards[state.index]

  if (!cards.length) {
    return <EmptyState message="Chưa có flashcard." />
  }

  return (
    <div className="study-flashcard-deck" data-testid="flashcard-deck">
      {card ? (
        <FlashcardViewer
          card={card}
          flipped={state.flipped}
          onFlip={() => setState((current) => flipFlashcard(current))}
          onOpenEvidence={onOpenEvidence}
        />
      ) : null}
      <FlashcardControls
        index={state.index}
        total={cards.length}
        flipped={state.flipped}
        onFlip={() => setState((current) => flipFlashcard(current))}
        onPrev={() => setState((current) => goToFlashcard(current, current.index - 1, cards.length))}
        onNext={() => setState((current) => goToFlashcard(current, current.index + 1, cards.length))}
      />
    </div>
  )
}

export default FlashcardDeck
