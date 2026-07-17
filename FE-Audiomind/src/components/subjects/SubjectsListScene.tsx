import { useEffect, useMemo, useState } from 'react'
import { Inbox } from 'lucide-react'
import { useSubjectsList } from '../../hooks/useSubjectsList'
import { useStudyWorkspace } from '../../hooks/useStudyWorkspace'
import { flattenStudyFolderTree } from '../../types/study'
import type { Subject } from '../../types/study'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
import { ConfirmDialog } from './ConfirmDialog'
import { SubjectDialog } from './SubjectDialog'
import './subjects.css'

export type SubjectsListSceneProps = {
  onOpenSubject: (subjectId: number) => void
  onNavigateUnclassified: () => void
}

export function SubjectsListScene({
  onOpenSubject,
  onNavigateUnclassified,
}: SubjectsListSceneProps) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [pageIndex, setPageIndex] = useState(1)
  const pageSize = 10

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPageIndex(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search])

  const { page, loading, error } = useSubjectsList({
    search: debouncedSearch || undefined,
    archived: false,
    page: pageIndex,
    pageSize,
    sort: 'name_asc',
  })
  const { folderTree, updateSubjectEntry, archiveSubjectEntry } = useStudyWorkspace()

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

  const flatFolders = useMemo(
    () => flattenStudyFolderTree(folderTree?.folders ?? []),
    [folderTree],
  )

  const [editingSubject, setEditingSubject] = useState<Subject | null>(null)
  const [archivingSubject, setArchivingSubject] = useState<Subject | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  const handleArchiveSubject = async () => {
    if (!archivingSubject) return
    setArchiveBusy(true)
    setArchiveError(null)
    try {
      await archiveSubjectEntry(archivingSubject.id)
      setArchivingSubject(null)
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : 'Không lưu trữ được môn học')
    } finally {
      setArchiveBusy(false)
    }
  }

  return (
    <section className="subjects-scene" data-testid="subjects-list-scene">
      <header className="subjects-scene__header">
        <div>
          <h1 className="subjects-scene__title">Môn học</h1>
          <p className="subjects-meta">Quản lý môn và cuộc họp theo thư mục học tập</p>
        </div>
        <div className="subjects-scene__toolbar">
          <input
            className="subjects-scene__search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Tìm môn học…"
            data-testid="subjects-list-search"
          />
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onNavigateUnclassified}
            data-testid="subjects-list-unclassified"
          >
            <Inbox size={16} aria-hidden /> Chưa phân loại
          </button>
        </div>
      </header>

      {loading ? <LoadingState message="Đang tải danh sách môn học…" /> : null}
      {!loading && error ? <ErrorState message={error} title="Không tải được môn học" /> : null}
      {archiveError ? <ErrorState message={archiveError} title="Lưu trữ thất bại" /> : null}
      {!loading && !error && items.length === 0 ? (
        <EmptyState message="Chưa có môn học nào. Hãy tạo môn từ thanh bên." />
      ) : null}

      {!loading && !error && items.length > 0 ? (
        <>
          <div className="subjects-table-wrap">
            <table className="subjects-table">
              <thead>
                <tr>
                  <th>Tên môn</th>
                  <th>Mã</th>
                  <th>Học kỳ</th>
                  <th>Số cuộc họp</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((subject) => (
                  <tr key={subject.id}>
                    <td>
                      {subject.color ? (
                        <span
                          className="subjects-color-swatch"
                          style={{ background: subject.color }}
                          aria-hidden
                        />
                      ) : null}
                      {subject.name}
                    </td>
                    <td>{subject.code || '—'}</td>
                    <td>{subject.semester || '—'}</td>
                    <td>{subject.meetingCount ?? 0}</td>
                    <td>
                      <div className="subjects-table__actions">
                        <button
                          type="button"
                          className="btn btn--secondary btn--compact"
                          onClick={() => onOpenSubject(subject.id)}
                          data-testid={`subjects-list-open-${subject.id}`}
                        >
                          Mở
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary btn--compact"
                          onClick={() => setEditingSubject(subject)}
                          data-testid={`subjects-list-edit-${subject.id}`}
                        >
                          Sửa
                        </button>
                        <button
                          type="button"
                          className="btn btn--danger btn--compact"
                          onClick={() => {
                            setArchiveError(null)
                            setArchivingSubject(subject)
                          }}
                          data-testid={`subjects-list-archive-${subject.id}`}
                        >
                          Lưu trữ
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 ? (
            <div className="subjects-pagination" data-testid="subjects-list-pagination">
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

      <SubjectDialog
        open={editingSubject != null}
        mode="edit"
        initial={editingSubject ?? undefined}
        folders={flatFolders}
        onClose={() => setEditingSubject(null)}
        onSubmit={async (payload) => {
          if (!editingSubject) return
          await updateSubjectEntry(editingSubject.id, payload)
        }}
      />

      <ConfirmDialog
        open={archivingSubject != null}
        title="Lưu trữ môn học"
        message={`Lưu trữ môn học "${archivingSubject?.name ?? ''}"? Môn học sẽ không còn hiển thị trong danh sách và bộ chọn môn học.`}
        confirmLabel="Lưu trữ"
        tone="danger"
        busy={archiveBusy}
        error={archiveError}
        onConfirm={() => void handleArchiveSubject()}
        onCancel={() => {
          if (archiveBusy) return
          setArchivingSubject(null)
          setArchiveError(null)
        }}
        testId="subjects-list-archive-confirm"
      />
    </section>
  )
}

export default SubjectsListScene
