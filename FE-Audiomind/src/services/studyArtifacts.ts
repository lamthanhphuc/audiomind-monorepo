import {
  aggregateStudyStatuses,
  isStudyArtifactTerminal,
  type AggregateStudyStatus,
  type CreateStudyArtifactsRequest,
  type StudyArtifact,
  type StudyArtifactsCreateResponse,
} from '../types/studyArtifacts'
import { PROCESSING_API_BASE } from './config'
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
  if (response.status === 204) {
    return undefined as T
  }
  return response.json() as Promise<T>
}

export const createStudyArtifacts = async (
  body: CreateStudyArtifactsRequest,
): Promise<StudyArtifactsCreateResponse> => {
  return fetchJson<StudyArtifactsCreateResponse>(
    `${PROCESSING_API_BASE}/processing/study-artifacts`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  )
}

export const getStudyArtifact = async (artifactId: number): Promise<StudyArtifact> => {
  return fetchJson<StudyArtifact>(
    `${PROCESSING_API_BASE}/processing/study-artifacts/${artifactId}`,
  )
}

export const listSubjectStudyArtifacts = async (
  subjectId: number,
  filters?: {
    artifactType?: string
    status?: string
    page?: number
    size?: number
    sort?: string
  },
): Promise<StudyArtifact[]> => {
  const params = new URLSearchParams()
  if (filters?.artifactType) {
    params.set('artifactType', filters.artifactType)
  }
  if (filters?.status) {
    params.set('status', filters.status)
  }
  if (filters?.page != null) {
    params.set('page', String(filters.page))
  }
  if (filters?.size != null) {
    params.set('size', String(filters.size))
  }
  if (filters?.sort) {
    params.set('sort', filters.sort)
  }
  const query = params.toString()
  const response = await fetchJson<StudyArtifact[] | { items: StudyArtifact[]; artifacts?: StudyArtifact[] }>(
    `${PROCESSING_API_BASE}/processing/subjects/${subjectId}/study-artifacts${query ? `?${query}` : ''}`,
  )
  if (Array.isArray(response)) {
    return response
  }
  if (Array.isArray(response.items)) {
    return response.items
  }
  if (Array.isArray(response.artifacts)) {
    return response.artifacts
  }
  return []
}

export const regenerateStudyArtifact = async (
  artifactId: number,
  body?: { force?: boolean },
): Promise<StudyArtifactsCreateResponse> => {
  return fetchJson<StudyArtifactsCreateResponse>(
    `${PROCESSING_API_BASE}/processing/study-artifacts/${artifactId}/regenerate`,
    {
      method: 'POST',
      body: JSON.stringify({ force: true, ...body }),
    },
  )
}

export type PickRegeneratedArtifactResult = {
  artifact: StudyArtifact | null
  pollIds: number[]
}

/**
 * Extract the regenerated artifact (if already known) and the artifact ids
 * that still need polling from a batch-shaped regenerate/create response.
 * Regenerate requests always target a single artifactType, so the response
 * carries at most one artifact, but we still treat `artifacts`/`artifactIds`
 * as the source of truth rather than assuming array shape/length.
 */
export const pickRegeneratedArtifact = (
  response: StudyArtifactsCreateResponse,
): PickRegeneratedArtifactResult => {
  const artifacts = response.artifacts ?? []
  const artifact = artifacts[0] ?? null
  const ids = response.artifactIds ?? []
  const pollIds = ids.filter((id) => {
    const row = artifacts.find((a) => a.id === id)
    if (!row) return true
    const rowStatus = String(row.status).toUpperCase()
    return rowStatus === 'QUEUED' || rowStatus === 'PROCESSING'
  })
  return { artifact, pollIds }
}

export const deleteStudyArtifact = async (artifactId: number): Promise<void> => {
  await fetchJson<void>(`${PROCESSING_API_BASE}/processing/study-artifacts/${artifactId}`, {
    method: 'DELETE',
  })
}

export type PollArtifactsResult = {
  artifacts: StudyArtifact[]
  aggregateStatus: AggregateStudyStatus
}

/**
 * Poll EACH artifactId every 2–5s until that artifact is terminal.
 * Never poll by generationRequestId.
 */
export const pollStudyArtifactsUntilTerminal = async (
  artifactIds: number[],
  options?: {
    intervalMs?: number
    signal?: AbortSignal
    onUpdate?: (result: PollArtifactsResult) => void
  },
): Promise<PollArtifactsResult> => {
  const uniqueIds = [...new Set(artifactIds.filter((id) => Number.isFinite(id) && id > 0))]
  if (uniqueIds.length === 0) {
    return { artifacts: [], aggregateStatus: 'FAILED' }
  }

  const intervalMs = Math.min(5000, Math.max(2000, options?.intervalMs ?? 3000))
  const byId = new Map<number, StudyArtifact>()

  const snapshot = (): PollArtifactsResult => {
    const artifacts = uniqueIds.map((id) => byId.get(id)).filter((row): row is StudyArtifact => Boolean(row))
    return {
      artifacts,
      aggregateStatus: aggregateStudyStatuses(artifacts.map((a) => String(a.status))),
    }
  }

  const pending = new Set(uniqueIds)

  while (pending.size > 0 && !options?.signal?.aborted) {
    await Promise.all(
      [...pending].map(async (artifactId) => {
        const artifact = await getStudyArtifact(artifactId)
        byId.set(artifactId, artifact)
        if (isStudyArtifactTerminal(String(artifact.status))) {
          pending.delete(artifactId)
        }
      }),
    )
    const current = snapshot()
    options?.onUpdate?.(current)
    if (pending.size === 0) {
      return current
    }
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => resolve(), intervalMs)
      options?.signal?.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
    })
  }

  if (options?.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  return snapshot()
}

export { aggregateStudyStatuses, isStudyArtifactTerminal }
