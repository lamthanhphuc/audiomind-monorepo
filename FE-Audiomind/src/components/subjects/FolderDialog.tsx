import { useEffect, useState } from 'react'
import type { StudyFolder } from '../../types'
import './subjects.css'

export type FolderDialogInitial = {
  id?: number
  name: string
  color?: string | null
  parentFolderId?: number | null
}

export type FolderDialogSubmitPayload = {
  name: string
  color: string | null
  parentFolderId: number | null
}

export type FolderDialogProps = {
  open: boolean
  mode: 'create' | 'edit'
  initial?: FolderDialogInitial
  folders: StudyFolder[]
  onClose: () => void
  onSubmit: (payload: FolderDialogSubmitPayload) => Promise<void>
}

export function FolderDialog({
  open,
  mode,
  initial,
  folders,
  onClose,
  onSubmit,
}: FolderDialogProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#6366f1')
  const [parentFolderId, setParentFolderId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setColor(initial?.color?.trim() || '#6366f1')
    setParentFolderId(initial?.parentFolderId ?? null)
    setBusy(false)
    setError(null)
  }, [open, initial])

  if (!open) return null

  const title = mode === 'create' ? 'Tạo thư mục' : 'Sửa thư mục'
  const parentOptions = folders.filter((folder) => folder.id !== initial?.id)

  const handleSubmit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Vui lòng nhập tên thư mục')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit({
        name: trimmed,
        color: color.trim() || null,
        parentFolderId,
      })
      onClose()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Không lưu được thư mục')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="subject-dialog-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div
        className="subject-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="subject-dialog__title">{title}</h2>

        <div className="subject-dialog__field">
          <label htmlFor="folder-dialog-name">Tên thư mục</label>
          <input
            id="folder-dialog-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ví dụ: Học kỳ 1"
            disabled={busy}
            autoFocus
          />
        </div>

        <div className="subject-dialog__field">
          <label htmlFor="folder-dialog-color">Màu</label>
          <input
            id="folder-dialog-color"
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            disabled={busy}
          />
        </div>

        <div className="subject-dialog__field">
          <label htmlFor="folder-dialog-parent">Thư mục cha</label>
          <select
            id="folder-dialog-parent"
            value={parentFolderId == null ? '' : String(parentFolderId)}
            onChange={(event) => {
              const raw = event.target.value
              setParentFolderId(raw ? Number(raw) : null)
            }}
            disabled={busy}
          >
            <option value="">Không có (gốc)</option>
            {parentOptions.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </div>

        {error ? <p className="subject-dialog__error">{error}</p> : null}

        <div className="subject-dialog__actions">
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? 'Đang lưu…' : mode === 'create' ? 'Tạo' : 'Lưu'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default FolderDialog
