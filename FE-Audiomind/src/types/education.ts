import { canonicalizeSegmentId } from '../utils/transcriptEvidence'

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

/**
 * Coerces a value to a trimmed string ONLY when it is actually a string.
 * Unlike `String(value)`, this never turns objects/numbers/null into text
 * (e.g. `String({})` => "[object Object]"); non-string input yields ''.
 */
const asTrimmedString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const normalizeImportance = (value: unknown): EducationImportance => {
  const normalized = asTrimmedString(value).toUpperCase()
  if (normalized === 'HIGH' || normalized === 'LOW') {
    return normalized
  }
  return 'MEDIUM'
}

/** Normalizes an array of free-text strings: string-only items, trims, dedupes case-insensitively, caps length. */
const normalizeStringArray = (value: unknown, limit = 32): string[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    const text = asTrimmedString(item)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
    if (result.length >= limit) break
  }
  return result
}

/** Normalizes source segment ids: string-only items, canonicalized (legacy or canonical form), deduped. */
const normalizeSegmentIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    const text = asTrimmedString(item)
    if (!text) continue
    const canonical = canonicalizeSegmentId(text)
    if (!canonical || seen.has(canonical)) continue
    seen.add(canonical)
    result.push(canonical)
  }
  return result
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

const normalizeSection = (value: unknown, index: number): EducationSection | null => {
  if (!isPlainObject(value)) {
    return null
  }
  const title = asTrimmedString(value.title)
  if (!title) return null
  return {
    id: asTrimmedString(value.id) || `section-${index + 1}`,
    title,
    summary: asTrimmedString(value.summary),
    keyPoints: normalizeStringArray(value.keyPoints ?? value.key_points),
    keywords: normalizeStringArray(value.keywords),
    sourceSegmentIds: normalizeSegmentIds(value.sourceSegmentIds ?? value.source_segment_ids),
  }
}

const normalizeKeyPoint = (value: unknown): EducationKeyPoint | null => {
  if (!isPlainObject(value)) {
    return null
  }
  const content = asTrimmedString(value.content)
  if (!content) return null
  return {
    content,
    importance: normalizeImportance(value.importance),
    sourceSegmentIds: normalizeSegmentIds(value.sourceSegmentIds ?? value.source_segment_ids),
  }
}

const normalizeGlossaryItem = (value: unknown): EducationGlossaryItem | null => {
  if (!isPlainObject(value)) {
    return null
  }
  const term = asTrimmedString(value.term)
  const definition = asTrimmedString(value.definition)
  if (!term || !definition) return null
  return {
    term,
    definition,
    example: asTrimmedString(value.example) || null,
    category: asTrimmedString(value.category) || null,
    sourceSegmentIds: normalizeSegmentIds(value.sourceSegmentIds ?? value.source_segment_ids),
  }
}

const normalizeMustRemember = (value: unknown): EducationMustRememberItem | null => {
  if (!isPlainObject(value)) {
    return null
  }
  const content = asTrimmedString(value.content)
  if (!content) return null
  return {
    content,
    importance: normalizeImportance(value.importance),
    reason: asTrimmedString(value.reason) || null,
    sourceSegmentIds: normalizeSegmentIds(value.sourceSegmentIds ?? value.source_segment_ids),
  }
}

const normalizeUnclearPoint = (value: unknown): EducationUnclearPoint | null => {
  if (!isPlainObject(value)) {
    return null
  }
  const content = asTrimmedString(value.content)
  const reason = asTrimmedString(value.reason)
  if (!content) return null
  return {
    content,
    reason: reason || 'Chưa rõ',
    sourceSegmentIds: normalizeSegmentIds(value.sourceSegmentIds ?? value.source_segment_ids),
  }
}

export const normalizeEducationStudyAnalysis = (value: unknown): EducationStudy | null => {
  if (!isPlainObject(value)) {
    return null
  }
  const record = value
  const title = asTrimmedString(record.title)
  const overview = asTrimmedString(record.overview)
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
  const learningObjectives = normalizeStringArray(record.learningObjectives ?? record.learning_objectives)
  const keywords = normalizeStringArray(record.keywords)

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
