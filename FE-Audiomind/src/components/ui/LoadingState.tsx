import './ui-states.css'

type LoadingStateProps = {
  message: string
  className?: string
}

export const LoadingState = ({ message, className = '' }: LoadingStateProps) => (
  <div className={`ui-state ui-state--loading ${className}`.trim()} role="status" aria-live="polite">
    <span className="ui-state__spinner" aria-hidden="true" />
    <p className="ui-state__message">{message}</p>
  </div>
)
