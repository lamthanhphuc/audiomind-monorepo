import type { ExamBriefContent } from '../../types/studyArtifacts'
import { EmptyState } from '../ui/EmptyState'
import './study.css'

export type ExamBriefPanelProps = {
  content: ExamBriefContent | null | undefined
  // Note: ExamBriefContent has no per-item sourceSegmentIds or evidence fields
  // (only a top-level sourceMeetingIds array). Per-item evidence buttons cannot
  // be wired because there is no segmentId to navigate to. If the backend ever
  // adds evidence[] or sourceSegmentIds to individual ExamBrief items, wire
  // onOpenEvidence here analogously to FlashcardViewer / QuizQuestion.
}

const ListSection = ({ title, items }: { title: string; items?: string[] }) => {
  if (!items?.length) return null
  return (
    <section className="study-section">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  )
}

export function ExamBriefPanel({ content }: ExamBriefPanelProps) {
  if (!content) {
    return <EmptyState message="Chưa có bản ôn thi nhanh." />
  }

  return (
    <div className="study-exam-brief" data-testid="exam-brief-panel">
      <p className="study-exam-brief__disclaimer" data-testid="exam-brief-disclaimer">
        Chủ đề thi mang tính gợi ý từ nội dung buổi học đã chọn — không phải đề thi chính thức.
      </p>
      {content.overview ? (
        <section className="study-section">
          <h3>Tổng quan</h3>
          <p>{content.overview}</p>
        </section>
      ) : null}
      <ListSection title="Cần nhớ" items={content.mustRemember} />
      <ListSection title="Thuật ngữ quan trọng" items={content.importantTerms} />
      {/* Hide formulas heading when empty */}
      {content.formulas?.length ? (
        <ListSection title="Công thức" items={content.formulas} />
      ) : null}
      <ListSection title="Lỗi thường gặp" items={content.commonMistakes} />
      <ListSection title="Chủ đề có thể ra thi" items={content.likelyExamTopics} />
      <ListSection title="Checklist phút chót" items={content.lastMinuteChecklist} />
    </div>
  )
}

export default ExamBriefPanel
