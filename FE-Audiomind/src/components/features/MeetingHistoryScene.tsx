import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    ApiError,
    deleteMeeting,
    downloadMeetingActionPlan,
    downloadMeetingReport,
    downloadMeetingTranscript,
    getMeetingActionPlan,
    getSavedAnalysis,
    getTranscript,
    listMeetingsWithParams,
    renameMeeting,
    searchMeetingTranscriptEvidence,
    semanticSearchMeetings,
} from '../../services/api'
import type { MeetingActionPlanData, SemanticSearchResult, TranscriptEvidenceMatch } from '../../services/api'
import { formatActionPlanConfidence } from '../../utils/uiLabels'
import { type DomainMode } from '../../constants/domainMode'
import type { AiAnalysis, GroupedActionPlan, Meeting } from '../../types'
import { formatGroupedActionPlanForCopy, normalizeGroupedActionPlan } from '../../types'
import { formatShareLabel, inviteMeetingShare, isPendingMeetingShare, listMeetingShares, pendingShareInviteCopyText, pendingShareInviteNotice, revokeMeetingShare, revokePendingMeetingShare, shareListKey, type MeetingShare } from '../../services/meetingShare'
import { getUserProfile } from '../../services/api'
import { getGoogleStatus, GOOGLE_GMAIL_SEND_SCOPE, hasGoogleGmailSendScope, missingGoogleLinkScopes, startGoogleLink, type GoogleStatus } from '../../services/googleIntegration'
import { buildStudioPath } from '../../utils/studioRouting'
import { buildExistingUserMeetingUrl } from '../../utils/inviteAuth'
import { PUBLIC_FRONTEND_ORIGIN, ERROR_UX_ENABLED } from '../../services/config'
import { getJwtPlan } from '../../services/auth'
import { isUserQuotaExceeded, resolveQuotaPresentation, type UserPlan } from '../../utils/quotaUx'
import {
  closeOAuthTab,
  completeOAuthNavigation,
  prepareOAuthTab,
} from '../../utils/openOAuthWindow'
import { normalizePersistedTranscriptForView } from '../../utils/transcript'
import { TranscriptDisplay } from '../transcript/TranscriptDisplay'
import GlossaryNotesPanel from './GlossaryNotesPanel'
import SpeakerNamingPanel from './SpeakerNamingPanel'
import TermExplainPopover from './TermExplainPopover'
import MeetingTimeline from './MeetingTimeline'
import type { TimelineChapter } from '../../utils/timelineData'
import {
  highlightRangeFromTime,
  scrollTranscriptToHighlight,
  type TranscriptHighlightRange,
} from '../../utils/transcriptJump'
import MeetingTaskTracker from './MeetingTaskTracker'
import { listSpeakerProfiles, type SpeakerProfile } from '../../services/knowledgeLayer'
import AiAssistant from '../dashboard/AiAssistant'
import { answerMeetingQuestion, type MeetingChatCitation } from '../../utils/meetingChatbot'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
import { formatDateVi, formatLanguage, formatMeetingStatus } from '../../utils/uiLabels'

type DetailAnalysisState = 'idle' | 'processing' | 'completed' | 'failed' | 'failed_retryable' | 'missing'
type ListState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
type TranscriptSearchState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
type TranscriptExportFormat = 'txt' | 'csv'
type TranscriptExportMode = 'readable' | 'raw'

const ACTION_PLAN_REQUIRED_MESSAGE = 'Cần có phân tích cuộc họp trước khi xuất action plan.'
const HISTORY_LAST_SELECTED_KEY = 'audiomind.history.lastSelectedMeetingId'
const DETAIL_CACHE_TTL_MS = 5 * 60 * 1000
const SEARCH_DEBOUNCE_MS = 300
type TranscriptExportRequest = {
  mode: TranscriptExportMode
  format: TranscriptExportFormat
}

type ActionPlanState = {
  preview: MeetingActionPlanData | null
  loading: boolean
  exporting: boolean
  error: string | null
  success: string | null
}

type SelectedMeetingDetail = {
  meeting: Meeting | null
  transcriptSegments: ReturnType<typeof normalizePersistedTranscriptForView>
  transcriptState: 'loading' | 'ready' | 'empty' | 'error'
  transcriptError: string | null
  analysis: AiAnalysis | null
  analysisMetadata: AiAnalysis | null
  analysisState: DetailAnalysisState
  analysisError: string | null
}

const emptyDetailState: SelectedMeetingDetail = {
  meeting: null,
  transcriptSegments: [],
  transcriptState: 'loading',
  transcriptError: null,
  analysis: null,
  analysisMetadata: null,
  analysisState: 'idle',
  analysisError: null,
}

type MeetingDetailCacheEntry = {
  meetingId: number
  meeting: Meeting
  transcriptSegments: SelectedMeetingDetail['transcriptSegments']
  transcriptState: SelectedMeetingDetail['transcriptState']
  transcriptError: string | null
  analysis: AiAnalysis | null
  analysisMetadata: AiAnalysis | null
  analysisState: DetailAnalysisState
  analysisError: string | null
  fetchedAt: number
}

type MeetingHistorySceneProps = {
  focusMeetingId?: number | null
  onOpenAnalysis?: (meetingId: number, context?: { title?: string }) => void
  onOpenMindmap?: (meetingId: number, context?: { title?: string }) => void
  searchQuery?: string
  onSearchQueryChange?: (value: string) => void
  onNavigateUpload?: () => void
  onNavigateRealtime?: () => void
  onNavigateBilling?: () => void
  preferredDomainMode?: DomainMode
  oauthRefreshTick?: number
}

const meetingSummaryChanged = (previous: Meeting, next: Meeting): boolean => {
  return previous.title !== next.title
    || previous.status !== next.status
    || previous.language !== next.language
    || previous.createdAt !== next.createdAt
    || previous.originalFileName !== next.originalFileName
}

const isAbortError = (error: unknown): boolean => {
  return error instanceof DOMException && error.name === 'AbortError'
}

const readStoredMeetingId = (): number | null => {
  try {
    const raw = sessionStorage.getItem(HISTORY_LAST_SELECTED_KEY)
    if (!raw) {
      return null
    }
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

const writeStoredMeetingId = (meetingId: number) => {
  try {
    sessionStorage.setItem(HISTORY_LAST_SELECTED_KEY, String(meetingId))
  } catch {
    // Ignore storage failures in private mode or restricted contexts.
  }
}

const clearStoredMeetingId = () => {
  try {
    sessionStorage.removeItem(HISTORY_LAST_SELECTED_KEY)
  } catch {
    // Ignore storage failures in private mode or restricted contexts.
  }
}

const resolveRestoredMeetingId = (
  items: Meeting[],
  current: number | null,
  focusMeetingId: number | null | undefined,
): number | null => {
  if (current !== null && items.some((meeting) => meeting.id === current)) {
    return current
  }

  const storedMeetingId = readStoredMeetingId()
  if (storedMeetingId !== null && items.some((meeting) => meeting.id === storedMeetingId)) {
    return storedMeetingId
  }

  if (focusMeetingId != null && items.some((meeting) => meeting.id === focusMeetingId)) {
    return focusMeetingId
  }

  return null
}

const getMeetingLabel = (meeting: Meeting): string => {
  return meeting.title?.trim() || meeting.originalFileName?.trim() || `Meeting #${meeting.id}`
}

const getMeetingLanguage = (meeting: Meeting): string => {
  return String(meeting.language ?? 'vi').trim().toLowerCase() || 'vi'
}

const getMeetingStatus = (meeting: Meeting): string => {
  const normalized = String(meeting.status ?? '').trim().toLowerCase()
  if (normalized === 'completed' || normalized === 'processing' || normalized === 'failed' || normalized === 'scheduled') {
    return formatMeetingStatus(normalized)
  }
  return 'Không rõ'
}

const formatEvidenceTime = (startTime: number, endTime: number): string => {
  const format = (value: number) => {
    if (!Number.isFinite(value)) {
      return '0:00'
    }
    const totalSeconds = Math.max(0, Math.floor(value))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }
  return `${format(startTime)}-${format(endTime)}`
}

const getActionPlanErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.status === 409) {
    return ACTION_PLAN_REQUIRED_MESSAGE
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Không thể xuất action plan'
}

const saveBlobToFile = (blob: Blob, filename: string) => {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}

const copyTextToClipboard = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

const getGroupedActionPlanItemCount = (plan: GroupedActionPlan | null | undefined, fallbackItems: MeetingActionPlanData['actionItems']): number => {
  return plan?.sections.reduce((total, section) => total + section.items.length, 0) ?? fallbackItems.length
}

type ActionPlanPreviewProps = {
  preview: MeetingActionPlanData
  onCopy: () => void
}

const ActionPlanPreview = ({ preview, onCopy }: ActionPlanPreviewProps) => {
  const groupedPlan = preview.groupedActionPlan ?? normalizeGroupedActionPlan(undefined, preview.actionItems) ?? null
  const itemCount = getGroupedActionPlanItemCount(groupedPlan, preview.actionItems)
  const featureSet = preview.analysisMetadata.analysisFeatureSet ?? groupedPlan?.version

  return (
    <div className="action-plan-preview" data-testid="meeting-action-plan-preview">
      <div className="action-plan-preview__header">
        <div>
          <strong>Công việc cần làm theo nhóm chức năng</strong>
          {featureSet && <p>{featureSet}</p>}
        </div>
        <div className="action-plan-preview__actions">
          <span className="meta-pill">{itemCount} việc</span>
          <button type="button" onClick={onCopy} data-testid="meeting-action-plan-copy">
            Sao chép
          </button>
        </div>
      </div>

      {preview.summary && <p className="action-plan-preview__summary">{preview.summary}</p>}
      {preview.note && <p className="action-plan-preview__note">{preview.note}</p>}

      {groupedPlan ? (
        <div className="action-plan-preview__grouped" data-testid="meeting-action-plan-grouped">
          {groupedPlan.intro && <p className="action-plan-preview__intro">{groupedPlan.intro}</p>}
          {groupedPlan.sections.map((section, sectionIndex) => (
            <section className="action-plan-preview__section" key={section.id}>
              <div className="action-plan-preview__section-heading">
                <h4>{sectionIndex + 1}. {section.title}</h4>
                <span>{section.items.length} việc</span>
              </div>
              {section.summary && <p className="action-plan-preview__section-summary">{section.summary}</p>}
              <ul className="action-plan-preview__items">
                {section.items.map((item) => (
                  <li className="action-plan-preview__item" key={item.id}>
                    <div className="action-plan-preview__item-title">
                      <strong>{item.title}</strong>
                      <span>{formatActionPlanConfidence(item.confidence)}</span>
                    </div>
                    {item.description && <p>{item.description}</p>}
                    {(item.owner || item.deadline || item.priority || item.status) && (
                      <div className="action-plan-preview__meta">
                        {item.owner && <span>Người phụ trách: {item.owner}</span>}
                        {item.deadline && <span>Hạn: {item.deadline}</span>}
                        {item.priority && <span>Ưu tiên: {item.priority}</span>}
                        {item.status && <span>Trạng thái: {item.status}</span>}
                      </div>
                    )}
                    {item.subtasks.length > 0 && (
                      <ul className="action-plan-preview__subtasks">
                        {item.subtasks.map((subtask) => (
                          <li key={subtask.text}>{subtask.text}</li>
                        ))}
                      </ul>
                    )}
                    {item.evidenceKeywords && item.evidenceKeywords.length > 0 && (
                      <div className="action-plan-preview__keywords" aria-label="Gợi ý từ khóa">
                        {item.evidenceKeywords.map((keyword) => (
                          <span key={keyword}>{keyword}</span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {groupedPlan.notes.length > 0 && (
            <div className="action-plan-preview__notes">
              {groupedPlan.notes.map((note) => (
                <p key={note.text}>{note.text}</p>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="action-plan-preview__empty">Chưa có công việc đủ rõ để phân nhóm.</p>
      )}
    </div>
  )
}

const getAnalysisStateFromResponse = (analysis: AiAnalysis | null): { state: DetailAnalysisState; analysis: AiAnalysis | null; error: string | null } => {
  if (!analysis) {
    return { state: 'missing', analysis: null, error: null }
  }

  const status = String(analysis.analysisStatus ?? analysis.status ?? '').trim().toUpperCase()
  if (status === 'ANALYSIS_FAILED_RETRYABLE' || analysis.retryable === true) {
    return { state: 'failed_retryable', analysis, error: null }
  }
  if (status === 'QUOTA_BLOCKED' || analysis.errorCode === 'QUOTA_EXCEEDED') {
    const plan = (getJwtPlan() || 'FREE') as UserPlan
    const presentation = resolveQuotaPresentation(
      {
        errorCode: analysis.errorCode,
        analysisStatus: status,
        fallbackMessage: analysis.errorMessage ?? undefined,
      },
      plan,
      ERROR_UX_ENABLED,
    )
    return { state: 'failed', analysis: null, error: presentation.message }
  }
  if (status === 'FAILED' || status === 'RATE_LIMITED') {
    const retryAfter = analysis.retryAfterSeconds && analysis.retryAfterSeconds > 0
      ? ` Retry after ${analysis.retryAfterSeconds}s.`
      : ''
    const detail = analysis.errorCode ? ` ${analysis.errorCode}.` : ''
    return { state: 'failed', analysis: null, error: `Phân tích AI tạm thời thất bại. Có thể thử lại.${detail}${retryAfter}` }
  }
  if (status === 'ANALYZING' || status === 'RUNNING' || status === 'QUEUED' || status === 'PENDING') {
    return { state: 'processing', analysis: null, error: null }
  }

  const hasStructuredData = Boolean(
    analysis.summary?.trim()
    || (analysis.keywords?.length ?? 0) > 0
    || (analysis.technicalTerms?.length ?? 0) > 0
    || (analysis.painPoints?.length ?? 0) > 0
    || (analysis.actionItems?.length ?? 0) > 0,
  )

  if (!hasStructuredData && status === 'NOT_FOUND') {
    return { state: 'missing', analysis: null, error: null }
  }

  if (!hasStructuredData && !status) {
    return { state: 'missing', analysis: null, error: null }
  }

  return { state: 'completed', analysis, error: null }
}

export default function MeetingHistoryScene({
  focusMeetingId = null,
  onOpenAnalysis,
  onOpenMindmap,
  searchQuery: controlledSearchQuery,
  onSearchQueryChange,
  onNavigateUpload,
  onNavigateRealtime,
  onNavigateBilling,
  preferredDomainMode: _preferredDomainMode,
  oauthRefreshTick = 0,
}: MeetingHistorySceneProps) {
  const isSearchControlled = onSearchQueryChange != null
  const [internalSearchQuery, setInternalSearchQuery] = useState('')
  const searchQuery = isSearchControlled ? (controlledSearchQuery ?? '') : internalSearchQuery
  const setSearchQuery = isSearchControlled ? onSearchQueryChange : setInternalSearchQuery
  const [listState, setListState] = useState<ListState>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [selectedMeetingId, setSelectedMeetingId] = useState<number | null>(null)
  const [detail, setDetail] = useState<SelectedMeetingDetail>(emptyDetailState)
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [languageFilter, setLanguageFilter] = useState('')
  const [sortValue, setSortValue] = useState('created_desc')
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [transcriptExportBusy, setTranscriptExportBusy] = useState<TranscriptExportRequest | null>(null)
  const [transcriptExportError, setTranscriptExportError] = useState<string | null>(null)
  const [transcriptExportMenuOpen, setTranscriptExportMenuOpen] = useState(false)
  const [transcriptEvidenceQuery, setTranscriptEvidenceQuery] = useState('')
  const [transcriptEvidenceState, setTranscriptEvidenceState] = useState<TranscriptSearchState>('idle')
  const [transcriptEvidenceResults, setTranscriptEvidenceResults] = useState<TranscriptEvidenceMatch[]>([])
  const [transcriptEvidenceError, setTranscriptEvidenceError] = useState<string | null>(null)
  const [actionPlanState, setActionPlanState] = useState<ActionPlanState>({
    preview: null,
    loading: false,
    exporting: false,
    error: null,
    success: null,
  })
  const [shareNotice, setShareNotice] = useState<string | null>(null)
  const [shareInviteEmail, setShareInviteEmail] = useState('')
  const [shareInviteBusy, setShareInviteBusy] = useState(false)
  const [shareInviteError, setShareInviteError] = useState<string | null>(null)
  const [meetingShares, setMeetingShares] = useState<MeetingShare[]>([])
  const [shareGoogleStatus, setShareGoogleStatus] = useState<GoogleStatus | null>(null)
  const [shareUserEmail, setShareUserEmail] = useState<string | null>(null)
  const [gmailLinkBusy, setGmailLinkBusy] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [activeTerm, setActiveTerm] = useState<string | null>(null)
  const [speakerDisplayMap, setSpeakerDisplayMap] = useState<Record<string, string>>({})
  const [highlightRange, setHighlightRange] = useState<TranscriptHighlightRange | null>(null)

  const handleTimelineJump = useCallback((chapter: TimelineChapter) => {
    const range = { startTime: chapter.startTime, endTime: chapter.endTime }
    setHighlightRange(range)
    scrollTranscriptToHighlight(range)
  }, [])

  const handleCitationClick = useCallback((citation: MeetingChatCitation) => {
    const range = highlightRangeFromTime(citation.startTime, citation.endTime)
    setHighlightRange(range)
    scrollTranscriptToHighlight(range)
  }, [])
  const [semanticResults, setSemanticResults] = useState<SemanticSearchResult[]>([])
  const [semanticState, setSemanticState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const detailAbortRef = useRef<AbortController | null>(null)
  const detailRequestKeyRef = useRef<number | null>(null)
  const listAbortRef = useRef<AbortController | null>(null)
  const detailCacheRef = useRef<Map<number, MeetingDetailCacheEntry>>(new Map())
  const selectedMeetingIdRef = useRef<number | null>(null)
  const focusMeetingIdRef = useRef<number | null>(focusMeetingId)

  const selectedMeetingSummary = useMemo(() => {
    return meetings.find((meeting) => meeting.id === selectedMeetingId) ?? null
  }, [meetings, selectedMeetingId])

  useEffect(() => {
    selectedMeetingIdRef.current = selectedMeetingId
  }, [selectedMeetingId])

  const applySpeakerProfiles = useCallback((profiles: SpeakerProfile[]) => {
    const nextMap: Record<string, string> = {}
    for (const profile of profiles) {
      if (profile.speakerKey && profile.displayName) {
        nextMap[profile.speakerKey] = profile.displayName
      }
    }
    setSpeakerDisplayMap(nextMap)
  }, [])

  useEffect(() => {
    if (selectedMeetingId == null) {
      setSpeakerDisplayMap({})
      return
    }
    void listSpeakerProfiles(selectedMeetingId)
      .then(applySpeakerProfiles)
      .catch(() => setSpeakerDisplayMap({}))
  }, [selectedMeetingId, applySpeakerProfiles])

  useEffect(() => {
    focusMeetingIdRef.current = focusMeetingId
  }, [focusMeetingId])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeoutId)
  }, [searchQuery])

  const pruneDetailCacheForList = (items: Meeting[]) => {
    const nextIds = new Set(items.map((meeting) => meeting.id))
    for (const meetingId of [...detailCacheRef.current.keys()]) {
      if (!nextIds.has(meetingId)) {
        detailCacheRef.current.delete(meetingId)
      }
    }
    for (const item of items) {
      const cached = detailCacheRef.current.get(item.id)
      if (cached && meetingSummaryChanged(cached.meeting, item)) {
        detailCacheRef.current.delete(item.id)
      }
    }
  }

  const writeDetailCache = (entry: Omit<MeetingDetailCacheEntry, 'fetchedAt'> & { fetchedAt?: number }) => {
    detailCacheRef.current.set(entry.meetingId, {
      ...entry,
      fetchedAt: entry.fetchedAt ?? Date.now(),
    })
  }

  const readDetailCache = (meetingId: number): MeetingDetailCacheEntry | null => {
    const cached = detailCacheRef.current.get(meetingId)
    if (!cached) {
      return null
    }
    if (Date.now() - cached.fetchedAt > DETAIL_CACHE_TTL_MS) {
      detailCacheRef.current.delete(meetingId)
      return null
    }
    return cached
  }

  const invalidateDetailCache = (meetingId: number) => {
    detailCacheRef.current.delete(meetingId)
  }

  useEffect(() => {
    setRenameValue(selectedMeetingSummary?.title ?? '')
  }, [selectedMeetingSummary?.id, selectedMeetingSummary?.title])

  useEffect(() => {
    setTranscriptEvidenceQuery('')
    setTranscriptEvidenceState('idle')
    setTranscriptEvidenceResults([])
    setTranscriptEvidenceError(null)
    setActionPlanState({
      preview: null,
      loading: false,
      exporting: false,
      error: null,
      success: null,
    })
  }, [selectedMeetingId])

  useEffect(() => {
    listAbortRef.current?.abort()
    const controller = new AbortController()
    listAbortRef.current = controller

    const loadHistory = async () => {
      setListState('loading')
      setListError(null)

      try {
        const items = await listMeetingsWithParams({
          query: debouncedSearchQuery,
          status: statusFilter || undefined,
          language: languageFilter || undefined,
          sort: sortValue,
        }, { signal: controller.signal })
        if (controller.signal.aborted) {
          return
        }

        pruneDetailCacheForList(items)
        setMeetings(items)
        setListState(items.length > 0 ? 'ready' : 'empty')
        setSelectedMeetingId((current) => resolveRestoredMeetingId(
          items,
          current,
          focusMeetingIdRef.current,
        ))
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          return
        }

        setMeetings([])
        setListState('error')
        setListError(error instanceof Error ? error.message : 'Không thể tải lịch sử meeting')
      }
    }

    void loadHistory()

    return () => {
      controller.abort()
    }
  }, [debouncedSearchQuery, languageFilter, reloadTick, sortValue, statusFilter])

  useEffect(() => {
    if (debouncedSearchQuery.trim().length < 3) {
      setSemanticResults([])
      setSemanticState('idle')
      return
    }
    let cancelled = false
    const loadSemantic = async () => {
      setSemanticState('loading')
      try {
        const response = await semanticSearchMeetings(debouncedSearchQuery, 8)
        if (!cancelled) {
          setSemanticResults(response.results)
          setSemanticState('ready')
        }
      } catch {
        if (!cancelled) {
          setSemanticResults([])
          setSemanticState('error')
        }
      }
    }
    void loadSemantic()
    return () => {
      cancelled = true
    }
  }, [debouncedSearchQuery])

  useEffect(() => {
    if (selectedMeetingId === null) {
      detailAbortRef.current?.abort()
      detailRequestKeyRef.current = null
      setDetail(emptyDetailState)
      return
    }

    const meetingSummary = meetings.find((meeting) => meeting.id === selectedMeetingId) ?? null
    if (!meetingSummary) {
      return
    }

    const cachedDetail = readDetailCache(selectedMeetingId)
    if (cachedDetail && !meetingSummaryChanged(cachedDetail.meeting, meetingSummary)) {
      setDetail({
        meeting: meetingSummary,
        transcriptSegments: cachedDetail.transcriptSegments,
        transcriptState: cachedDetail.transcriptState,
        transcriptError: cachedDetail.transcriptError,
        analysis: cachedDetail.analysis,
        analysisMetadata: cachedDetail.analysisMetadata,
        analysisState: cachedDetail.analysisState,
        analysisError: cachedDetail.analysisError,
      })
      return
    }

    detailAbortRef.current?.abort()
    const controller = new AbortController()
    detailAbortRef.current = controller
    const requestKey = selectedMeetingId
    detailRequestKeyRef.current = requestKey

    const loadDetail = async () => {
      setDetail({
        meeting: meetingSummary,
        transcriptSegments: [],
        transcriptState: 'loading',
        transcriptError: null,
        analysis: null,
        analysisMetadata: null,
        analysisState: 'idle',
        analysisError: null,
      })

      try {
        const [transcriptResponse, analysisResponse] = await Promise.all([
          getTranscript(requestKey, { signal: controller.signal }),
          getSavedAnalysis(requestKey, { signal: controller.signal }),
        ])

        if (controller.signal.aborted || detailRequestKeyRef.current !== requestKey) {
          return
        }

        const transcriptSegments = normalizePersistedTranscriptForView(
          transcriptResponse.transcripts || [],
        )
        const transcriptState: SelectedMeetingDetail['transcriptState'] = transcriptSegments.length > 0 ? 'ready' : 'empty'
        const analysisState = getAnalysisStateFromResponse(analysisResponse)
        const nextDetail: SelectedMeetingDetail = {
          meeting: meetingSummary,
          transcriptSegments,
          transcriptState,
          transcriptError: null,
          analysis: analysisState.analysis,
          analysisMetadata: analysisResponse,
          analysisState: analysisState.state,
          analysisError: analysisState.error,
        }

        setDetail(nextDetail)
        writeDetailCache({
          meetingId: requestKey,
          meeting: meetingSummary,
          transcriptSegments: nextDetail.transcriptSegments,
          transcriptState: nextDetail.transcriptState,
          transcriptError: nextDetail.transcriptError,
          analysis: nextDetail.analysis,
          analysisMetadata: nextDetail.analysisMetadata,
          analysisState: nextDetail.analysisState,
          analysisError: nextDetail.analysisError,
        })
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error) || detailRequestKeyRef.current !== requestKey) {
          return
        }

        setDetail({
          meeting: meetingSummary,
          transcriptSegments: [],
          transcriptState: 'error',
          transcriptError: error instanceof Error ? error.message : 'Không thể tải chi tiết meeting',
          analysis: null,
          analysisMetadata: null,
          analysisState: 'failed',
          analysisError: null,
        })
      }
    }

    void loadDetail()

    return () => {
      controller.abort()
    }
  }, [meetings, selectedMeetingId])

  const handleRename = async () => {
    if (!selectedMeetingSummary) {
      return
    }
    const nextTitle = renameValue.trim()
    if (!nextTitle) {
      setListError('Tên meeting không được để trống')
      return
    }
    if (nextTitle === selectedMeetingSummary.title) {
      return
    }

    setRenameBusy(true)
    setListError(null)
    try {
      const renamed = await renameMeeting(selectedMeetingSummary.id, nextTitle)
      setMeetings((current) => current.map((meeting) => (meeting.id === renamed.id ? { ...meeting, ...renamed } : meeting)))
      setDetail((current) => current.meeting && current.meeting.id === renamed.id
        ? { ...current, meeting: { ...current.meeting, ...renamed } }
        : current)
      invalidateDetailCache(renamed.id)
      setRenameValue(renamed.title)
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'Không thể đổi tên meeting')
    } finally {
      setRenameBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!selectedMeetingSummary) {
      return
    }
    setDeleteBusy(true)
    setListError(null)
    try {
      await deleteMeeting(selectedMeetingSummary.id)
      invalidateDetailCache(selectedMeetingSummary.id)
      clearStoredMeetingId()
      setMeetings((current) => {
        const next = current.filter((meeting) => meeting.id !== selectedMeetingSummary.id)
        setSelectedMeetingId((selectedId) => (selectedId === selectedMeetingSummary.id ? null : selectedId))
        setListState(next.length > 0 ? 'ready' : 'empty')
        return next
      })
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'Không thể xoá meeting')
    } finally {
      setDeleteBusy(false)
    }
  }

  const handleShareMeetingLink = async () => {
    if (!selectedMeetingSummary) {
      return
    }
    const origin = PUBLIC_FRONTEND_ORIGIN.trim() || window.location.origin
    const shareUrl = buildExistingUserMeetingUrl(origin, selectedMeetingSummary.id)
    try {
      await navigator.clipboard.writeText(shareUrl)
      setShareNotice('Đã copy link chia sẻ workspace (mở meeting khi đăng nhập).')
    } catch {
      setShareNotice(shareUrl)
    }
    window.setTimeout(() => setShareNotice(null), 4000)
  }

  useEffect(() => {
    if (!selectedMeetingId) {
      setMeetingShares([])
      return
    }
    void listMeetingShares(selectedMeetingId)
      .then((items) => setMeetingShares(items))
      .catch(() => setMeetingShares([]))
  }, [selectedMeetingId])

  useEffect(() => {
    if (!selectedMeetingId) {
      setShareGoogleStatus(null)
      setShareUserEmail(null)
      return
    }
    void getGoogleStatus()
      .then((status) => setShareGoogleStatus(status))
      .catch(() => setShareGoogleStatus(null))
    void getUserProfile()
      .then((profile) => setShareUserEmail(profile.email || null))
      .catch(() => setShareUserEmail(null))
  }, [selectedMeetingId])

  useEffect(() => {
    if (!oauthRefreshTick || !selectedMeetingId) {
      return
    }
    void getGoogleStatus()
      .then((status) => setShareGoogleStatus(status))
      .catch(() => setShareGoogleStatus(null))
    setGmailLinkBusy(false)
    setShareNotice('Đã cập nhật quyền Gmail — bạn có thể gửi lời mời qua email.')
  }, [oauthRefreshTick, selectedMeetingId])

  const handleCopyPendingInvite = async (share: MeetingShare) => {
    try {
      await copyTextToClipboard(
        pendingShareInviteCopyText(share, selectedMeetingSummary?.title, window.location.origin),
      )
      setShareNotice('Đã sao chép lời mời — gửi qua Zalo/Telegram nếu người nhận không thấy email.')
    } catch {
      setShareNotice('Không sao chép được — hãy copy thủ công.')
    }
  }

  const handleInviteShare = async () => {
    if (!selectedMeetingSummary) return
    const normalizedInviteEmail = shareInviteEmail.trim().toLowerCase()
    const wasPendingResend = meetingShares.some(
      (share) => isPendingMeetingShare(share)
        && share.email?.trim().toLowerCase() === normalizedInviteEmail,
    )
    setShareInviteBusy(true)
    setShareInviteError(null)
    try {
      const created = await inviteMeetingShare(selectedMeetingSummary.id, shareInviteEmail)
      const notice = isPendingMeetingShare(created)
        ? pendingShareInviteNotice(created, {
            resent: wasPendingResend,
            senderGoogleEmail: shareGoogleStatus?.googleEmail ?? null,
          })
        : 'Đã gửi lời mời — người nhận sẽ thấy thông báo trong app và email (nếu đã cấu hình).'
      setShareInviteEmail('')
      setShareNotice(notice)
      setMeetingShares((current) => [
        ...current.filter((item) => shareListKey(item) !== shareListKey(created)),
        created,
      ])
      window.setTimeout(() => setShareInviteBusy(false), 2000)
      return
    } catch (error) {
      setShareInviteError(error instanceof Error ? error.message : 'Không mời được người dùng')
      setShareInviteBusy(false)
    }
  }

  const handleGrantGmailSendScope = () => {
    setGmailLinkBusy(true)
    const oauthTab = prepareOAuthTab()
    void (async () => {
      try {
        const fresh = await getGoogleStatus().catch(() => null)
        if (fresh && hasGoogleGmailSendScope(fresh)) {
          closeOAuthTab(oauthTab)
          setShareGoogleStatus(fresh)
          setShareNotice('Đã có quyền gửi email qua Gmail.')
          setGmailLinkBusy(false)
          return
        }
        const redirectAfter = buildStudioPath('files')
        const scopesToRequest = fresh ? missingGoogleLinkScopes(fresh) : [GOOGLE_GMAIL_SEND_SCOPE]
        const authorizationUrl = await startGoogleLink(
          scopesToRequest.length > 0 ? scopesToRequest : [GOOGLE_GMAIL_SEND_SCOPE],
          redirectAfter,
        )
        if (completeOAuthNavigation(oauthTab, authorizationUrl) === 'new_tab') {
          setShareNotice('Tab Google đã mở — hoàn tất cấp quyền ở tab đó, sau đó quay lại tab này.')
        } else {
          setShareNotice('Trình duyệt chặn tab mới — đang chuyển hướng trong tab hiện tại.')
        }
      } catch (error) {
        closeOAuthTab(oauthTab)
        setShareInviteError(error instanceof Error ? error.message : 'Không mở được liên kết Google')
        setGmailLinkBusy(false)
      }
    })()
  }

  const shareGmailEmailMismatch = useMemo(() => {
    if (!shareGoogleStatus?.googleEmail || !shareUserEmail) return false
    return shareGoogleStatus.googleEmail.trim().toLowerCase() !== shareUserEmail.trim().toLowerCase()
  }, [shareGoogleStatus, shareUserEmail])

  const shareMissingGmailScope = useMemo(() => {
    if (!shareGoogleStatus) return false
    return !hasGoogleGmailSendScope(shareGoogleStatus)
  }, [shareGoogleStatus])

  const handleRevokeShare = async (share: MeetingShare) => {
    if (!selectedMeetingSummary) return
    try {
      if (isPendingMeetingShare(share)) {
        if (!share.email) {
          throw new Error('Không xác định được email lời mời')
        }
        await revokePendingMeetingShare(selectedMeetingSummary.id, share.email)
      } else if (share.sharedWithUserId != null) {
        await revokeMeetingShare(selectedMeetingSummary.id, share.sharedWithUserId)
      } else {
        throw new Error('Không xác định được người được chia sẻ')
      }
      setShareNotice('Đã thu hồi quyền truy cập.')
      setMeetingShares((current) => current.filter((item) => shareListKey(item) !== shareListKey(share)))
    } catch (error) {
      setShareInviteError(error instanceof Error ? error.message : 'Không thu hồi được quyền')
    }
  }

  const handleExport = async () => {
    if (!selectedMeetingSummary || detail.transcriptState !== 'ready') {
      return
    }

    const analysisState = getAnalysisStateFromResponse(detail.analysis)
    const analysisStatus = String(detail.analysis?.analysisStatus ?? detail.analysis?.status ?? '').toUpperCase()
    const retryPending = analysisStatus === 'ANALYZING'
      || analysisStatus === 'ANALYSIS_FAILED_RETRYABLE'
      || analysisState.state === 'processing'
      || analysisState.state === 'failed_retryable'
    if (retryPending && detail.analysis?.retryExhausted !== true) {
      setExportError('Phân tích chưa hoàn tất. Vui lòng đợi hệ thống thử lại hoặc chạy phân tích lại trước khi xuất report.')
      return
    }

    setExportBusy(true)
    setExportError(null)
    try {
      const { blob, filename } = await downloadMeetingReport(selectedMeetingSummary.id, 'docx')
      saveBlobToFile(blob, filename)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Không thể xuất report')
    } finally {
      setExportBusy(false)
    }
  }

  const handleExportPdf = async () => {
    if (!selectedMeetingSummary || detail.transcriptState !== 'ready') {
      return
    }

    const analysisState = getAnalysisStateFromResponse(detail.analysis)
    const analysisStatus = String(detail.analysis?.analysisStatus ?? detail.analysis?.status ?? '').toUpperCase()
    const retryPending = analysisStatus === 'ANALYZING'
      || analysisStatus === 'ANALYSIS_FAILED_RETRYABLE'
      || analysisState.state === 'processing'
      || analysisState.state === 'failed_retryable'
    if (retryPending && detail.analysis?.retryExhausted !== true) {
      setExportError('Phân tích chưa hoàn tất. Vui lòng đợi hệ thống thử lại hoặc chạy phân tích lại trước khi xuất report.')
      return
    }

    setExportBusy(true)
    setExportError(null)
    try {
      const { blob, filename } = await downloadMeetingReport(selectedMeetingSummary.id, 'pdf')
      saveBlobToFile(blob, filename)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Không thể xuất PDF')
    } finally {
      setExportBusy(false)
    }
  }

  const handleTranscriptExport = async (mode: TranscriptExportMode, format: TranscriptExportFormat) => {
    if (!selectedMeetingSummary || detail.transcriptState !== 'ready') {
      return
    }

    setTranscriptExportBusy({ mode, format })
    setTranscriptExportError(null)
    setTranscriptExportMenuOpen(false)

    try {
      const { blob, filename } = await downloadMeetingTranscript(selectedMeetingSummary.id, format, mode)
      saveBlobToFile(blob, filename)
    } catch (error) {
      setTranscriptExportError(error instanceof Error ? error.message : 'Không thể xuất transcript')
    } finally {
      setTranscriptExportBusy(null)
    }
  }

  const handleTranscriptEvidenceSearch = async () => {
    if (!selectedMeetingSummary) {
      return
    }
    const query = transcriptEvidenceQuery.trim()
    if (query.length < 2) {
      setTranscriptEvidenceState('error')
      setTranscriptEvidenceResults([])
      setTranscriptEvidenceError('Nhập ít nhất 2 ký tự để tìm trong transcript.')
      return
    }

    setTranscriptEvidenceState('loading')
    setTranscriptEvidenceError(null)
    try {
      const response = await searchMeetingTranscriptEvidence(selectedMeetingSummary.id, query, { limit: 10, context: 1 })
      setTranscriptEvidenceResults(response.matches)
      setTranscriptEvidenceState(response.matches.length > 0 ? 'ready' : 'empty')
    } catch (error) {
      setTranscriptEvidenceResults([])
      setTranscriptEvidenceState('error')
      setTranscriptEvidenceError(error instanceof Error ? error.message : 'Không thể tìm trong transcript')
    }
  }

  const handleActionPlanExport = async (format: 'docx' | 'pdf' = 'docx') => {
    if (!selectedMeetingSummary) {
      return
    }
    const meetingId = selectedMeetingSummary.id
    setActionPlanState((current) => ({
      ...current,
      loading: true,
      exporting: false,
      error: null,
      success: null,
    }))

    try {
      const preview = await getMeetingActionPlan(meetingId)
      setActionPlanState({
        preview,
        loading: false,
        exporting: true,
        error: null,
        success: null,
      })
      const { blob, filename } = await downloadMeetingActionPlan(meetingId, format)
      saveBlobToFile(blob, filename)
      setActionPlanState({
        preview,
        loading: false,
        exporting: false,
        error: null,
        success: `Action plan (${format.toUpperCase()}) đã sẵn sàng để tải xuống.`,
      })
    } catch (error) {
      setActionPlanState((current) => ({
        ...current,
        loading: false,
        exporting: false,
        error: getActionPlanErrorMessage(error),
        success: null,
      }))
    }
  }

  const handleActionPlanCopy = async () => {
    if (!actionPlanState.preview) {
      return
    }
    const copyText = formatGroupedActionPlanForCopy(
      actionPlanState.preview.groupedActionPlan ?? undefined,
      actionPlanState.preview.actionItems,
    )
    try {
      await copyTextToClipboard(copyText)
      setActionPlanState((current) => ({
        ...current,
        error: null,
        success: 'Action plan đã được copy.',
      }))
    } catch (error) {
      setActionPlanState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'Không thể copy action plan',
        success: null,
      }))
    }
  }

  const meetingCards = meetings.map((meeting) => ({
    id: meeting.id,
    title: getMeetingLabel(meeting),
    createdAt: formatDateVi(meeting.createdAt),
    language: formatLanguage(getMeetingLanguage(meeting)),
    status: getMeetingStatus(meeting),
    sharedWithMe: Boolean(meeting.sharedWithMe),
    active: meeting.id === selectedMeetingId,
  }))

  return (
    <div className="dashboard-page bg-gray-light">
      {!isSearchControlled && (
        <header className="dashboard-header border-b">
          <div className="search-bar">
            <span className="icon">🔍</span>
            <input
              type="text"
              placeholder="Tìm meeting theo tên hoặc file gốc..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              data-testid="meeting-search-input"
            />
          </div>
          <div className="header-actions">
            <button type="button" className="icon-btn" aria-label="Tải lại danh sách" onClick={() => setReloadTick((value) => value + 1)}>↻</button>
          </div>
        </header>
      )}

      <div className="history-scene">
        <section className="history-list-card studio-card">
          <div className="history-page-head studio-page-head">
            <div>
              <h1>Lịch sử cuộc họp</h1>
              <p>Tìm kiếm, lọc, đổi tên và xoá mềm meeting.</p>
            </div>
            <span className="meta-pill">{meetings.length}</span>
          </div>

          <div className="history-toolbar">
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} data-testid="meeting-status-filter">
              <option value="">Tất cả trạng thái</option>
              <option value="scheduled">Đã lên lịch</option>
              <option value="processing">Đang xử lý</option>
              <option value="completed">Hoàn tất</option>
              <option value="failed">Thất bại</option>
            </select>
            <select value={languageFilter} onChange={(event) => setLanguageFilter(event.target.value)} data-testid="meeting-language-filter">
              <option value="">Tất cả ngôn ngữ</option>
              <option value="vi">Tiếng Việt</option>
              <option value="en">Tiếng Anh</option>
              <option value="multi">Việt + Anh</option>
            </select>
            <select value={sortValue} onChange={(event) => setSortValue(event.target.value)} data-testid="meeting-sort-select">
              <option value="created_desc">Mới nhất</option>
              <option value="created_asc">Cũ nhất</option>
            </select>
          </div>

          {listState === 'loading' && <LoadingState message="Đang tải danh sách meeting..." />}
          {listState === 'error' && <ErrorState title="Không thể tải lịch sử" message={listError || 'Không thể tải lịch sử meeting'} />}
          {listState === 'empty' && (
            <div className="ui-state ui-state--empty" data-testid="meeting-history-empty">
              <p>Chưa có meeting phù hợp. Hãy tải file âm thanh hoặc ghi âm trực tiếp để bắt đầu.</p>
              <div className="history-empty-actions">
                {onNavigateUpload && (
                  <button type="button" className="secondary-cta" data-testid="history-empty-upload" onClick={onNavigateUpload}>
                    Tải file
                  </button>
                )}
                {onNavigateRealtime && (
                  <button type="button" className="secondary-cta" data-testid="history-empty-realtime" onClick={onNavigateRealtime}>
                    Ghi âm trực tiếp
                  </button>
                )}
              </div>
            </div>
          )}

          {semanticState === 'loading' && (
            <LoadingState message="Đang tìm kiếm semantic…" />
          )}
          {semanticState === 'error' && (
            <ErrorState title="Tìm kiếm semantic" message="Không thể tìm meeting liên quan lúc này." />
          )}
          {semanticState === 'ready' && semanticResults.length === 0 && searchQuery.trim() && (
            <EmptyState message="Không tìm thấy meeting phù hợp với truy vấn semantic." />
          )}
          {semanticState === 'ready' && semanticResults.length > 0 && (
            <div className="semantic-search-results" data-testid="semantic-search-results">
              <h3 className="studio-page-head">Kết quả tìm kiếm semantic</h3>
              <ul className="semantic-search-results__list">
                {semanticResults.map((result) => (
                  <li key={result.meetingId}>
                    <button
                      type="button"
                      className="secondary-cta"
                      onClick={() => {
                        setSelectedMeetingId(result.meetingId)
                        writeStoredMeetingId(result.meetingId)
                      }}
                    >
                      #{result.meetingId} {result.title || result.originalFileName || 'Meeting'}
                    </button>
                    {result.reason && <p>{result.reason}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {listState === 'ready' && (
            <div className="history-list-grid" data-testid="meeting-list">
              {meetingCards.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`history-list-item${item.active ? ' history-list-item--active' : ''}`}
                  onClick={() => {
                    setSelectedMeetingId(item.id)
                    writeStoredMeetingId(item.id)
                  }}
                >
                  <div className="history-list-item__row">
                    <strong>{item.title}</strong>
                    <div className="history-list-item__badges">
                      {item.sharedWithMe && (
                        <span className="history-share-badge" data-testid="meeting-shared-badge">
                          Chia sẻ
                        </span>
                      )}
                      <span className="meta-pill">#{item.id}</span>
                    </div>
                  </div>
                  <div className="history-list-item__meta">
                    <span>{item.createdAt}</span>
                    <span>•</span>
                    <span>{item.language}</span>
                    <span>•</span>
                    <span>{item.status}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="history-detail-card">
          {selectedMeetingSummary ? (
            <div className="studio-card">
              <div className="history-detail-stack">
                <div className="history-detail-header">
                  <div>
                    <h2 className="studio-page-head">{getMeetingLabel(selectedMeetingSummary)}</h2>
                    <div className="history-detail-meta">
                      ID {selectedMeetingSummary.id} • {formatLanguage(getMeetingLanguage(selectedMeetingSummary))} • {formatDateVi(selectedMeetingSummary.scheduledStartAt || selectedMeetingSummary.createdAt)}
                    </div>
                  </div>
                  <span className="meta-pill">{getMeetingStatus(selectedMeetingSummary)}</span>
                </div>
                {(onOpenAnalysis || onOpenMindmap) && (
                  <div className="history-detail-ctas">
                    {onOpenAnalysis && (
                      <button
                        type="button"
                        className="primary-cta"
                        onClick={() => onOpenAnalysis(selectedMeetingSummary.id, { title: getMeetingLabel(selectedMeetingSummary) })}
                        data-testid="meeting-open-analysis"
                      >
                        Xem kết quả phân tích
                      </button>
                    )}
                    {onOpenMindmap && (
                      <button
                        type="button"
                        className="secondary-cta"
                        onClick={() => onOpenMindmap(selectedMeetingSummary.id, { title: getMeetingLabel(selectedMeetingSummary) })}
                        data-testid="meeting-open-mindmap"
                      >
                        Mở sơ đồ mindmap
                      </button>
                    )}
                  </div>
                )}

                <div className="history-actions">
                  <div className="history-actions__group history-rename-row">
                    <span className="history-actions__label">Quản lý</span>
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      placeholder="Đổi tên meeting"
                      data-testid="meeting-rename-input"
                    />
                    <button type="button" className="history-btn" onClick={handleRename} disabled={renameBusy} data-testid="meeting-rename-submit">
                      {renameBusy ? 'Đang lưu...' : 'Lưu tên'}
                    </button>
                    <button type="button" className="history-btn history-btn--danger" onClick={handleDelete} disabled={deleteBusy} data-testid="meeting-delete-submit">
                      {deleteBusy ? 'Đang xoá...' : 'Xoá mềm'}
                    </button>
                    <button
                      type="button"
                      className="history-btn"
                      onClick={() => void handleShareMeetingLink()}
                      data-testid="meeting-share-link"
                    >
                      Sao chép link
                    </button>
                  </div>

                  <div className="history-actions__group">
                    <span className="history-actions__label">Xuất file</span>
                    <button
                      type="button"
                      className="history-btn history-btn--primary"
                      onClick={() => void handleExportPdf()}
                      disabled={exportBusy || detail.transcriptState !== 'ready'}
                      data-testid="meeting-export-report-pdf"
                    >
                      {exportBusy ? 'Đang xuất...' : 'PDF báo cáo'}
                    </button>
                    <button
                      type="button"
                      className="history-btn"
                      onClick={handleExport}
                      disabled={exportBusy || detail.transcriptState !== 'ready'}
                      data-testid="meeting-export-report"
                    >
                      {exportBusy ? 'Đang xuất...' : 'DOCX báo cáo'}
                    </button>
                    <div className="history-export-anchor">
                      <button
                        type="button"
                        className="history-btn"
                        onClick={() => setTranscriptExportMenuOpen((value) => !value)}
                        disabled={transcriptExportBusy !== null || detail.transcriptState !== 'ready'}
                        data-testid="meeting-export-transcript"
                      >
                        {transcriptExportBusy
                          ? `Đang xuất ${transcriptExportBusy.mode} ${transcriptExportBusy.format.toUpperCase()}...`
                          : 'Xuất transcript'}
                      </button>
                      {transcriptExportMenuOpen && detail.transcriptState === 'ready' && transcriptExportBusy === null && (
                        <div className="history-export-menu" data-testid="meeting-export-transcript-menu">
                          <button type="button" data-testid="meeting-export-transcript-readable-txt" onClick={() => void handleTranscriptExport('readable', 'txt')}>
                            Readable TXT
                          </button>
                          <button type="button" data-testid="meeting-export-transcript-readable-csv" onClick={() => void handleTranscriptExport('readable', 'csv')}>
                            Readable CSV
                          </button>
                          <button type="button" data-testid="meeting-export-transcript-raw-txt" onClick={() => void handleTranscriptExport('raw', 'txt')}>
                            Raw TXT
                          </button>
                          <button type="button" data-testid="meeting-export-transcript-raw-csv" onClick={() => void handleTranscriptExport('raw', 'csv')}>
                            Raw CSV
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="history-btn"
                      onClick={() => void handleActionPlanExport('docx')}
                      disabled={actionPlanState.loading || actionPlanState.exporting}
                      data-testid="meeting-export-action-plan"
                    >
                      {actionPlanState.loading || actionPlanState.exporting ? 'Đang xuất kế hoạch...' : 'DOCX kế hoạch'}
                    </button>
                    <button
                      type="button"
                      className="history-btn"
                      onClick={() => void handleActionPlanExport('pdf')}
                      disabled={actionPlanState.loading || actionPlanState.exporting}
                      data-testid="meeting-export-action-plan-pdf"
                    >
                      {actionPlanState.loading || actionPlanState.exporting ? 'Đang xuất kế hoạch...' : 'PDF kế hoạch'}
                    </button>
                  </div>
                </div>

                {listError && <ErrorState title="Thao tác thất bại" message={listError} />}
                {shareNotice && (
                  <p className="history-notice" data-testid="meeting-share-notice">
                    {shareNotice}
                  </p>
                )}
                <div className="history-share-panel" data-testid="meeting-share-panel">
                  <strong className="history-share-panel__title">Chia sẻ workspace</strong>
                  {shareGmailEmailMismatch && (
                    <p className="history-notice history-notice--warn" data-testid="meeting-share-gmail-mismatch">
                      Gmail đã liên kết ({shareGoogleStatus?.googleEmail}) khác email đăng nhập ({shareUserEmail}).
                      Mail mời sẽ gửi từ Gmail đã liên kết.
                    </p>
                  )}
                  {shareMissingGmailScope && (
                    <div className="history-share-row">
                      <p className="history-notice">
                        Chưa cấp quyền gửi email qua Gmail — lời mời vẫn được lưu nhưng mail có thể không gửi tự động.
                      </p>
                      <button
                        type="button"
                        className="history-btn"
                        onClick={() => void handleGrantGmailSendScope()}
                        disabled={gmailLinkBusy}
                        data-testid="meeting-share-grant-gmail"
                      >
                        {gmailLinkBusy ? 'Đang mở Google...' : 'Cấp quyền gửi email qua Gmail'}
                      </button>
                    </div>
                  )}
                  <div className="history-share-row">
                    <input
                      type="email"
                      value={shareInviteEmail}
                      onChange={(event) => setShareInviteEmail(event.target.value)}
                      placeholder="Email người nhận"
                      data-testid="meeting-share-email"
                    />
                    <button
                      type="button"
                      className="history-btn"
                      onClick={() => void handleInviteShare()}
                      disabled={shareInviteBusy || !shareInviteEmail.trim()}
                      data-testid="meeting-share-invite"
                    >
                      {shareInviteBusy ? 'Đang mời...' : 'Mời VIEWER'}
                    </button>
                  </div>
                  {shareInviteError && <ErrorState title="Chia sẻ thất bại" message={shareInviteError} />}
                  {meetingShares.length > 0 && (
                    <ul className="history-share-list">
                      {meetingShares.map((share) => (
                        <li key={shareListKey(share)}>
                          <span>
                            {formatShareLabel(share)}
                            {' '}
                            ({share.role}
                            {isPendingMeetingShare(share) ? ', chờ đăng ký' : ''})
                          </span>
                          {isPendingMeetingShare(share) && (
                            <button
                              type="button"
                              className="history-btn"
                              onClick={() => void handleCopyPendingInvite(share)}
                            >
                              Sao chép lời mời
                            </button>
                          )}
                          <button type="button" className="history-btn" onClick={() => void handleRevokeShare(share)}>
                            Thu hồi
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {exportError && <ErrorState title="Xuất report thất bại" message={exportError} />}
                {detail.analysisState === 'failed' && detail.analysisError && (
                  <ErrorState
                    title="Phân tích không khả dụng"
                    message={detail.analysisError}
                    errorCode={detail.analysisMetadata?.errorCode ?? undefined}
                    onCtaClick={
                      isUserQuotaExceeded({
                        errorCode: detail.analysisMetadata?.errorCode,
                        analysisStatus: String(detail.analysisMetadata?.analysisStatus ?? detail.analysisMetadata?.status ?? ''),
                      })
                        ? onNavigateBilling
                        : undefined
                    }
                  />
                )}
                {transcriptExportError && <ErrorState title="Xuất transcript thất bại" message={transcriptExportError} />}
                {actionPlanState.error && <ErrorState title="Xuất action plan thất bại" message={actionPlanState.error} />}
                {actionPlanState.success && (
                  <p className="history-notice" data-testid="meeting-action-plan-success">
                    {actionPlanState.success}
                  </p>
                )}
                {actionPlanState.preview && (
                  <ActionPlanPreview preview={actionPlanState.preview} onCopy={() => void handleActionPlanCopy()} />
                )}
                {detail.transcriptState === 'ready' && (
                  <p className="history-helper" data-testid="meeting-export-transcript-helper">
                    Bản Readable dễ đọc; bản Raw dùng cho kiểm tra và audit.
                  </p>
                )}
                {detail.transcriptState !== 'ready' && (
                  <p className="history-helper" data-testid="meeting-export-hint">
                    Cần transcript đã lưu để xuất báo cáo.
                  </p>
                )}
              </div>

              <div className="history-detail-section">
                <div className="history-detail-block">
                  <div className="history-detail-block__head">
                    <h3 className="history-detail-block__title">Bản ghi</h3>
                    <span className="meta-pill">{detail.transcriptState}</span>
                  </div>
                  {detail.transcriptState === 'loading' && <LoadingState message="Đang tải transcript đã lưu..." />}
                  {detail.transcriptState === 'error' && <ErrorState title="Không thể tải transcript" message={detail.transcriptError || 'Không thể tải transcript'} />}
                  {detail.transcriptState === 'empty' && <EmptyState message="Không có transcript đã lưu" />}
                  {detail.transcriptState === 'ready' && (
                    <div className="history-detail-block">
                      <form
                        className="transcript-evidence-form"
                        data-testid="transcript-evidence-search-form"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void handleTranscriptEvidenceSearch()
                        }}
                      >
                        <input
                          type="search"
                          className="studio-input"
                          value={transcriptEvidenceQuery}
                          onChange={(event) => setTranscriptEvidenceQuery(event.target.value)}
                          placeholder="Tìm trong transcript..."
                          data-testid="transcript-evidence-search-input"
                        />
                        <button
                          type="submit"
                          className="studio-btn studio-btn--primary"
                          disabled={transcriptEvidenceState === 'loading'}
                          data-testid="transcript-evidence-search-submit"
                        >
                          {transcriptEvidenceState === 'loading' ? 'Đang tìm...' : 'Tìm evidence'}
                        </button>
                      </form>
                      {transcriptEvidenceState === 'error' && (
                        <ErrorState
                          title="Không thể tìm evidence"
                          message={transcriptEvidenceError || 'Không thể tìm trong transcript'}
                        />
                      )}
                      {transcriptEvidenceState === 'empty' && (
                        <EmptyState message="Không tìm thấy evidence phù hợp" />
                      )}
                      {transcriptEvidenceState === 'ready' && (
                        <div className="transcript-evidence-results" data-testid="transcript-evidence-results">
                          {transcriptEvidenceResults.map((match) => (
                            <article key={match.evidenceId} className="history-evidence-card">
                              <div className="history-evidence-card__head">
                                <strong>{match.speaker || 'Speaker'}</strong>
                                <div className="history-evidence-card__badges">
                                  {match.verificationStatus && (
                                    <span className="meta-pill" data-testid="transcript-evidence-verification-status">
                                      {match.verificationStatus}
                                    </span>
                                  )}
                                  <span className="meta-pill">#{match.rank} {formatEvidenceTime(match.startTime, match.endTime)}</span>
                                </div>
                              </div>
                              {match.contextBefore.map((context) => (
                                <p key={`before-${context.segmentId}-${context.index}`} className="history-evidence-card__context">
                                  {context.speaker}: {context.text}{context.textTruncated ? ' (đã rút gọn)' : ''}
                                </p>
                              ))}
                              <p className="history-evidence-card__quote">
                                {match.text}{match.textTruncated ? ' (đã rút gọn)' : ''}
                              </p>
                              {match.contextAfter.map((context) => (
                                <p key={`after-${context.segmentId}-${context.index}`} className="history-evidence-card__context">
                                  {context.speaker}: {context.text}{context.textTruncated ? ' (đã rút gọn)' : ''}
                                </p>
                              ))}
                            </article>
                          ))}
                        </div>
                      )}
                      <TranscriptDisplay
                        segments={detail.transcriptSegments}
                        emptyMessage="Không có transcript đã lưu"
                        maxHeight="460px"
                        enableDisplayGrouping
                        domainMode={detail.analysis?.domainMode ?? (detail.analysisMetadata as { domainMode?: string } | null)?.domainMode}
                        onTermClick={selectedMeetingId ? (term) => setActiveTerm(term) : undefined}
                        speakerDisplayMap={speakerDisplayMap}
                        highlightRange={highlightRange}
                      />
                      <MeetingTimeline
                        segments={detail.transcriptSegments}
                        analysis={detail.analysis}
                        onJumpToChapter={handleTimelineJump}
                      />
                      <GlossaryNotesPanel
                        meetingId={selectedMeetingId}
                        analysis={detail.analysis}
                        onTermSelect={(term) => setActiveTerm(term)}
                      />
                      <SpeakerNamingPanel
                        meetingId={selectedMeetingId}
                        transcriptSegments={detail.transcriptSegments}
                        onProfilesSaved={applySpeakerProfiles}
                      />
                      <MeetingTaskTracker
                        meetingId={selectedMeetingId}
                        groupedActionPlan={detail.analysis?.groupedActionPlan}
                      />
                      {selectedMeetingId != null && (
                        <AiAssistant
                          meetingId={selectedMeetingId}
                          onCitationClick={handleCitationClick}
                          onAsk={async (message) => {
                            const result = await answerMeetingQuestion(
                              selectedMeetingId,
                              message,
                              detail.analysis,
                            )
                            let text = result.answer
                            if (result.provider !== 'gemini') {
                              const suffix = result.provider === 'evidence'
                                ? '\n\n(Lưu ý: trả lời từ transcript đã lưu.)'
                                : '\n\n(Lưu ý: Gemini tạm không khả dụng — trả lời từ dữ liệu phân tích cục bộ.)'
                              text = `${result.answer}${suffix}`
                            }
                            return { text, citations: result.sourceSegments }
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="studio-card">
              {listState === 'loading' ? (
                <LoadingState message="Đang chuẩn bị history..." />
              ) : (
                <EmptyState message="Chọn một meeting để xem transcript và analysis đã lưu" />
              )}
            </div>
          )}
        </section>
      </div>
      {selectedMeetingId != null && activeTerm && (
        <TermExplainPopover
          meetingId={selectedMeetingId}
          term={activeTerm}
          analysis={detail.analysis}
          onClose={() => setActiveTerm(null)}
        />
      )}
    </div>
  )
}
