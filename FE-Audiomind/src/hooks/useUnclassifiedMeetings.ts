import { useCallback, useEffect, useRef, useState } from 'react'
import { listUnclassifiedMeetings } from '../services/subjects'
import { useStudyWorkspace } from './useStudyWorkspace'
import type { Meeting } from '../types'
import type { PageResponse, UnclassifiedFilters } from '../types/study'

export const useUnclassifiedMeetings = (filters: UnclassifiedFilters) => {
  const { catalogRevision } = useStudyWorkspace()
  const [page, setPage] = useState<PageResponse<Meeting> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSeqRef = useRef(0)

  const reload = useCallback(async () => {
    const requestId = ++requestSeqRef.current
    setLoading(true)
    setError(null)
    try {
      const response = await listUnclassifiedMeetings(filters)
      if (requestId !== requestSeqRef.current) {
        return
      }
      setPage(response)
    } catch (loadError) {
      if (requestId !== requestSeqRef.current) {
        return
      }
      setError(loadError instanceof Error ? loadError.message : 'Không tải được cuộc họp chưa phân loại')
    } finally {
      if (requestId === requestSeqRef.current) {
        setLoading(false)
      }
    }
  }, [filters.page, filters.pageSize, filters.search, filters.sort])

  useEffect(() => {
    void reload()
  }, [reload, catalogRevision])

  return { page, loading, error, reload }
}
