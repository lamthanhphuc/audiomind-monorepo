import { useState } from 'react'
import type { StudyArtifactOptions } from '../../types/studyArtifacts'
import './study.css'

export type StudyArtifactOptionsDialogProps = {
  open: boolean
  initial?: StudyArtifactOptions
  onClose: () => void
  onConfirm: (options: StudyArtifactOptions) => void
}

const DEFAULT_OPTIONS: StudyArtifactOptions = {
  language: 'vi',
  difficulty: 'MIXED',
  flashcardCount: 20,
  multipleChoiceCount: 15,
  essayQuestionCount: 5,
}

export function StudyArtifactOptionsDialog({
  open,
  initial,
  onClose,
  onConfirm,
}: StudyArtifactOptionsDialogProps) {
  const [options, setOptions] = useState<StudyArtifactOptions>({
    ...DEFAULT_OPTIONS,
    ...initial,
  })

  if (!open) {
    return null
  }

  return (
    <div className="study-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="study-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="study-options-title"
        data-testid="study-artifact-options-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="study-options-title" className="study-dialog__title">
          Tùy chọn học liệu
        </h2>
        <label className="study-dialog__field">
          Ngôn ngữ
          <select
            value={options.language ?? 'vi'}
            onChange={(event) => setOptions((prev) => ({ ...prev, language: event.target.value }))}
          >
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="study-dialog__field">
          Độ khó
          <select
            value={options.difficulty ?? 'MIXED'}
            onChange={(event) => setOptions((prev) => ({ ...prev, difficulty: event.target.value }))}
          >
            <option value="EASY">Dễ</option>
            <option value="MEDIUM">Trung bình</option>
            <option value="HARD">Khó</option>
            <option value="MIXED">Hỗn hợp</option>
          </select>
        </label>
        <label className="study-dialog__field">
          Số flashcard
          <input
            type="number"
            min={5}
            max={50}
            value={options.flashcardCount ?? 20}
            onChange={(event) =>
              setOptions((prev) => ({ ...prev, flashcardCount: Number(event.target.value) || 20 }))
            }
          />
        </label>
        <label className="study-dialog__field">
          Số câu trắc nghiệm
          <input
            type="number"
            min={5}
            max={40}
            value={options.multipleChoiceCount ?? 15}
            onChange={(event) =>
              setOptions((prev) => ({
                ...prev,
                multipleChoiceCount: Number(event.target.value) || 15,
              }))
            }
          />
        </label>
        <label className="study-dialog__field">
          Số câu tự luận
          <input
            type="number"
            min={1}
            max={15}
            value={options.essayQuestionCount ?? 5}
            onChange={(event) =>
              setOptions((prev) => ({
                ...prev,
                essayQuestionCount: Number(event.target.value) || 5,
              }))
            }
          />
        </label>
        <div className="study-dialog__actions">
          <button type="button" className="btn btn--secondary btn--compact" onClick={onClose}>
            Hủy
          </button>
          <button
            type="button"
            className="btn btn--primary btn--compact"
            onClick={() => onConfirm(options)}
          >
            Áp dụng
          </button>
        </div>
      </div>
    </div>
  )
}

export default StudyArtifactOptionsDialog
