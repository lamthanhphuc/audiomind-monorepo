export const SUBJECT_DETAIL_TABS = [
  'meetings',
  'synthesis',
  'mind-map',
  'flashcards',
  'quiz',
  'essay',
  'exam-brief',
] as const

export type SubjectDetailTab = (typeof SUBJECT_DETAIL_TABS)[number]

export const DEFAULT_SUBJECT_TAB: SubjectDetailTab = 'meetings'

export const SUBJECT_TAB_LABELS: Record<SubjectDetailTab, string> = {
  meetings: 'Buổi học',
  synthesis: 'Tổng hợp',
  'mind-map': 'Mind map',
  flashcards: 'Flashcards',
  quiz: 'Trắc nghiệm',
  essay: 'Tự luận',
  'exam-brief': 'Ôn thi',
}

export const isSubjectDetailTab = (value: string | null | undefined): value is SubjectDetailTab => {
  if (!value) return false
  return (SUBJECT_DETAIL_TABS as readonly string[]).includes(value)
}

export const parseSubjectDetailTab = (value: string | null | undefined): SubjectDetailTab => {
  if (isSubjectDetailTab(value)) {
    return value
  }
  return DEFAULT_SUBJECT_TAB
}

export const artifactTypeForTab = (
  tab: SubjectDetailTab,
): 'MIND_MAP' | 'FLASHCARDS' | 'MULTIPLE_CHOICE' | 'ESSAY_QUESTIONS' | 'EXAM_BRIEF' | null => {
  switch (tab) {
    case 'mind-map':
      return 'MIND_MAP'
    case 'flashcards':
      return 'FLASHCARDS'
    case 'quiz':
      return 'MULTIPLE_CHOICE'
    case 'essay':
      return 'ESSAY_QUESTIONS'
    case 'exam-brief':
      return 'EXAM_BRIEF'
    default:
      return null
  }
}
