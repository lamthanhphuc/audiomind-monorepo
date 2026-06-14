import { useEffect, useMemo, useRef, useState } from 'react'
import {
    ApiError,
    deleteMeeting,
    downloadMeetingActionPlanDocx,
    downloadMeetingReport,
    downloadMeetingTranscript,
    getMeetingActionPlan,
    getSavedAnalysis,
    getTranscript,
    listMeetingsWithParams,
    reanalyzeMeetingAnalysis,
    renameMeeting,
    searchMeetingTranscriptEvidence,
} from '../../services/api'
import type { MeetingActionPlanData, TranscriptEvidenceMatch } from '../../services/api'
import { formatGroupedActionPlanForCopy, normalizeGroupedActionPlan } from '../../types'
import type { AiAnalysis, GroupedActionPlan, Meeting } from '../../types'
import { normalizePersistedTranscriptForView } from '../../utils/transcript'
import { AnalysisPanel } from '../analysis/AnalysisPanel'
import { AnalysisStatusPanel, normalizeAnalysisMetadata } from '../analysis/AnalysisStatusPanel'
import { TranscriptDisplay } from '../transcript/TranscriptDisplay'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'

type DetailAnalysisState = 'idle' | 'processing' | 'completed' | 'failed' | 'missing'
type ListState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
type TranscriptSearchState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
type TranscriptExportFormat = 'txt' | 'csv'
type TranscriptExportMode = 'readable' | 'raw'

const SAVED_TRANSCRIPT_MISSING_REANALYZE_MESSAGE = 'Cannot re-analyze because saved transcript was not found.'
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
  if (normalized === 'completed' || normalized === 'processing' || normalized === 'failed') {
    return normalized
  }
  return 'unknown'
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
          <span className="meta-pill">{itemCount} items</span>
          <button type="button" onClick={onCopy} data-testid="meeting-action-plan-copy">
            Copy
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
                      <span>{item.confidence ?? 'NEEDS_REVIEW'}</span>
                    </div>
                    {item.description && <p>{item.description}</p>}
                    {(item.owner || item.deadline || item.priority || item.status) && (
                      <div className="action-plan-preview__meta">
                        {item.owner && <span>Owner: {item.owner}</span>}
                        {item.deadline && <span>Due: {item.deadline}</span>}
                        {item.priority && <span>Priority: {item.priority}</span>}
                        {item.status && <span>Status: {item.status}</span>}
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
                      <div className="action-plan-preview__keywords" aria-label="Keyword hints">
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
    const retryAfter = analysis.retryAfterSeconds && analysis.retryAfterSeconds > 0
      ? ` Retry after ${analysis.retryAfterSeconds}s.`
      : ''
    const detail = analysis.errorCode ? ` ${analysis.errorCode}.` : ''
    return { state: 'failed', analysis: null, error: `Analysis failed temporarily. Retry available.${detail}${retryAfter}` }
  }
  if (status === 'FAILED' || status === 'RATE_LIMITED' || status === 'QUOTA_BLOCKED') {
    const retryAfter = analysis.retryAfterSeconds && analysis.retryAfterSeconds > 0
      ? ` Retry after ${analysis.retryAfterSeconds}s.`
      : ''
    const detail = analysis.errorCode ? ` ${analysis.errorCode}.` : ''
    return { state: 'failed', analysis: null, error: `Analysis failed temporarily. Retry available.${detail}${retryAfter}` }
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

const baseAnalysisMetadata = (meetingId: number): AiAnalysis => ({
  meetingId,
  meeting_id: meetingId,
  status: 'NO_ANALYSIS',
  analysisStatus: 'NO_ANALYSIS',
  summary: '',
  keywords: [],
  technicalTerms: [],
  painPoints: [],
  actionItems: [],
  domainMode: 'it',
})

const isTerminalAnalysisStatus = (analysis: AiAnalysis | null): boolean => {
  const status = normalizeAnalysisMetadata(analysis).status
  return status === 'COMPLETED'
    || status === 'FAILED'
    || status === 'RATE_LIMITED'
    || status === 'QUOTA_BLOCKED'
}

const getReanalyzeErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.status === 404) {
    return SAVED_TRANSCRIPT_MISSING_REANALYZE_MESSAGE
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Không thể re-analyze meeting'
}

export default function MeetingHistoryScene({ focusMeetingId = null, onOpenAnalysis }: MeetingHistorySceneProps) {
  const [listState, setListState] = useState<ListState>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [selectedMeetingId, setSelectedMeetingId] = useState<number | null>(null)
  const [detail, setDetail] = useState<SelectedMeetingDetail>(emptyDetailState)
  const [searchQuery, setSearchQuery] = useState('')
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
  const [reanalyzeBusy, setReanalyzeBusy] = useState(false)
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const rerunPollRef = useRef<{ meetingId: number; cancelled: boolean; timeoutId: number | null } | null>(null)
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
    if (rerunPollRef.current) {
      rerunPollRef.current.cancelled = true
      if (rerunPollRef.current.timeoutId !== null) {
        window.clearTimeout(rerunPollRef.current.timeoutId)
      }
    }
    setReanalyzeBusy(false)
    setReanalyzeError(null)
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

    return () => {
      if (rerunPollRef.current) {
        rerunPollRef.current.cancelled = true
        if (rerunPollRef.current.timeoutId !== null) {
          window.clearTimeout(rerunPollRef.current.timeoutId)
        }
      }
    }
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

  const handleExport = async () => {
    if (!selectedMeetingSummary || detail.transcriptState !== 'ready') {
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

  const handleActionPlanExport = async () => {
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
      const { blob, filename } = await downloadMeetingActionPlanDocx(meetingId)
      saveBlobToFile(blob, filename)
      setActionPlanState({
        preview,
        loading: false,
        exporting: false,
        error: null,
        success: 'Action plan đã sẵn sàng để tải xuống.',
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

  const applyAnalysisResponse = (meetingId: number, analysisResponse: AiAnalysis | null, terminal = false) => {
    const nextState = getAnalysisStateFromResponse(analysisResponse)
    setDetail((current) => {
      if (current.meeting?.id !== meetingId) {
        return current
      }
      const shouldKeepCompletedContent = Boolean(current.analysis && nextState.state !== 'completed')
      const nextDetail = {
        ...current,
        analysis: shouldKeepCompletedContent ? current.analysis : nextState.analysis,
        analysisMetadata: analysisResponse ?? current.analysisMetadata,
        analysisState: shouldKeepCompletedContent ? 'completed' as const : nextState.state,
        analysisError: terminal && nextState.state === 'failed' ? nextState.error : null,
      }
      if (terminal && current.meeting) {
        writeDetailCache({
          meetingId,
          meeting: current.meeting,
          transcriptSegments: nextDetail.transcriptSegments,
          transcriptState: nextDetail.transcriptState,
          transcriptError: nextDetail.transcriptError,
          analysis: nextDetail.analysis,
          analysisMetadata: nextDetail.analysisMetadata,
          analysisState: nextDetail.analysisState,
          analysisError: nextDetail.analysisError,
        })
      }
      return nextDetail
    })
  }

  const pollSavedAnalysis = async (
    meetingId: number,
    pollState: { meetingId: number; cancelled: boolean; timeoutId: number | null },
  ) => {
    while (!pollState.cancelled) {
      await new Promise<void>((resolve) => {
        pollState.timeoutId = window.setTimeout(resolve, 1500)
      })
      pollState.timeoutId = null
      if (pollState.cancelled) {
        return
      }

      try {
        const savedAnalysis = await getSavedAnalysis(meetingId)
        if (pollState.cancelled || selectedMeetingIdRef.current !== meetingId) {
          return
        }
        applyAnalysisResponse(meetingId, savedAnalysis, isTerminalAnalysisStatus(savedAnalysis))
        if (isTerminalAnalysisStatus(savedAnalysis)) {
          setReanalyzeBusy(false)
          return
        }
      } catch (error) {
        if (pollState.cancelled) {
          return
        }
        setReanalyzeError(error instanceof Error ? error.message : 'Không thể cập nhật trạng thái analysis')
        setReanalyzeBusy(false)
        return
      }
    }
  }

  const handleReanalyze = async () => {
    if (!selectedMeetingSummary) {
      return
    }

    const meetingId = selectedMeetingSummary.id
    const previousAnalysis = detail.meeting?.id === meetingId ? detail.analysis : null
    const previousAnalysisMetadata = detail.meeting?.id === meetingId ? detail.analysisMetadata : null
    const previousAnalysisState = detail.meeting?.id === meetingId ? detail.analysisState : 'missing'
    const previousAnalysisError = detail.meeting?.id === meetingId ? detail.analysisError : null
    if (rerunPollRef.current) {
      rerunPollRef.current.cancelled = true
      if (rerunPollRef.current.timeoutId !== null) {
        window.clearTimeout(rerunPollRef.current.timeoutId)
      }
    }

    invalidateDetailCache(meetingId)
    const pollState = { meetingId, cancelled: false, timeoutId: null as number | null }
    rerunPollRef.current = pollState
    setReanalyzeBusy(true)
    setReanalyzeError(null)
    setDetail((current) => {
      if (current.meeting?.id !== meetingId) {
        return current
      }
      return {
        ...current,
        analysisMetadata: {
          ...(current.analysisMetadata ?? current.analysis ?? baseAnalysisMetadata(meetingId)),
          status: 'ANALYZING',
          analysisStatus: 'ANALYZING',
        },
        analysisState: current.analysis ? 'completed' : 'processing',
        analysisError: null,
      }
    })

    try {
      const response = await reanalyzeMeetingAnalysis(meetingId, { mode: 'force', reason: 'manual_reanalyze' })
      if (pollState.cancelled || selectedMeetingIdRef.current !== meetingId) {
        return
      }
      applyAnalysisResponse(meetingId, response, isTerminalAnalysisStatus(response))
      if (isTerminalAnalysisStatus(response)) {
        setReanalyzeBusy(false)
        return
      }
      void pollSavedAnalysis(meetingId, pollState)
    } catch (error) {
      if (pollState.cancelled) {
        return
      }
      pollState.cancelled = true
      if (pollState.timeoutId !== null) {
        window.clearTimeout(pollState.timeoutId)
        pollState.timeoutId = null
      }
      setDetail((current) => {
        if (current.meeting?.id !== meetingId) {
          return current
        }
        return {
          ...current,
          analysis: previousAnalysis ?? current.analysis,
          analysisMetadata: previousAnalysisMetadata ?? previousAnalysis ?? current.analysisMetadata,
          analysisState: previousAnalysis ? 'completed' : previousAnalysisState,
          analysisError: previousAnalysisError,
        }
      })
      setReanalyzeError(getReanalyzeErrorMessage(error))
      setReanalyzeBusy(false)
    }
  }

  const meetingCards = meetings.map((meeting) => ({
    id: meeting.id,
    title: getMeetingLabel(meeting),
    createdAt: meeting.createdAt,
    language: getMeetingLanguage(meeting),
    status: getMeetingStatus(meeting),
    active: meeting.id === selectedMeetingId,
  }))

  return (
    <div className="dashboard-page bg-gray-light">
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
          <button type="button" className="icon-btn" aria-label="Reload list" onClick={() => setReloadTick((value) => value + 1)}>↻</button>
        </div>
      </header>

      <div className="history-scene">
        <section className="history-list-card studio-card">
          <div className="studio-page-head" style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
            <div>
              <h1>Meeting history</h1>
              <p>Tìm kiếm, lọc, đổi tên và xoá mềm meeting.</p>
            </div>
            <span className="meta-pill">{meetings.length}</span>
          </div>

          <div className="history-toolbar">
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} data-testid="meeting-status-filter">
              <option value="">Tất cả trạng thái</option>
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
          {listState === 'empty' && <EmptyState message="Không có meeting phù hợp bộ lọc hiện tại" />}

          {listState === 'ready' && (
            <div style={{ display: 'grid', gap: '10px' }} data-testid="meeting-list">
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <strong>{item.title}</strong>
                    <span className="meta-pill">#{item.id}</span>
                  </div>
                  <div className="history-list-item__meta">
                    <span>{item.createdAt || 'Unknown date'}</span>
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
              <div style={{ display: 'grid', gap: '12px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                  <div>
                    <h2 className="studio-page-head">{getMeetingLabel(selectedMeetingSummary)}</h2>
                    <div style={{ marginTop: '6px', fontSize: '13px', color: 'var(--studio-muted)' }}>
                      ID {selectedMeetingSummary.id} • {getMeetingLanguage(selectedMeetingSummary)} • {selectedMeetingSummary.createdAt || 'Unknown date'}
                    </div>
                  </div>
                  <span className="meta-pill">{getMeetingStatus(selectedMeetingSummary)}</span>
                </div>
                {onOpenAnalysis && (
                  <button
                    type="button"
                    className="primary-cta"
                    onClick={() => onOpenAnalysis(selectedMeetingSummary.id, { title: getMeetingLabel(selectedMeetingSummary) })}
                    data-testid="meeting-open-analysis"
                  >
                    Xem kết quả
                  </button>
                )}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    placeholder="Đổi tên meeting"
                    data-testid="meeting-rename-input"
                    style={{ flex: 1 }}
                  />
                  <button type="button" onClick={handleRename} disabled={renameBusy} data-testid="meeting-rename-submit">
                    {renameBusy ? 'Đang lưu...' : 'Lưu tên'}
                  </button>
                  <button type="button" onClick={handleDelete} disabled={deleteBusy} data-testid="meeting-delete-submit">
                    {deleteBusy ? 'Đang xoá...' : 'Xoá mềm'}
                  </button>
                  <button
                    type="button"
                    onClick={handleExport}
                    disabled={exportBusy || detail.transcriptState !== 'ready'}
                    data-testid="meeting-export-report"
                  >
                    {exportBusy ? 'Đang xuất...' : 'Export report'}
                  </button>
                  <div style={{ position: 'relative' }}>
                    <button
                      type="button"
                      onClick={() => setTranscriptExportMenuOpen((value) => !value)}
                      disabled={transcriptExportBusy !== null || detail.transcriptState !== 'ready'}
                      data-testid="meeting-export-transcript"
                    >
                      {transcriptExportBusy ? `Đang xuất ${transcriptExportBusy.mode.toUpperCase()} ${transcriptExportBusy.format.toUpperCase()}...` : 'Export transcript'}
                    </button>
                    {transcriptExportMenuOpen && detail.transcriptState === 'ready' && transcriptExportBusy === null && (
                      <div
                        data-testid="meeting-export-transcript-menu"
                        style={{
                          position: 'absolute',
                          top: 'calc(100% + 8px)',
                          right: 0,
                          display: 'grid',
                          gap: '8px',
                          minWidth: '180px',
                          padding: '10px',
                          background: '#fff',
                          border: '1px solid #e5e7eb',
                          borderRadius: '12px',
                          boxShadow: '0 12px 32px rgba(15, 23, 42, 0.12)',
                          zIndex: 2,
                        }}
                      >
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
                    onClick={() => void handleActionPlanExport()}
                    disabled={actionPlanState.loading || actionPlanState.exporting}
                    data-testid="meeting-export-action-plan"
                  >
                    {actionPlanState.loading || actionPlanState.exporting ? 'Đang xuất action plan...' : 'Export action plan'}
                  </button>
                </div>
                {listError && <ErrorState title="Thao tác thất bại" message={listError} />}
                {exportError && <ErrorState title="Xuất report thất bại" message={exportError} />}
                {transcriptExportError && <ErrorState title="Xuất transcript thất bại" message={transcriptExportError} />}
                {actionPlanState.error && <ErrorState title="Xuất action plan thất bại" message={actionPlanState.error} />}
                {actionPlanState.success && (
                  <p style={{ margin: 0, color: '#166534', fontSize: '12px' }} data-testid="meeting-action-plan-success">
                    {actionPlanState.success}
                  </p>
                )}
                {actionPlanState.preview && (
                  <ActionPlanPreview preview={actionPlanState.preview} onCopy={() => void handleActionPlanCopy()} />
                )}
                {detail.transcriptState === 'ready' && (
                  <p
                    style={{ margin: 0, color: '#64748b', fontSize: '12px' }}
                    data-testid="meeting-export-transcript-helper"
                  >
                    Readable is best-effort; Raw is for audit/debug.
                  </p>
                )}
                {detail.transcriptState !== 'ready' && (
                  <p style={{ margin: 0, color: '#64748b', fontSize: '12px' }} data-testid="meeting-export-hint">
                    Cần transcript đã lưu để export report.
                  </p>
                )}
              </div>

              <div style={{ display: 'grid', gap: '16px' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '10px' }}>
                    <h3 className="studio-page-head" style={{ fontSize: '16px' }}>Transcript</h3>
                    <span className="meta-pill">{detail.transcriptState}</span>
                  </div>
                  {detail.transcriptState === 'loading' && <LoadingState message="Đang tải transcript đã lưu..." />}
                  {detail.transcriptState === 'error' && <ErrorState title="Không thể tải transcript" message={detail.transcriptError || 'Không thể tải transcript'} />}
                  {detail.transcriptState === 'empty' && <EmptyState message="Không có transcript đã lưu" />}
                  {detail.transcriptState === 'ready' && (
                    <div style={{ display: 'grid', gap: '12px' }}>
                      <form
                        data-testid="transcript-evidence-search-form"
                        style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}
                        onSubmit={(event) => {
                          event.preventDefault()
                          void handleTranscriptEvidenceSearch()
                        }}
                      >
                        <input
                          type="search"
                          value={transcriptEvidenceQuery}
                          onChange={(event) => setTranscriptEvidenceQuery(event.target.value)}
                          placeholder="Tìm trong transcript..."
                          data-testid="transcript-evidence-search-input"
                          style={{ flex: '1 1 220px' }}
                        />
                        <button
                          type="submit"
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
                        <div data-testid="transcript-evidence-results" style={{ display: 'grid', gap: '10px' }}>
                          {transcriptEvidenceResults.map((match) => (
                            <article
                              key={match.evidenceId}
                              style={{
                                display: 'grid',
                                gap: '6px',
                                padding: '12px',
                                border: '1px solid #e5e7eb',
                                borderRadius: '12px',
                                background: '#fff',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                <strong>{match.speaker || 'Speaker'}</strong>
                                <span className="meta-pill">#{match.rank} {formatEvidenceTime(match.startTime, match.endTime)}</span>
                              </div>
                              {match.contextBefore.map((context) => (
                                <p key={`before-${context.segmentId}-${context.index}`} style={{ margin: 0, color: '#64748b', fontSize: '12px' }}>
                                  {context.speaker}: {context.text}{context.textTruncated ? ' (đã rút gọn)' : ''}
                                </p>
                              ))}
                              <p style={{ margin: 0, color: '#0f172a', fontSize: '13px', lineHeight: 1.55 }}>
                                {match.text}{match.textTruncated ? ' (đã rút gọn)' : ''}
                              </p>
                              {match.contextAfter.map((context) => (
                                <p key={`after-${context.segmentId}-${context.index}`} style={{ margin: 0, color: '#64748b', fontSize: '12px' }}>
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
                      />
                    </div>
                  )}
                </div>

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '10px' }}>
                    <h3 className="studio-page-head" style={{ fontSize: '16px' }}>Analysis</h3>
                    <span className="meta-pill">{detail.analysisState}</span>
                  </div>
                  <AnalysisStatusPanel
                    metadata={detail.analysisMetadata ?? detail.analysis}
                    busy={reanalyzeBusy}
                    error={reanalyzeError}
                    onReanalyze={() => void handleReanalyze()}
                  />
                  {detail.analysisState === 'processing' && <LoadingState message="Analysis đã lưu đang xử lý..." />}
                  {detail.analysisState === 'failed' && <ErrorState title="Phân tích không sẵn sàng" message={detail.analysisError || 'Không thể tải phân tích đã lưu'} />}
                  {detail.analysisState === 'missing' && <EmptyState message="Meeting này chưa có analysis đã lưu" />}
                  {detail.analysisState === 'completed' && (
                    <AnalysisPanel
                      title="Saved analysis"
                      analysis={detail.analysis}
                      status="ready"
                      emptyMessage="Không có analysis đã lưu"
                      loadingMessage="Đang tải analysis đã lưu..."
                      summaryFallback="(empty)"
                      testId="e2e-saved-analysis"
                    />
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
    </div>
  )
}
