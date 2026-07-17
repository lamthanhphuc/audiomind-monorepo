import { useStudyWorkspace } from '../../hooks/useStudyWorkspace'
import './subjects.css'

export type SubjectPickerProps = {
  value: number | null
  onChange: (id: number | null) => void
  disabled?: boolean
  allowClear?: boolean
  label?: string
  id?: string
}

export function SubjectPicker({
  value,
  onChange,
  disabled = false,
  allowClear = true,
  label = 'Môn học',
  id = 'subject-picker',
}: SubjectPickerProps) {
  const { catalogSubjects, catalogLoading } = useStudyWorkspace()

  return (
    <div className="subject-picker">
      {label ? (
        <label className="subject-picker__label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <select
        id={id}
        className="subject-picker__select"
        value={value == null ? '' : String(value)}
        disabled={disabled || catalogLoading}
        onChange={(event) => {
          const raw = event.target.value
          if (!raw) {
            onChange(null)
            return
          }
          const next = Number(raw)
          onChange(Number.isFinite(next) ? next : null)
        }}
        data-testid="subject-picker"
      >
        {allowClear ? (
          <option value="">Không chọn môn</option>
        ) : (
          <option value="" disabled>
            Chọn môn học
          </option>
        )}
        {catalogSubjects.map((subject) => (
          <option key={subject.id} value={subject.id}>
            {subject.code ? `${subject.code} — ${subject.name}` : subject.name}
          </option>
        ))}
      </select>
    </div>
  )
}

export default SubjectPicker
