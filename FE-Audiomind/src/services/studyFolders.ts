import { MEETING_API_BASE } from './config'
import { getAccessToken } from './auth'
import type { StudyFolder, StudyFolderTreeResponse } from '../types/study'

const buildHeaders = (): HeadersInit => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
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
      ...buildHeaders(),
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText)
    throw new Error(message || `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

export type CreateStudyFolderInput = {
  name: string
  color?: string | null
  parentFolderId?: number | null
}

export type UpdateStudyFolderInput = {
  name?: string
  color?: string | null
  parentFolderId?: number | null
}

export const listStudyFolders = async (): Promise<StudyFolder[]> => {
  return fetchJson<StudyFolder[]>(`${MEETING_API_BASE}/study-folders`)
}

export const getStudyFolderTree = async (): Promise<StudyFolderTreeResponse> => {
  return fetchJson<StudyFolderTreeResponse>(`${MEETING_API_BASE}/study-folders/tree`)
}

export const getStudyFolder = async (folderId: number): Promise<StudyFolder> => {
  return fetchJson<StudyFolder>(`${MEETING_API_BASE}/study-folders/${folderId}`)
}

export const createStudyFolder = async (input: CreateStudyFolderInput): Promise<StudyFolder> => {
  return fetchJson<StudyFolder>(`${MEETING_API_BASE}/study-folders`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export const updateStudyFolder = async (
  folderId: number,
  input: UpdateStudyFolderInput,
): Promise<StudyFolder> => {
  return fetchJson<StudyFolder>(`${MEETING_API_BASE}/study-folders/${folderId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export const deleteStudyFolder = async (folderId: number): Promise<StudyFolder> => {
  return fetchJson<StudyFolder>(`${MEETING_API_BASE}/study-folders/${folderId}`, {
    method: 'DELETE',
  })
}
