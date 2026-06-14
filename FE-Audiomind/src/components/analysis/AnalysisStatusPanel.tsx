import type { AiAnalysis } from '../../types'

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
  errorCode?: string
  errorMessage?: string
}

type AnalysisStatusPanelProps = {
  metadata: AnalysisMetadata
  busy?: boolean
  error?: string | null
  onReanalyze: () => void
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
  if (normalized === 'NOT_FOUND' || normalized === 'NO_ANALYSIS' || normalized === 'UNKNOWN') {
    return 'NO_ANALYSIS'
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
    errorCode: metadata?.errorCode,
    errorMessage: metadata?.errorMessage,
  }
}

const formatBoolean = (value: boolean | undefined): string => {
  if (value === undefined) {
    return 'unknown'
  }
  return value ? 'yes' : 'no'
}

const formatDateTime = (value: string | undefined): string => {
  if (!value) {
    return 'unknown'
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleString()
}

export const AnalysisStatusPanel = ({
  metadata,
  busy = false,
  error = null,
  onReanalyze,
}: AnalysisStatusPanelProps) => {
  const normalized = normalizeAnalysisMetadata(metadata)
  const retryAfterSeconds = normalized.retryAfterSeconds ?? 0
  const noTranscriptAfterFinalize = normalized.errorCode === 'NO_TRANSCRIPT_AFTER_FINALIZE'
  const reanalyzeDisabled = busy
    || normalized.status === 'ANALYZING'
    || noTranscriptAfterFinalize
    || retryAfterSeconds > 0

  const rows = [
    ['Provider', normalized.provider ?? 'unknown'],
    ['Model', normalized.model ?? 'unknown'],
    ['Last analyzed', formatDateTime(normalized.lastAnalyzedAt)],
    ['Cache hit', formatBoolean(normalized.cacheHit)],
    ['Input', normalized.analysisInputMode ?? 'unknown'],
  ]
  const technicalRows = [
    ['Prompt', normalized.promptVersion],
    ['Schema', normalized.schemaVersion],
    ['Canonical hash', normalized.canonicalTranscriptHash],
    ['Canonical version', normalized.canonicalTranscriptVersion],
  ].filter(([, value]) => Boolean(value))

  return (
    <section
      data-testid="analysis-status-panel"
      style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px', display: 'grid', gap: '12px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <span
          data-testid="analysis-status-badge"
          className="meta-pill"
          style={{ textTransform: 'uppercase' }}
        >
          {normalized.status}
        </span>
        <button
          type="button"
          onClick={onReanalyze}
          disabled={reanalyzeDisabled}
          data-testid="analysis-reanalyze-button"
        >
          {busy ? 'Re-analyzing...' : 'Re-analyze'}
        </button>
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', margin: 0 }}>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt style={{ color: '#64748b', fontSize: '12px' }}>{label}</dt>
            <dd style={{ margin: '4px 0 0', color: '#0f172a', fontSize: '13px', overflowWrap: 'anywhere' }}>{value}</dd>
          </div>
        ))}
      </dl>

      {normalized.staleReason && (
        <p style={{ margin: 0, color: '#92400e', fontSize: '13px' }} data-testid="analysis-stale-reason">
          staleReason: {normalized.staleReason}
        </p>
      )}
      {retryAfterSeconds > 0 && (
        <p style={{ margin: 0, color: '#64748b', fontSize: '13px' }} data-testid="analysis-retry-after">
          retryAfterSeconds: {retryAfterSeconds}
        </p>
      )}
      {(normalized.errorCode || normalized.errorMessage) && (
        <p style={{ margin: 0, color: '#b91c1c', fontSize: '13px' }} data-testid="analysis-error-metadata">
          {[normalized.errorCode, normalized.errorMessage].filter(Boolean).join(': ')}
        </p>
      )}
      {technicalRows.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }} data-testid="analysis-technical-metadata">
          {technicalRows.map(([label, value]) => (
            <span key={label} className="meta-pill" style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}>
              {label}: {value}
            </span>
          ))}
        </div>
      )}
      {error && (
        <p style={{ margin: 0, color: '#b91c1c', fontSize: '13px' }} data-testid="analysis-rerun-error">
          {error}
        </p>
      )}
    </section>
  )
}
