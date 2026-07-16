import { useEffect, useState } from 'react'
import { useUnclassifiedMeetings } from '../../hooks/useUnclassifiedMeetings'
import { useStudyWorkspace } from '../../hooks/useStudyWorkspace'
import { formatDateVi, formatLanguage, formatMeetingStatus } from '../../utils/uiLabels'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
import { SubjectPicker } from './SubjectPicker'
import './subjects.css'

export type UnclassifiedMeetingsSceneProps = {
  onOpenMeeting: (meetingId: number) => void
}

export function UnclassifiedMeetingsScene({
  onOpenMeeting,
}: UnclassifiedMeetingsSceneProps) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [pageIndex, setPageIndex] = useState(1)
  const pageSize = 10
  const [rowBusyId, setRowBusyId] = useState<number | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPageIndex(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search])

  const { page, loading, error } = useUnclassifiedMeetings({
    search: debouncedSearch || undefined,
    page: pageIndex,
    pageSize,
    sort: 'created_desc',
  })
  const { assignMeetingToSubject } = useStudyWorkspace()

  const items = page?.items ?? []
  const total = page?.total ?? 0
  const totalPages = Math.max(1, page?.totalPages ?? 1)

  useEffect(() => {
    if (total === 0) {
      if (pageIndex !== 1) setPageIndex(1)
      return
    }
    if (pageIndex > totalPages) {
      setPageIndex(totalPages)
    }
  }, [pageIndex, total, totalPages])

  const handleAssign = async (meetingId: number, subjectId: number | null) => {
    if (subjectId == null) return
    setRowBusyId(meetingId)
    setActionError(null)
    try {
      await assignMeetingToSubject(meetingId, subjectId)
    } catch (assignError) {
      setActionError(assignError instanceof Error ? assignError.message : 'Không gán được môn')
    } finally {
      setRowBusyId(null)
    }
  }

  return (
    <section className="subjects-scene" data-testid="unclassified-meetings-scene">
      <header className="subjects-scene__header">
        <div>
          <h1 className="subjects-scene__title">Cuộc họp chưa phân loại</h1>
          <p className="subjects-meta">Gán môn học để tổ chức lại lịch sử học tập</p>
        </div>
        <div className="subjects-scene__toolbar">
          <input
            className="subjects-scene__search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Tìm cuộc họp…"
            data-testid="unclassified-search"
          />
        </div>
      </header>

      {loading ? <LoadingState message="Đang tải cuộc họp chưa phân loại…" /> : null}
      {!loading && error ? <ErrorState message={error} title="Không tải được danh sách" /> : null}
      {actionError ? <ErrorState message={actionError} title="Gán môn thất bại" /> : null}

      {!loading && !error && items.length === 0 ? (
        <EmptyState message="Không còn cuộc họp chưa phân loại." />
      ) : null}

      {!loading && !error && items.length > 0 ? (
        <>
          <div className="subjects-table-wrap">
            <table className="subjects-table">
              <thead>
                <tr>
                  <th>Tiêu đề</th>
                  <th>Ngày tạo</th>
                  <th>Ngôn ngữ</th>
                  <th>Trạng thái</th>
                  <th>Gán môn</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((meeting) => {
                  const busy = rowBusyId === meeting.id
                  return (
                    <tr key={meeting.id}>
                      <td>{meeting.title || meeting.originalFileName || `Meeting #${meeting.id}`}</td>
                      <td>{formatDateVi(meeting.createdAt)}</td>
                      <td>{formatLanguage(String(meeting.language ?? 'vi'))}</td>
                      <td>{formatMeetingStatus(String(meeting.status ?? ''))}</td>
                      <td>
                        <SubjectPicker
                          id={`unclassified-picker-${meeting.id}`}
                          label=""
                          value={null}
                          disabled={busy}
                          allowClear={false}
                          onChange={(subjectId) => {
                            void handleAssign(meeting.id, subjectId)
                          }}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--primary btn--compact"
                          onClick={() => onOpenMeeting(meeting.id)}
                          disabled={busy}
                        >
                          Mở
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

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

export default UnclassifiedMeetingsScene
