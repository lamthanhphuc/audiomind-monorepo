import type {
  CreateSubjectSynthesisRequest,
  SubjectSynthesis,
  SubjectSynthesisPrepareResponse,
} from '../types/subjectSynthesis'
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

class StudyHttpError extends Error {
  status: number
  errorCode?: string

  constructor(message: string, status: number, errorCode?: string) {
    super(message)
    this.name = 'StudyHttpError'
    this.status = status
    this.errorCode = errorCode
  }
}

const parseStudyError = async (response: Response): Promise<StudyHttpError> => {
  const text = await response.text().catch(() => response.statusText)
  let message = text || `Request failed (${response.status})`
  let errorCode: string | undefined
  try {
    const parsed = JSON.parse(text) as {
      message?: string
      error?: string
      errorCode?: string
      error_code?: string
      detail?: string | { message?: string }
    }
    const detail =
      parsed.detail && typeof parsed.detail === 'object' ? parsed.detail.message : undefined
    const detailText = typeof parsed.detail === 'string' ? parsed.detail : undefined
    message =
      detailText ||
      detail ||
      parsed.message ||
      parsed.errorCode ||
      parsed.error_code ||
      parsed.error ||
      message
    errorCode = parsed.errorCode || parsed.error_code || parsed.error
  } catch {
    // keep raw text
  }
  return new StudyHttpError(message, response.status, errorCode)
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
    throw await parseStudyError(response)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return response.json() as Promise<T>
}

const unwrapSynthesis = (
  payload: SubjectSynthesis | SubjectSynthesisPrepareResponse,
): SubjectSynthesis => {
  if ('synthesis' in payload && payload.synthesis) {
    return payload.synthesis
  }
  return payload as SubjectSynthesis
}

export const createSubjectSynthesis = async (
  subjectId: number,
  body: CreateSubjectSynthesisRequest = {},
): Promise<SubjectSynthesis> => {
  const response = await fetchJson<SubjectSynthesis | SubjectSynthesisPrepareResponse>(
    `${PROCESSING_API_BASE}/processing/subjects/${subjectId}/synthesis`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  )
  return unwrapSynthesis(response)
}

export const getSubjectSynthesis = async (subjectId: number): Promise<SubjectSynthesis | null> => {
  try {
    const response = await fetchJson<SubjectSynthesis | { synthesis: SubjectSynthesis }>(
      `${PROCESSING_API_BASE}/processing/subjects/${subjectId}/synthesis`,
    )
    if ('synthesis' in response && response.synthesis) {
      return response.synthesis
    }
    return response as SubjectSynthesis
  } catch (error) {
    if (error instanceof StudyHttpError && error.status === 404) {
      return null
    }
    throw error
  }
}

export const regenerateSubjectSynthesis = async (
  subjectId: number,
  body: CreateSubjectSynthesisRequest = {},
): Promise<SubjectSynthesis> => {
  const response = await fetchJson<SubjectSynthesis | SubjectSynthesisPrepareResponse>(
    `${PROCESSING_API_BASE}/processing/subjects/${subjectId}/synthesis/regenerate`,
    {
      method: 'POST',
      body: JSON.stringify({ ...body, force: true }),
    },
  )
  return unwrapSynthesis(response)
}

const SYNTHESIS_TERMINAL = new Set(['COMPLETED', 'STALE', 'FAILED', 'QUOTA_EXCEEDED'])

export const pollSubjectSynthesisUntilTerminal = async (
  subjectId: number,
  options?: {
    intervalMs?: number
    signal?: AbortSignal
    onUpdate?: (synthesis: SubjectSynthesis) => void
  },
): Promise<SubjectSynthesis | null> => {
  const intervalMs = Math.min(5000, Math.max(2000, options?.intervalMs ?? 3000))
  while (!options?.signal?.aborted) {
    const current = await getSubjectSynthesis(subjectId)
    if (current) {
      options?.onUpdate?.(current)
      if (SYNTHESIS_TERMINAL.has(String(current.status).toUpperCase())) {
        return current
      }
    } else {
      return null
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
  throw new DOMException('Aborted', 'AbortError')
}
