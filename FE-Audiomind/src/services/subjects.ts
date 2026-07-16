import type { Meeting } from '../types'
import type {
  PageResponse,
  Subject,
  SubjectListFilters,
  SubjectMeeting,
  UnclassifiedFilters,
} from '../types/study'
import { MEETING_API_BASE } from './config'
import { getAccessToken } from './auth'

const buildHeaders = (contentType = 'application/json'): HeadersInit => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (contentType) {
    headers['Content-Type'] = contentType
  }
  const token = getAccessToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...buildHeaders(init?.body instanceof FormData ? '' : 'application/json'),
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText)
    throw new Error(message || `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

const appendPaginationParams = (
  params: URLSearchParams,
  filters: { page?: number; pageSize?: number },
): void => {
  if (filters.page != null) {
    params.set('page', String(filters.page))
  }
  if (filters.pageSize != null) {
    params.set('pageSize', String(filters.pageSize))
  }
}

export type CreateSubjectInput = {
  name: string
  code?: string | null
  semester?: string | null
  description?: string | null
  color?: string | null
  folderId?: number | null
}

export type UpdateSubjectInput = {
  name?: string
  code?: string | null
  semester?: string | null
  description?: string | null
  color?: string | null
  folderId?: number | null
}

export const listSubjects = async (
  filters: SubjectListFilters = {},
): Promise<PageResponse<Subject>> => {
  const params = new URLSearchParams()
  if (filters.folderId != null) {
    params.set('folderId', String(filters.folderId))
  }
  if (filters.search?.trim()) {
    params.set('search', filters.search.trim())
  }
  if (filters.archived != null) {
    params.set('archived', String(filters.archived))
  }
  if (filters.sort?.trim()) {
    params.set('sort', filters.sort.trim())
  }
  appendPaginationParams(params, filters)
  const query = params.toString()
  return fetchJson<PageResponse<Subject>>(
    `${MEETING_API_BASE}/subjects${query ? `?${query}` : ''}`,
  )
}

export const getSubject = async (subjectId: number): Promise<Subject> => {
  const response = await fetchJson<{ subject: Subject }>(
    `${MEETING_API_BASE}/subjects/${subjectId}`,
  )
  return response.subject
}

export const createSubject = async (input: CreateSubjectInput): Promise<Subject> => {
  return fetchJson<Subject>(`${MEETING_API_BASE}/subjects`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export const updateSubject = async (
  subjectId: number,
  input: UpdateSubjectInput,
): Promise<Subject> => {
  return fetchJson<Subject>(`${MEETING_API_BASE}/subjects/${subjectId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export const archiveSubject = async (subjectId: number): Promise<Subject> => {
  return fetchJson<Subject>(`${MEETING_API_BASE}/subjects/${subjectId}`, {
    method: 'DELETE',
  })
}

export const getSubjectMeetings = async (
  subjectId: number,
  page = 1,
  pageSize = 10,
): Promise<PageResponse<SubjectMeeting>> => {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  })
  return fetchJson<PageResponse<SubjectMeeting>>(
    `${MEETING_API_BASE}/subjects/${subjectId}/meetings?${params.toString()}`,
  )
}

export const assignMeetingSubject = async (
  meetingId: number,
  subjectId: number | null,
): Promise<Meeting> => {
  return fetchJson<Meeting>(`${MEETING_API_BASE}/meetings/${meetingId}/subject`, {
    method: 'PATCH',
    body: JSON.stringify({ subjectId }),
  })
}

export const listUnclassifiedMeetings = async (
  filters: UnclassifiedFilters = {},
): Promise<PageResponse<Meeting>> => {
  const params = new URLSearchParams()
  if (filters.search?.trim()) {
    params.set('search', filters.search.trim())
  }
  if (filters.sort?.trim()) {
    params.set('sort', filters.sort.trim())
  }
  appendPaginationParams(params, filters)
  const query = params.toString()
  return fetchJson<PageResponse<Meeting>>(
    `${MEETING_API_BASE}/meetings/unclassified${query ? `?${query}` : ''}`,
  )
}
