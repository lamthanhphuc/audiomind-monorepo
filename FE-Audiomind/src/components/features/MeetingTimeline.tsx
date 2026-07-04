import type { TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import type { AiAnalysis } from '../../types'
import { buildTimelineChapters, formatChapterRange, TIMELINE_CHAPTER_GAP_SECONDS, type TimelineChapter } from '../../utils/timelineData'

type Props = {
  segments: TranscriptSegment[]
  analysis?: AiAnalysis | null
  onJumpToChapter?: (chapter: TimelineChapter) => void
}

export default function MeetingTimeline({ segments, analysis, onJumpToChapter }: Props) {
  const chapters = buildTimelineChapters(segments, analysis)

  if (chapters.length === 0) {
    return (
      <section className="meeting-timeline meeting-timeline--empty" data-testid="meeting-timeline">
        <p>Chưa đủ dữ liệu để dựng timeline.</p>
      </section>
    )
  }

  return (
    <section className="meeting-timeline" data-testid="meeting-timeline">
      <header className="meeting-timeline__header">
        <div className="meeting-timeline__heading">
          <h3>Timeline cuộc họp</h3>
          <p>Chương được gom theo khoảng nghỉ ≥ {TIMELINE_CHAPTER_GAP_SECONDS}s trong transcript; tiêu đề ưu tiên từ phân tích AI.</p>
        </div>
      </header>
      <ol className="meeting-timeline__list">
        {chapters.map((chapter: TimelineChapter) => (
          <li key={chapter.id} className="meeting-timeline__item">
            <button
              type="button"
              className="meeting-timeline__jump"
              onClick={() => onJumpToChapter?.(chapter)}
              data-testid={`timeline-jump-${chapter.id}`}
            >
              <strong>{chapter.title}</strong>
              <span>{formatChapterRange(chapter)}</span>
            </button>
            {chapter.summary && <p className="meeting-timeline__summary">{chapter.summary}</p>}
          </li>
        ))}
      </ol>
    </section>
  )
}
