import { useState, type FormEvent } from 'react'
import type { HistoryLanguageFilter, HistoryStatusFilter } from '../../app/useHistorySearchFilters'

type GlobalMeetingSearchProps = {
  value?: string
  onValueChange?: (value: string) => void
  onSubmit: (query: string) => void
  statusFilter?: HistoryStatusFilter
  onStatusFilterChange?: (value: HistoryStatusFilter) => void
  languageFilter?: HistoryLanguageFilter
  onLanguageFilterChange?: (value: HistoryLanguageFilter) => void
}

export default function GlobalMeetingSearch({
  value,
  onValueChange,
  onSubmit,
  statusFilter = '',
  onStatusFilterChange,
  languageFilter = '',
  onLanguageFilterChange,
}: GlobalMeetingSearchProps) {
  const [internalValue, setInternalValue] = useState('')
  const query = value ?? internalValue

  const setQuery = (next: string) => {
    if (onValueChange) {
      onValueChange(next)
      return
    }
    setInternalValue(next)
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit(query.trim())
  }

  return (
    <form className="global-meeting-search search-bar" onSubmit={handleSubmit}>
      <span className="icon" aria-hidden>🔍</span>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Tìm meeting theo tên, file hoặc nội dung (semantic)..."
        aria-label="Tìm meeting toàn cục"
        data-testid="global-meeting-search"
      />
      <div className="global-meeting-search__chips" role="group" aria-label="Bộ lọc nhanh">
        <button
          type="button"
          className={`global-meeting-search__chip${statusFilter === '' ? ' global-meeting-search__chip--active' : ''}`}
          onClick={() => onStatusFilterChange?.('')}
        >
          Tất cả
        </button>
        <button
          type="button"
          className={`global-meeting-search__chip${statusFilter === 'processing' ? ' global-meeting-search__chip--active' : ''}`}
          onClick={() => onStatusFilterChange?.('processing')}
        >
          Đang xử lý
        </button>
        <button
          type="button"
          className={`global-meeting-search__chip${statusFilter === 'completed' ? ' global-meeting-search__chip--active' : ''}`}
          onClick={() => onStatusFilterChange?.('completed')}
        >
          Hoàn tất
        </button>
        <button
          type="button"
          className={`global-meeting-search__chip${languageFilter === 'vi' ? ' global-meeting-search__chip--active' : ''}`}
          onClick={() => onLanguageFilterChange?.(languageFilter === 'vi' ? '' : 'vi')}
        >
          VI
        </button>
        <button
          type="button"
          className={`global-meeting-search__chip${languageFilter === 'en' ? ' global-meeting-search__chip--active' : ''}`}
          onClick={() => onLanguageFilterChange?.(languageFilter === 'en' ? '' : 'en')}
        >
          EN
        </button>
      </div>
    </form>
  )
}
