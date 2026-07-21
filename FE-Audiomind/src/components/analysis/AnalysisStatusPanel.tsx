import type { AiAnalysis } from '../../types'
import { resolveErrorPresentation } from '../../constants/errorCatalog'
import { ERROR_UX_ENABLED } from '../../services/config'
import {
  formatAnalysisStatus,
  formatBooleanVi,
  formatDateTimeVi,
  formatVerificationStatus,
} from '../../utils/uiLabels'
import './analysis-status-panel.css'

export type AnalysisDisplayStatus =
  | 'NO_ANALYSIS'
  | 'ANALYZING'
  | 'COMPLETED'
  | 'FAILED'
  | 'STALE'
  | 'RATE_LIMITED'
  | 'QUOTA_BLOCKED'

export type AnalysisMetadata = Pick<
  AiAnalysis,
  | 'status'
  | 'analysisStatus'
  | 'cacheHit'
  | 'stale'
  | 'staleReason'
  | 'provider'
  | 'model'
  | 'promptVersion'
  | 'schemaVersion'
  | 'canonicalTranscriptHash'
  | 'canonicalTranscriptVersion'
  | 'analysisInputMode'
  | 'lastAnalyzedAt'
  | 'retryAfterSeconds'
  | 'retryable'
  | 'retryExhausted'
  | 'analysisRetryCount'
  | 'analysisNextRetryAt'
  | 'analysisTraceId'
  | 'analysisProviderAlias'
  | 'errorCode'
  | 'errorMessage'
> | null

type NormalizedAnalysisMetadata = {
  status: AnalysisDisplayStatus
  cacheHit?: boolean
  stale?: boolean
  staleReason?: string
  provider?: string
  model?: string
  promptVersion?: string
  schemaVersion?: string
  canonicalTranscriptHash?: string
  canonicalTranscriptVersion?: string
  analysisInputMode?: string
  lastAnalyzedAt?: string
  retryAfterSeconds?: number
  retryable?: boolean
  retryExhausted?: boolean
  analysisRetryCount?: number
  analysisNextRetryAt?: string
  analysisTraceId?: string
  analysisProviderAlias?: string
  errorCode?: string
  errorMessage?: string
}

type EvidenceMatchPreview = {
  verificationStatus?: string
  score?: number
  snippet?: string
  speaker?: string
  startTime?: number
  endTime?: number
}

export type { EvidenceMatchPreview }

type AnalysisStatusPanelProps = {
  metadata: AnalysisMetadata
  evidenceMatches?: EvidenceMatchPreview[]
  busy?: boolean
  error?: string | null
  onReanalyze: () => void
  onUpgradePlan?: () => void
}

const ACTIVE_OR_BLOCKING_STATUSES = new Set<AnalysisDisplayStatus>([
  'ANALYZING',
  'FAILED',
  'RATE_LIMITED',
  'QUOTA_BLOCKED',
])

const normalizeRawStatus = (value: unknown): AnalysisDisplayStatus | null => {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (!normalized) {
    return null
  }
  if (normalized === 'RUNNING' || normalized === 'QUEUED' || normalized === 'PENDING' || normalized === 'IN_PROGRESS') {
    return 'ANALYZING'
  }
  if (normalized === 'COMPLETED' || normalized === 'COMPLETE' || normalized === 'DONE') {
    return 'COMPLETED'
  }
  if (normalized === 'FAILED' || normalized === 'ERROR' || normalized === 'ANALYSIS_FAILED_RETRYABLE') {
    return 'FAILED'
  }
  if (normalized === 'STALE') {
    return 'STALE'
  }
  if (normalized === 'RATE_LIMITED') {
    return 'RATE_LIMITED'
  }
  if (normalized === 'QUOTA_BLOCKED') {
    return 'QUOTA_BLOCKED'
  }
  if (normalized === 'NO_ANALYSIS' || normalized === 'SKIPPED') {
    return 'NO_ANALYSIS'
  }
  if (normalized === 'ANALYZING') {
    return 'ANALYZING'
  }
  return null
}

export const normalizeAnalysisMetadata = (metadata: AnalysisMetadata): NormalizedAnalysisMetadata => {
  const preferredStatus = normalizeRawStatus(metadata?.analysisStatus) ?? normalizeRawStatus(metadata?.status) ?? 'NO_ANALYSIS'
  const status = metadata?.stale === true && !ACTIVE_OR_BLOCKING_STATUSES.has(preferredStatus)
    ? 'STALE'
    : preferredStatus

  return {
    status,
    cacheHit: metadata?.cacheHit,
    stale: metadata?.stale,
    staleReason: metadata?.staleReason,
    provider: metadata?.provider,
    model: metadata?.model,
    promptVersion: metadata?.promptVersion,
    schemaVersion: metadata?.schemaVersion,
    canonicalTranscriptHash: metadata?.canonicalTranscriptHash,
    canonicalTranscriptVersion: metadata?.canonicalTranscriptVersion,
    analysisInputMode: metadata?.analysisInputMode,
    lastAnalyzedAt: metadata?.lastAnalyzedAt,
    retryAfterSeconds: metadata?.retryAfterSeconds,
    retryable: metadata?.retryable,
    retryExhausted: metadata?.retryExhausted,
    analysisRetryCount: metadata?.analysisRetryCount,
    analysisNextRetryAt: metadata?.analysisNextRetryAt,
    analysisTraceId: metadata?.analysisTraceId,
    analysisProviderAlias: metadata?.analysisProviderAlias,
    errorCode: metadata?.errorCode,
    errorMessage: metadata?.errorMessage,
  }
}

const formatBoolean = formatBooleanVi
const formatDateTime = formatDateTimeVi

export const AnalysisStatusPanel = ({
  metadata,
  busy = false,
  error = null,
  evidenceMatches = [],
  onReanalyze,
  onUpgradePlan,
}: AnalysisStatusPanelProps) => {
  const normalized = normalizeAnalysisMetadata(metadata)
  const retryAfterSeconds = normalized.retryAfterSeconds ?? 0
  const isRetryableFailure = metadata?.analysisStatus === 'ANALYSIS_FAILED_RETRYABLE' || metadata?.retryable === true
  const isShortTranscriptSkip = normalized.errorCode === 'ANALYSIS_SKIPPED_SHORT_TRANSCRIPT'
    || normalized.errorCode === 'NO_MEANINGFUL_TRANSCRIPT'
  const isUserQuotaBlocked = normalized.status === 'QUOTA_BLOCKED'
    || normalized.errorCode === 'QUOTA_EXCEEDED'
  const isQuotaExhausted = normalized.errorCode === 'GEMINI_QUOTA_EXHAUSTED'
    || normalized.errorCode === 'GEMINI_RATE_LIMITED'
  const isGeminiBillingBlocked = normalized.errorCode === 'GEMINI_BILLING_CREDITS_DEPLETED'
  const noTranscriptAfterFinalize = normalized.errorCode === 'NO_TRANSCRIPT_AFTER_FINALIZE'
    || normalized.errorCode === 'NO_TRANSCRIPT'
  const failedAudioCapture = normalized.errorCode === 'FAILED_AUDIO_CAPTURE'
  const reanalyzeDisabled = busy
    || normalized.status === 'ANALYZING'
    || noTranscriptAfterFinalize
    || failedAudioCapture
    || isShortTranscriptSkip
    || isGeminiBillingBlocked
    || retryAfterSeconds > 0
    || (isRetryableFailure && !normalized.retryExhausted && retryAfterSeconds > 0)

  const statusBanner = (() => {
    if (normalized.status === 'ANALYZING') {
      return 'Phân tích đang chạy, vui lòng đợi…'
    }
    if (isUserQuotaBlocked) {
      return resolveErrorPresentation('QUOTA_EXCEEDED', normalized.errorMessage || 'Hết quota', ERROR_UX_ENABLED).message
    }
    if (isGeminiBillingBlocked) {
      return normalized.errorMessage
        || 'Dịch vụ AI tạm dừng do project Gemini đã hết billing credit. Yêu cầu sẽ không tự động thử lại.'
    }
    if (isShortTranscriptSkip) {
      return 'Bản ghi quá ngắn hoặc chưa có đủ nội dung để phân tích. Bạn có thể ghi lại hoặc tải file khác.'
    }
    if (isRetryableFailure && (isQuotaExhausted || retryAfterSeconds > 0) && !normalized.retryExhausted) {
      return 'AI đang quá tải, hệ thống sẽ tự thử lại.'
    }
    if (busy) {
      return 'Phân tích đang chạy, vui lòng đợi…'
    }
    return null
  })()

  const rows = [
    ['Nhà cung cấp', normalized.provider ?? 'Chưa rõ'],
    ['Mô hình', normalized.model ?? 'Chưa rõ'],
    ['Phân tích lần cuối', formatDateTime(normalized.lastAnalyzedAt)],
    ['Cache', formatBoolean(normalized.cacheHit)],
    ['Đầu vào', normalized.analysisInputMode ?? 'Chưa rõ'],
    ...(normalized.analysisRetryCount != null
      ? [['Lần thử lại', String(normalized.analysisRetryCount)] as [string, string]]
      : []),
    ...(normalized.retryExhausted != null
      ? [['Hết lượt thử', formatBoolean(normalized.retryExhausted)] as [string, string]]
      : []),
    ...(normalized.analysisNextRetryAt
      ? [['Thử lại lúc', formatDateTime(normalized.analysisNextRetryAt)] as [string, string]]
      : []),
    ...(normalized.analysisTraceId
      ? [['Trace ID', normalized.analysisTraceId] as [string, string]]
      : []),
  ]
  const technicalRows = [
    ['Prompt', normalized.promptVersion],
    ['Schema', normalized.schemaVersion],
    ['Hash transcript', normalized.canonicalTranscriptHash],
    ['Phiên bản transcript', normalized.canonicalTranscriptVersion],
  ].filter(([, value]) => Boolean(value))

  return (
    <section className="analysis-status-panel" data-testid="analysis-status-panel">
      <div className="analysis-status-panel__header">
        <span
          data-testid="analysis-status-badge"
          data-status={normalized.status}
          className="meta-pill analysis-status-panel__badge"
        >
          {formatAnalysisStatus(normalized.status)}
        </span>
        <button
          type="button"
          onClick={onReanalyze}
          disabled={reanalyzeDisabled}
          data-testid="analysis-reanalyze-button"
        >
          {busy ? 'Đang phân tích lại…' : 'Thử phân tích lại'}
        </button>
      </div>

      {statusBanner && (
        <p className="analysis-status-panel__banner" data-testid="analysis-status-banner">
          {statusBanner}
        </p>
      )}
      {isUserQuotaBlocked && onUpgradePlan && (
        <button
          type="button"
          className="btn btn--primary btn--block"
          data-testid="analysis-quota-upgrade-button"
          onClick={onUpgradePlan}
        >
          {resolveErrorPresentation('QUOTA_EXCEEDED', '', ERROR_UX_ENABLED).ctaLabel || 'Xem gói & thanh toán'}
        </button>
      )}

      <dl className="analysis-status-panel__grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {normalized.staleReason && (
        <p className="analysis-status-panel__meta" data-testid="analysis-stale-reason">
          Lý do dữ liệu cũ: {normalized.staleReason}
        </p>
      )}
      {retryAfterSeconds > 0 && (
        <p className="analysis-status-panel__meta" data-testid="analysis-retry-after">
          Thử lại sau {retryAfterSeconds} giây
        </p>
      )}
      {(normalized.errorCode || normalized.errorMessage) && (
        <p className="analysis-status-panel__error" data-testid="analysis-error-metadata">
          {[normalized.errorCode, normalized.errorMessage].filter(Boolean).join(': ')}
        </p>
      )}
      {technicalRows.length > 0 && (
        <div className="analysis-status-panel__technical" data-testid="analysis-technical-metadata">
          {technicalRows.map(([label, value]) => (
            <span key={label} className="meta-pill">
              {label}: {value}
            </span>
          ))}
        </div>
      )}
      {evidenceMatches.length > 0 && (
        <div className="analysis-status-panel__evidence" data-testid="verified-evidence-block">
          <strong className="analysis-status-panel__evidence-title">Bằng chứng đã xác minh</strong>
          {evidenceMatches.map((match, index) => (
            <div
              key={`${match.speaker ?? 'speaker'}-${match.startTime ?? index}`}
              className="analysis-status-panel__evidence-card"
            >
              <span className="meta-pill" data-testid="evidence-verification-badge">
                {formatVerificationStatus(match.verificationStatus)}
              </span>
              <div>{match.speaker} · {match.startTime}s–{match.endTime}s</div>
              <div className="analysis-status-panel__evidence-snippet">{match.snippet}</div>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="analysis-status-panel__error" data-testid="analysis-rerun-error">
          {error}
        </p>
      )}
    </section>
  )
}
