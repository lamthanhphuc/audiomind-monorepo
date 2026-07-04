import { useMemo } from 'react'
import MindmapView from '../mindmap/MindmapView'
import type { AiAnalysis, Meeting } from '../../types'

type FeatureMindmapProps = {
  meetings: Meeting[]
  selectedMeetingId?: number | null
  onMeetingSelect: (meetingId: number) => void
  getMeetingLabel: (meeting: Pick<Meeting, 'id' | 'title' | 'originalFileName'>) => string
  analysis: AiAnalysis | null
  onLoadAnalysis: () => Promise<void>
  busy?: boolean
  meetingId?: number | null
  meetingTitle?: string
}

export default function FeatureMindmap({
  meetings,
  selectedMeetingId,
  onMeetingSelect,
  getMeetingLabel,
  analysis,
  onLoadAnalysis,
  busy,
  meetingId,
  meetingTitle,
}: FeatureMindmapProps) {
  const hasAnalysis = useMemo(() => Boolean(analysis), [analysis])
  const hasMeetings = meetings.length > 0

  return (
    <section className="feature-scene feature-mindmap-scene" data-testid="feature-mindmap">
      <header className="feature-mindmap-scene__hero">
        <div className="feature-mindmap-scene__intro">
          <p className="feature-mindmap-scene__eyebrow">SƠ ĐỒ</p>
          <h1>Mindmap cuộc họp</h1>
          <p className="feature-mindmap-scene__subtitle">
            Trực quan hóa từ khóa, thuật ngữ, vấn đề và hành động từ phân tích AI.
          </p>
        </div>
        {hasMeetings ? (
          <label className="feature-mindmap-scene__picker" data-testid="mindmap-meeting-picker">
            <span>Meeting</span>
            <select
              value={selectedMeetingId ?? ''}
              onChange={(event) => {
                const nextId = Number(event.target.value)
                if (Number.isFinite(nextId) && nextId > 0) {
                  onMeetingSelect(nextId)
                }
              }}
            >
              {meetings.map((meeting) => (
                <option key={meeting.id} value={meeting.id}>
                  {getMeetingLabel(meeting)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="feature-mindmap-scene__empty" data-testid="mindmap-empty-meetings">
            Chưa có meeting — hãy phân tích file hoặc ghi âm trước.
          </p>
        )}
      </header>

      {hasMeetings && (
        <MindmapView
          layout="page"
          analysis={analysis}
          meetingId={meetingId}
          meetingTitle={meetingTitle}
          onRefresh={onLoadAnalysis}
          busy={busy}
        />
      )}

      {hasMeetings && !hasAnalysis && (
        <p className="feature-mindmap-scene__hint">
          Chọn một cuộc họp đã phân tích hoặc bấm &quot;Làm mới dữ liệu&quot; sau khi xử lý xong.
        </p>
      )}
    </section>
  )
}
