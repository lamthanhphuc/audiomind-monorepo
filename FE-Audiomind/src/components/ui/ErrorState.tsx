import { ERROR_UX_ENABLED } from '../../services/config'
import { ErrorDisplay, type ErrorDisplayProps } from './ErrorDisplay'

type ErrorStateProps = Omit<ErrorDisplayProps, 'showTraceId'>

export const ErrorState = ({
  message,
  title = 'Lỗi',
  traceId,
  errorCode,
  className = '',
}: ErrorStateProps) => (
  <ErrorDisplay
    message={message}
    title={title}
    traceId={traceId}
    errorCode={errorCode}
    className={className}
    showTraceId={ERROR_UX_ENABLED}
  />
)
