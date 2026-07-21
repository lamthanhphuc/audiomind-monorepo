import './subjects.css'

export type ConfirmDialogProps = {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  busy?: boolean
  error?: string | null
  tone?: 'default' | 'danger'
  onConfirm: () => void
  onCancel: () => void
  testId?: string
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Xác nhận',
  cancelLabel = 'Hủy',
  busy = false,
  error = null,
  tone = 'default',
  onConfirm,
  onCancel,
  testId,
}: ConfirmDialogProps) {
  if (!open) return null

  return (
    <div
      className="subject-dialog-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) onCancel()
      }}
    >
      <div
        className="subject-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="subject-dialog__title">{title}</h2>
        <p className="subject-dialog__message">{message}</p>

        {error ? <p className="subject-dialog__error">{error}</p> : null}

        <div className="subject-dialog__actions">
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
            data-testid={testId ? `${testId}-confirm` : undefined}
          >
            {busy ? 'Đang xử lý…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmDialog
