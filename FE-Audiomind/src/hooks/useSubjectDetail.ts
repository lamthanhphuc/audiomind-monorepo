import { useCallback, useEffect, useState } from 'react'
import { getSubject, getSubjectMeetings } from '../services/subjects'
import { useStudyWorkspace } from './useStudyWorkspace'
import type { PageResponse, Subject, SubjectMeeting } from '../types/study'

export const useSubjectDetail = (subjectId: number | null, page = 1, pageSize = 10) => {
  const { catalogRevision } = useStudyWorkspace()
  const [subject, setSubject] = useState<Subject | null>(null)
  const [meetingsPage, setMeetingsPage] = useState<PageResponse<SubjectMeeting> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (subjectId == null || subjectId <= 0) {
      setSubject(null)
      setMeetingsPage(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [subjectResponse, meetingsResponse] = await Promise.all([
        getSubject(subjectId),
        getSubjectMeetings(subjectId, page, pageSize),
      ])
      setSubject(subjectResponse)
      setMeetingsPage(meetingsResponse)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Không tải được chi tiết môn học')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, subjectId])

  useEffect(() => {
    void reload()
  }, [reload, catalogRevision])

  return { subject, meetingsPage, loading, error, reload }
}
