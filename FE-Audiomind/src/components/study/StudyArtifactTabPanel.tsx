import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StudyArtifact, StudyArtifactOptions, StudyArtifactType } from '../../types/studyArtifacts'
import type { StudySourceSelectionMode } from '../../types/subjectSynthesis'
import {
  createStudyArtifacts,
  deleteStudyArtifact,
  isStudyArtifactTerminal,
  listSubjectStudyArtifacts,
  pickRegeneratedArtifact,
  pollStudyArtifactsUntilTerminal,
  regenerateStudyArtifact,
} from '../../services/studyArtifacts'
import { ConfirmDialog } from '../subjects/ConfirmDialog'
import { StudyArtifactGenerator } from './StudyArtifactGenerator'
import { SubjectMindMapView } from './SubjectMindMapView'
import { FlashcardDeck } from './FlashcardDeck'
import { MultipleChoiceQuiz } from './MultipleChoiceQuiz'
import { EssayQuestionList } from './EssayQuestionList'
import { ExamBriefPanel } from './ExamBriefPanel'
import type { StudySourceMeetingOption } from './StudySourceSelector'
import type {
  EssayContent,
  ExamBriefContent,
  FlashcardsContent,
  MindMapContent,
  MultipleChoiceContent,
} from '../../types/studyArtifacts'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
import './study.css'

export type StudyArtifactTabPanelProps = {
  subjectId: number
  artifactType: StudyArtifactType
  meetings: StudySourceMeetingOption[]
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
}

const pickLatest = (artifacts: StudyArtifact[]): StudyArtifact | null => {
  if (!artifacts.length) return null
  return [...artifacts].sort((a, b) => {
    if (b.version !== a.version) return b.version - a.version
    return (b.id ?? 0) - (a.id ?? 0)
  })[0] ?? null
}

export function StudyArtifactTabPanel({
  subjectId,
  artifactType,
  meetings,
  onOpenEvidence,
}: StudyArtifactTabPanelProps) {
  const [artifact, setArtifact] = useState<StudyArtifact | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [aggregateStatus, setAggregateStatus] = useState<string | null>(null)
  const [pollingArtifacts, setPollingArtifacts] = useState<StudyArtifact[]>([])
  const pollAbortRef = useRef<AbortController | null>(null)

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const loadLatest = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const items = await listSubjectStudyArtifacts(subjectId, { artifactType })
      setArtifact(pickLatest(items))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Không tải được học liệu')
    } finally {
      setLoading(false)
    }
  }, [artifactType, subjectId])

  useEffect(() => {
    void loadLatest()
    return () => {
      pollAbortRef.current?.abort()
    }
  }, [loadLatest])

  const startPoll = useCallback(async (artifactIds: number[]) => {
    pollAbortRef.current?.abort()
    const controller = new AbortController()
    pollAbortRef.current = controller
    setBusy(true)
    setPollingArtifacts([])
    try {
      const result = await pollStudyArtifactsUntilTerminal(artifactIds, {
        signal: controller.signal,
        onUpdate: (snapshot) => {
          setAggregateStatus(snapshot.aggregateStatus)
          setPollingArtifacts(snapshot.artifacts)
          const match = snapshot.artifacts.find((row) => row.artifactType === artifactType)
          // Only swap the displayed artifact once the regenerated/newly
          // generated version reaches a terminal status; otherwise keep
          // showing the previous (stale) content instead of a content-less
          // QUEUED/PROCESSING row.
          if (match && isStudyArtifactTerminal(String(match.status))) {
            setArtifact(match)
          }
        },
      })
      setAggregateStatus(result.aggregateStatus)
      setPollingArtifacts([])
      const match = result.artifacts.find((row) => row.artifactType === artifactType) ?? result.artifacts[0]
      if (match) {
        setArtifact(match)
      }
    } catch (pollError) {
      if (pollError instanceof DOMException && pollError.name === 'AbortError') {
        return
      }
      setError(pollError instanceof Error ? pollError.message : 'Poll học liệu thất bại')
    } finally {
      setBusy(false)
      setPollingArtifacts([])
    }
  }, [artifactType])

  const handleGenerate = async (input: {
    meetingIds: number[]
    sourceSelectionMode: StudySourceSelectionMode
    options: StudyArtifactOptions
    force?: boolean
  }) => {
    setError(null)
    setBusy(true)
    try {
      const response = await createStudyArtifacts({
        subjectId,
        meetingIds: input.meetingIds,
        artifactTypes: [artifactType],
        sourceSelectionMode: input.sourceSelectionMode,
        options: input.options,
        force: input.force,
      })
      setAggregateStatus(String(response.status))
      const first = response.artifacts.find((row) => row.artifactType === artifactType) ?? response.artifacts[0]
      if (first) {
        setArtifact(first)
      }
      const idsToPoll = response.artifactIds.filter((id) => {
        const row = response.artifacts.find((a) => a.id === id)
        if (!row) return true
        const status = String(row.status).toUpperCase()
        return status === 'QUEUED' || status === 'PROCESSING'
      })
      if (idsToPoll.length > 0) {
        await startPoll(idsToPoll)
      } else {
        setBusy(false)
      }
    } catch (generateError) {
      setBusy(false)
      setError(generateError instanceof Error ? generateError.message : 'Không tạo được học liệu')
    }
  }

  const handleUpdate = async () => {
    if (!artifact) return
    setBusy(true)
    setError(null)
    try {
      const response = await regenerateStudyArtifact(artifact.id)
      setAggregateStatus(String(response.status))
      const { artifact: regenerated, pollIds } = pickRegeneratedArtifact(response)
      if (pollIds.length > 0) {
        // Keep showing the current (stale) content while the regenerated
        // artifact is still QUEUED/PROCESSING; the poll's onUpdate callback
        // swaps `artifact` in once it reaches a terminal status.
        await startPoll(pollIds)
      } else {
        if (regenerated) {
          setArtifact(regenerated)
        }
        setBusy(false)
      }
    } catch (updateError) {
      setBusy(false)
      setError(updateError instanceof Error ? updateError.message : 'Không cập nhật được học liệu')
    }
  }

  const handleDeleteConfirm = async () => {
    if (!artifact || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await deleteStudyArtifact(artifact.id)
      setDeleteOpen(false)
      setArtifact(null)
      await loadLatest()
    } catch (deleteErr) {
      setDeleteError(deleteErr instanceof Error ? deleteErr.message : 'Không xóa được học liệu')
    } finally {
      setDeleteBusy(false)
    }
  }

  const contentView = useMemo(() => {
    if (!artifact?.content) {
      return null
    }
    switch (artifactType) {
      case 'MIND_MAP':
        return (
          <SubjectMindMapView
            content={artifact.content as MindMapContent}
            onOpenEvidence={onOpenEvidence}
          />
        )
      case 'FLASHCARDS':
        return (
          <FlashcardDeck
            cards={(artifact.content as FlashcardsContent).cards ?? []}
            onOpenEvidence={onOpenEvidence}
          />
        )
      case 'MULTIPLE_CHOICE':
        return (
          <MultipleChoiceQuiz
            questions={(artifact.content as MultipleChoiceContent).questions ?? []}
            onOpenEvidence={onOpenEvidence}
          />
        )
      case 'ESSAY_QUESTIONS':
        return (
          <EssayQuestionList
            questions={(artifact.content as EssayContent).questions ?? []}
            onOpenEvidence={onOpenEvidence}
          />
        )
      case 'EXAM_BRIEF':
        return <ExamBriefPanel content={artifact.content as ExamBriefContent} />
      default:
        return null
    }
  }, [artifact, artifactType, onOpenEvidence])

  const status = String(artifact?.status ?? '').toUpperCase()
  const showStale = Boolean(artifact?.stale || status === 'STALE')

  return (
    <div className="subjects-tab-panel" data-testid={`study-artifact-tab-${artifactType}`}>
      <StudyArtifactGenerator
        subjectId={subjectId}
        meetings={meetings}
        artifactTypes={[artifactType]}
        busy={busy}
        aggregateStatus={aggregateStatus ?? (status || null)}
        onGenerate={handleGenerate}
      />

      {showStale ? (
        <div className="study-stale-banner" data-testid="artifact-stale-banner">
          <span>Nguồn đã đổi — học liệu có thể lỗi thời.</span>
          <button type="button" className="btn btn--primary btn--compact" onClick={() => void handleUpdate()}>
            Cập nhật
          </button>
        </div>
      ) : null}

      {/* Toolbar shown when an artifact is loaded — provides delete action */}
      {!loading && artifact ? (
        <div className="study-panel-toolbar" data-testid="artifact-toolbar">
          <span className="study-muted">
            {artifact.title ?? artifact.artifactType}
            {artifact.version > 1 ? ` (v${artifact.version})` : ''}
          </span>
          <div className="study-panel-toolbar__actions">
            <button
              type="button"
              className="btn btn--danger btn--compact"
              data-testid="artifact-delete-btn"
              disabled={busy || deleteBusy}
              onClick={() => {
                setDeleteError(null)
                setDeleteOpen(true)
              }}
            >
              Xóa học liệu
            </button>
          </div>
        </div>
      ) : null}

      {/* Per-artifact status list during polling so users see individual progress */}
      {busy && pollingArtifacts.length > 0 ? (
        <ul className="study-polling-status" data-testid="polling-status-list">
          {pollingArtifacts.map((row) => (
            <li key={row.id} data-testid={`polling-status-item-${row.artifactType}`}>
              <span className="study-muted">{row.artifactType}:</span>{' '}
              <span>{String(row.status)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {loading ? <LoadingState message="Đang tải học liệu…" /> : null}
      {!loading && error ? <ErrorState message={error} title="Lỗi học liệu" /> : null}
      {!loading && !error && !artifact && !busy ? (
        <EmptyState message="Chưa có học liệu. Chọn nguồn rồi nhấn Tạo học liệu (không tự tạo khi mở tab)." />
      ) : null}
      {!loading && artifact?.errorMessage ? (
        <ErrorState message={artifact.errorMessage} title="Tạo học liệu thất bại" />
      ) : null}
      {busy && !artifact?.content ? <LoadingState message="Đang tạo học liệu…" /> : null}
      {contentView}

      <ConfirmDialog
        open={deleteOpen}
        title="Xóa học liệu"
        message="Bạn có chắc muốn xóa học liệu này? Hành động không thể hoàn tác."
        confirmLabel="Xóa"
        tone="danger"
        busy={deleteBusy}
        error={deleteError}
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => {
          if (!deleteBusy) {
            setDeleteOpen(false)
            setDeleteError(null)
          }
        }}
        testId="artifact-delete-dialog"
      />
    </div>
  )
}

export default StudyArtifactTabPanel
