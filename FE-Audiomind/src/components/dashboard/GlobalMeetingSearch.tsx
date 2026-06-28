import { useState, type FormEvent } from 'react'

type GlobalMeetingSearchProps = {
  value?: string
  onValueChange?: (value: string) => void
  onSubmit: (query: string) => void
}

export default function GlobalMeetingSearch({
  value,
  onValueChange,
  onSubmit,
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
    </form>
  )
}
