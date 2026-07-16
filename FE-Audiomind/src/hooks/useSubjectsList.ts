import { useCallback, useEffect, useState } from 'react'
import { listSubjects } from '../services/subjects'
import { useStudyWorkspace } from './useStudyWorkspace'
import type { PageResponse, Subject, SubjectListFilters } from '../types/study'

export const useSubjectsList = (filters: SubjectListFilters) => {
  const { catalogRevision } = useStudyWorkspace()
  const [page, setPage] = useState<PageResponse<Subject> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await listSubjects(filters)
      setPage(response)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Không tải được danh sách môn học')
    } finally {
      setLoading(false)
    }
  }, [filters.archived, filters.folderId, filters.page, filters.pageSize, filters.search, filters.sort])

  useEffect(() => {
    void reload()
  }, [reload, catalogRevision])

  return { page, loading, error, reload }
}
