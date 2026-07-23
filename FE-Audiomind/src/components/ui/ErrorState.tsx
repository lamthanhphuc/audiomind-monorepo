import { ERROR_UX_ENABLED } from '../../services/config'
import { resolveErrorPresentation } from '../../constants/errorCatalog'
import { ErrorDisplay, type ErrorDisplayProps } from './ErrorDisplay'

type ErrorStateProps = Omit<ErrorDisplayProps, 'showTraceId' | 'showCta' | 'message' | 'ctaId' | 'ctaLabel'> & {
  message: string
}

export const ErrorState = ({
  message,
  title = 'Lỗi',
  traceId,
  errorCode,
  className = '',
  onCtaClick,
}: ErrorStateProps) => {
  const presentation = resolveErrorPresentation(errorCode, message, ERROR_UX_ENABLED)

  return (
    <ErrorDisplay
      message={presentation.message}
      title={title}
      traceId={traceId}
      errorCode={errorCode}
      ctaId={presentation.ctaId}
      ctaLabel={presentation.ctaLabel}
      onCtaClick={onCtaClick}
      className={className}
      showTraceId={false}
      showCta={ERROR_UX_ENABLED}
    />
  )
}
