import { useEffect, useMemo, useState } from 'react'
import {
  deleteMeeting,
  getMeetingDetail,
  getSavedAnalysis,
  getTranscript,
  listMeetingsWithParams,
  renameMeeting,
} from '../../services/api'
import type { AiAnalysis, Meeting } from '../../types'
import { mergeTranscriptSegments, normalizePersistedTranscriptSegments } from '../../utils/transcript'
import { AnalysisPanel } from '../analysis/AnalysisPanel'
import { TranscriptDisplay } from '../transcript/TranscriptDisplay'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'

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
  return meeting.title?.trim() || meeting.originalFileName?.trim() || `Meeting #${meeting.id}`
}

const getMeetingLanguage = (meeting: Meeting): string => {
  return String(meeting.language ?? 'vi').trim().toLowerCase() || 'vi'
}

const getMeetingStatus = (meeting: Meeting): string => {
  return String(meeting.status ?? 'processing').trim().toLowerCase() || 'processing'
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
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [languageFilter, setLanguageFilter] = useState('')
  const [sortValue, setSortValue] = useState('created_desc')
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)

  const selectedMeetingSummary = useMemo(() => {
    return meetings.find((meeting) => meeting.id === selectedMeetingId) ?? null
  }, [meetings, selectedMeetingId])

  useEffect(() => {
    setRenameValue(selectedMeetingSummary?.title ?? '')
  }, [selectedMeetingSummary?.id, selectedMeetingSummary?.title])

  useEffect(() => {
    let cancelled = false

    const loadHistory = async () => {
      setListState('loading')
      setListError(null)

      try {
        const items = await listMeetingsWithParams({
          query: searchQuery,
          status: statusFilter || undefined,
          language: languageFilter || undefined,
          sort: sortValue,
        })
        if (cancelled) {
          return
        }

        setMeetings(items)
        setListState(items.length > 0 ? 'ready' : 'empty')
        setSelectedMeetingId((current) => {
          if (current !== null && items.some((meeting) => meeting.id === current)) {
            return current
          }
          return items[0]?.id ?? null
        })
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
  }, [languageFilter, reloadTick, searchQuery, sortValue, statusFilter])

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
      setMeetings((current) => {
        const next = current.filter((meeting) => meeting.id !== selectedMeetingSummary.id)
        setSelectedMeetingId(next[0]?.id ?? null)
        setListState(next.length > 0 ? 'ready' : 'empty')
        return next
      })
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'Không thể xoá meeting')
    } finally {
      setDeleteBusy(false)
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

      <div className="history-scene" style={{ display: 'grid', gridTemplateColumns: '320px minmax(0, 1fr)', gap: '20px', padding: '24px', minHeight: 'calc(100vh - 72px)' }}>
        <section className="history-list-card" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '18px', padding: '20px', boxShadow: '0 12px 40px rgba(15, 23, 42, 0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
            <div>
              <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700, color: '#0f172a' }}>Meeting history</h1>
              <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: '14px' }}>Tìm kiếm, lọc, đổi tên và xoá mềm meeting.</p>
            </div>
            <span className="meta-pill">{meetings.length}</span>
          </div>

          <div style={{ display: 'grid', gap: '8px', marginBottom: '14px' }}>
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
                    <span>•</span>
                    <span>{item.status}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="history-detail-card" style={{ display: 'grid', gap: '20px' }}>
          {selectedMeetingSummary ? (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '18px', padding: '20px', boxShadow: '0 12px 40px rgba(15, 23, 42, 0.05)' }}>
              <div style={{ display: 'grid', gap: '12px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                  <div>
                    <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 700, color: '#0f172a' }}>{getMeetingLabel(selectedMeetingSummary)}</h2>
                    <div style={{ marginTop: '6px', color: '#64748b', fontSize: '13px' }}>
                      ID {selectedMeetingSummary.id} • {getMeetingLanguage(selectedMeetingSummary)} • {selectedMeetingSummary.createdAt || 'Unknown date'}
                    </div>
                  </div>
                  <span className="meta-pill">{getMeetingStatus(selectedMeetingSummary)}</span>
                </div>
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
                </div>
                {listError && <ErrorState title="Thao tác thất bại" message={listError} />}
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
