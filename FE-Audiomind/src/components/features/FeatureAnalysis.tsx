import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import { ApiError, getSavedAnalysis, getTranscript, reanalyzeMeetingAnalysis } from '../../services/api'
import { normalizeAnalysisResponse, type AiAnalysis } from '../../types'
import { normalizePersistedTranscriptForView } from '../../utils/transcript'
import { AnalysisPanel } from '../analysis/AnalysisPanel'
import { AnalysisStatusPanel, normalizeAnalysisMetadata } from '../analysis/AnalysisStatusPanel'
import AiAssistant from '../dashboard/AiAssistant'
import { TranscriptDisplay } from '../transcript/TranscriptDisplay'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
import { StudioWaveform } from '../ui/StudioWaveform'

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
  onBackToHistory?: () => void
}

type HydrationState = 'idle' | 'loading' | 'ready' | 'error'
type AnalysisViewState = 'idle' | 'processing' | 'completed' | 'failed' | 'missing'

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
      ? ` Retry after ${analysis.retryAfterSeconds}s.`
      : ''
    const detail = analysis.errorCode ? ` ${analysis.errorCode}.` : ''
    return {
      state: 'failed',
      analysis: null,
      error: `Analysis failed temporarily. Retry available.${detail}${retryAfter}`,
    }
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

const isTerminalAnalysisStatus = (analysis: AiAnalysis | null): boolean => {
  const status = normalizeAnalysisMetadata(analysis).status
  return status === 'COMPLETED'
    || status === 'FAILED'
    || status === 'RATE_LIMITED'
    || status === 'QUOTA_BLOCKED'
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

const getReanalyzeErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError && error.status === 404) {
    return 'Không tìm thấy transcript đã lưu để phân tích lại.'
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Không thể phân tích lại meeting.'
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
  const [hydrateAnalysisMetadata, setHydrateAnalysisMetadata] = useState<AiAnalysis | null>(null)
  const [reanalyzeBusy, setReanalyzeBusy] = useState(false)
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null)
  const hydrateAbortRef = useRef<AbortController | null>(null)
  const hydrateRequestKeyRef = useRef<number | null>(null)
  const rerunPollRef = useRef<{ meetingId: number; cancelled: boolean; timeoutId: number | null } | null>(null)

  const applyHydratedAnalysis = useCallback((requestKey: number, analysisResponse: AiAnalysis | null) => {
    if (hydrateRequestKeyRef.current !== requestKey) {
      return
    }
    const nextState = getAnalysisStateFromResponse(analysisResponse)
    setHydratedAnalysis(nextState.analysis)
    setHydrateAnalysisMetadata(analysisResponse)
    setHydrateAnalysisState(nextState.state)
    setHydrateAnalysisError(nextState.error)
  }, [])

  useEffect(() => {
    if (!hydrateFromApi || meetingId == null) {
      return undefined
    }

    hydrateAbortRef.current?.abort()
    const controller = new AbortController()
    hydrateAbortRef.current = controller
    const requestKey = meetingId
    hydrateRequestKeyRef.current = requestKey

    setHydrateState('loading')
    setHydrateError(null)
    setHydratedAnalysis(null)
    setHydratedTranscriptSegments([])
    setHydratedTranscriptText('')
    setHydrateAnalysisState('idle')
    setHydrateAnalysisError(null)
    setHydrateAnalysisMetadata(null)
    setReanalyzeBusy(false)
    setReanalyzeError(null)

    const load = async () => {
      try {
        const [transcriptResponse, analysisResponse] = await Promise.all([
          getTranscript(requestKey, { signal: controller.signal }),
          getSavedAnalysis(requestKey, { signal: controller.signal }),
        ])

        if (controller.signal.aborted || hydrateRequestKeyRef.current !== requestKey) {
          return
        }

        const segments = normalizePersistedTranscriptForView(transcriptResponse.transcripts || [])
        const analysisState = getAnalysisStateFromResponse(analysisResponse)

        setHydratedTranscriptSegments(segments)
        setHydratedTranscriptText(
          segments.map((segment) => `${segment.speaker}: ${segment.text}`).join(' ').trim(),
        )
        setHydratedAnalysis(analysisState.analysis)
        setHydrateAnalysisMetadata(analysisResponse)
        setHydrateAnalysisState(analysisState.state)
        setHydrateAnalysisError(analysisState.error)
        setHydrateState('ready')
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error) || hydrateRequestKeyRef.current !== requestKey) {
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
  }, [hydrateFromApi, meetingId])

  useEffect(() => {
    return () => {
      if (rerunPollRef.current) {
        rerunPollRef.current.cancelled = true
        if (rerunPollRef.current.timeoutId !== null) {
          window.clearTimeout(rerunPollRef.current.timeoutId)
        }
      }
    }
  }, [])

  const pollSavedAnalysis = async (
    requestKey: number,
    pollState: { meetingId: number; cancelled: boolean; timeoutId: number | null },
  ) => {
    while (!pollState.cancelled) {
      await new Promise<void>((resolve) => {
        pollState.timeoutId = window.setTimeout(resolve, 1500)
      })
      pollState.timeoutId = null
      if (pollState.cancelled || hydrateRequestKeyRef.current !== requestKey) {
        return
      }

      try {
        const savedAnalysis = await getSavedAnalysis(requestKey)
        if (pollState.cancelled || hydrateRequestKeyRef.current !== requestKey) {
          return
        }
        applyHydratedAnalysis(requestKey, savedAnalysis)
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
    if (!hydrateFromApi || meetingId == null) {
      return
    }

    const requestKey = meetingId
    const previousAnalysis = hydratedAnalysis
    const previousAnalysisMetadata = hydrateAnalysisMetadata
    const previousAnalysisState = hydrateAnalysisState
    const previousAnalysisError = hydrateAnalysisError

    if (rerunPollRef.current) {
      rerunPollRef.current.cancelled = true
      if (rerunPollRef.current.timeoutId !== null) {
        window.clearTimeout(rerunPollRef.current.timeoutId)
      }
    }

    const pollState = { meetingId: requestKey, cancelled: false, timeoutId: null as number | null }
    rerunPollRef.current = pollState
    setReanalyzeBusy(true)
    setReanalyzeError(null)
    setHydrateAnalysisMetadata({
      ...(hydrateAnalysisMetadata ?? hydratedAnalysis ?? baseAnalysisMetadata(requestKey)),
      status: 'ANALYZING',
      analysisStatus: 'ANALYZING',
    })
    setHydrateAnalysisState(hydratedAnalysis ? 'completed' : 'processing')
    setHydrateAnalysisError(null)

    try {
      const response = await reanalyzeMeetingAnalysis(requestKey, { mode: 'force', reason: 'manual_reanalyze' })
      if (pollState.cancelled || hydrateRequestKeyRef.current !== requestKey) {
        return
      }
      applyHydratedAnalysis(requestKey, response)
      if (isTerminalAnalysisStatus(response)) {
        setReanalyzeBusy(false)
        return
      }
      void pollSavedAnalysis(requestKey, pollState)
    } catch (error) {
      if (pollState.cancelled || hydrateRequestKeyRef.current !== requestKey) {
        return
      }
      pollState.cancelled = true
      if (pollState.timeoutId !== null) {
        window.clearTimeout(pollState.timeoutId)
        pollState.timeoutId = null
      }
      setHydratedAnalysis(previousAnalysis)
      setHydrateAnalysisMetadata(previousAnalysisMetadata)
      setHydrateAnalysisState(previousAnalysis ? 'completed' : previousAnalysisState)
      setHydrateAnalysisError(previousAnalysisError)
      setReanalyzeError(getReanalyzeErrorMessage(error))
      setReanalyzeBusy(false)
    }
  }

  const effectiveAnalysis = hydrateFromApi ? hydratedAnalysis : (analysis ?? null)
  const effectiveSegments = hydrateFromApi ? hydratedTranscriptSegments : transcriptSegments
  const effectiveTranscriptText = hydrateFromApi ? hydratedTranscriptText : transcriptText
  const effectiveBusy = hydrateFromApi
    ? hydrateState === 'loading' || reanalyzeBusy || hydrateAnalysisState === 'processing'
    : Boolean(busy)

  const normalizedAnalysis = useMemo(
    () => (effectiveAnalysis ? normalizeAnalysisResponse(effectiveAnalysis) : null),
    [effectiveAnalysis],
  )
  const title = meetingTitle || fileName || 'Kết quả phân tích'
  const audioLabel = fileName || meetingTitle || 'audio-file.mp3'
  const hasTranscript = effectiveSegments.length > 0 || effectiveTranscriptText.trim().length > 0

  const statusBadge = useMemo(() => {
    if (!statusLabel) return null
    return <span className="meta-pill analysis-meta-pill">{statusLabel}</span>
  }, [statusLabel])

  const analysisPanelStatus = useMemo(() => {
    if (effectiveBusy) {
      return 'loading' as const
    }
    if (normalizedAnalysis) {
      return 'ready' as const
    }
    return 'empty' as const
  }, [effectiveBusy, normalizedAnalysis])

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
        <div className="header-actions">
          <button type="button" className="secondary-cta" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>⬇</span> Tải slide
          </button>
        </div>
      </header>

      <div className="analysis-main-content">
        <div className="analysis-left-panel">
          <div className="audio-player-card studio-reveal studio-reveal--delay-1">
            <StudioWaveform className="studio-waveform--lg" bars={36} active={!effectiveBusy} />
            <div className="audio-controls">
              <button type="button" className="play-btn" aria-label="Phát">▶</button>
              <div className="time-info">
                <span className="time-title">{audioLabel}</span>
                <span className="time-duration">—</span>
              </div>
              <div className="audio-options">
                <button type="button" aria-label="Âm lượng">🔊</button>
                <select aria-label="Tốc độ phát"><option>1x</option></select>
                <button type="button" aria-label="Cài đặt">⚙</button>
              </div>
            </div>
          </div>

          <div className="analysis-tabs">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'content' ? 'active' : ''}`}
              onClick={() => setActiveTab('content')}
            >
              Transcript
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'model' ? 'active' : ''}`}
              onClick={() => setActiveTab('model')}
            >
              Phân tích AI
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'mindmap' ? 'active' : ''}`}
              onClick={() => setActiveTab('mindmap')}
            >
              Mindmap
            </button>
          </div>

          <div className="doc-content">
            {activeTab === 'mindmap' && (
              <div className="mindmap-placeholder">
                <p>Sơ đồ mindmap sẽ hiển thị khi có dữ liệu từ phân tích.</p>
              </div>
            )}

            {activeTab === 'content' && (
              <div data-testid="e2e-transcript">
                {hasTranscript ? (
                  <TranscriptDisplay
                    segments={effectiveSegments}
                    transcriptTextFallback={effectiveTranscriptText}
                    emptyMessage="Không có transcript"
                    maxHeight="none"
                    enableDisplayGrouping
                  />
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
              <div className="analysis-inline-panel">
                {hydrateFromApi && (
                  <div data-testid="feature-analysis-hydrated-controls">
                    <AnalysisStatusPanel
                      metadata={hydrateAnalysisMetadata ?? hydratedAnalysis}
                      busy={reanalyzeBusy}
                      error={reanalyzeError}
                      onReanalyze={() => void handleReanalyze()}
                    />
                    {hydrateAnalysisState === 'processing' && (
                      <LoadingState message="Phân tích AI đang xử lý..." />
                    )}
                    {hydrateAnalysisState === 'failed' && (
                      <ErrorState
                        title="Phân tích không sẵn sàng"
                        message={hydrateAnalysisError || 'Không thể tải phân tích đã lưu'}
                      />
                    )}
                    {hydrateAnalysisState === 'missing' && !normalizedAnalysis && (
                      <EmptyState message="Chưa có kết quả phân tích" />
                    )}
                  </div>
                )}
                <AnalysisPanel
                  title="Phân tích AI"
                  analysis={normalizedAnalysis}
                  status={analysisPanelStatus}
                  testId="e2e-analysis"
                  summaryTestId="e2e-summary"
                  summaryFallback="(empty)"
                  loadingMessage="Đang phân tích nội dung..."
                  emptyMessage={analysisEmptyMessage}
                />
              </div>
            )}
          </div>
        </div>

        <div className="analysis-right-panel">
          <AnalysisPanel
            title="Tóm tắt"
            analysis={normalizedAnalysis}
            status={analysisPanelStatus}
            summaryTestId="e2e-summary"
            summaryFallback="(empty)"
            emptyMessage={analysisEmptyMessage}
          />
          <AiAssistant
            busy={effectiveBusy}
            meetingId={meetingId}
            onAsk={async () => {
              await new Promise((resolve) => window.setTimeout(resolve, 600))
              return normalizedAnalysis?.summary
                ? `Tóm tắt: ${normalizedAnalysis.summary}`
                : 'Chưa có dữ liệu phân tích để trả lời câu hỏi.'
            }}
          />
        </div>
      </div>
    </div>
  )
}
