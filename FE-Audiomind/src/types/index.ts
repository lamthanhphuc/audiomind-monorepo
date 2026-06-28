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
  scheduledStartAt?: string | null
  scheduledEndAt?: string | null
  scheduledTimezone?: string | null
  sharedWithMe?: boolean | null
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

export type GroupedActionPlanConfidence = 'SUPPORTED' | 'INFERRED' | 'NEEDS_REVIEW'

export type GroupedActionPlanSubtask = {
  text: string
  confidence?: GroupedActionPlanConfidence
  evidenceKeywords?: string[]
}

export type GroupedActionPlanItem = {
  id: string
  title: string
  description?: string | null
  subtasks: GroupedActionPlanSubtask[]
  owner?: string | null
  deadline?: string | null
  priority?: 'low' | 'medium' | 'high' | string | null
  status?: 'open' | 'in_progress' | 'blocked' | 'done' | string | null
  confidence?: GroupedActionPlanConfidence
  evidenceKeywords?: string[]
  sourceActionItemIds?: string[]
}

export type GroupedActionPlanSection = {
  id: string
  order: number
  title: string
  summary?: string | null
  items: GroupedActionPlanItem[]
}

export type GroupedActionPlanNote = {
  text: string
  confidence?: GroupedActionPlanConfidence
  evidenceKeywords?: string[]
}

export type GroupedActionPlan = {
  version: string
  language: 'vi' | 'en' | 'mixed'
  intro: string
  sections: GroupedActionPlanSection[]
  notes: GroupedActionPlanNote[]
}

export type AiAnalysis = {
  meetingId?: number
  meeting_id?: number
  status?: string
  analysisStatus?: string
  cacheHit?: boolean
  stale?: boolean
  staleReason?: string
  provider?: string
  model?: string
  canonicalTranscriptHash?: string
  canonicalTranscriptVersion?: string
  analysisInputMode?: string
  lastAnalyzedAt?: string
  retryAfterSeconds?: number
  errorCode?: string
  errorMessage?: string
  retryable?: boolean
  retryExhausted?: boolean
  analysisRetryCount?: number
  analysisNextRetryAt?: string
  analysisTraceId?: string
  analysisProviderAlias?: string
  attemptCount?: number
  transcriptSaved?: boolean
  transcriptRows?: number
  finalized?: boolean
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
  analysisFeatureSet?: string
  groupedActionPlan?: GroupedActionPlan
  transcriptHash?: string
  evidence?: {
    matches?: Array<{
      verificationStatus?: string
      score?: number
      snippet?: string
      speaker?: string
      startTime?: number
      endTime?: number
      dedupeKey?: string
    }>
  }
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

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

const firstBoolean = (...values: unknown[]): boolean | undefined => {
  for (const value of values) {
    if (typeof value === 'boolean') {
      return value
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (normalized === 'true') {
        return true
      }
      if (normalized === 'false') {
        return false
      }
    }
  }
  return undefined
}

const firstNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string') {
      const parsed = Number(value.trim())
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }
  return undefined
}

const normalizeStringList = (value: unknown, limit = 8): string[] => {
  const items = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  const normalized: string[] = []

  items.forEach((item) => {
    const text = String(item ?? '').trim()
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

  return normalized.slice(0, limit)
}

const normalizeGroupedConfidence = (
  value: unknown,
  fallback: GroupedActionPlanConfidence = 'NEEDS_REVIEW',
): GroupedActionPlanConfidence => {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (normalized === 'SUPPORTED' || normalized === 'INFERRED' || normalized === 'NEEDS_REVIEW') {
    return normalized
  }
  return fallback
}

const normalizeGroupedLanguage = (value: unknown): GroupedActionPlan['language'] => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'en' || normalized === 'mixed') {
    return normalized
  }
  return 'vi'
}

const trimText = (value: unknown, maxLength: number): string => {
  const text = String(value ?? '').trim()
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text
}

const normalizeGroupedSubtasks = (value: unknown): GroupedActionPlanSubtask[] => {
  const items = Array.isArray(value) ? value : []
  return items.slice(0, 8).map((item): GroupedActionPlanSubtask => {
    if (typeof item === 'string') {
      return {
        text: trimText(item, 240),
        confidence: 'NEEDS_REVIEW',
        evidenceKeywords: [],
      }
    }
    const record = item && typeof item === 'object'
      ? (item as Record<string, unknown>)
      : {}
    return {
      text: trimText(record.text ?? record.title ?? record.task, 240),
      confidence: normalizeGroupedConfidence(record.confidence),
      evidenceKeywords: normalizeStringList(record.evidenceKeywords ?? record.evidence_keywords, 8),
    }
  }).filter((item) => item.text)
}

const normalizeGroupedItems = (value: unknown, sectionIndex: number): GroupedActionPlanItem[] => {
  const items = Array.isArray(value) ? value : []
  return items.slice(0, 8).map((item, itemIndex) => {
    const record = item && typeof item === 'object'
      ? (item as Record<string, unknown>)
      : {}
    const title = trimText(record.title ?? record.task ?? record.description ?? item, 120)
    const id = trimText(record.id, 80) || `section-${sectionIndex + 1}-item-${itemIndex + 1}`
    return {
      id,
      title,
      description: trimText(record.description, 500) || null,
      subtasks: normalizeGroupedSubtasks(record.subtasks),
      owner: trimText(record.owner, 120) || null,
      deadline: trimText(record.deadline ?? record.dueDate ?? record.due_date, 120) || null,
      priority: normalizeGroupedPriority(record.priority),
      status: normalizeGroupedStatus(record.status),
      confidence: normalizeGroupedConfidence(record.confidence),
      evidenceKeywords: normalizeStringList(record.evidenceKeywords ?? record.evidence_keywords, 8),
      sourceActionItemIds: normalizeStringList(record.sourceActionItemIds ?? record.source_action_item_ids, 8),
    }
  }).filter((item) => item.title)
}

const normalizeGroupedPriority = (value: unknown): 'low' | 'medium' | 'high' | null => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized
  }
  return null
}

const normalizeGroupedStatus = (value: unknown): 'open' | 'in_progress' | 'blocked' | 'done' => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (
    normalized === 'open'
    || normalized === 'in_progress'
    || normalized === 'blocked'
    || normalized === 'done'
  ) {
    return normalized
  }
  return 'open'
}

const normalizeGroupedNotes = (value: unknown): GroupedActionPlanNote[] => {
  const items = Array.isArray(value) ? value : []
  return items.slice(0, 8).map((item): GroupedActionPlanNote => {
    if (typeof item === 'string') {
      return { text: trimText(item, 240), confidence: 'NEEDS_REVIEW', evidenceKeywords: [] }
    }
    const record = item && typeof item === 'object'
      ? (item as Record<string, unknown>)
      : {}
    return {
      text: trimText(record.text ?? record.note ?? record.title, 240),
      confidence: normalizeGroupedConfidence(record.confidence),
      evidenceKeywords: normalizeStringList(record.evidenceKeywords ?? record.evidence_keywords, 8),
    }
  }).filter((item) => item.text)
}

const flatActionItemsToFallback = (value: unknown): GroupedActionPlan | undefined => {
  const items = normalizeBusinessActionItems(value)
  const normalizedItems = items.slice(0, 8).map((item, index): GroupedActionPlanItem => {
    const sourceRecord = item as AnalysisActionItem & Record<string, unknown>
    const evidenceKeywords = normalizeStringList(
      sourceRecord.evidenceKeywords ?? sourceRecord.evidence_keywords,
      8,
    )
    const fallbackEvidenceKeywords = item.evidence ? [item.evidence] : []
    const resolvedEvidenceKeywords = evidenceKeywords.length > 0 ? evidenceKeywords : fallbackEvidenceKeywords

    return {
      id: `fallback-item-${index + 1}`,
      title: item.task,
      description: null,
      subtasks: [],
      owner: item.owner ?? null,
      deadline: item.deadline ?? item.dueDate ?? null,
      priority: normalizeGroupedPriority(item.priority),
      status: normalizeGroupedStatus(item.status),
      confidence: resolvedEvidenceKeywords.length > 0 ? 'SUPPORTED' : 'NEEDS_REVIEW',
      evidenceKeywords: resolvedEvidenceKeywords,
      sourceActionItemIds: [`action-${index + 1}`],
    }
  })

  if (normalizedItems.length === 0) {
    return undefined
  }

  return {
    version: 'grouped-action-plan-v1',
    language: 'vi',
    intro: 'Dựa trên nội dung cuộc thảo luận trong file audio, dưới đây là danh sách các công việc cần thực hiện, được phân chia theo các nhóm chức năng chính:',
    sections: [
      {
        id: 'fallback-section-1',
        order: 1,
        title: 'Công việc chung',
        summary: null,
        items: normalizedItems,
      },
    ],
    notes: [],
  }
}

export const normalizeGroupedActionPlan = (
  value: unknown,
  fallbackActionItems?: unknown,
): GroupedActionPlan | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return flatActionItemsToFallback(fallbackActionItems)
  }

  const payload = value as Record<string, unknown>
  const sections = (Array.isArray(payload.sections) ? payload.sections : [])
    .slice(0, 8)
    .map((section, sectionIndex): GroupedActionPlanSection | null => {
      const record = section && typeof section === 'object'
        ? (section as Record<string, unknown>)
        : {}
      const items = normalizeGroupedItems(record.items, sectionIndex)
      const title = trimText(record.title, 80)
      if (!title || items.length === 0) {
        return null
      }
      return {
        id: trimText(record.id, 80) || `section-${sectionIndex + 1}`,
        order: firstNumber(record.order) ?? sectionIndex + 1,
        title,
        summary: trimText(record.summary, 240) || null,
        items,
      }
    })
    .filter((section): section is GroupedActionPlanSection => section !== null)
    .sort((left, right) => left.order - right.order)

  if (sections.length === 0) {
    return flatActionItemsToFallback(fallbackActionItems)
  }

  return {
    version: trimText(payload.version, 80) || 'grouped-action-plan-v1',
    language: normalizeGroupedLanguage(payload.language),
    intro: trimText(payload.intro, 360) || 'Dựa trên nội dung cuộc thảo luận trong file audio, dưới đây là danh sách các công việc cần thực hiện, được phân chia theo các nhóm chức năng chính:',
    sections,
    notes: normalizeGroupedNotes(payload.notes),
  }
}

const confidenceLabel = (confidence?: GroupedActionPlanConfidence): string => {
  if (confidence === 'INFERRED') {
    return 'Suy luận'
  }
  if (confidence === 'NEEDS_REVIEW') {
    return 'Cần xác minh'
  }
  return ''
}

export const formatGroupedActionPlanForCopy = (
  groupedActionPlan: GroupedActionPlan | undefined,
  fallbackActionItems?: unknown,
): string => {
  const plan = groupedActionPlan ?? normalizeGroupedActionPlan(undefined, fallbackActionItems)
  if (!plan || plan.sections.length === 0) {
    return 'Chưa có công việc đủ rõ để phân nhóm.'
  }

  const lines: string[] = [plan.intro, '']
  plan.sections.forEach((section, sectionIndex) => {
    lines.push(`### ${sectionIndex + 1}. ${section.title}`)
    section.items.forEach((item) => {
      const label = confidenceLabel(item.confidence)
      const suffix = label ? ` (${label})` : ''
      const description = item.description ? ` ${item.description}` : ''
      lines.push(`* **${item.title}:**${description}${suffix}`.trim())
      item.subtasks.forEach((subtask) => {
        const subtaskLabel = confidenceLabel(subtask.confidence)
        lines.push(`  * ${subtask.text}${subtaskLabel ? ` (${subtaskLabel})` : ''}`)
      })
    })
    lines.push('')
  })

  return lines.join('\n').trim()
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

  const resolvedStatus = firstString(nested.status, payload.status)

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
  const groupedActionPlan = normalizeGroupedActionPlan(
    nested.groupedActionPlan ?? nested.grouped_action_plan,
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
    analysisStatus: firstString(nested.analysisStatus, payload.analysisStatus),
    cacheHit: firstBoolean(nested.cacheHit, payload.cacheHit),
    stale: firstBoolean(nested.stale, payload.stale),
    staleReason: firstString(nested.staleReason, payload.staleReason),
    provider: firstString(nested.provider, payload.provider),
    model: firstString(nested.model, payload.model),
    canonicalTranscriptHash: firstString(
      nested.canonicalTranscriptHash,
      nested.canonical_transcript_hash,
      payload.canonicalTranscriptHash,
      payload.canonical_transcript_hash,
    ),
    canonicalTranscriptVersion: firstString(
      nested.canonicalTranscriptVersion,
      nested.canonical_transcript_version,
      payload.canonicalTranscriptVersion,
      payload.canonical_transcript_version,
    ),
    analysisInputMode: firstString(nested.analysisInputMode, nested.analysis_input_mode, payload.analysisInputMode, payload.analysis_input_mode),
    lastAnalyzedAt: firstString(nested.lastAnalyzedAt, nested.last_analyzed_at, payload.lastAnalyzedAt, payload.last_analyzed_at),
    retryAfterSeconds: firstNumber(nested.retryAfterSeconds, nested.retry_after_seconds, payload.retryAfterSeconds, payload.retry_after_seconds),
    errorCode: firstString(nested.errorCode, nested.error_code, payload.errorCode, payload.error_code),
    errorMessage: firstString(nested.errorMessage, nested.error_message, payload.errorMessage, payload.error_message),
    retryable: firstBoolean(nested.retryable, payload.retryable),
    retryExhausted: firstBoolean(nested.retryExhausted, nested.retry_exhausted, payload.retryExhausted, payload.retry_exhausted),
    analysisRetryCount: firstNumber(nested.analysisRetryCount, nested.analysis_retry_count, payload.analysisRetryCount, payload.analysis_retry_count),
    analysisNextRetryAt: firstString(nested.analysisNextRetryAt, nested.analysis_next_retry_at, payload.analysisNextRetryAt, payload.analysis_next_retry_at),
    analysisTraceId: firstString(nested.analysisTraceId, nested.analysis_trace_id, payload.analysisTraceId, payload.analysis_trace_id),
    analysisProviderAlias: firstString(nested.analysisProviderAlias, nested.analysis_provider_alias, payload.analysisProviderAlias, payload.analysis_provider_alias),
    attemptCount: firstNumber(nested.attemptCount, nested.attempt_count, payload.attemptCount, payload.attempt_count),
    transcriptSaved: firstBoolean(nested.transcriptSaved, nested.transcript_saved, payload.transcriptSaved, payload.transcript_saved),
    transcriptRows: firstNumber(nested.transcriptRows, nested.transcript_rows, payload.transcriptRows, payload.transcript_rows),
    finalized: firstBoolean(nested.finalized, payload.finalized),
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
    promptVersion: firstString(nested.promptVersion, nested.prompt_version, payload.promptVersion, payload.prompt_version),
    schemaVersion: firstString(nested.schemaVersion, nested.schema_version, payload.schemaVersion, payload.schema_version),
    analysisFeatureSet: firstString(nested.analysisFeatureSet, nested.analysis_feature_set, payload.analysisFeatureSet, payload.analysis_feature_set),
    groupedActionPlan,
    transcriptHash: firstString(nested.transcriptHash, nested.transcript_hash, payload.transcriptHash, payload.transcript_hash),
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

export type AnalysisDisplayState = 'pending' | 'running' | 'completed' | 'failed' | 'failed_retryable'

export const isRetryableAnalysisFailure = (value: AiAnalysis | null | undefined): boolean => {
  const status = String(value?.analysisStatus ?? value?.status ?? '').trim().toUpperCase()
  return status === 'ANALYSIS_FAILED_RETRYABLE' || value?.retryable === true
}

export const normalizeAnalysisDisplayStatus = (
  value: AiAnalysis | null | undefined,
): AnalysisDisplayState => {
  const status = String(value?.analysisStatus ?? value?.status ?? '').trim().toUpperCase()
  if (status === 'COMPLETED') {
    return 'completed'
  }
  if (status === 'ANALYSIS_FAILED_RETRYABLE' || isRetryableAnalysisFailure(value)) {
    return 'failed_retryable'
  }
  if (status === 'FAILED' || status === 'RATE_LIMITED' || status === 'QUOTA_BLOCKED') {
    return 'failed'
  }
  if (status === 'ANALYZING' || status === 'RUNNING' || status === 'QUEUED' || status === 'PENDING' || status === 'ANALYSIS_RUNNING') {
    return 'running'
  }
  return 'pending'
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

