import './study.css'

export type FlashcardControlsProps = {
  index: number
  total: number
  flipped: boolean
  onPrev: () => void
  onNext: () => void
  onFlip: () => void
}

export function FlashcardControls({
  index,
  total,
  flipped,
  onPrev,
  onNext,
  onFlip,
}: FlashcardControlsProps) {
  return (
    <div className="study-flashcard-controls" data-testid="flashcard-controls">
      <button
        type="button"
        className="btn btn--secondary btn--compact"
        onClick={onPrev}
        disabled={index <= 0}
      >
        Trước
      </button>
      <span className="study-muted">
        {total === 0 ? '0/0' : `${index + 1}/${total}`}
      </span>
      <button type="button" className="btn btn--secondary btn--compact" onClick={onFlip}>
        {flipped ? 'Mặt trước' : 'Lật thẻ'}
      </button>
      <button
        type="button"
        className="btn btn--secondary btn--compact"
        onClick={onNext}
        disabled={index >= total - 1}
      >
        Sau
      </button>
    </div>
  )
}

export default FlashcardControls
