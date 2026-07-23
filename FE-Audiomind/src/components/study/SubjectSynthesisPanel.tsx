import type {
  EvidencedItem,
  GlossaryItem,
  SubjectSynthesis,
  SynthesisChapter,
} from '../../types/subjectSynthesis'
import type { StudyEvidenceSourceLike } from '../../types/studyArtifacts'
import { pickStudyEvidence } from '../../types/studyArtifacts'
import { navigateToSubjectEvidence } from '../../utils/subjectEvidence'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
import './study.css'

export type SubjectSynthesisPanelProps = {
  synthesis: SubjectSynthesis | null
  loading?: boolean
  error?: string | null
  generating?: boolean
  onGenerate?: () => void
  onUpdate?: () => void
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
}

const EvidenceLinks = ({
  source,
  onOpenEvidence,
}: {
  source: StudyEvidenceSourceLike
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
}) => {
  // Prefer the first evidence[] pair (already correlated by the backend)
  // over independently-indexed sourceMeetingIds[0]/sourceSegmentIds[0].
  const evidence = pickStudyEvidence(source)
  if (!evidence) {
    return null
  }
  const { meetingId, segmentId } = evidence
  return (
    <button
      type="button"
      className="btn btn--secondary btn--compact"
      onClick={() => {
        if (onOpenEvidence) {
          onOpenEvidence(meetingId, segmentId)
        } else {
          navigateToSubjectEvidence({ meetingId, segmentId })
        }
      }}
    >
      Xem bằng chứng
    </button>
  )
}

const EvidencedList = ({
  title,
  items,
  onOpenEvidence,
}: {
  title: string
  items?: EvidencedItem[]
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
}) => {
  if (!items?.length) return null
  return (
    <section className="study-section">
      <h3>{title}</h3>
      <ul>
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>
            <div>{item.content}</div>
            <EvidenceLinks source={item} onOpenEvidence={onOpenEvidence} />
          </li>
        ))}
      </ul>
    </section>
  )
}

const GlossaryList = ({
  title,
  items,
  onOpenEvidence,
}: {
  title: string
  items?: GlossaryItem[]
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
}) => {
  if (!items?.length) return null
  return (
    <section className="study-section">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item.term}>
            <strong>{item.term}</strong>: {item.definition}
            <EvidenceLinks source={item} onOpenEvidence={onOpenEvidence} />
          </li>
        ))}
      </ul>
    </section>
  )
}

const ChapterCard = ({
  chapter,
  onOpenEvidence,
}: {
  chapter: SynthesisChapter
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
}) => (
  <article className="study-chapter" data-testid="synthesis-chapter">
    <h3>{chapter.title || 'Chương'}</h3>
    {chapter.summary ? <p>{chapter.summary}</p> : null}
    <EvidencedList title="Ý chính" items={chapter.keyPoints} onOpenEvidence={onOpenEvidence} />
    <GlossaryList title="Thuật ngữ" items={chapter.glossary} onOpenEvidence={onOpenEvidence} />
    <EvidencedList title="Cần nhớ" items={chapter.mustRemember} onOpenEvidence={onOpenEvidence} />
    {chapter.sourceMeetingIds?.length ? (
      <p className="study-muted">Nguồn: buổi {chapter.sourceMeetingIds.map((meetingId) => `mã hỗ trợ #${String(meetingId).slice(-6)}`).join(', ')}</p>
    ) : null}
  </article>
)

export function SubjectSynthesisPanel({
  synthesis,
  loading = false,
  error = null,
  generating = false,
  onGenerate,
  onUpdate,
  onOpenEvidence,
}: SubjectSynthesisPanelProps) {
  if (loading) {
    return <LoadingState message="Đang tải tổng hợp môn học…" />
  }

  const status = String(synthesis?.status ?? '').toUpperCase()
  const inFlight = status === 'QUEUED' || status === 'PROCESSING' || generating
  const content = synthesis?.content

  return (
    <div className="study-synthesis-panel" data-testid="subject-synthesis-panel">
      <div className="study-panel-toolbar">
        <p className="study-muted" data-testid="synthesis-status">
          Trạng thái: {status || 'CHƯA CÓ'}
          {synthesis?.version != null ? ` · v${synthesis.version}` : ''}
        </p>
        <div className="study-panel-toolbar__actions">
          {synthesis?.stale || status === 'STALE' ? (
            <div className="study-stale-banner" data-testid="synthesis-stale-banner">
              <span>Nguồn đã đổi — tổng hợp có thể lỗi thời.</span>
              {onUpdate ? (
                <button type="button" className="btn btn--primary btn--compact" onClick={onUpdate}>
                  Cập nhật
                </button>
              ) : null}
            </div>
          ) : null}
          {onGenerate ? (
            <button
              type="button"
              className="btn btn--primary btn--compact"
              disabled={inFlight}
              onClick={onGenerate}
              data-testid="synthesis-generate-button"
            >
              {inFlight ? 'Đang tổng hợp…' : synthesis ? 'Tạo lại' : 'Tạo tổng hợp'}
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <ErrorState
          message={error}
          title={synthesis ? 'Không tạo được tổng hợp' : 'Không tải được tổng hợp'}
          errorCode={
            /SOURCE_MEETINGS_NOT_READY/i.test(error) ? 'SOURCE_MEETINGS_NOT_READY' : undefined
          }
        />
      ) : null}

      {synthesis?.errorMessage ? (
        <ErrorState message={synthesis.errorMessage} title="Tổng hợp thất bại" />
      ) : null}

      {!content && !inFlight && !error ? (
        <EmptyState message="Chưa có tổng hợp kiến thức cho môn này. Nhấn tạo tổng hợp khi đã có buổi học sẵn sàng." />
      ) : null}

      {inFlight && !content ? <LoadingState message="Đang tổng hợp kiến thức môn học…" /> : null}

      {content ? (
        <>
          {content.subjectOverview ? (
            <section className="study-section">
              <h3>Tổng quan môn học</h3>
              <p>{content.subjectOverview}</p>
            </section>
          ) : null}
          {content.learningObjectives?.length ? (
            <section className="study-section">
              <h3>Mục tiêu học tập</h3>
              <ul>
                {content.learningObjectives.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="study-section">
            <h3>Chương ({content.chapters?.length ?? 0})</h3>
            <div className="study-chapter-list">
              {(content.chapters ?? []).map((chapter) => (
                <ChapterCard key={chapter.id || chapter.title} chapter={chapter} onOpenEvidence={onOpenEvidence} />
              ))}
            </div>
          </section>
          <GlossaryList
            title="Thuật ngữ quan trọng"
            items={content.importantTerms}
            onOpenEvidence={onOpenEvidence}
          />
          <EvidencedList
            title="Cần nhớ"
            items={content.mustRemember}
            onOpenEvidence={onOpenEvidence}
          />
          {content.knowledgeGaps?.length ? (
            <section className="study-section">
              <h3>Khoảng trống kiến thức</h3>
              <ul>
                {content.knowledgeGaps.map((gap, index) => (
                  <li key={`gap-${index}`}>
                    {gap.content}
                    {gap.reason ? <span className="study-muted"> — {gap.reason}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {content.examFocus?.length ? (
            <section className="study-section">
              <h3>Trọng tâm thi</h3>
              <ul>
                {content.examFocus.map((item, index) => (
                  <li key={`exam-${index}`}>
                    {item.content}
                    {item.reason ? <span className="study-muted"> — {item.reason}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {synthesis?.sources?.length || synthesis?.sourceMeetingIds?.length ? (
            <section className="study-section" data-testid="synthesis-sources">
              <h3>Nguồn</h3>
              <p className="study-muted">
                Buổi học:{' '}
                {(synthesis.sourceMeetingIds ?? synthesis.sources?.map((s) => s.meetingId) ?? [])
                  .map((meetingId) => `mã hỗ trợ #${String(meetingId).slice(-6)}`)
                  .join(', ')}
              </p>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

export default SubjectSynthesisPanel
