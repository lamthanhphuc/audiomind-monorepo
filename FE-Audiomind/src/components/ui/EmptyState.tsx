import './ui-states.css'

type EmptyStateProps = {
  message: string
  title?: string
  className?: string
}

export const EmptyState = ({ message, title, className = '' }: EmptyStateProps) => (
  <div className={`ui-state ui-state--empty ${className}`.trim()} role="status">
    {title && <p className="ui-state__title">{title}</p>}
    <p className="ui-state__message">{message}</p>
  </div>
)
