export type Meeting = {
  id: number
  title: string
  audioPath: string
  createdAt: string
  originalFileName?: string | null
  ownerUserId?: number | null
  language?: string | null
  status?: string | null
  fileSize?: number | null
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
  dueDate?: string
  deadline?: string
  priority?: 'low' | 'medium' | 'high'
  status?: 'open' | 'in_progress' | 'blocked' | 'done' | 'pending' | 'cancelled'
  evidence?: string
}

export type AiAnalysis = {
  meetingId?: number
  meeting_id?: number
  status?: string
  summary: string
  meetingSummary?: string
  keywords: string[]
  technicalTerms: AnalysisTechnicalTerm[]
  painPoints: AnalysisPainPoint[]
  actionItems: string[]
  businessActionItems?: AnalysisActionItem[]
  keyDecisions?: string[]
  risks?: string[]
  blockers?: string[]
  questions?: string[]
  deadlines?: string[]
  owners?: string[]
  nextSteps?: string[]
  businessImpact?: string
  customerImpact?: string
  technicalImpact?: string
  confidence?: number
  promptVersion?: string
  schemaVersion?: string
  transcriptHash?: string
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

const normalizeBusinessActionItems = (value: unknown): AnalysisActionItem[] => {
  const items = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const normalized: AnalysisActionItem[] = []

  items.forEach((item) => {
    let task = ''
    let owner: string | undefined
    let dueDate: string | undefined
    let deadline: string | undefined
    let priority: AnalysisActionItem['priority'] | undefined
    let status: AnalysisActionItem['status'] | undefined
    let evidence: string | undefined

    if (typeof item === 'string') {
      task = item.trim()
    } else if (item && typeof item === 'object') {
      const record = item as Partial<AnalysisActionItem> & Record<string, unknown>
      task = String(record.task ?? record.description ?? record.text ?? record.title ?? '').trim()
      owner = String(record.owner ?? '').trim() || undefined
      dueDate = String(record.dueDate ?? record['due_date'] ?? record.deadline ?? '').trim() || undefined
      deadline = dueDate
      const rawPriority = String(record.priority ?? '').trim().toLowerCase()
      if (rawPriority === 'low' || rawPriority === 'medium' || rawPriority === 'high') {
        priority = rawPriority
      }
      const rawStatus = String(record.status ?? '').trim().toLowerCase()
      if (
        rawStatus === 'open'
        || rawStatus === 'in_progress'
        || rawStatus === 'blocked'
        || rawStatus === 'done'
        || rawStatus === 'pending'
        || rawStatus === 'cancelled'
      ) {
        status = rawStatus
      }
      evidence = String(record.evidence ?? '').trim() || undefined
    }

    if (!task) {
      return
    }
    const key = task.toLowerCase()
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    normalized.push({ task, owner, dueDate, deadline, priority, status, evidence })
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

const normalizeConfidence = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value > 1 && value <= 100 ? value / 100 : value))
  }
  if (typeof value === 'string') {
    const parsed = Number(value.replace('%', '').trim())
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed > 1 && parsed <= 100 ? parsed / 100 : parsed))
    }
  }
  return undefined
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

  const resolvedStatus = typeof nested.status === 'string'
    ? nested.status
    : typeof payload.status === 'string'
      ? payload.status
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
  const businessActionItems = normalizeBusinessActionItems(
    nested.businessActionItems ?? nested.action_items ?? nested.actionItems,
  )
  const keyDecisions = Array.isArray(nested.keyDecisions)
    ? (nested.keyDecisions as string[])
    : Array.isArray(nested.decisions)
      ? (nested.decisions as string[])
      : []
  const risks = Array.isArray(nested.risks)
    ? (nested.risks as string[])
    : Array.isArray(nested.risks_blockers)
      ? (nested.risks_blockers as string[])
      : []
  const blockers = Array.isArray(nested.blockers) ? (nested.blockers as string[]) : []
  const questions = Array.isArray(nested.questions) ? (nested.questions as string[]) : []
  const deadlines = Array.isArray(nested.deadlines) ? (nested.deadlines as string[]) : []
  const owners = Array.isArray(nested.owners) ? (nested.owners as string[]) : []
  const nextSteps = Array.isArray(nested.nextSteps)
    ? (nested.nextSteps as string[])
    : Array.isArray(nested.next_steps)
      ? (nested.next_steps as string[])
      : []
  const meetingSummary = String(nested.meetingSummary ?? nested.summary ?? '').trim()
  const summary = String(nested.summary ?? nested.meetingSummary ?? '').trim()

  return {
    meetingId: resolvedMeetingId,
    meeting_id: resolvedMeetingId,
    status: resolvedStatus,
    summary,
    meetingSummary,
    keywords,
    technicalTerms,
    painPoints,
    actionItems,
    businessActionItems,
    keyDecisions,
    risks,
    blockers,
    questions,
    deadlines,
    owners,
    nextSteps,
    businessImpact: String(nested.businessImpact ?? '').trim() || undefined,
    customerImpact: String(nested.customerImpact ?? '').trim() || undefined,
    technicalImpact: String(nested.technicalImpact ?? '').trim() || undefined,
    confidence: normalizeConfidence(nested.confidence),
    promptVersion: String(nested.promptVersion ?? nested.prompt_version ?? '').trim() || undefined,
    schemaVersion: String(nested.schemaVersion ?? nested.schema_version ?? '').trim() || undefined,
    transcriptHash: String(nested.transcriptHash ?? nested.transcript_hash ?? '').trim() || undefined,
    domainMode: normalizeDomainMode(nested.domainMode ?? nested.domain_mode),
    createdAt: typeof nested.createdAt === 'string' ? nested.createdAt : typeof nested.created_at === 'string' ? nested.created_at : undefined,
    technical_terms: Array.isArray(nested.technical_terms) ? (nested.technical_terms as Array<string | AnalysisTechnicalTerm>) : undefined,
    pain_points: Array.isArray(nested.pain_points) ? (nested.pain_points as AnalysisPainPoint[]) : undefined,
    action_items: Array.isArray(nested.action_items) ? (nested.action_items as Array<string | AnalysisActionItem>) : undefined,
    domain_mode: typeof nested.domain_mode === 'string' ? nested.domain_mode : undefined,
    key_points: Array.isArray(nested.key_points) ? (nested.key_points as string[]) : undefined,
    decisions: keyDecisions,
    risks_blockers: Array.isArray(nested.risks_blockers)
      ? (nested.risks_blockers as string[])
      : risks.length > 0 || blockers.length > 0
        ? [...risks, ...blockers]
        : undefined,
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
