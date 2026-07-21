import type { McqQuestion } from '../types/studyArtifacts'

export type FlashcardFlipState = {
  index: number
  flipped: boolean
}

export const createFlashcardFlipState = (index = 0): FlashcardFlipState => ({
  index,
  flipped: false,
})

export const flipFlashcard = (state: FlashcardFlipState): FlashcardFlipState => ({
  ...state,
  flipped: !state.flipped,
})

export const goToFlashcard = (
  _state: FlashcardFlipState,
  index: number,
  total: number,
): FlashcardFlipState => {
  if (total <= 0) {
    return createFlashcardFlipState(0)
  }
  const next = Math.max(0, Math.min(total - 1, index))
  return { index: next, flipped: false }
}

export type QuizAnswerMap = Record<string, string>

export type QuizScore = {
  correct: number
  total: number
  percent: number
}

export const scoreQuizAnswers = (
  questions: Pick<McqQuestion, 'id' | 'correctOptionId'>[],
  answers: QuizAnswerMap,
): QuizScore => {
  const total = questions.length
  let correct = 0
  for (const question of questions) {
    if (answers[question.id] === question.correctOptionId) {
      correct += 1
    }
  }
  const percent = total === 0 ? 0 : Math.round((correct / total) * 100)
  return { correct, total, percent }
}
