import './study.css'

export type StudySourceMeetingOption = {
  id: number
  title: string
  createdAt?: string
}

export type StudySourceSelectorProps = {
  meetings: StudySourceMeetingOption[]
  selectedIds: number[]
  mode: 'ALL_READY' | 'EXPLICIT'
  disabled?: boolean
  onModeChange: (mode: 'ALL_READY' | 'EXPLICIT') => void
  onChange: (meetingIds: number[]) => void
}

export function StudySourceSelector({
  meetings,
  selectedIds,
  mode,
  disabled = false,
  onModeChange,
  onChange,
}: StudySourceSelectorProps) {
  const selected = new Set(selectedIds)

  const toggle = (meetingId: number) => {
    const next = new Set(selected)
    if (next.has(meetingId)) {
      next.delete(meetingId)
    } else {
      next.add(meetingId)
    }
    onChange([...next])
  }

  return (
    <div className="study-source-selector" data-testid="study-source-selector">
      <fieldset className="study-source-selector__modes" disabled={disabled}>
        <legend>Nguồn buổi học</legend>
        <label>
          <input
            type="radio"
            name="study-source-mode"
            checked={mode === 'ALL_READY'}
            onChange={() => onModeChange('ALL_READY')}
          />
          Tất cả buổi đã sẵn sàng
        </label>
        <label>
          <input
            type="radio"
            name="study-source-mode"
            checked={mode === 'EXPLICIT'}
            onChange={() => onModeChange('EXPLICIT')}
          />
          Chọn thủ công
        </label>
      </fieldset>

      {mode === 'EXPLICIT' ? (
        <ul className="study-source-selector__list">
          {meetings.length === 0 ? (
            <li className="study-muted">Chưa có buổi học để chọn.</li>
          ) : (
            meetings.map((meeting) => (
              <li key={meeting.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(meeting.id)}
                    disabled={disabled}
                    onChange={() => toggle(meeting.id)}
                  />
                  <span>{meeting.title || 'Buổi học chưa đặt tên'}</span>
                </label>
              </li>
            ))
          )}
        </ul>
      ) : (
        <p className="study-muted">
          Hệ thống dùng mọi buổi học của môn đã có transcript + educationStudy sẵn sàng.
        </p>
      )}
    </div>
  )
}

export default StudySourceSelector
