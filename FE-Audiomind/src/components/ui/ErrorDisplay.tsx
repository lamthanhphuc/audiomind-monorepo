import './ui-states.css'

export type ErrorDisplayProps = {
  message: string
  title?: string
  traceId?: string
  errorCode?: string
  ctaId?: string
  ctaLabel?: string
  onCtaClick?: () => void
  className?: string
  showTraceId?: boolean
  showCta?: boolean
}

export const ErrorDisplay = ({
  message,
  title = 'Lỗi',
  traceId,
  ctaId,
  ctaLabel,
  onCtaClick,
  className = '',
  showTraceId = false,
  showCta = true,
}: ErrorDisplayProps) => (
  <div className={`ui-state ui-state--error ${className}`.trim()} role="alert">
    {title && <p className="ui-state__title">{title}</p>}
    <p className="ui-state__message">{message}</p>
    {showCta && ctaId && ctaLabel && (
      <button
        type="button"
        className="ui-state__cta"
        data-testid="error-cta"
        data-cta-id={ctaId}
        onClick={onCtaClick}
      >
        {ctaLabel}
      </button>
    )}
    {showTraceId && traceId && (
      <p className="ui-state__trace-id" data-testid="error-trace-id">
        Mã hỗ trợ: <code>{traceId}</code>
      </p>
    )}
  </div>
)
