import './ui-states.css'

type ErrorStateProps = {
  message: string
  title?: string
  className?: string
}

export const ErrorState = ({ message, title = 'Lỗi', className = '' }: ErrorStateProps) => (
  <div className={`ui-state ui-state--error ${className}`.trim()} role="alert">
    {title && <p className="ui-state__title">{title}</p>}
    <p className="ui-state__message">{message}</p>
  </div>
)
