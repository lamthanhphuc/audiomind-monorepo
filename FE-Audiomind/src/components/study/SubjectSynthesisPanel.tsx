import type {
  EvidencedItem,
  GlossaryItem,
  SubjectSynthesis,
  SynthesisChapter,
} from '../../types/subjectSynthesis'
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileText,
  Layers3,
  Lightbulb,
  Link2,
  ListChecks,
  RefreshCw,
  Sparkles,
  Target,
} from 'lucide-react'
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
      className="study-evidence-link"
      onClick={() => {
        if (onOpenEvidence) {
          onOpenEvidence(meetingId, segmentId)
        } else {
          navigateToSubjectEvidence({ meetingId, segmentId })
        }
      }}
    >
      <Link2 size={14} aria-hidden="true" />
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
    <section className="study-section study-section--compact">
      <h3>{title}</h3>
      <ul className="study-evidenced-list">
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
    <section className="study-section study-section--compact">
      <h3>{title}</h3>
      <ul className="study-glossary-list">
        {items.map((item) => (
          <li key={item.term}>
            <div>
              <strong>{item.term}</strong>
              <span>{item.definition}</span>
            </div>
            <EvidenceLinks source={item} onOpenEvidence={onOpenEvidence} />
          </li>
        ))}
      </ul>
    </section>
  )
}

type SynthesisMapBranch = {
  id: string
  title: string
  sourceCount: number
  summary?: string
  highlights: string[]
}

const uniqueNumberCount = (values?: number[]): number =>
  new Set((values ?? []).filter((value) => Number.isFinite(value))).size

const compactText = (value: string, maxLength = 92): string => {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1).trim()}…`
}

const buildSynthesisMapBranches = (
  chapters: SynthesisChapter[] | undefined,
  fallbackSourceCount: number,
): SynthesisMapBranch[] =>
  (chapters ?? []).slice(0, 8).map((chapter, index) => {
    const keyPoints = (chapter.keyPoints ?? []).map((item) => item.content).filter(Boolean)
    const terms = (chapter.glossary ?? []).map((item) => item.term).filter(Boolean)
    return {
      id: chapter.id || `chapter-${index}`,
      title: chapter.title || `Chương ${index + 1}`,
      sourceCount: uniqueNumberCount(chapter.sourceMeetingIds) || fallbackSourceCount,
      summary: chapter.summary ? compactText(chapter.summary, 120) : undefined,
      highlights: [...keyPoints, ...terms].slice(0, 4).map((item) => compactText(item, 72)),
    }
  })

const SynthesisLearningMap = ({
  title,
  branches,
}: {
  title: string
  branches: SynthesisMapBranch[]
}) => {
  if (!branches.length) return null
  return (
    <section className="study-section study-synthesis-map" data-testid="synthesis-learning-map">
      <div className="study-section__heading">
        <Layers3 size={18} aria-hidden="true" />
        <h3>Mindmap tổng hợp</h3>
      </div>
      <div className="study-synthesis-map__stage">
        <div className="study-synthesis-map__root">
          <span>Môn học</span>
          <strong>{title}</strong>
        </div>
        <div className="study-synthesis-map__branches">
          {branches.map((branch) => (
            <article className="study-synthesis-map__branch" key={branch.id}>
              <header>
                <strong>{branch.title}</strong>
                <span>{branch.sourceCount} audio</span>
              </header>
              {branch.summary ? <p>{branch.summary}</p> : null}
              {branch.highlights.length ? (
                <ul>
                  {branch.highlights.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      </div>
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
    <header className="study-chapter__header">
      <span className="study-chapter__icon" aria-hidden="true">
        <BookOpen size={16} />
      </span>
      <div>
        <h3>{chapter.title || 'Chương'}</h3>
        {chapter.sourceMeetingIds?.length ? (
          <p className="study-muted">
            {chapter.sourceMeetingIds.length} nguồn học
          </p>
        ) : null}
      </div>
    </header>
    {chapter.summary ? <p className="study-chapter__summary">{chapter.summary}</p> : null}
    <div className="study-chapter__body">
      <EvidencedList title="Ý chính" items={chapter.keyPoints} onOpenEvidence={onOpenEvidence} />
      <GlossaryList title="Thuật ngữ" items={chapter.glossary} onOpenEvidence={onOpenEvidence} />
      <EvidencedList title="Cần nhớ" items={chapter.mustRemember} onOpenEvidence={onOpenEvidence} />
    </div>
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
  const chapterCount = content?.chapters?.length ?? 0
  const sourceCount = synthesis?.sourceMeetingIds?.length ?? synthesis?.sources?.length ?? 0
  const objectiveCount = content?.learningObjectives?.length ?? 0
  const termCount = content?.importantTerms?.length ?? 0
  const statusLabel = status || 'CHUA CO'
  const mapBranches = buildSynthesisMapBranches(content?.chapters, sourceCount)
  const synthesisTitle =
    content?.subjectOverview?.split(/[.!?。]/)[0]?.trim() ||
    synthesis?.title ||
    'Tổng hợp môn học'

  return (
    <div className="study-synthesis-panel" data-testid="subject-synthesis-panel">
      <header className="study-synthesis-hero">
        <div className="study-synthesis-hero__main">
          <span className={`study-status-pill study-status-pill--${statusLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} data-testid="synthesis-status">
            {inFlight ? <RefreshCw size={14} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}
            {status || 'Chưa có'}
            {synthesis?.version != null ? ` · v${synthesis.version}` : ''}
          </span>
          <h2>Tổng hợp môn học</h2>
          <p>
            Biến các buổi học đã phân tích thành một bản đọc có cấu trúc: tổng quan, mục tiêu,
            chương, thuật ngữ và trọng tâm cần nhớ.
          </p>
        </div>
        <div className="study-panel-toolbar__actions">
          {synthesis?.stale || status === 'STALE' ? (
            <div className="study-stale-banner" data-testid="synthesis-stale-banner">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>Nguồn đã đổi, tổng hợp có thể lỗi thời.</span>
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
              <RefreshCw size={15} aria-hidden="true" />
              {inFlight ? 'Đang tổng hợp...' : synthesis ? 'Tạo lại' : 'Tạo tổng hợp'}
            </button>
          ) : null}
        </div>
      </header>

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
        <div className="study-synthesis-layout">
          <aside className="study-synthesis-summary" aria-label="Tóm tắt tổng hợp">
            <div className="study-summary-card">
              <Sparkles size={18} aria-hidden="true" />
              <span>{chapterCount}</span>
              <p>Chương</p>
            </div>
            <div className="study-summary-card">
              <Target size={18} aria-hidden="true" />
              <span>{objectiveCount}</span>
              <p>Mục tiêu</p>
            </div>
            <div className="study-summary-card">
              <Lightbulb size={18} aria-hidden="true" />
              <span>{termCount}</span>
              <p>Thuật ngữ</p>
            </div>
            <div className="study-summary-card">
              <FileText size={18} aria-hidden="true" />
              <span>{sourceCount}</span>
              <p>Nguồn</p>
            </div>
          </aside>

          <div className="study-synthesis-content">
          {content.subjectOverview ? (
            <section className="study-section study-section--lead">
              <div className="study-section__heading">
                <Layers3 size={18} aria-hidden="true" />
                <h3>Tổng quan môn học</h3>
              </div>
              <p>{content.subjectOverview}</p>
            </section>
          ) : null}
          <SynthesisLearningMap title={synthesisTitle} branches={mapBranches} />
          {content.learningObjectives?.length ? (
            <section className="study-section">
              <div className="study-section__heading">
                <Target size={18} aria-hidden="true" />
                <h3>Mục tiêu học tập</h3>
              </div>
              <ul className="study-check-list">
                {content.learningObjectives.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="study-section">
            <div className="study-section__heading">
              <BookOpen size={18} aria-hidden="true" />
              <h3>Chương ({content.chapters?.length ?? 0})</h3>
            </div>
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
              <div className="study-section__heading">
                <AlertTriangle size={18} aria-hidden="true" />
                <h3>Khoảng trống kiến thức</h3>
              </div>
              <ul className="study-evidenced-list">
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
              <div className="study-section__heading">
                <ListChecks size={18} aria-hidden="true" />
                <h3>Trọng tâm thi</h3>
              </div>
              <ul className="study-evidenced-list">
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
              <div className="study-section__heading">
                <FileText size={18} aria-hidden="true" />
                <h3>Nguồn</h3>
              </div>
              <p className="study-muted">
                Buổi học:{' '}
                {(synthesis.sourceMeetingIds ?? synthesis.sources?.map((s) => s.meetingId) ?? [])
                  .map((meetingId) => `mã hỗ trợ #${String(meetingId).slice(-6)}`)
                  .join(', ')}
              </p>
            </section>
          ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default SubjectSynthesisPanel
