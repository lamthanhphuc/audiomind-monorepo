import { describe, expect, it } from 'vitest'
import { aggregateStudyStatuses, isStudyArtifactTerminal } from '../types/studyArtifacts'
import {
  createFlashcardFlipState,
  flipFlashcard,
  goToFlashcard,
  scoreQuizAnswers,
} from './flashcardQuizHelpers'

describe('aggregateStudyStatuses', () => {
  it('returns FAILED for empty list', () => {
    expect(aggregateStudyStatuses([])).toBe('FAILED')
  })

  it('prefers PROCESSING over QUEUED', () => {
    expect(aggregateStudyStatuses(['QUEUED', 'PROCESSING', 'COMPLETED'])).toBe('PROCESSING')
  })

  it('returns QUEUED when only queued among non-processing', () => {
    expect(aggregateStudyStatuses(['QUEUED', 'COMPLETED'])).toBe('QUEUED')
  })

  it('returns COMPLETED when all terminal success', () => {
    expect(aggregateStudyStatuses(['COMPLETED', 'STALE'])).toBe('COMPLETED')
  })

  it('returns PARTIALLY_FAILED for mixed success and failure', () => {
    expect(aggregateStudyStatuses(['COMPLETED', 'FAILED'])).toBe('PARTIALLY_FAILED')
  })

  it('returns FAILED when all terminal failures', () => {
    expect(aggregateStudyStatuses(['FAILED', 'QUOTA_EXCEEDED'])).toBe('FAILED')
  })

  it('detects terminal statuses', () => {
    expect(isStudyArtifactTerminal('COMPLETED')).toBe(true)
    expect(isStudyArtifactTerminal('QUEUED')).toBe(false)
  })
})

describe('flashcardQuizHelpers', () => {
  it('flips flashcard state', () => {
    const initial = createFlashcardFlipState(0)
    expect(initial.flipped).toBe(false)
    expect(flipFlashcard(initial).flipped).toBe(true)
  })

  it('resets flip when changing card', () => {
    const flipped = flipFlashcard(createFlashcardFlipState(0))
    expect(goToFlashcard(flipped, 1, 3)).toEqual({ index: 1, flipped: false })
  })

  it('scores quiz answers', () => {
    const score = scoreQuizAnswers(
      [
        { id: 'q1', correctOptionId: 'a' },
        { id: 'q2', correctOptionId: 'b' },
      ],
      { q1: 'a', q2: 'x' },
    )
    expect(score).toEqual({ correct: 1, total: 2, percent: 50 })
  })
})
