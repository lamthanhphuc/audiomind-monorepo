import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { type DomainMode } from '../../constants/domainMode'
import type { Meeting } from '../../types'
import { isUserQuotaExceeded } from '../../utils/quotaUx'
import {
  formatResultScopeLabel,
  scopeCacheKey,
  type MeetingResultScope,
} from '../../utils/meetingResultScope'
import TermExplainPopover from './TermExplainPopover'
import type { TimelineChapter } from '../../utils/timelineData'
import {
  highlightRangeFromTime,
  scrollTranscriptToHighlight,
  type TranscriptHighlightRange,
} from '../../utils/transcriptJump'
import { listSpeakerProfiles, type SpeakerProfile } from '../../services/knowledgeLayer'
import { type MeetingChatCitation } from '../../utils/meetingChatbot'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
import { formatDateVi, formatLanguage, formatMeetingStatus } from '../../utils/uiLabels'
import type { HistoryLanguageFilter, HistoryStatusFilter } from '../../app/useHistorySearchFilters'
import {
  HistoryDetailTabs,
  HistoryExportPanel,
  HistorySharePanel,
  TranscriptEvidencePanel,
  type HistoryDetailTab,
} from './MeetingHistoryPanels'
import { useMeetingHistoryExports } from './useMeetingHistoryExports'
import { useMeetingHistorySharing } from './useMeetingHistorySharing'
import { type ListState, useMeetingHistoryData } from './useMeetingHistoryData'
import { useTranscriptEvidenceSearch } from './useTranscriptEvidenceSearch'

type HistoryOverviewPanelProps = {
  selectedMeeting: Meeting
  availableScopes: MeetingResultScope[]
  selectedScope: MeetingResultScope | null
  scopeState: ListState
  renameValue: string
  renameBusy: boolean
  deleteBusy: boolean
  listError: string | null
  onSelectedScopeChange: (scope: MeetingResultScope) => void
  onRenameValueChange: (value: string) => void
  onRename: () => void
  onDelete: () => void
  onShareLink: () => void
  onOpenAnalysis?: (meetingId: number, context?: { title?: string; scope?: MeetingResultScope | null }) => void
  onOpenMindmap?: (meetingId: number, context?: { title?: string; scope?: MeetingResultScope | null }) => void
}

type MeetingHistorySceneProps = {
  focusMeetingId?: number | null
  onOpenAnalysis?: (meetingId: number, context?: { title?: string; scope?: MeetingResultScope | null }) => void
  onOpenMindmap?: (meetingId: number, context?: { title?: string; scope?: MeetingResultScope | null }) => void
  searchQuery?: string
  onSearchQueryChange?: (value: string) => void
  statusFilter?: HistoryStatusFilter
  onStatusFilterChange?: (value: HistoryStatusFilter) => void
  languageFilter?: HistoryLanguageFilter
  onLanguageFilterChange?: (value: HistoryLanguageFilter) => void
  onNavigateUpload?: () => void
  onNavigateRealtime?: () => void
  onNavigateBilling?: () => void
  preferredDomainMode?: DomainMode
  oauthRefreshTick?: number
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

function HistoryOverviewPanel({
  selectedMeeting,
  availableScopes,
  selectedScope,
  scopeState,
  renameValue,
  renameBusy,
  deleteBusy,
  listError,
  onSelectedScopeChange,
  onRenameValueChange,
  onRename,
  onDelete,
  onShareLink,
  onOpenAnalysis,
  onOpenMindmap,
}: HistoryOverviewPanelProps) {
  const meetingTitle = getMeetingLabel(selectedMeeting)

  return (
    <>
      {(onOpenAnalysis || onOpenMindmap) && (
        <div className="history-detail-ctas">
          {availableScopes.length > 1 && (
            <label className="history-scope-picker">
              <span>Phiên ghi</span>
              <select
                value={selectedScope ? scopeCacheKey(selectedScope) : ''}
                onChange={(event) => {
                  const nextScope = availableScopes.find((scope) => scopeCacheKey(scope) === event.target.value)
                  if (nextScope) {
                    onSelectedScopeChange(nextScope)
                  }
                }}
                data-testid="meeting-scope-select"
              >
                {availableScopes.map((scope) => (
                  <option key={scopeCacheKey(scope)} value={scopeCacheKey(scope)}>
                    {formatResultScopeLabel(scope)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {onOpenAnalysis && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={selectedScope == null || scopeState !== 'ready'}
              onClick={() => onOpenAnalysis(selectedMeeting.id, { title: meetingTitle, scope: selectedScope })}
              data-testid="meeting-open-analysis"
            >
              Xem kết quả phân tích
            </button>
          )}
          {onOpenMindmap && (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={selectedScope == null || scopeState !== 'ready'}
              onClick={() => onOpenMindmap(selectedMeeting.id, { title: meetingTitle, scope: selectedScope })}
              data-testid="meeting-open-mindmap"
            >
              Mở sơ đồ mindmap
            </button>
          )}
        </div>
      )}

      <div className="history-actions">
        <div className="history-actions__group history-rename-row ui-panel-actions">
          <span className="history-actions__label">Quản lý</span>
          <input
            type="text"
            value={renameValue}
            onChange={(event) => onRenameValueChange(event.target.value)}
            placeholder="Đổi tên cuộc họp"
            data-testid="meeting-rename-input"
          />
          <button type="button" className="btn btn--secondary btn--compact" onClick={onRename} disabled={renameBusy} data-testid="meeting-rename-submit">
            {renameBusy ? 'Đang lưu...' : 'Lưu tên'}
          </button>
          <button type="button" className="btn btn--danger btn--compact" onClick={onDelete} disabled={deleteBusy} data-testid="meeting-delete-submit">
            {deleteBusy ? 'Đang xoá...' : 'Xoá mềm'}
          </button>
          <button type="button" className="btn btn--secondary btn--compact" onClick={onShareLink} data-testid="meeting-share-link">
            Sao chép link
          </button>
        </div>
      </div>
      {listError && <ErrorState title="Thao tác thất bại" message={listError} />}
    </>
  )
}

export default function MeetingHistoryScene({
  focusMeetingId = null,
  onOpenAnalysis,
  onOpenMindmap,
  searchQuery: controlledSearchQuery,
  onSearchQueryChange,
  statusFilter: controlledStatusFilter,
  onStatusFilterChange,
  languageFilter: controlledLanguageFilter,
  onLanguageFilterChange,
  onNavigateUpload,
  onNavigateRealtime,
  onNavigateBilling,
  preferredDomainMode: _preferredDomainMode,
  oauthRefreshTick = 0,
}: MeetingHistorySceneProps) {
  const {
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
    reload,
    semanticResults,
    semanticState,
    availableScopes,
    selectedScope,
    setSelectedScope,
    scopeState,
    handleRename,
    handleDelete,
  } = useMeetingHistoryData({
    focusMeetingId,
    controlledSearchQuery,
    onSearchQueryChange,
    controlledStatusFilter,
    onStatusFilterChange,
    controlledLanguageFilter,
    onLanguageFilterChange,
  })

  const [activeTerm, setActiveTerm] = useState<string | null>(null)
  const [activeDetailTab, setActiveDetailTab] = useState<HistoryDetailTab>('overview')
  const [speakerDisplayMap, setSpeakerDisplayMap] = useState<Map<string, string>>(() => new Map())
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

  const {
    transcriptEvidenceQuery,
    setTranscriptEvidenceQuery,
    transcriptEvidenceState,
    transcriptEvidenceResults,
    transcriptEvidenceError,
    handleTranscriptEvidenceSearch,
    resetTranscriptEvidence,
  } = useTranscriptEvidenceSearch({ selectedMeetingSummary })

  const {
    shareNotice,
    shareInviteEmail,
    setShareInviteEmail,
    shareInviteBusy,
    shareInviteError,
    meetingShares,
    shareGoogleStatus,
    shareUserEmail,
    gmailLinkBusy,
    shareGmailEmailMismatch,
    shareMissingGmailScope,
    handleShareMeetingLink,
    handleCopyPendingInvite,
    handleInviteShare,
    handleGrantGmailSendScope,
    handleRevokeShare,
  } = useMeetingHistorySharing({
    selectedMeetingSummary,
    oauthRefreshTick,
  })

  const {
    exportBusy,
    exportError,
    transcriptExportBusy,
    transcriptExportError,
    transcriptExportMenuOpen,
    setTranscriptExportMenuOpen,
    exportActionsMenuOpen,
    setExportActionsMenuOpen,
    actionPlanState,
    handleExportDocx,
    handleExportPdf,
    handleTranscriptExport,
    handleActionPlanExport,
    handleActionPlanCopy,
    resetExportState,
  } = useMeetingHistoryExports({
    selectedMeetingSummary,
    transcriptState: detail.transcriptState,
    analysisState: detail.analysisState,
  })

  useEffect(() => {
    setActiveDetailTab('overview')
  }, [selectedMeetingId])

  const applySpeakerProfiles = useCallback((profiles: SpeakerProfile[]) => {
    const nextMap = new Map<string, string>()
    for (const profile of profiles) {
      if (profile.speakerKey && profile.displayName) {
        nextMap.set(profile.speakerKey, profile.displayName)
      }
    }
    setSpeakerDisplayMap(nextMap)
  }, [])

  useEffect(() => {
    if (selectedMeetingId == null) {
      setSpeakerDisplayMap(new Map())
      return
    }
    void listSpeakerProfiles(selectedMeetingId)
      .then(applySpeakerProfiles)
      .catch(() => setSpeakerDisplayMap(new Map()))
  }, [selectedMeetingId, applySpeakerProfiles])

  useEffect(() => {
    resetTranscriptEvidence()
    resetExportState()
  }, [selectedMeetingId, resetExportState, resetTranscriptEvidence])
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
            <button type="button" className="ui-icon-btn" aria-label="Tải lại danh sách" onClick={reload}>
              <RefreshCw size={18} aria-hidden="true" />
            </button>
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
            <span className="meta-pill">{listTotal}</span>
          </div>

          <div className="history-toolbar ui-toolbar">
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as HistoryStatusFilter)}
              data-testid="meeting-status-filter"
            >
              <option value="">Tất cả trạng thái</option>
              <option value="scheduled">Đã lên lịch</option>
              <option value="processing">Đang xử lý</option>
              <option value="completed">Hoàn tất</option>
              <option value="failed">Thất bại</option>
            </select>
            <select
              value={languageFilter}
              onChange={(event) => setLanguageFilter(event.target.value as HistoryLanguageFilter)}
              data-testid="meeting-language-filter"
            >
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
                  <button type="button" className="btn btn--secondary" data-testid="history-empty-upload" onClick={onNavigateUpload}>
                    Tải file
                  </button>
                )}
                {onNavigateRealtime && (
                  <button type="button" className="btn btn--secondary" data-testid="history-empty-realtime" onClick={onNavigateRealtime}>
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
                      className="btn btn--secondary"
                      onClick={() => {
                        selectMeeting(result.meetingId)
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
            <>
              <div className="history-list-scroll" data-testid="meeting-list-scroll">
                <div className="history-list-grid" data-testid="meeting-list">
                  {meetingCards.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`history-list-item${item.active ? ' history-list-item--active' : ''}`}
                      onClick={() => {
                        selectMeeting(item.id)
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
              </div>

              {listTotalPages > 1 && (
                <div className="history-list-pagination" data-testid="meeting-list-pagination">
                  <button
                    type="button"
                    className="btn btn--secondary btn--compact"
                    disabled={listPage <= 1}
                    onClick={goToPreviousListPage}
                    data-testid="meeting-list-prev-page"
                  >
                    Trang trước
                  </button>
                  <span className="history-list-pagination__label">
                    Trang {listPage}/{listTotalPages}
                  </span>
                  <button
                    type="button"
                    className="btn btn--secondary btn--compact"
                    disabled={listPage >= listTotalPages}
                    onClick={goToNextListPage}
                    data-testid="meeting-list-next-page"
                  >
                    Trang sau
                  </button>
                </div>
              )}
            </>
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
                <HistoryDetailTabs activeTab={activeDetailTab} onTabChange={setActiveDetailTab} />

                {activeDetailTab === 'overview' && (
                  <HistoryOverviewPanel
                    selectedMeeting={selectedMeetingSummary}
                    availableScopes={availableScopes}
                    selectedScope={selectedScope}
                    scopeState={scopeState}
                    renameValue={renameValue}
                    renameBusy={renameBusy}
                    deleteBusy={deleteBusy}
                    listError={listError}
                    onSelectedScopeChange={setSelectedScope}
                    onRenameValueChange={setRenameValue}
                    onRename={handleRename}
                    onDelete={handleDelete}
                    onShareLink={() => void handleShareMeetingLink()}
                    onOpenAnalysis={onOpenAnalysis}
                    onOpenMindmap={onOpenMindmap}
                  />
                )}

                {activeDetailTab === 'exports' && (
                  <HistoryExportPanel
                    transcriptState={detail.transcriptState}
                    exportBusy={exportBusy}
                    exportActionsMenuOpen={exportActionsMenuOpen}
                    transcriptExportMenuOpen={transcriptExportMenuOpen}
                    transcriptExportBusy={transcriptExportBusy}
                    transcriptExportError={transcriptExportError}
                    exportError={exportError}
                    actionPlanState={actionPlanState}
                    onExportPdf={() => void handleExportPdf()}
                    onExportDocx={() => void handleExportDocx()}
                    onToggleExportActionsMenu={() => setExportActionsMenuOpen((value) => !value)}
                    onToggleTranscriptExportMenu={() => setTranscriptExportMenuOpen((value) => !value)}
                    onTranscriptExport={(mode, format) => void handleTranscriptExport(mode, format)}
                    onActionPlanExport={(format) => void handleActionPlanExport(format)}
                    onActionPlanCopy={() => void handleActionPlanCopy()}
                  />
                )}

                {activeDetailTab === 'sharing' && (
                  <HistorySharePanel
                    shareNotice={shareNotice}
                    shareGmailEmailMismatch={shareGmailEmailMismatch}
                    shareGoogleStatus={shareGoogleStatus}
                    shareUserEmail={shareUserEmail}
                    shareMissingGmailScope={shareMissingGmailScope}
                    gmailLinkBusy={gmailLinkBusy}
                    shareInviteEmail={shareInviteEmail}
                    shareInviteBusy={shareInviteBusy}
                    shareInviteError={shareInviteError}
                    meetingShares={meetingShares}
                    onGrantGmailSendScope={() => void handleGrantGmailSendScope()}
                    onShareInviteEmailChange={setShareInviteEmail}
                    onInviteShare={() => void handleInviteShare()}
                    onCopyPendingInvite={(share) => void handleCopyPendingInvite(share)}
                    onRevokeShare={(share) => void handleRevokeShare(share)}
                  />
                )}

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
              </div>

              {activeDetailTab === 'transcript' && (
                <TranscriptEvidencePanel
                  selectedMeetingId={selectedMeetingId}
                  detail={detail}
                  transcriptEvidenceQuery={transcriptEvidenceQuery}
                  transcriptEvidenceState={transcriptEvidenceState}
                  transcriptEvidenceResults={transcriptEvidenceResults}
                  transcriptEvidenceError={transcriptEvidenceError}
                  speakerDisplayMap={speakerDisplayMap}
                  highlightRange={highlightRange}
                  onEvidenceQueryChange={setTranscriptEvidenceQuery}
                  onEvidenceSearch={() => void handleTranscriptEvidenceSearch()}
                  onTermSelect={setActiveTerm}
                  onTimelineJump={handleTimelineJump}
                  onProfilesSaved={applySpeakerProfiles}
                  onCitationClick={handleCitationClick}
                />
              )}
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
