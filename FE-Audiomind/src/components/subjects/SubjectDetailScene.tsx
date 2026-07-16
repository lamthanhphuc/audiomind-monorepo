import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useSubjectDetail } from '../../hooks/useSubjectDetail'
import { useStudyWorkspace } from '../../hooks/useStudyWorkspace'
import { formatDateVi, formatLanguage, formatMeetingStatus } from '../../utils/uiLabels'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
import { SubjectPicker } from './SubjectPicker'
import './subjects.css'

export type SubjectDetailSceneProps = {
  subjectId: number
  onOpenMeeting: (meetingId: number) => void
  onBack: () => void
}

export function SubjectDetailScene({
  subjectId,
  onOpenMeeting,
  onBack,
}: SubjectDetailSceneProps) {
  const [pageIndex, setPageIndex] = useState(1)
  const pageSize = 10
  const { subject, meetingsPage, loading, error } = useSubjectDetail(subjectId, pageIndex, pageSize)
  const { assignMeetingToSubject } = useStudyWorkspace()
  const [rowBusyId, setRowBusyId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const meetings = meetingsPage?.items ?? []
  const totalPages = Math.max(1, meetingsPage?.totalPages ?? 1)

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

      {loading ? <LoadingState message="Đang tải chi tiết môn học…" /> : null}
      {!loading && error ? <ErrorState message={error} title="Không tải được môn học" /> : null}
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
    </section>
  )
}

export default SubjectDetailScene
