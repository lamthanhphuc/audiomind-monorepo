import './ui-states.css'

export type ErrorDisplayProps = {
  message: string
  title?: string
  traceId?: string
  errorCode?: string
  className?: string
  showTraceId?: boolean
}

export const ErrorDisplay = ({
  message,
  title = 'Lỗi',
  traceId,
  errorCode,
  className = '',
  showTraceId = true,
}: ErrorDisplayProps) => (
  <div className={`ui-state ui-state--error ${className}`.trim()} role="alert">
    {title && <p className="ui-state__title">{title}</p>}
    <p className="ui-state__message">{message}</p>
    {showTraceId && traceId && (
      <p className="ui-state__trace-id" data-testid="error-trace-id">
        Mã hỗ trợ: <code>{traceId}</code>
        {errorCode ? ` (${errorCode})` : ''}
      </p>
    )}
  </div>
)
