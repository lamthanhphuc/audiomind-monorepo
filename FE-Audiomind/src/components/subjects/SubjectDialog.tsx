import { useEffect, useState } from 'react'
import type { StudyFolder } from '../../types'
import './subjects.css'

export type SubjectDialogInitial = {
  id?: number
  name: string
  code?: string | null
  semester?: string | null
  description?: string | null
  color?: string | null
  folderId?: number | null
}

export type SubjectDialogSubmitPayload = {
  name: string
  code: string | null
  semester: string | null
  description: string | null
  color: string | null
  folderId: number | null
}

export type SubjectDialogProps = {
  open: boolean
  mode: 'create' | 'edit'
  initial?: SubjectDialogInitial
  folders: StudyFolder[]
  onClose: () => void
  onSubmit: (payload: SubjectDialogSubmitPayload) => Promise<void>
}

export function SubjectDialog({
  open,
  mode,
  initial,
  folders,
  onClose,
  onSubmit,
}: SubjectDialogProps) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [semester, setSemester] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('#0ea5e9')
  const [folderId, setFolderId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setCode(initial?.code ?? '')
    setSemester(initial?.semester ?? '')
    setDescription(initial?.description ?? '')
    setColor(initial?.color?.trim() || '#0ea5e9')
    setFolderId(initial?.folderId ?? null)
    setBusy(false)
    setError(null)
  }, [open, initial])

  if (!open) return null

  const title = mode === 'create' ? 'Tạo môn học' : 'Sửa môn học'

  const handleSubmit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Vui lòng nhập tên môn học')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit({
        name: trimmed,
        code: code.trim() || null,
        semester: semester.trim() || null,
        description: description.trim() || null,
        color: color.trim() || null,
        folderId,
      })
      onClose()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Không lưu được môn học')
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
          <label htmlFor="subject-dialog-name">Tên môn</label>
          <input
            id="subject-dialog-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ví dụ: Cơ sở dữ liệu"
            disabled={busy}
            autoFocus
          />
        </div>

        <div className="subject-dialog__field">
          <label htmlFor="subject-dialog-code">Mã môn</label>
          <input
            id="subject-dialog-code"
            type="text"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Ví dụ: DB101"
            disabled={busy}
          />
        </div>

        <div className="subject-dialog__field">
          <label htmlFor="subject-dialog-semester">Học kỳ</label>
          <input
            id="subject-dialog-semester"
            type="text"
            value={semester}
            onChange={(event) => setSemester(event.target.value)}
            placeholder="Ví dụ: HK1-2026"
            disabled={busy}
          />
        </div>

        <div className="subject-dialog__field">
          <label htmlFor="subject-dialog-folder">Thư mục</label>
          <select
            id="subject-dialog-folder"
            value={folderId == null ? '' : String(folderId)}
            onChange={(event) => {
              const raw = event.target.value
              setFolderId(raw ? Number(raw) : null)
            }}
            disabled={busy}
          >
            <option value="">Không thuộc thư mục</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </div>

        <div className="subject-dialog__field">
          <label htmlFor="subject-dialog-color">Màu</label>
          <input
            id="subject-dialog-color"
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            disabled={busy}
          />
        </div>

        <div className="subject-dialog__field">
          <label htmlFor="subject-dialog-description">Mô tả</label>
          <textarea
            id="subject-dialog-description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Ghi chú ngắn về môn học"
            disabled={busy}
          />
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

export default SubjectDialog
