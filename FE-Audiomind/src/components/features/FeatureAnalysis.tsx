import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import { ApiError, getSavedAnalysis, getTranscript } from '../../services/api'
import { normalizeAnalysisResponse, type AiAnalysis } from '../../types'
import { answerMeetingQuestion, type MeetingChatCitation } from '../../utils/meetingChatbot'
import type { TimelineChapter } from '../../utils/timelineData'
import {
  highlightRangeFromTime,
  scrollTranscriptToHighlight,
  type TranscriptHighlightRange,
} from '../../utils/transcriptJump'
import { normalizePersistedTranscriptSegments } from '../../utils/transcript'
import { resolveMeetingResultScope } from '../../services/api'
import {
  scopeToAnalysisOptions,
  scopeToTranscriptOptions,
  scopeCacheKey,
  type MeetingResultScope,
} from '../../utils/meetingResultScope'
import AiAssistant from '../dashboard/AiAssistant'
import AnalysisTermNotesSection from './AnalysisTermNotesSection'
import MindmapView from '../mindmap/MindmapView'
import SpeakerNamingPanel from './SpeakerNamingPanel'
import TermExplainPopover from './TermExplainPopover'
import MeetingTimeline from './MeetingTimeline'
import MeetingTaskTracker from './MeetingTaskTracker'
import { TranscriptDisplay } from '../transcript/TranscriptDisplay'
import { listSpeakerProfiles, type SpeakerProfile } from '../../services/knowledgeLayer'
import { AnalysisPanel } from '../analysis/AnalysisPanel'
import { useTranscriptEvidenceNavigation } from '../../hooks/useTranscriptEvidenceNavigation'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'

type FeatureAnalysisProps = {
  meetingId?: number | null
  meetingTitle?: string
  fileName?: string
  busy?: boolean
  analysis?: AiAnalysis | null
  transcriptSegments?: TranscriptSegment[]
  transcriptText?: string
  statusLabel?: string
  hydrateFromApi?: boolean
  resultScope?: MeetingResultScope | null
  evidenceSegmentId?: string | null
  onBackToHistory?: () => void
  preferredDomainMode?: string
}

type HydrationState = 'idle' | 'loading' | 'ready' | 'error'
type AnalysisViewState = 'idle' | 'processing' | 'completed' | 'failed' | 'missing'
type AnalysisRightPanelKey = 'speaker' | 'tasks' | 'assistant'

const ANALYSIS_RIGHT_PANEL_STORAGE_KEY = 'audiomind.analysis.rightPanels.v2'

const isAbortError = (error: unknown): boolean => {
  return error instanceof DOMException && error.name === 'AbortError'
}

const getAnalysisStateFromResponse = (
  analysis: AiAnalysis | null,
): { state: AnalysisViewState; analysis: AiAnalysis | null; error: string | null } => {
  if (!analysis) {
    return { state: 'missing', analysis: null, error: null }
  }

  const status = String(analysis.analysisStatus ?? analysis.status ?? '').trim().toUpperCase()
  if (status === 'ANALYSIS_FAILED_RETRYABLE' || analysis.retryable === true) {
    const retryAfter = analysis.retryAfterSeconds && analysis.retryAfterSeconds > 0
      ? ` Thử lại sau ${analysis.retryAfterSeconds}s.`
      : ''
    const detail = analysis.errorCode ? ` (${analysis.errorCode})` : ''
    return {
      state: 'failed',
      analysis: null,
      error: `Phân tích AI tạm thời chưa sẵn sàng${detail}.${retryAfter}`,
    }
  }
  if (status === 'FAILED' || status === 'RATE_LIMITED' || status === 'QUOTA_BLOCKED') {
    const retryAfter = analysis.retryAfterSeconds && analysis.retryAfterSeconds > 0
      ? ` Thử lại sau ${analysis.retryAfterSeconds}s.`
      : ''
    const detail = analysis.errorCode ? ` ${analysis.errorCode}.` : ''
    return {
      state: 'failed',
      analysis: null,
      error: `Phân tích AI tạm thời thất bại. Có thể thử lại.${detail}${retryAfter}`,
    }
  }
  if (status === 'ANALYZING' || status === 'RUNNING' || status === 'QUEUED' || status === 'PENDING') {
    return { state: 'processing', analysis: null, error: null }
  }

  if (status === 'ANALYSIS_UNAVAILABLE_FOR_SCOPE') {
    return {
      state: 'missing',
      analysis: null,
      error: 'Kết quả phân tích chưa có cho phiên ghi này.',
    }
  }

  const hasStructuredData = hasStructuredAnalysisData(analysis)

  if (!hasStructuredData && (status === 'NOT_FOUND' || !status)) {
    return { state: 'missing', analysis: null, error: null }
  }

  return { state: 'completed', analysis, error: null }
}

const hasStructuredAnalysisData = (analysis: AiAnalysis | null): boolean => {
  if (!analysis) return false
  return Boolean(
    analysis.summary?.trim()
    || analysis.educationStudy
    || (analysis.keywords?.length ?? 0) > 0
    || (analysis.technicalTerms?.length ?? 0) > 0
    || (analysis.painPoints?.length ?? 0) > 0
    || (analysis.actionItems?.length ?? 0) > 0,
  )
}

const getFriendlyHydrateError = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return 'Không tìm thấy meeting hoặc transcript.'
    }
    if (error.status === 401 || error.status === 403) {
      return 'Bạn không có quyền xem meeting này.'
    }
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Không thể tải dữ liệu meeting.'
}

export default function FeatureAnalysis({
  meetingId,
  meetingTitle,
  fileName,
  busy,
  analysis,
  transcriptSegments = [],
  transcriptText = '',
  statusLabel,
  hydrateFromApi = false,
  resultScope = null,
  evidenceSegmentId = null,
  onBackToHistory,
}: FeatureAnalysisProps) {
  const [activeTab, setActiveTab] = useState<'content' | 'model' | 'mindmap'>('content')
  const [hydrateState, setHydrateState] = useState<HydrationState>('idle')
  const [hydrateError, setHydrateError] = useState<string | null>(null)
  const [hydratedAnalysis, setHydratedAnalysis] = useState<AiAnalysis | null>(null)
  const [hydratedTranscriptSegments, setHydratedTranscriptSegments] = useState<TranscriptSegment[]>([])
  const [hydratedTranscriptText, setHydratedTranscriptText] = useState('')
  const [hydrateAnalysisState, setHydrateAnalysisState] = useState<AnalysisViewState>('idle')
  const [hydrateAnalysisError, setHydrateAnalysisError] = useState<string | null>(null)
  const hydrateAbortRef = useRef<AbortController | null>(null)
  const hydrateRequestKeyRef = useRef<string | null>(null)
  const [activeTerm, setActiveTerm] = useState<string | null>(null)
  const [speakerDisplayMap, setSpeakerDisplayMap] = useState<Record<string, string>>({})
  const [highlightRange, setHighlightRange] = useState<TranscriptHighlightRange | null>(null)
  const [evidenceWarning, setEvidenceWarning] = useState<string | null>(null)
  const [savedAnalysis, setSavedAnalysis] = useState<AiAnalysis | null>(null)
  const savedAnalysisAbortRef = useRef<AbortController | null>(null)
  const [rightPanelsOpen, setRightPanelsOpen] = useState<Record<AnalysisRightPanelKey, boolean>>(() => {
    try {
      const raw = localStorage.getItem(ANALYSIS_RIGHT_PANEL_STORAGE_KEY)
      if (!raw) {
        return { speaker: false, tasks: true, assistant: true }
      }
      const parsed = JSON.parse(raw) as Partial<Record<AnalysisRightPanelKey, boolean>>
      return {
        speaker: parsed.speaker ?? false,
        tasks: parsed.tasks ?? true,
        assistant: parsed.assistant ?? true,
      }
    } catch {
      return { speaker: false, tasks: true, assistant: true }
    }
  })

  const toggleRightPanel = useCallback((panel: AnalysisRightPanelKey) => {
    setRightPanelsOpen((current) => {
      const next = { ...current, [panel]: !current[panel] }
      try {
        localStorage.setItem(ANALYSIS_RIGHT_PANEL_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // ignore localStorage errors
      }
      return next
    })
  }, [])

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
    if (meetingId == null) {
      setSpeakerDisplayMap({})
      return
    }
    void listSpeakerProfiles(meetingId)
      .then(applySpeakerProfiles)
      .catch(() => setSpeakerDisplayMap({}))
  }, [meetingId, applySpeakerProfiles])

  const handleTimelineJump = useCallback((chapter: TimelineChapter) => {
    const range = { startTime: chapter.startTime, endTime: chapter.endTime }
    setHighlightRange(range)
    scrollTranscriptToHighlight(range)
  }, [])

  const handleCitationClick = (citation: MeetingChatCitation) => {
    const range = highlightRangeFromTime(citation.startTime, citation.endTime)
    setHighlightRange(range)
    scrollTranscriptToHighlight(range)
  }

  useEffect(() => {
    if (!hydrateFromApi || meetingId == null) {
      return undefined
    }

    hydrateAbortRef.current?.abort()
    const controller = new AbortController()
    hydrateAbortRef.current = controller
    const requestKey = resultScope
      ? scopeCacheKey(resultScope)
      : `${meetingId}:auto`
    hydrateRequestKeyRef.current = requestKey

    setHydrateState('loading')
    setHydrateError(null)
    setHydratedAnalysis(null)
    setHydratedTranscriptSegments([])
    setHydratedTranscriptText('')
    setHydrateAnalysisState('idle')
    setHydrateAnalysisError(null)

    const load = async () => {
      try {
        const resolvedScope = resultScope
          ?? await resolveMeetingResultScope(meetingId, undefined, { signal: controller.signal })
        if (controller.signal.aborted || hydrateRequestKeyRef.current !== requestKey) {
          return
        }

        const analysisOptions = {
          ...scopeToAnalysisOptions(resolvedScope),
          signal: controller.signal,
        }
        const [transcriptResponse, analysisResponse] = await Promise.all([
          getTranscript(meetingId, {
            ...scopeToTranscriptOptions(resolvedScope),
            signal: controller.signal,
          }),
          getSavedAnalysis(meetingId, analysisOptions),
        ])

        if (controller.signal.aborted || hydrateRequestKeyRef.current !== requestKey) {
          return
        }

        // Keep canonical persisted segment identities for evidence resolution.
        // TranscriptDisplay performs its own visual grouping without changing
        // the navigation source segments.
        const segments = normalizePersistedTranscriptSegments(transcriptResponse.transcripts || [])
        const analysisState = getAnalysisStateFromResponse(analysisResponse)

        setHydratedTranscriptSegments(segments)
        setHydratedTranscriptText(
          segments.map((segment) => `${segment.speaker}: ${segment.text}`).join(' ').trim(),
        )
        setHydratedAnalysis(analysisState.analysis)
        setHydrateAnalysisState(analysisState.state)
        setHydrateAnalysisError(analysisState.error)
        setHydrateState('ready')
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error) || hydrateRequestKeyRef.current !== requestKey) {
          return
        }
        if (error instanceof ApiError && error.status === 404) {
          setHydrateState('error')
          setHydrateError('Không tìm thấy transcript cho phiên ghi đã chọn')
          return
        }
        setHydrateState('error')
        setHydrateError(getFriendlyHydrateError(error))
      }
    }

    void load()

    return () => {
      controller.abort()
    }
  }, [hydrateFromApi, meetingId, resultScope])

  const loadSavedAnalysis = useCallback(async (
    requestMeetingId: number,
    scope: MeetingResultScope | null,
  ) => {
    savedAnalysisAbortRef.current?.abort()
    const controller = new AbortController()
    savedAnalysisAbortRef.current = controller
    try {
      const resolvedScope = scope
        ?? await resolveMeetingResultScope(requestMeetingId, undefined, { signal: controller.signal })
      const response = await getSavedAnalysis(requestMeetingId, {
        ...scopeToAnalysisOptions(resolvedScope),
        signal: controller.signal,
      })
      if (!controller.signal.aborted) {
        setSavedAnalysis(response)
      }
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) {
        setSavedAnalysis(null)
      }
    }
  }, [])

  useEffect(() => {
    if (meetingId == null) {
      setSavedAnalysis(null)
      return undefined
    }
    void loadSavedAnalysis(meetingId, resultScope)
    return () => {
      savedAnalysisAbortRef.current?.abort()
    }
  }, [loadSavedAnalysis, meetingId, resultScope])

  useEffect(() => {
    if ((activeTab === 'mindmap' || activeTab === 'model') && meetingId != null) {
      void loadSavedAnalysis(meetingId, resultScope)
    }
  }, [activeTab, loadSavedAnalysis, meetingId, resultScope])

  const effectiveAnalysis = hydrateFromApi ? hydratedAnalysis : (analysis ?? null)
  const effectiveSegments = useMemo(
    () => (hydrateFromApi ? hydratedTranscriptSegments : (transcriptSegments ?? [])),
    [hydrateFromApi, hydratedTranscriptSegments, transcriptSegments],
  )
  const effectiveTranscriptText = hydrateFromApi ? hydratedTranscriptText : (transcriptText ?? '')
  const { navigateToSegment } = useTranscriptEvidenceNavigation({
    segments: effectiveSegments,
    meetingId,
    onHighlightChange: setHighlightRange,
    onNavigateSuccess: () => {
      setEvidenceWarning(null)
      setActiveTab('content')
    },
    onMissingSegment: () => {
      setEvidenceWarning('Không tìm thấy đoạn transcript tương ứng với bằng chứng này.')
    },
  })

  const appliedEvidenceRef = useRef<string | null>(null)
  useEffect(() => {
    const target = evidenceSegmentId?.trim()
    if (!target || effectiveSegments.length === 0) {
      return
    }
    const key = `${meetingId ?? 'none'}:${target}`
    if (appliedEvidenceRef.current === key) {
      return
    }
    appliedEvidenceRef.current = key
    navigateToSegment([target])
  }, [evidenceSegmentId, effectiveSegments, meetingId, navigateToSegment])

  const effectiveBusy = hydrateFromApi
    ? hydrateState === 'loading' || hydrateAnalysisState === 'processing'
    : Boolean(busy)

  const normalizedAnalysis = useMemo(
    () => (effectiveAnalysis ? normalizeAnalysisResponse(effectiveAnalysis) : null),
    [effectiveAnalysis],
  )
  const displayAnalysis = useMemo(() => {
    const fromSaved = savedAnalysis ? normalizeAnalysisResponse(savedAnalysis) : null
    if (fromSaved && hasStructuredAnalysisData(fromSaved)) {
      return fromSaved
    }
    if (normalizedAnalysis && hasStructuredAnalysisData(normalizedAnalysis)) {
      return normalizedAnalysis
    }
    return fromSaved ?? normalizedAnalysis
  }, [normalizedAnalysis, savedAnalysis])
  const title = meetingTitle || fileName || 'Kết quả phân tích'
  const hasTranscript = effectiveSegments.length > 0 || effectiveTranscriptText.trim().length > 0

  const statusBadge = useMemo(() => {
    if (!statusLabel) return null
    return <span className="meta-pill analysis-meta-pill">{statusLabel}</span>
  }, [statusLabel])

  const analysisPanelStatus = useMemo(() => {
    if (effectiveBusy) {
      return 'loading' as const
    }
    if (displayAnalysis && hasStructuredAnalysisData(displayAnalysis)) {
      return 'ready' as const
    }
    return 'empty' as const
  }, [displayAnalysis, effectiveBusy])

  const analysisEmptyMessage = hydrateFromApi && hydrateAnalysisState === 'missing'
    ? 'Phân tích AI chưa sẵn sàng'
    : 'Chưa có kết quả phân tích'

  if (hydrateFromApi && hydrateState === 'loading') {
    return (
      <div className="dashboard-page feature-analysis-page bg-gray-light" data-testid="feature-analysis-hydrating">
        <header className="analysis-page-header">
          <div className="breadcrumbs">
            <button
              type="button"
              className="back-btn"
              aria-label="Quay lại"
              data-testid="feature-analysis-back"
              onClick={() => onBackToHistory?.()}
            >
              ←
            </button>
            <span>{title}</span>
            {meetingId && <span className="meta-pill">ID {meetingId}</span>}
          </div>
        </header>
        <LoadingState message="Đang tải transcript và phân tích đã lưu..." />
      </div>
    )
  }

  if (hydrateFromApi && hydrateState === 'error') {
    return (
      <div className="dashboard-page feature-analysis-page bg-gray-light" data-testid="feature-analysis-hydrate-error">
        <header className="analysis-page-header">
          <div className="breadcrumbs">
            <button
              type="button"
              className="back-btn"
              aria-label="Quay lại"
              data-testid="feature-analysis-back"
              onClick={() => onBackToHistory?.()}
            >
              ←
            </button>
            <span>{title}</span>
            {meetingId && <span className="meta-pill">ID {meetingId}</span>}
          </div>
        </header>
        <ErrorState title="Không thể mở kết quả phân tích" message={hydrateError || 'Không thể tải dữ liệu meeting'} />
      </div>
    )
  }

  return (
    <div className="dashboard-page feature-analysis-page bg-gray-light">
      <header className="analysis-page-header">
        <div className="breadcrumbs">
          <button
            type="button"
            className="back-btn"
            aria-label="Quay lại"
            data-testid="feature-analysis-back"
            onClick={() => onBackToHistory?.()}
          >
            ←
          </button>
          <span>{title}</span>
          {meetingId && <span className="meta-pill">ID {meetingId}</span>}
          {statusBadge}
        </div>
      </header>

      <div className="analysis-main-content">
        <div className="analysis-left-panel">
          <div className="analysis-tabs">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'content' ? 'active' : ''}`}
              onClick={() => setActiveTab('content')}
            >
              Bản ghi
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'model' ? 'active' : ''}`}
              onClick={() => setActiveTab('model')}
              data-testid="feature-analysis-model-tab"
            >
              Phân tích AI
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'mindmap' ? 'active' : ''}`}
              onClick={() => setActiveTab('mindmap')}
              data-testid="feature-analysis-mindmap-tab"
            >
              Sơ đồ
            </button>
          </div>

          <div className="doc-content">
            {activeTab === 'mindmap' && (
              <div className="analysis-mindmap-tab" data-testid="feature-analysis-mindmap">
                <MindmapView
                  analysis={displayAnalysis}
                  meetingId={meetingId}
                  meetingTitle={meetingTitle}
                  compact
                  onRefresh={meetingId != null ? () => loadSavedAnalysis(meetingId, resultScope) : undefined}
                />
              </div>
            )}

            {activeTab === 'content' && (
              <div data-testid="e2e-transcript">
                {hasTranscript ? (
                  <>
                    <TranscriptDisplay
                      segments={effectiveSegments}
                      transcriptTextFallback={effectiveTranscriptText}
                      emptyMessage="Không có transcript"
                      maxHeight="none"
                      enableDisplayGrouping
                      domainMode={displayAnalysis?.domainMode ?? effectiveAnalysis?.domainMode}
                      onTermClick={meetingId ? (term) => setActiveTerm(term) : undefined}
                      speakerDisplayMap={speakerDisplayMap}
                      highlightRange={highlightRange}
                    />
                    <MeetingTimeline
                      segments={effectiveSegments}
                      analysis={displayAnalysis}
                      onJumpToChapter={handleTimelineJump}
                    />
                  </>
                ) : (
                  <p className="analysis-empty-hint">
                    {effectiveBusy
                      ? 'Đang xử lý transcript...'
                      : 'Chưa có transcript. Hãy tải file và phân tích từ màn Tải & phân tích.'}
                  </p>
                )}
              </div>
            )}

            {activeTab === 'model' && (
              <div className="analysis-inline-panel" data-testid="feature-analysis-model">
                {hydrateFromApi && hydrateAnalysisState === 'processing' && (
                  <LoadingState message="Phân tích AI đang xử lý..." />
                )}
                {hydrateFromApi && hydrateAnalysisState === 'failed' && (
                  <ErrorState
                    title="Phân tích không sẵn sàng"
                    message={hydrateAnalysisError || 'Không thể tải phân tích đã lưu'}
                  />
                )}
                <AnalysisPanel
                  title="Phân tích AI"
                  analysis={displayAnalysis}
                  status={analysisPanelStatus}
                  testId="e2e-analysis"
                  summaryTestId="e2e-summary"
                  summaryFallback="(trống)"
                  loadingMessage="Đang phân tích nội dung..."
                  emptyMessage={analysisEmptyMessage}
                  onEvidenceClick={navigateToSegment}
                />
                {evidenceWarning ? (
                  <p className="ui-status-strip" role="status">{evidenceWarning}</p>
                ) : null}
                <AnalysisTermNotesSection
                  meetingId={meetingId}
                  analysis={displayAnalysis}
                />
              </div>
            )}
          </div>
        </div>

        <div className="analysis-right-panel">
          <section className="analysis-collapsible-panel">
            <button type="button" className="analysis-collapsible-panel__toggle" onClick={() => toggleRightPanel('speaker')}>
              <span>Người nói</span>
              <span>{rightPanelsOpen.speaker ? '−' : '+'}</span>
            </button>
            {rightPanelsOpen.speaker && (
              <SpeakerNamingPanel
                meetingId={meetingId}
                transcriptSegments={effectiveSegments}
                onProfilesSaved={applySpeakerProfiles}
              />
            )}
          </section>
          <section className="analysis-collapsible-panel">
            <button type="button" className="analysis-collapsible-panel__toggle" onClick={() => toggleRightPanel('tasks')}>
              <span>Công việc</span>
              <span>{rightPanelsOpen.tasks ? '−' : '+'}</span>
            </button>
            {rightPanelsOpen.tasks && (
              <MeetingTaskTracker
                meetingId={meetingId}
                groupedActionPlan={displayAnalysis?.groupedActionPlan}
              />
            )}
          </section>
          <section className="analysis-collapsible-panel">
            <button type="button" className="analysis-collapsible-panel__toggle" onClick={() => toggleRightPanel('assistant')}>
              <span>Trợ lý AI</span>
              <span>{rightPanelsOpen.assistant ? '−' : '+'}</span>
            </button>
            {rightPanelsOpen.assistant && (
              <AiAssistant
                busy={effectiveBusy}
                meetingId={meetingId}
                onCitationClick={handleCitationClick}
                onAsk={async (message) => {
                  const result = await answerMeetingQuestion(meetingId, message, displayAnalysis)
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
          </section>
        </div>
      </div>
      {meetingId != null && activeTerm && (
        <TermExplainPopover
          meetingId={meetingId}
          term={activeTerm}
          analysis={displayAnalysis}
          onClose={() => setActiveTerm(null)}
        />
      )}
    </div>
  )
}
