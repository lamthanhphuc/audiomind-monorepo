export type Meeting = {
  id: number
  title: string
  audioPath: string
  createdAt: string
}

export type AnalysisTechnicalTerm = {
  term: string
  meaning: string
  category: string
}

export type AnalysisPainPoint = {
  title: string
  evidence: string
  severity: 'low' | 'medium' | 'high'
}

export type AnalysisActionItem = {
  task: string
  owner?: string
  deadline?: string
}

export type AiAnalysis = {
  meetingId?: number
  meeting_id?: number
  summary: string
  keywords: string[]
  technicalTerms: AnalysisTechnicalTerm[]
  painPoints: AnalysisPainPoint[]
  actionItems: string[]
  domainMode: 'general' | 'it' | 'business' | 'education'
  createdAt?: string
  technical_terms?: Array<string | AnalysisTechnicalTerm>
  pain_points?: AnalysisPainPoint[]
  action_items?: Array<string | AnalysisActionItem>
  domain_mode?: string
  key_points?: string[]
  decisions?: string[]
  risks_blockers?: string[]
  topics?: string[]
  created_at?: string
}

const normalizeSeverity = (value: unknown): 'low' | 'medium' | 'high' => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized
  }
  return 'medium'
}

const normalizeTechnicalTerms = (value: unknown): AnalysisTechnicalTerm[] => {
  const items = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const normalized: AnalysisTechnicalTerm[] = []

  items.forEach((item) => {
    let term = ''
    let meaning = ''
    let category = ''

    if (typeof item === 'string') {
      term = item.trim()
    } else if (item && typeof item === 'object') {
      const record = item as Partial<AnalysisTechnicalTerm> & Record<string, unknown>
      term = String(record.term ?? record.name ?? record.label ?? '').trim()
      meaning = String(record.meaning ?? record.definition ?? '').trim()
      category = String(record.category ?? record.type ?? '').trim()
    }

    if (!term) {
      return
    }

    const key = term.toLowerCase()
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    normalized.push({ term, meaning, category })
  })

  return normalized
}

const normalizePainPoints = (value: unknown): AnalysisPainPoint[] => {
  const items = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const normalized: AnalysisPainPoint[] = []

  items.forEach((item) => {
    let title = ''
    let evidence = ''
    let severity: AnalysisPainPoint['severity'] = 'medium'

    if (typeof item === 'string') {
      title = item.trim()
    } else if (item && typeof item === 'object') {
      const record = item as Partial<AnalysisPainPoint> & Record<string, unknown>
      title = String(record.title ?? record.summary ?? '').trim()
      evidence = String(record.evidence ?? record.detail ?? '').trim()
      severity = normalizeSeverity(record.severity)
    }

    if (!title) {
      return
    }

    const key = title.toLowerCase()
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    normalized.push({ title, evidence, severity })
  })

  return normalized
}

const normalizeActionItems = (value: unknown): string[] => {
  const items = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const normalized: string[] = []

  items.forEach((item) => {
    let text = ''
    if (typeof item === 'string') {
      text = item.trim()
    } else if (item && typeof item === 'object') {
      const record = item as Partial<AnalysisActionItem> & Record<string, unknown>
      text = String(record.task ?? record.description ?? record.text ?? record.title ?? '').trim()
    }

    if (!text) {
      return
    }

    const key = text.toLowerCase()
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    normalized.push(text)
  })

  return normalized
}

const normalizeDomainMode = (value: unknown): AiAnalysis['domainMode'] => {
  const normalized = String(value ?? 'it').trim().toLowerCase()
  if (normalized === 'general' || normalized === 'it' || normalized === 'business' || normalized === 'education') {
    return normalized
  }
  return 'it'
}

const normalizeKeywords = (value: unknown, technicalTerms: AnalysisTechnicalTerm[]): string[] => {
  const items = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const technicalKeys = new Set(technicalTerms.map((item) => item.term.toLowerCase()))
  const normalized: string[] = []

  items.forEach((item) => {
    const text = String(item ?? '').trim()
    if (!text) {
      return
    }

    const key = text.toLowerCase()
    if (seen.has(key) || technicalKeys.has(key)) {
      return
    }
    seen.add(key)
    normalized.push(text)
  })

  return normalized
}

export const normalizeAnalysisResponse = (value: unknown): AiAnalysis => {
  const payload = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

  const nested = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : payload.structuredAnalysis && typeof payload.structuredAnalysis === 'object' && !Array.isArray(payload.structuredAnalysis)
      ? (payload.structuredAnalysis as Record<string, unknown>)
      : payload

  const resolvedMeetingId = typeof payload.meetingId === 'number'
    ? payload.meetingId
    : typeof payload.meeting_id === 'number'
      ? payload.meeting_id
      : typeof nested.meetingId === 'number'
        ? nested.meetingId
        : typeof nested.meeting_id === 'number'
          ? nested.meeting_id
          : undefined

  const technicalTerms = normalizeTechnicalTerms(
    nested.technicalTerms ?? nested.technical_terms ?? nested.terms,
  )
  const painPoints = normalizePainPoints(nested.painPoints ?? nested.pain_points)
  const keywords = normalizeKeywords(
    nested.keywords ?? nested.key_points ?? nested.topics,
    technicalTerms,
  )
  const actionItems = normalizeActionItems(nested.actionItems ?? nested.action_items)

  return {
    meetingId: resolvedMeetingId,
    meeting_id: resolvedMeetingId,
    summary: String(nested.summary ?? '').trim(),
    keywords,
    technicalTerms,
    painPoints,
    actionItems,
    domainMode: normalizeDomainMode(nested.domainMode ?? nested.domain_mode),
    createdAt: typeof nested.createdAt === 'string' ? nested.createdAt : typeof nested.created_at === 'string' ? nested.created_at : undefined,
    technical_terms: Array.isArray(nested.technical_terms) ? (nested.technical_terms as Array<string | AnalysisTechnicalTerm>) : undefined,
    pain_points: Array.isArray(nested.pain_points) ? (nested.pain_points as AnalysisPainPoint[]) : undefined,
    action_items: Array.isArray(nested.action_items) ? (nested.action_items as Array<string | AnalysisActionItem>) : undefined,
    domain_mode: typeof nested.domain_mode === 'string' ? nested.domain_mode : undefined,
    key_points: Array.isArray(nested.key_points) ? (nested.key_points as string[]) : undefined,
    decisions: Array.isArray(nested.decisions) ? (nested.decisions as string[]) : undefined,
    risks_blockers: Array.isArray(nested.risks_blockers) ? (nested.risks_blockers as string[]) : undefined,
    topics: Array.isArray(nested.topics) ? (nested.topics as string[]) : undefined,
    created_at: typeof nested.created_at === 'string' ? nested.created_at : undefined,
  }
}

export type TranscriptSegment = {
  speaker: string
  start_time: number
  end_time: number
  text: string
}

export type TranscriptResponse = {
  meeting_id: number
  transcripts: TranscriptSegment[]
}
