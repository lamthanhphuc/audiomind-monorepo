import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useSubjectDetail } from '../../hooks/useSubjectDetail'
import { useStudyWorkspace } from '../../hooks/useStudyWorkspace'
import {
  createSubjectSynthesis,
  getSubjectSynthesis,
  pollSubjectSynthesisUntilTerminal,
  regenerateSubjectSynthesis,
} from '../../services/subjectSynthesis'
import type { SubjectSynthesis } from '../../types/subjectSynthesis'
import { formatDateVi, formatLanguage, formatMeetingStatus } from '../../utils/uiLabels'
import {
  SUBJECT_DETAIL_TABS,
  SUBJECT_TAB_LABELS,
  artifactTypeForTab,
  type SubjectDetailTab,
} from '../../utils/subjectTabs'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
import { SubjectPicker } from './SubjectPicker'
import { SubjectSynthesisPanel } from '../study/SubjectSynthesisPanel'
import { StudyArtifactTabPanel } from '../study/StudyArtifactTabPanel'
import '../study/study.css'
import './subjects.css'

export type SubjectDetailSceneProps = {
  subjectId: number
  activeTab?: SubjectDetailTab
  onTabChange?: (tab: SubjectDetailTab) => void
  onOpenMeeting: (meetingId: number) => void
  onOpenEvidence?: (meetingId: number, segmentId: string) => void
  onBack: () => void
}

function MeetingsTab({
  subjectId,
  onOpenMeeting,
}: {
  subjectId: number
  onOpenMeeting: (meetingId: number) => void
}) {
  const [pageIndex, setPageIndex] = useState(1)
  const pageSize = 10
  const { meetingsPage, loading, error } = useSubjectDetail(subjectId, pageIndex, pageSize)
  const { assignMeetingToSubject } = useStudyWorkspace()
  const [rowBusyId, setRowBusyId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const meetings = meetingsPage?.items ?? []
  const total = meetingsPage?.total ?? 0
  const totalPages = Math.max(1, meetingsPage?.totalPages ?? 1)

  useEffect(() => {
    if (total === 0) {
      if (pageIndex !== 1) setPageIndex(1)
      return
    }
    if (pageIndex > totalPages) {
      setPageIndex(totalPages)
    }
  }, [pageIndex, total, totalPages])

  const handleChangeSubject = async (meetingId: number, nextSubjectId: number | null) => {
    setRowBusyId(meetingId)
    setActionError(null)
    try {
      await assignMeetingToSubject(meetingId, nextSubjectId)
    } catch (assignError) {
      setActionError(assignError instanceof Error ? assignError.message : 'Không đổi được môn')
    } finally {
      setRowBusyId(null)
    }
  }

  const handleRemoveSubject = async (meetingId: number) => {
    await handleChangeSubject(meetingId, null)
  }

  return (
    <div className="subjects-tab-panel" data-testid="subject-meetings-tab">
      {loading ? <LoadingState message="Đang tải buổi học…" /> : null}
      {!loading && error ? <ErrorState message={error} title="Không tải được buổi học" /> : null}
      {actionError ? <ErrorState message={actionError} title="Thao tác thất bại" /> : null}

      {!loading && !error ? (
        <>
          {meetings.length === 0 ? (
            <EmptyState message="Chưa có cuộc họp nào thuộc môn này." />
          ) : (
            <div className="subjects-table-wrap">
              <table className="subjects-table">
                <thead>
                  <tr>
                    <th>Tiêu đề</th>
                    <th>Ngày tạo</th>
                    <th>Ngôn ngữ</th>
                    <th>Trạng thái</th>
                    <th>Đổi môn</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {meetings.map((meeting) => {
                    const busy = rowBusyId === meeting.id
                    return (
                      <tr key={meeting.id}>
                        <td>{meeting.title || `Meeting #${meeting.id}`}</td>
                        <td>{formatDateVi(meeting.createdAt)}</td>
                        <td>{formatLanguage(String(meeting.language ?? 'vi'))}</td>
                        <td>{formatMeetingStatus(String(meeting.status ?? ''))}</td>
                        <td>
                          <SubjectPicker
                            id={`subject-detail-picker-${meeting.id}`}
                            label=""
                            value={meeting.subjectId ?? subjectId}
                            disabled={busy}
                            allowClear
                            onChange={(nextId) => {
                              void handleChangeSubject(meeting.id, nextId)
                            }}
                          />
                        </td>
                        <td>
                          <div className="subjects-table__actions">
                            <button
                              type="button"
                              className="btn btn--primary btn--compact"
                              onClick={() => onOpenMeeting(meeting.id)}
                              disabled={busy}
                            >
                              Mở
                            </button>
                            <button
                              type="button"
                              className="btn btn--secondary btn--compact"
                              onClick={() => void handleRemoveSubject(meeting.id)}
                              disabled={busy}
                            >
                              Gỡ môn
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 ? (
            <div className="subjects-pagination">
              <button
                type="button"
                className="btn btn--secondary btn--compact"
                disabled={pageIndex <= 1}
                onClick={() => setPageIndex((value) => Math.max(1, value - 1))}
              >
                Trang trước
              </button>
              <span className="subjects-meta">
                Trang {pageIndex}/{totalPages}
              </span>
              <button
                type="button"
                className="btn btn--secondary btn--compact"
                disabled={pageIndex >= totalPages}
                onClick={() => setPageIndex((value) => Math.min(totalPages, value + 1))}
              >
                Trang sau
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

export function SubjectDetailScene({
  subjectId,
  activeTab = 'meetings',
  onTabChange,
  onOpenMeeting,
  onOpenEvidence,
  onBack,
}: SubjectDetailSceneProps) {
  const { subject, meetingsPage, error } = useSubjectDetail(subjectId, 1, 100)
  const [tab, setTab] = useState<SubjectDetailTab>(activeTab)
  const [synthesis, setSynthesis] = useState<SubjectSynthesis | null>(null)
  const [synthesisLoading, setSynthesisLoading] = useState(false)
  const [synthesisError, setSynthesisError] = useState<string | null>(null)
  const [synthesisBusy, setSynthesisBusy] = useState(false)
  const synthesisPollRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setTab(activeTab)
  }, [activeTab])

  const meetingOptions = useMemo(
    () =>
      (meetingsPage?.items ?? []).map((meeting) => ({
        id: meeting.id,
        title: meeting.title || `Meeting #${meeting.id}`,
        createdAt: meeting.createdAt,
      })),
    [meetingsPage?.items],
  )

  const handleTabChange = (next: SubjectDetailTab) => {
    setTab(next)
    onTabChange?.(next)
  }

  const loadSynthesis = useCallback(async () => {
    setSynthesisLoading(true)
    setSynthesisError(null)
    try {
      const current = await getSubjectSynthesis(subjectId)
      setSynthesis(current)
    } catch (loadError) {
      setSynthesisError(loadError instanceof Error ? loadError.message : 'Không tải được tổng hợp')
    } finally {
      setSynthesisLoading(false)
    }
  }, [subjectId])

  useEffect(() => {
    if (tab !== 'synthesis') return
    void loadSynthesis()
    return () => {
      synthesisPollRef.current?.abort()
    }
  }, [loadSynthesis, tab])

  const pollSynthesis = useCallback(async () => {
    synthesisPollRef.current?.abort()
    const controller = new AbortController()
    synthesisPollRef.current = controller
    setSynthesisBusy(true)
    try {
      const result = await pollSubjectSynthesisUntilTerminal(subjectId, {
        signal: controller.signal,
        onUpdate: setSynthesis,
      })
      setSynthesis(result)
    } catch (pollError) {
      if (pollError instanceof DOMException && pollError.name === 'AbortError') {
        return
      }
      setSynthesisError(pollError instanceof Error ? pollError.message : 'Poll tổng hợp thất bại')
    } finally {
      setSynthesisBusy(false)
    }
  }, [subjectId])

  const handleGenerateSynthesis = async () => {
    setSynthesisBusy(true)
    setSynthesisError(null)
    try {
      const created = synthesis
        ? await regenerateSubjectSynthesis(subjectId, { sourceSelectionMode: 'ALL_READY', force: true })
        : await createSubjectSynthesis(subjectId, { sourceSelectionMode: 'ALL_READY' })
      setSynthesis(created)
      const status = String(created.status).toUpperCase()
      if (status === 'QUEUED' || status === 'PROCESSING') {
        await pollSynthesis()
      } else {
        setSynthesisBusy(false)
      }
    } catch (generateError) {
      setSynthesisBusy(false)
      setSynthesisError(generateError instanceof Error ? generateError.message : 'Không tạo được tổng hợp')
    }
  }

  const artifactType = artifactTypeForTab(tab)

  return (
    <section className="subjects-scene" data-testid="subject-detail-scene">
      <header className="subjects-scene__header">
        <div>
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            onClick={onBack}
            data-testid="subject-detail-back"
          >
            <ArrowLeft size={14} aria-hidden /> Quay lại
          </button>
          <h1 className="subjects-scene__title" style={{ marginTop: 12 }}>
            {subject?.color ? (
              <span
                className="subjects-color-swatch"
                style={{ background: subject.color }}
                aria-hidden
              />
            ) : null}
            {subject?.name || `Môn #${subjectId}`}
          </h1>
          {subject ? (
            <p className="subjects-meta">
              {[subject.code, subject.semester, `${subject.meetingCount ?? meetingsPage?.total ?? 0} cuộc họp`]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
        </div>
      </header>

      {subject?.archivedAt ? (
        <p className="subjects-archived-banner" data-testid="subject-detail-archived-banner">
          Môn học này đã được lưu trữ. Bạn vẫn có thể xem cuộc họp nhưng không thể gán môn học mới cho các cuộc họp khác.
        </p>
      ) : null}

      {error && tab !== 'meetings' ? <ErrorState message={error} title="Không tải được môn học" /> : null}

      <nav className="subjects-tabs" aria-label="Subject detail tabs" data-testid="subject-detail-tabs">
        {SUBJECT_DETAIL_TABS.map((item) => (
          <button
            key={item}
            type="button"
            className={`subjects-tabs__tab${tab === item ? ' subjects-tabs__tab--active' : ''}`}
            aria-selected={tab === item}
            data-testid={`subject-tab-${item}`}
            onClick={() => handleTabChange(item)}
          >
            {SUBJECT_TAB_LABELS[item]}
          </button>
        ))}
      </nav>

      {tab === 'meetings' ? (
        <MeetingsTab subjectId={subjectId} onOpenMeeting={onOpenMeeting} />
      ) : null}

      {tab === 'synthesis' ? (
        <SubjectSynthesisPanel
          synthesis={synthesis}
          loading={synthesisLoading}
          error={synthesisError}
          generating={synthesisBusy}
          onGenerate={() => void handleGenerateSynthesis()}
          onUpdate={() => void handleGenerateSynthesis()}
          onOpenEvidence={onOpenEvidence}
        />
      ) : null}

      {artifactType ? (
        <StudyArtifactTabPanel
          subjectId={subjectId}
          artifactType={artifactType}
          meetings={meetingOptions}
          onOpenEvidence={onOpenEvidence}
        />
      ) : null}
    </section>
  )
}

export default SubjectDetailScene
