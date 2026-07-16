export type EducationImportance = 'HIGH' | 'MEDIUM' | 'LOW'

export type EducationSection = {
  id: string
  title: string
  summary: string
  keyPoints: string[]
  keywords: string[]
  sourceSegmentIds: string[]
}

export type EducationKeyPoint = {
  content: string
  importance: EducationImportance
  sourceSegmentIds: string[]
}

export type EducationGlossaryItem = {
  term: string
  definition: string
  example?: string | null
  category?: string | null
  sourceSegmentIds: string[]
}

export type EducationMustRememberItem = {
  content: string
  importance: EducationImportance
  reason?: string | null
  sourceSegmentIds: string[]
}

export type EducationUnclearPoint = {
  content: string
  reason: string
  sourceSegmentIds: string[]
}

export type EducationStudy = {
  title: string
  overview: string
  learningObjectives: string[]
  sections: EducationSection[]
  keyPoints: EducationKeyPoint[]
  keywords: string[]
  glossary: EducationGlossaryItem[]
  mustRemember: EducationMustRememberItem[]
  unclearPoints: EducationUnclearPoint[]
}

const normalizeImportance = (value: unknown): EducationImportance => {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (normalized === 'HIGH' || normalized === 'LOW') {
    return normalized
  }
  return 'MEDIUM'
}

const normalizeStringList = (value: unknown, limit = 32): string[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    const text = String(item ?? '').trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
    if (result.length >= limit) break
  }
  return result
}

const normalizeSegmentIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
}

const normalizeSection = (value: unknown, index: number): EducationSection | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const title = String(record.title ?? '').trim()
  if (!title) return null
  return {
    id: String(record.id ?? `section-${index + 1}`).trim(),
    title,
    summary: String(record.summary ?? '').trim(),
    keyPoints: normalizeStringList(record.keyPoints ?? record.key_points),
    keywords: normalizeStringList(record.keywords),
    sourceSegmentIds: normalizeSegmentIds(record.sourceSegmentIds ?? record.source_segment_ids),
  }
}

const normalizeKeyPoint = (value: unknown): EducationKeyPoint | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const content = String(record.content ?? '').trim()
  if (!content) return null
  return {
    content,
    importance: normalizeImportance(record.importance),
    sourceSegmentIds: normalizeSegmentIds(record.sourceSegmentIds ?? record.source_segment_ids),
  }
}

const normalizeGlossaryItem = (value: unknown): EducationGlossaryItem | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const term = String(record.term ?? '').trim()
  const definition = String(record.definition ?? '').trim()
  if (!term || !definition) return null
  return {
    term,
    definition,
    example: String(record.example ?? '').trim() || null,
    category: String(record.category ?? '').trim() || null,
    sourceSegmentIds: normalizeSegmentIds(record.sourceSegmentIds ?? record.source_segment_ids),
  }
}

const normalizeMustRemember = (value: unknown): EducationMustRememberItem | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const content = String(record.content ?? '').trim()
  if (!content) return null
  return {
    content,
    importance: normalizeImportance(record.importance),
    reason: String(record.reason ?? '').trim() || null,
    sourceSegmentIds: normalizeSegmentIds(record.sourceSegmentIds ?? record.source_segment_ids),
  }
}

const normalizeUnclearPoint = (value: unknown): EducationUnclearPoint | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const content = String(record.content ?? '').trim()
  const reason = String(record.reason ?? '').trim()
  if (!content) return null
  return {
    content,
    reason: reason || 'Chưa rõ',
    sourceSegmentIds: normalizeSegmentIds(record.sourceSegmentIds ?? record.source_segment_ids),
  }
}

export const normalizeEducationStudyAnalysis = (value: unknown): EducationStudy | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const title = String(record.title ?? '').trim()
  const overview = String(record.overview ?? '').trim()
  const sections = (Array.isArray(record.sections) ? record.sections : [])
    .map((item, index) => normalizeSection(item, index))
    .filter((item): item is EducationSection => item != null)
  const keyPoints = (Array.isArray(record.keyPoints ?? record.key_points) ? (record.keyPoints ?? record.key_points) as unknown[] : [])
    .map((item) => normalizeKeyPoint(item))
    .filter((item): item is EducationKeyPoint => item != null)
  const glossary = (Array.isArray(record.glossary) ? record.glossary : [])
    .map((item) => normalizeGlossaryItem(item))
    .filter((item): item is EducationGlossaryItem => item != null)
  const mustRemember = (Array.isArray(record.mustRemember ?? record.must_remember) ? (record.mustRemember ?? record.must_remember) as unknown[] : [])
    .map((item) => normalizeMustRemember(item))
    .filter((item): item is EducationMustRememberItem => item != null)
  const unclearPoints = (Array.isArray(record.unclearPoints ?? record.unclear_points) ? (record.unclearPoints ?? record.unclear_points) as unknown[] : [])
    .map((item) => normalizeUnclearPoint(item))
    .filter((item): item is EducationUnclearPoint => item != null)
  const learningObjectives = normalizeStringList(record.learningObjectives ?? record.learning_objectives)
  const keywords = normalizeStringList(record.keywords)

  const hasContent = Boolean(
    title
    || overview
    || learningObjectives.length > 0
    || sections.length > 0
    || keyPoints.length > 0
    || keywords.length > 0
    || glossary.length > 0
    || mustRemember.length > 0
    || unclearPoints.length > 0,
  )
  if (!hasContent) {
    return null
  }

  return {
    title,
    overview,
    learningObjectives,
    sections,
    keyPoints,
    keywords,
    glossary,
    mustRemember,
    unclearPoints,
  }
}
