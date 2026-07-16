import { useCallback, useEffect, useState } from 'react'
import { listUnclassifiedMeetings } from '../services/subjects'
import { useStudyWorkspace } from './useStudyWorkspace'
import type { Meeting } from '../types'
import type { PageResponse, UnclassifiedFilters } from '../types/study'

export const useUnclassifiedMeetings = (filters: UnclassifiedFilters) => {
  const { catalogRevision } = useStudyWorkspace()
  const [page, setPage] = useState<PageResponse<Meeting> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await listUnclassifiedMeetings(filters)
      setPage(response)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Không tải được cuộc họp chưa phân loại')
    } finally {
      setLoading(false)
    }
  }, [filters.page, filters.pageSize, filters.search, filters.sort])

  useEffect(() => {
    void reload()
  }, [reload, catalogRevision])

  return { page, loading, error, reload }
}
