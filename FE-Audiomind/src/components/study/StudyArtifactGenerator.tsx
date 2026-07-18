import { useState } from 'react'
import type { StudyArtifactOptions, StudyArtifactType } from '../../types/studyArtifacts'
import type { StudySourceSelectionMode } from '../../types/subjectSynthesis'
import { StudyArtifactOptionsDialog } from './StudyArtifactOptionsDialog'
import { StudySourceSelector, type StudySourceMeetingOption } from './StudySourceSelector'
import './study.css'

export type StudyArtifactGeneratorProps = {
  subjectId: number
  meetings: StudySourceMeetingOption[]
  artifactTypes: StudyArtifactType[]
  busy?: boolean
  aggregateStatus?: string | null
  onGenerate: (input: {
    meetingIds: number[]
    sourceSelectionMode: StudySourceSelectionMode
    options: StudyArtifactOptions
    force?: boolean
  }) => void | Promise<void>
}

export function StudyArtifactGenerator({
  meetings,
  artifactTypes,
  busy = false,
  aggregateStatus,
  onGenerate,
}: StudyArtifactGeneratorProps) {
  const [mode, setMode] = useState<StudySourceSelectionMode>('ALL_READY')
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [options, setOptions] = useState<StudyArtifactOptions>({
    language: 'vi',
    difficulty: 'MIXED',
    flashcardCount: 20,
    multipleChoiceCount: 15,
    essayQuestionCount: 5,
  })
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  const handleGenerate = (force = false) => {
    setValidationError(null)
    if (artifactTypes.length === 0) {
      setValidationError('Chưa chọn loại học liệu.')
      return
    }
    if (mode === 'EXPLICIT' && selectedIds.length === 0) {
      setValidationError('Hãy chọn ít nhất một buổi học nguồn.')
      return
    }
    void onGenerate({
      meetingIds: mode === 'EXPLICIT' ? selectedIds : [],
      sourceSelectionMode: mode,
      options,
      force,
    })
  }

  return (
    <div className="study-generator" data-testid="study-artifact-generator">
      <StudySourceSelector
        meetings={meetings}
        selectedIds={selectedIds}
        mode={mode}
        disabled={busy}
        onModeChange={setMode}
        onChange={setSelectedIds}
      />
      <div className="study-generator__actions">
        <button
          type="button"
          className="btn btn--secondary btn--compact"
          disabled={busy}
          onClick={() => setOptionsOpen(true)}
        >
          Tùy chọn
        </button>
        <button
          type="button"
          className="btn btn--primary btn--compact"
          disabled={busy}
          onClick={() => handleGenerate(false)}
          data-testid="study-generate-button"
        >
          {busy ? 'Đang tạo…' : 'Tạo học liệu'}
        </button>
      </div>
      {aggregateStatus ? (
        <p className="study-muted" data-testid="study-aggregate-status">
          Trạng thái: {aggregateStatus}
        </p>
      ) : null}
      {validationError ? (
        <p className="study-error" role="alert">
          {validationError}
        </p>
      ) : null}
      <StudyArtifactOptionsDialog
        open={optionsOpen}
        initial={options}
        onClose={() => setOptionsOpen(false)}
        onConfirm={(next) => {
          setOptions(next)
          setOptionsOpen(false)
        }}
      />
    </div>
  )
}

export default StudyArtifactGenerator
