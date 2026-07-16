import { useEffect, useState } from 'react'
import { Inbox } from 'lucide-react'
import { useSubjectsList } from '../../hooks/useSubjectsList'
import { EmptyState } from '../ui/EmptyState'
import { ErrorState } from '../ui/ErrorState'
import { LoadingState } from '../ui/LoadingState'
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

  const items = page?.items ?? []
  const totalPages = Math.max(1, page?.totalPages ?? 1)

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
    </section>
  )
}

export default SubjectsListScene
