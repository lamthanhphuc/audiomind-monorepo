import { useEffect, useMemo, useState } from 'react'
import { AnalysisPanel } from '../analysis/AnalysisPanel'
import { TranscriptDisplay } from '../transcript/TranscriptDisplay'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
import { getMeetingDetail, getSavedAnalysis, getTranscript, listMeetings } from '../../services/api'
import type { AiAnalysis, Meeting } from '../../types'
import { mergeTranscriptSegments, normalizePersistedTranscriptSegments } from '../../utils/transcript'

type DetailAnalysisState = 'idle' | 'processing' | 'completed' | 'failed' | 'missing'
type ListState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

type SelectedMeetingDetail = {
  meeting: Meeting | null
  transcriptSegments: ReturnType<typeof mergeTranscriptSegments>
  transcriptState: 'loading' | 'ready' | 'empty' | 'error'
  transcriptError: string | null
  analysis: AiAnalysis | null
  analysisState: DetailAnalysisState
  analysisError: string | null
}

const emptyDetailState: SelectedMeetingDetail = {
  meeting: null,
  transcriptSegments: [],
  transcriptState: 'loading',
  transcriptError: null,
  analysis: null,
  analysisState: 'idle',
  analysisError: null,
}

const getMeetingLabel = (meeting: Meeting): string => {
  return meeting.originalFileName?.trim() || meeting.title || `Meeting #${meeting.id}`
}

const getAnalysisStateFromResponse = (analysis: AiAnalysis | null): { state: DetailAnalysisState; analysis: AiAnalysis | null; error: string | null } => {
  if (!analysis) {
    return { state: 'missing', analysis: null, error: null }
  }

  const status = String(analysis.status ?? '').trim().toUpperCase()
  if (status === 'FAILED') {
    return { state: 'failed', analysis: null, error: 'Không thể tải phân tích đã lưu' }
  }
  if (status === 'RUNNING' || status === 'QUEUED' || status === 'PENDING') {
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

export default function MeetingHistoryScene() {
  const [listState, setListState] = useState<ListState>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [selectedMeetingId, setSelectedMeetingId] = useState<number | null>(null)
  const [detail, setDetail] = useState<SelectedMeetingDetail>(emptyDetailState)

  const selectedMeetingSummary = useMemo(() => {
    return meetings.find((meeting) => meeting.id === selectedMeetingId) ?? null
  }, [meetings, selectedMeetingId])

  useEffect(() => {
    let cancelled = false

    const loadHistory = async () => {
      setListState('loading')
      setListError(null)

      try {
        const items = await listMeetings()
        if (cancelled) {
          return
        }

        setMeetings(items)
        setListState(items.length > 0 ? 'ready' : 'empty')
        setSelectedMeetingId((current) => current ?? items[0]?.id ?? null)
      } catch (error) {
        if (cancelled) {
          return
        }

        setMeetings([])
        setListState('error')
        setListError(error instanceof Error ? error.message : 'Không thể tải lịch sử meeting')
      }
    }

    void loadHistory()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (selectedMeetingId === null) {
      setDetail(emptyDetailState)
      return
    }

    let cancelled = false

    const loadDetail = async () => {
      setDetail({
        meeting: null,
        transcriptSegments: [],
        transcriptState: 'loading',
        transcriptError: null,
        analysis: null,
        analysisState: 'idle',
        analysisError: null,
      })

      try {
        const [meeting, transcriptResponse, analysisResponse] = await Promise.all([
          getMeetingDetail(selectedMeetingId),
          getTranscript(selectedMeetingId),
          getSavedAnalysis(selectedMeetingId),
        ])

        if (cancelled) {
          return
        }

        const transcriptSegments = mergeTranscriptSegments(
          normalizePersistedTranscriptSegments(transcriptResponse.transcripts || []),
        )
        const transcriptState: SelectedMeetingDetail['transcriptState'] = transcriptSegments.length > 0 ? 'ready' : 'empty'
        const analysisState = getAnalysisStateFromResponse(analysisResponse)

        setDetail({
          meeting,
          transcriptSegments,
          transcriptState,
          transcriptError: null,
          analysis: analysisState.analysis,
          analysisState: analysisState.state,
          analysisError: analysisState.error,
        })
      } catch (error) {
        if (cancelled) {
          return
        }

        setDetail({
          meeting: null,
          transcriptSegments: [],
          transcriptState: 'error',
          transcriptError: error instanceof Error ? error.message : 'Không thể tải chi tiết meeting',
          analysis: null,
          analysisState: 'failed',
          analysisError: null,
        })
      }
    }

    void loadDetail()

    return () => {
      cancelled = true
    }
  }, [selectedMeetingId])

  const meetingCards = meetings.map((meeting) => ({
    id: meeting.id,
    title: getMeetingLabel(meeting),
    createdAt: meeting.createdAt,
    language: meeting.language || 'vi',
    active: meeting.id === selectedMeetingId,
  }))

  return (
    <div className="dashboard-page bg-gray-light">
      <header className="dashboard-header border-b">
        <div className="search-bar">
          <span className="icon">🔍</span>
          <input type="text" placeholder="Tìm meeting cũ, transcript, ghi chú..." readOnly />
        </div>
        <div className="header-actions">
          <button type="button" className="icon-btn" aria-label="Thông báo">🔔</button>
        </div>
      </header>

      <div className="history-scene" style={{ display: 'grid', gridTemplateColumns: '320px minmax(0, 1fr)', gap: '20px', padding: '24px', minHeight: 'calc(100vh - 72px)' }}>
        <section className="history-list-card" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '18px', padding: '20px', boxShadow: '0 12px 40px rgba(15, 23, 42, 0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
            <div>
              <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700, color: '#0f172a' }}>Meeting history</h1>
              <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: '14px' }}>Mở transcript và analysis đã lưu.</p>
            </div>
            <span className="meta-pill">{meetings.length}</span>
          </div>

          {listState === 'loading' && <LoadingState message="Đang tải danh sách meeting..." />}
          {listState === 'error' && <ErrorState title="Không thể tải lịch sử" message={listError || 'Không thể tải lịch sử meeting'} />}
          {listState === 'empty' && <EmptyState message="Chưa có meeting nào được lưu" />}

          {listState === 'ready' && (
            <div style={{ display: 'grid', gap: '10px' }}>
              {meetingCards.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedMeetingId(item.id)}
                  style={{
                    textAlign: 'left',
                    border: item.active ? '1px solid #3b82f6' : '1px solid #e5e7eb',
                    background: item.active ? '#eff6ff' : '#fff',
                    borderRadius: '14px',
                    padding: '14px 16px',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <strong style={{ fontSize: '15px', color: '#0f172a' }}>{item.title}</strong>
                    <span className="meta-pill">#{item.id}</span>
                  </div>
                  <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '8px', color: '#475569', fontSize: '12px' }}>
                    <span>{item.createdAt || 'Unknown date'}</span>
                    <span>•</span>
                    <span>{item.language}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="history-detail-card" style={{ display: 'grid', gap: '20px' }}>
          {selectedMeetingSummary ? (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '18px', padding: '20px', boxShadow: '0 12px 40px rgba(15, 23, 42, 0.05)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 700, color: '#0f172a' }}>{selectedMeetingSummary.title}</h2>
                  <div style={{ marginTop: '6px', color: '#64748b', fontSize: '13px' }}>
                    ID {selectedMeetingSummary.id} • {selectedMeetingSummary.language || 'vi'} • {selectedMeetingSummary.createdAt || 'Unknown date'}
                  </div>
                </div>
                <span className="meta-pill">Read-only</span>
              </div>

              <div style={{ display: 'grid', gap: '16px' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '10px' }}>
                    <h3 style={{ margin: 0, fontSize: '16px', color: '#0f172a' }}>Transcript</h3>
                    <span className="meta-pill">{detail.transcriptState}</span>
                  </div>
                  {detail.transcriptState === 'loading' && <LoadingState message="Đang tải transcript đã lưu..." />}
                  {detail.transcriptState === 'error' && <ErrorState title="Không thể tải transcript" message={detail.transcriptError || 'Không thể tải transcript'} />}
                  {detail.transcriptState === 'empty' && <EmptyState message="Không có transcript đã lưu" />}
                  {detail.transcriptState === 'ready' && (
                    <TranscriptDisplay
                      segments={detail.transcriptSegments}
                      emptyMessage="Không có transcript đã lưu"
                      maxHeight="460px"
                      enableDisplayGrouping
                    />
                  )}
                </div>

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '10px' }}>
                    <h3 style={{ margin: 0, fontSize: '16px', color: '#0f172a' }}>Analysis</h3>
                    <span className="meta-pill">{detail.analysisState}</span>
                  </div>
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
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '18px', padding: '24px', boxShadow: '0 12px 40px rgba(15, 23, 42, 0.05)' }}>
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