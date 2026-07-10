import { useEffect, useMemo, useRef, useState } from 'react'

import {
  ApiError,
  deleteMeeting,
  getMeetingDetail,
  getSavedAnalysis,
  getTranscript,
  listMeetingResultScopes,
  listMeetingsPage,
  MEETING_HISTORY_PAGE_SIZE,
  renameMeeting,
  resolveMeetingResultScope,
  semanticSearchMeetings,
} from '../../services/api'
import type { SemanticSearchResult } from '../../services/api'
import type { AiAnalysis, Meeting } from '../../types'
import { normalizePersistedTranscriptForView } from '../../utils/transcript'
import {
  scopeCacheKey,
  scopeToTranscriptOptions,
  selectDefaultResultScope,
  type MeetingResultScope,
} from '../../utils/meetingResultScope'
import type { HistoryLanguageFilter, HistoryStatusFilter } from '../../app/useHistorySearchFilters'

export type DetailAnalysisState = 'idle' | 'processing' | 'completed' | 'failed' | 'failed_retryable' | 'missing'
export type ListState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

export type SelectedMeetingDetail = {
  meeting: Meeting | null
  transcriptSegments: ReturnType<typeof normalizePersistedTranscriptForView>
  transcriptState: 'loading' | 'ready' | 'empty' | 'error'
  transcriptError: string | null
  analysis: AiAnalysis | null
  analysisMetadata: AiAnalysis | null
  analysisState: DetailAnalysisState
  analysisError: string | null
}

type MeetingDetailCacheEntry = {
  cacheKey: string
  meetingId: number
  resultScope: MeetingResultScope
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

type UseMeetingHistoryDataOptions = {
  focusMeetingId?: number | null
  controlledSearchQuery?: string
  onSearchQueryChange?: (value: string) => void
  controlledStatusFilter?: HistoryStatusFilter
  onStatusFilterChange?: (value: HistoryStatusFilter) => void
  controlledLanguageFilter?: HistoryLanguageFilter
  onLanguageFilterChange?: (value: HistoryLanguageFilter) => void
}

const HISTORY_LAST_SELECTED_KEY = 'audiomind.history.lastSelectedMeetingId'
const DETAIL_CACHE_TTL_MS = 5 * 60 * 1000
const SEARCH_DEBOUNCE_MS = 300

export const emptyDetailState: SelectedMeetingDetail = {
  meeting: null,
  transcriptSegments: [],
  transcriptState: 'loading',
  transcriptError: null,
  analysis: null,
  analysisMetadata: null,
  analysisState: 'idle',
  analysisError: null,
}

const isAbortError = (error: unknown): boolean => (
  error instanceof DOMException && error.name === 'AbortError'
)

const readStoredMeetingId = (): number | null => {
  try {
    const raw = window.sessionStorage.getItem(HISTORY_LAST_SELECTED_KEY)
    if (!raw) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

const writeStoredMeetingId = (meetingId: number) => {
  try {
    window.sessionStorage.setItem(HISTORY_LAST_SELECTED_KEY, String(meetingId))
  } catch {
    // ignore storage errors
  }
}

const clearStoredMeetingId = () => {
  try {
    window.sessionStorage.removeItem(HISTORY_LAST_SELECTED_KEY)
  } catch {
    // ignore storage errors
  }
}

const resolveRestoredMeetingId = (
  items: Meeting[],
  currentMeetingId: number | null,
  focusMeetingId: number | null,
): number | null => {
  if (items.length === 0) return null

  if (currentMeetingId != null && items.some((meeting) => meeting.id === currentMeetingId)) {
    return currentMeetingId
  }

  if (focusMeetingId != null && items.some((meeting) => meeting.id === focusMeetingId)) {
    return focusMeetingId
  }

  const storedMeetingId = readStoredMeetingId()
  if (storedMeetingId != null && items.some((meeting) => meeting.id === storedMeetingId)) {
    return storedMeetingId
  }

  if (focusMeetingId != null && items.some((meeting) => meeting.id === focusMeetingId)) {
    return focusMeetingId
  }

  return null
}

const meetingSummaryChanged = (previous: Meeting | null, next: Meeting | null): boolean => {
  if (!previous || !next) return previous !== next
  return previous.title !== next.title
    || previous.status !== next.status
    || previous.createdAt !== next.createdAt
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
    return { state: 'failed', analysis: null, error: analysis.errorMessage ?? 'Đã vượt giới hạn gói hiện tại.' }
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
  if (status === 'ANALYSIS_UNAVAILABLE_FOR_SCOPE') {
    return { state: 'missing', analysis: null, error: 'Kết quả phân tích chưa có cho phiên ghi này.' }
  }

  const hasStructuredData = Boolean(
    analysis.summary?.trim()
    || (analysis.keywords?.length ?? 0) > 0
    || (analysis.technicalTerms?.length ?? 0) > 0
    || (analysis.painPoints?.length ?? 0) > 0
    || (analysis.actionItems?.length ?? 0) > 0,
  )

  if (!hasStructuredData && (status === 'NOT_FOUND' || !status)) {
    return { state: 'missing', analysis: null, error: null }
  }

  return { state: 'completed', analysis, error: null }
}

export function useMeetingHistoryData({
  focusMeetingId = null,
  controlledSearchQuery,
  onSearchQueryChange,
  controlledStatusFilter,
  onStatusFilterChange,
  controlledLanguageFilter,
  onLanguageFilterChange,
}: UseMeetingHistoryDataOptions) {
  const isSearchControlled = onSearchQueryChange != null
  const [internalSearchQuery, setInternalSearchQuery] = useState('')
  const searchQuery = isSearchControlled ? (controlledSearchQuery ?? '') : internalSearchQuery
  const setSearchQuery = isSearchControlled ? onSearchQueryChange : setInternalSearchQuery

  const isStatusFilterControlled = onStatusFilterChange != null
  const isLanguageFilterControlled = onLanguageFilterChange != null
  const [internalStatusFilter, setInternalStatusFilter] = useState<HistoryStatusFilter>('')
  const [internalLanguageFilter, setInternalLanguageFilter] = useState<HistoryLanguageFilter>('')
  const statusFilter = isStatusFilterControlled ? (controlledStatusFilter ?? '') : internalStatusFilter
  const setStatusFilter = (value: HistoryStatusFilter) => {
    if (onStatusFilterChange) {
      onStatusFilterChange(value)
      return
    }
    setInternalStatusFilter(value)
  }
  const languageFilter = isLanguageFilterControlled ? (controlledLanguageFilter ?? '') : internalLanguageFilter
  const setLanguageFilter = (value: HistoryLanguageFilter) => {
    if (onLanguageFilterChange) {
      onLanguageFilterChange(value)
      return
    }
    setInternalLanguageFilter(value)
  }

  const [listState, setListState] = useState<ListState>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [listPage, setListPage] = useState(1)
  const [listTotal, setListTotal] = useState(0)
  const [listTotalPages, setListTotalPages] = useState(0)
  const [pinnedMeetingSummary, setPinnedMeetingSummary] = useState<Meeting | null>(null)
  const [selectedMeetingId, setSelectedMeetingId] = useState<number | null>(null)
  const [detail, setDetail] = useState<SelectedMeetingDetail>(emptyDetailState)
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [sortValue, setSortValue] = useState('created_desc')
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [semanticResults, setSemanticResults] = useState<SemanticSearchResult[]>([])
  const [semanticState, setSemanticState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [availableScopes, setAvailableScopes] = useState<MeetingResultScope[]>([])
  const [selectedScope, setSelectedScope] = useState<MeetingResultScope | null>(null)
  const [scopeState, setScopeState] = useState<ListState>('idle')
  const [scopeError, setScopeError] = useState<string | null>(null)

  const detailAbortRef = useRef<AbortController | null>(null)
  const detailRequestKeyRef = useRef<string | null>(null)
  const listAbortRef = useRef<AbortController | null>(null)
  const detailCacheRef = useRef<Map<string, MeetingDetailCacheEntry>>(new Map())
  const selectedMeetingIdRef = useRef<number | null>(null)
  const focusMeetingIdRef = useRef<number | null>(focusMeetingId)

  const selectedMeetingSummary = useMemo(() => {
    if (selectedMeetingId == null) return null
    return meetings.find((meeting) => meeting.id === selectedMeetingId)
      ?? (pinnedMeetingSummary?.id === selectedMeetingId ? pinnedMeetingSummary : null)
  }, [meetings, pinnedMeetingSummary, selectedMeetingId])

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
    for (const cacheKey of [...detailCacheRef.current.keys()]) {
      const meetingId = Number(cacheKey.split(':')[0])
      if (!nextIds.has(meetingId)) {
        detailCacheRef.current.delete(cacheKey)
      }
    }
    for (const item of items) {
      for (const [cacheKey, cached] of detailCacheRef.current.entries()) {
        if (cached.meetingId === item.id && meetingSummaryChanged(cached.meeting, item)) {
          detailCacheRef.current.delete(cacheKey)
        }
      }
    }
  }

  const writeDetailCache = (entry: Omit<MeetingDetailCacheEntry, 'fetchedAt'> & { fetchedAt?: number }) => {
    detailCacheRef.current.set(entry.cacheKey, {
      ...entry,
      fetchedAt: entry.fetchedAt ?? Date.now(),
    })
  }

  const readDetailCache = (cacheKey: string): MeetingDetailCacheEntry | null => {
    const cached = detailCacheRef.current.get(cacheKey)
    if (!cached) return null
    if (Date.now() - cached.fetchedAt > DETAIL_CACHE_TTL_MS) {
      detailCacheRef.current.delete(cacheKey)
      return null
    }
    return cached
  }

  const invalidateDetailCacheForMeeting = (meetingId: number) => {
    for (const cacheKey of [...detailCacheRef.current.keys()]) {
      if (cacheKey.startsWith(`${meetingId}:`)) {
        detailCacheRef.current.delete(cacheKey)
      }
    }
  }

  useEffect(() => {
    setRenameValue(selectedMeetingSummary?.title ?? '')
  }, [selectedMeetingSummary?.id, selectedMeetingSummary?.title])

  useEffect(() => {
    setListPage(1)
  }, [debouncedSearchQuery, languageFilter, sortValue, statusFilter])

  useEffect(() => {
    if (selectedMeetingId == null) {
      setPinnedMeetingSummary(null)
      return
    }

    const fromList = meetings.find((meeting) => meeting.id === selectedMeetingId)
    if (fromList) {
      setPinnedMeetingSummary(fromList)
      return
    }

    let cancelled = false
    void getMeetingDetail(selectedMeetingId)
      .then((meeting) => {
        if (!cancelled) {
          setPinnedMeetingSummary(meeting)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPinnedMeetingSummary(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [meetings, selectedMeetingId])

  useEffect(() => {
    listAbortRef.current?.abort()
    const controller = new AbortController()
    listAbortRef.current = controller

    const loadHistory = async () => {
      setListState('loading')
      setListError(null)

      try {
        const pageResult = await listMeetingsPage({
          query: debouncedSearchQuery,
          status: statusFilter || undefined,
          language: languageFilter || undefined,
          sort: sortValue,
          page: listPage,
          pageSize: MEETING_HISTORY_PAGE_SIZE,
        }, { signal: controller.signal })
        if (controller.signal.aborted) return

        const items = pageResult.items
        pruneDetailCacheForList(items)
        setMeetings(items)
        setListTotal(pageResult.total)
        setListTotalPages(pageResult.totalPages)
        setListState(items.length > 0 || pageResult.total > 0 ? 'ready' : 'empty')
        setSelectedMeetingId((current) => {
          const restored = resolveRestoredMeetingId(items, current, focusMeetingIdRef.current)
          if (restored != null) return restored
          if (focusMeetingIdRef.current != null) return focusMeetingIdRef.current
          if (current != null) return current
          return null
        })
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return
        setMeetings([])
        setListTotal(0)
        setListTotalPages(0)
        setListState('error')
        setListError(error instanceof Error ? error.message : 'Không thể tải lịch sử meeting')
      }
    }

    void loadHistory()
    return () => controller.abort()
  }, [debouncedSearchQuery, languageFilter, listPage, reloadTick, sortValue, statusFilter])

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
      setAvailableScopes([])
      setSelectedScope(null)
      setScopeState('idle')
      setScopeError(null)
      return
    }

    const controller = new AbortController()
    setAvailableScopes([])
    setSelectedScope(null)
    setScopeState('loading')
    setScopeError(null)

    const loadScopes = async () => {
      try {
        const scopeItems = await listMeetingResultScopes(selectedMeetingId, { signal: controller.signal })
        if (controller.signal.aborted || selectedMeetingIdRef.current !== selectedMeetingId) return
        const resolvedScope = selectDefaultResultScope(selectedMeetingId, scopeItems)
          ?? await resolveMeetingResultScope(selectedMeetingId, undefined, { signal: controller.signal })
        const scopes = scopeItems.length > 0
          ? scopeItems.map((item) => selectDefaultResultScope(selectedMeetingId, [item])!).filter(Boolean)
          : resolvedScope
            ? [resolvedScope]
            : []
        setAvailableScopes(scopes)
        setSelectedScope(resolvedScope)
        setScopeState('ready')
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error) || selectedMeetingIdRef.current !== selectedMeetingId) return
        setAvailableScopes([])
        setSelectedScope(null)
        setScopeState('error')
        setScopeError(error instanceof Error ? error.message : 'Không thể xác định phạm vi dữ liệu')
      }
    }

    void loadScopes()
    return () => controller.abort()
  }, [selectedMeetingId])

  useEffect(() => {
    if (selectedMeetingId === null) {
      detailAbortRef.current?.abort()
      detailRequestKeyRef.current = null
      setDetail(emptyDetailState)
      return
    }

    const meetingSummary = selectedMeetingSummary
    if (!meetingSummary || selectedScope == null || selectedScope.meetingId !== selectedMeetingId || scopeState !== 'ready') {
      if (scopeState === 'error') {
        setDetail({
          meeting: meetingSummary,
          transcriptSegments: [],
          transcriptState: 'error',
          transcriptError: scopeError ?? 'Không thể xác định phạm vi dữ liệu',
          analysis: null,
          analysisMetadata: null,
          analysisState: 'failed',
          analysisError: null,
        })
      }
      return
    }

    const cacheKey = scopeCacheKey(selectedScope)
    const cachedDetail = readDetailCache(cacheKey)
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
    const requestKey = cacheKey
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
        const transcriptOptions = { ...scopeToTranscriptOptions(selectedScope), signal: controller.signal }
        const [transcriptResponse, analysisResponse] = await Promise.all([
          getTranscript(selectedMeetingId, transcriptOptions),
          getSavedAnalysis(selectedMeetingId, { ...scopeToTranscriptOptions(selectedScope), signal: controller.signal }),
        ])
        if (controller.signal.aborted || detailRequestKeyRef.current !== requestKey) return

        const transcriptSegments = normalizePersistedTranscriptForView(transcriptResponse.transcripts || [])
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
          cacheKey,
          meetingId: selectedMeetingId,
          resultScope: selectedScope,
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
        if (controller.signal.aborted || isAbortError(error) || detailRequestKeyRef.current !== requestKey) return
        const message = error instanceof ApiError && error.status === 404
          ? 'Không tìm thấy transcript cho phiên ghi này'
          : error instanceof Error
            ? error.message
            : 'Không thể tải chi tiết meeting'

        setDetail({
          meeting: meetingSummary,
          transcriptSegments: [],
          transcriptState: 'error',
          transcriptError: message,
          analysis: null,
          analysisMetadata: null,
          analysisState: 'failed',
          analysisError: null,
        })
      }
    }

    void loadDetail()
    return () => controller.abort()
  }, [selectedMeetingSummary, selectedScope, scopeError, scopeState, selectedMeetingId])

  const handleRename = async () => {
    if (!selectedMeetingSummary) return
    const nextTitle = renameValue.trim()
    if (!nextTitle) {
      setListError('Tên meeting không được để trống')
      return
    }
    if (nextTitle === selectedMeetingSummary.title) return

    setRenameBusy(true)
    setListError(null)
    try {
      const renamed = await renameMeeting(selectedMeetingSummary.id, nextTitle)
      setMeetings((current) => current.map((meeting) => (meeting.id === renamed.id ? { ...meeting, ...renamed } : meeting)))
      setDetail((current) => current.meeting && current.meeting.id === renamed.id
        ? { ...current, meeting: { ...current.meeting, ...renamed } }
        : current)
      invalidateDetailCacheForMeeting(renamed.id)
      setRenameValue(renamed.title)
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'Không thể đổi tên meeting')
    } finally {
      setRenameBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!selectedMeetingSummary) return
    setDeleteBusy(true)
    setListError(null)
    try {
      await deleteMeeting(selectedMeetingSummary.id)
      invalidateDetailCacheForMeeting(selectedMeetingSummary.id)
      clearStoredMeetingId()
      setPinnedMeetingSummary(null)
      setSelectedMeetingId(null)
      setReloadTick((value) => value + 1)
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'Không thể xoá meeting')
    } finally {
      setDeleteBusy(false)
    }
  }

  const selectMeeting = (meetingId: number) => {
    setSelectedMeetingId(meetingId)
    writeStoredMeetingId(meetingId)
    const fromList = meetings.find((meeting) => meeting.id === meetingId)
    if (fromList) {
      setPinnedMeetingSummary(fromList)
    }
  }

  const goToPreviousListPage = () => {
    setListPage((current) => Math.max(1, current - 1))
  }

  const goToNextListPage = () => {
    setListPage((current) => (listTotalPages > 0 ? Math.min(listTotalPages, current + 1) : current))
  }

  return {
    isSearchControlled,
    searchQuery,
    setSearchQuery,
    statusFilter,
    setStatusFilter,
    languageFilter,
    setLanguageFilter,
    sortValue,
    setSortValue,
    listState,
    listError,
    meetings,
    listPage,
    listTotal,
    listTotalPages,
    goToPreviousListPage,
    goToNextListPage,
    selectedMeetingId,
    selectedMeetingSummary,
    selectMeeting,
    detail,
    renameValue,
    setRenameValue,
    renameBusy,
    deleteBusy,
    reload: () => setReloadTick((value) => value + 1),
    semanticResults,
    semanticState,
    availableScopes,
    selectedScope,
    setSelectedScope,
    scopeState,
    handleRename,
    handleDelete,
  }
}
