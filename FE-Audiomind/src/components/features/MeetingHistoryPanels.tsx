import type { AiAnalysis } from '../../types'
import { normalizeGroupedActionPlan } from '../../types'
import type { MeetingActionPlanData, TranscriptEvidenceMatch } from '../../services/api'
import { formatActionPlanConfidence } from '../../utils/uiLabels'
import { formatShareLabel, isPendingMeetingShare, shareListKey, type MeetingShare } from '../../services/meetingShare'
import type { GoogleStatus } from '../../services/googleIntegration'
import type { TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import type { SpeakerProfile } from '../../services/knowledgeLayer'
import type { MeetingChatCitation } from '../../utils/meetingChatbot'
import type { TimelineChapter } from '../../utils/timelineData'
import type { TranscriptHighlightRange } from '../../utils/transcriptJump'
import { TranscriptDisplay } from '../transcript/TranscriptDisplay'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
import HistoryTranscriptTools from './HistoryTranscriptTools'
import MeetingTimeline from './MeetingTimeline'

export type HistoryDetailTab = 'overview' | 'transcript' | 'exports' | 'sharing'
export type TranscriptSearchState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
export type TranscriptExportFormat = 'txt' | 'csv'
export type TranscriptExportMode = 'readable' | 'raw'
export type TranscriptExportRequest = {
  mode: TranscriptExportMode
  format: TranscriptExportFormat
}

export type ActionPlanState = {
  preview: MeetingActionPlanData | null
  loading: boolean
  exporting: boolean
  error: string | null
  success: string | null
}

type HistoryDetailTabsProps = {
  activeTab: HistoryDetailTab
  onTabChange: (tab: HistoryDetailTab) => void
}

type HistoryExportPanelProps = {
  transcriptState: 'loading' | 'ready' | 'empty' | 'error'
  exportBusy: boolean
  transcriptExportBusy: TranscriptExportRequest | null
  transcriptExportError: string | null
  exportError: string | null
  actionPlanState: ActionPlanState
  onExportPdf: () => void
  onExportDocx: () => void
  onTranscriptExport: (mode: TranscriptExportMode, format: TranscriptExportFormat) => void
  onActionPlanExport: (format: 'docx' | 'pdf') => void
  onActionPlanCopy: () => void
}

type HistorySharePanelProps = {
  shareNotice: string | null
  shareGmailEmailMismatch: boolean
  shareGoogleStatus: GoogleStatus | null
  shareUserEmail: string | null
  shareMissingGmailScope: boolean
  gmailLinkBusy: boolean
  shareInviteEmail: string
  shareInviteBusy: boolean
  shareInviteError: string | null
  meetingShares: MeetingShare[]
  onGrantGmailSendScope: () => void
  onShareInviteEmailChange: (value: string) => void
  onInviteShare: () => void
  onCopyPendingInvite: (share: MeetingShare) => void
  onRevokeShare: (share: MeetingShare) => void
}

type TranscriptEvidencePanelProps = {
  selectedMeetingId: number | null
  detail: {
    transcriptSegments: TranscriptSegment[]
    transcriptState: 'loading' | 'ready' | 'empty' | 'error'
    transcriptError: string | null
    analysis: AiAnalysis | null
    analysisMetadata: AiAnalysis | null
  }
  transcriptEvidenceQuery: string
  transcriptEvidenceState: TranscriptSearchState
  transcriptEvidenceResults: TranscriptEvidenceMatch[]
  transcriptEvidenceError: string | null
  speakerDisplayMap: Map<string, string>
  highlightRange: TranscriptHighlightRange | null
  onEvidenceQueryChange: (value: string) => void
  onEvidenceSearch: () => void
  onTermSelect: (term: string) => void
  onTimelineJump: (chapter: TimelineChapter) => void
  onProfilesSaved: (profiles: SpeakerProfile[]) => void
  onCitationClick: (citation: MeetingChatCitation) => void
}

const HISTORY_DETAIL_TABS: Array<{ id: HistoryDetailTab; label: string }> = [
  { id: 'overview', label: 'Xem' },
  { id: 'transcript', label: 'Tìm trong transcript' },
  { id: 'exports', label: 'Xuất file' },
  { id: 'sharing', label: 'Chia sẻ' },
]

const formatTranscriptExportRequest = (request: TranscriptExportRequest): string => {
  const modeLabel = request.mode === 'readable' ? 'bản dễ đọc' : 'bản dữ liệu gốc'
  return `${modeLabel} ${request.format.toUpperCase()}`
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

type ActionPlanPreviewProps = {
  preview: MeetingActionPlanData
  onCopy: () => void
}

const getGroupedActionPlanItemCount = (
  plan: MeetingActionPlanData['groupedActionPlan'],
  fallbackItems: MeetingActionPlanData['actionItems'],
): number => {
  return plan?.sections.reduce((total, section) => total + section.items.length, 0) ?? fallbackItems.length
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

export function HistoryDetailTabs({ activeTab, onTabChange }: HistoryDetailTabsProps) {
  return (
    <div className="history-detail-tabs" role="tablist" aria-label="Chi tiết meeting">
      {HISTORY_DETAIL_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          className={`history-detail-tab${activeTab === tab.id ? ' history-detail-tab--active' : ''}`}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

export function HistoryExportPanel({
  transcriptState,
  exportBusy,
  transcriptExportBusy,
  transcriptExportError,
  exportError,
  actionPlanState,
  onExportPdf,
  onExportDocx,
  onTranscriptExport,
  onActionPlanExport,
  onActionPlanCopy,
}: HistoryExportPanelProps) {
  const exportDisabled = exportBusy || transcriptState !== 'ready'
  const actionPlanBusy = actionPlanState.loading || actionPlanState.exporting
  const actionPlanBusyLabel = actionPlanState.loading ? 'Đang chuẩn bị...' : 'Đang tải...'

  return (
    <>
      <div className="history-export-grid" data-testid="meeting-export-more">
        <section className="history-export-card" aria-labelledby="history-export-report-title">
          <div>
            <h4 id="history-export-report-title">Báo cáo phân tích</h4>
            <p>Tóm tắt, insight, pain point và action item.</p>
          </div>
          <div className="history-export-card__actions">
            <button type="button" className="btn btn--primary btn--compact" onClick={onExportDocx} disabled={exportDisabled} data-testid="meeting-export-report">
              {exportBusy ? 'Đang xuất...' : 'DOCX'}
            </button>
            <button type="button" className="btn btn--secondary btn--compact" onClick={onExportPdf} disabled={exportDisabled} data-testid="meeting-export-report-pdf">
              {exportBusy ? 'Đang xuất...' : 'PDF'}
            </button>
          </div>
        </section>

        <section className="history-export-card" aria-labelledby="history-export-transcript-title">
          <div>
            <h4 id="history-export-transcript-title">Transcript</h4>
            <p>Bản dễ đọc để chia sẻ, bản dữ liệu gốc để kiểm tra.</p>
          </div>
          <div className="history-export-transcript-grid" data-testid="meeting-export-transcript-menu">
            <button type="button" className="btn btn--secondary btn--compact" data-testid="meeting-export-transcript-readable-txt" onClick={() => onTranscriptExport('readable', 'txt')} disabled={transcriptState !== 'ready' || transcriptExportBusy !== null}>
              {transcriptExportBusy?.mode === 'readable' && transcriptExportBusy.format === 'txt' ? 'Đang xuất...' : 'Dễ đọc TXT'}
            </button>
            <button type="button" className="btn btn--secondary btn--compact" data-testid="meeting-export-transcript-readable-csv" onClick={() => onTranscriptExport('readable', 'csv')} disabled={transcriptState !== 'ready' || transcriptExportBusy !== null}>
              {transcriptExportBusy?.mode === 'readable' && transcriptExportBusy.format === 'csv' ? 'Đang xuất...' : 'Dễ đọc CSV'}
            </button>
            <button type="button" className="btn btn--secondary btn--compact" data-testid="meeting-export-transcript-raw-txt" onClick={() => onTranscriptExport('raw', 'txt')} disabled={transcriptState !== 'ready' || transcriptExportBusy !== null}>
              {transcriptExportBusy?.mode === 'raw' && transcriptExportBusy.format === 'txt' ? 'Đang xuất...' : 'Gốc TXT'}
            </button>
            <button type="button" className="btn btn--secondary btn--compact" data-testid="meeting-export-transcript-raw-csv" onClick={() => onTranscriptExport('raw', 'csv')} disabled={transcriptState !== 'ready' || transcriptExportBusy !== null}>
              {transcriptExportBusy?.mode === 'raw' && transcriptExportBusy.format === 'csv' ? 'Đang xuất...' : 'Gốc CSV'}
            </button>
          </div>
          <button type="button" className="history-export-card__hidden-trigger" data-testid="meeting-export-transcript" aria-hidden="true" tabIndex={-1}>
            {transcriptExportBusy ? `Đang xuất ${formatTranscriptExportRequest(transcriptExportBusy)}...` : 'Xuất bản ghi'}
          </button>
        </section>

        <section className="history-export-card" aria-labelledby="history-export-action-plan-title">
          <div>
            <h4 id="history-export-action-plan-title">Kế hoạch hành động</h4>
            <p>Danh sách việc cần làm theo nhóm chức năng.</p>
          </div>
          <div className="history-export-card__actions">
            <button type="button" className="btn btn--secondary btn--compact" data-testid="meeting-export-action-plan" onClick={() => onActionPlanExport('docx')} disabled={actionPlanBusy}>
              {actionPlanBusy ? actionPlanBusyLabel : 'DOCX'}
            </button>
            <button type="button" className="btn btn--secondary btn--compact" data-testid="meeting-export-action-plan-pdf" onClick={() => onActionPlanExport('pdf')} disabled={actionPlanBusy}>
              {actionPlanBusy ? actionPlanBusyLabel : 'PDF'}
            </button>
          </div>
        </section>
      </div>
      {exportError && <ErrorState title="Xuất report thất bại" message={exportError} />}
      {transcriptExportError && <ErrorState title="Xuất transcript thất bại" message={transcriptExportError} />}
      {actionPlanState.error && <ErrorState title="Xuất action plan thất bại" message={actionPlanState.error} />}
      {actionPlanState.success && <p className="history-notice" data-testid="meeting-action-plan-success">{actionPlanState.success}</p>}
      {actionPlanState.preview && <ActionPlanPreview preview={actionPlanState.preview} onCopy={onActionPlanCopy} />}
      {transcriptState === 'ready' ? (
        <p className="history-helper" data-testid="meeting-export-transcript-helper">
          Bản dễ đọc phù hợp để chia sẻ; bản dữ liệu gốc dùng cho kiểm tra và audit.
        </p>
      ) : (
        <p className="history-helper" data-testid="meeting-export-hint">Cần transcript đã lưu để xuất báo cáo.</p>
      )}
    </>
  )
}

export function HistorySharePanel({
  shareNotice,
  shareGmailEmailMismatch,
  shareGoogleStatus,
  shareUserEmail,
  shareMissingGmailScope,
  gmailLinkBusy,
  shareInviteEmail,
  shareInviteBusy,
  shareInviteError,
  meetingShares,
  onGrantGmailSendScope,
  onShareInviteEmailChange,
  onInviteShare,
  onCopyPendingInvite,
  onRevokeShare,
}: HistorySharePanelProps) {
  return (
    <>
      {shareNotice && <p className="history-notice" data-testid="meeting-share-notice">{shareNotice}</p>}
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
              Chưa cấp quyền gửi email qua Gmail - lời mời vẫn được lưu nhưng mail có thể không gửi tự động.
            </p>
            <button
              type="button"
              className="btn btn--secondary btn--compact"
              onClick={onGrantGmailSendScope}
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
            onChange={(event) => onShareInviteEmailChange(event.target.value)}
            placeholder="Email người nhận"
            data-testid="meeting-share-email"
          />
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            onClick={onInviteShare}
            disabled={shareInviteBusy || !shareInviteEmail.trim()}
            data-testid="meeting-share-invite"
          >
            {shareInviteBusy ? 'Đang mời...' : 'Mời xem'}
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
                  <button type="button" className="btn btn--secondary btn--compact" onClick={() => onCopyPendingInvite(share)}>
                    Sao chép lời mời
                  </button>
                )}
                <button type="button" className="btn btn--secondary btn--compact" onClick={() => onRevokeShare(share)}>
                  Thu hồi
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

export function TranscriptEvidencePanel({
  selectedMeetingId,
  detail,
  transcriptEvidenceQuery,
  transcriptEvidenceState,
  transcriptEvidenceResults,
  transcriptEvidenceError,
  speakerDisplayMap,
  highlightRange,
  onEvidenceQueryChange,
  onEvidenceSearch,
  onTermSelect,
  onTimelineJump,
  onProfilesSaved,
  onCitationClick,
}: TranscriptEvidencePanelProps) {
  return (
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
                onEvidenceSearch()
              }}
            >
              <input
                type="search"
                className="studio-input"
                value={transcriptEvidenceQuery}
                onChange={(event) => onEvidenceQueryChange(event.target.value)}
                placeholder="Tìm trong transcript..."
                data-testid="transcript-evidence-search-input"
              />
              <button
                type="submit"
                className="studio-btn studio-btn--primary"
                disabled={transcriptEvidenceState === 'loading'}
                data-testid="transcript-evidence-search-submit"
              >
                {transcriptEvidenceState === 'loading' ? 'Đang tìm...' : 'Tìm dẫn chứng'}
              </button>
            </form>
            {transcriptEvidenceState === 'error' && (
              <ErrorState
                title="Không thể tìm dẫn chứng"
                message={transcriptEvidenceError || 'Không thể tìm trong transcript'}
              />
            )}
            {transcriptEvidenceState === 'empty' && <EmptyState message="Không tìm thấy dẫn chứng phù hợp" />}
            {transcriptEvidenceState === 'ready' && (
              <div className="transcript-evidence-results" data-testid="transcript-evidence-results">
                {transcriptEvidenceResults.map((match) => (
                  <article key={match.evidenceId} className="history-evidence-card">
                    <div className="history-evidence-card__head">
                      <strong>{match.speaker || 'Người nói'}</strong>
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
              onTermClick={selectedMeetingId ? onTermSelect : undefined}
              speakerDisplayMap={Object.fromEntries(speakerDisplayMap)}
              highlightRange={highlightRange}
            />
            <MeetingTimeline
              segments={detail.transcriptSegments}
              analysis={detail.analysis}
              onJumpToChapter={onTimelineJump}
            />
            <HistoryTranscriptTools
              meetingId={selectedMeetingId}
              analysis={detail.analysis}
              transcriptSegments={detail.transcriptSegments}
              onTermSelect={onTermSelect}
              onProfilesSaved={onProfilesSaved}
              onCitationClick={onCitationClick}
            />
          </div>
        )}
      </div>
    </div>
  )
}
