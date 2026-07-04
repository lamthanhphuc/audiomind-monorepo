import { getAccessToken } from './auth'
import { API_BASE, MEETING_API_BASE, USER_API_BASE } from './config'

export type SpeakerProfile = {
  id?: number
  meetingId?: number
  speakerKey: string
  displayName: string
  color?: string | null
  avatarUrl?: string | null
  updatedAt?: string | null
}

export type KnowledgeNote = {
  id: number
  meetingId?: number | null
  term?: string | null
  noteType?: string | null
  title?: string | null
  body: string
  createdAt?: string | null
  updatedAt?: string | null
}

export type SpeakerMemorySuggestion = {
  suggested: boolean
  speakerFingerprint?: string
  displayName?: string
  usageCount?: number
  lastMeetingId?: number | null
}

export type SpeakerMemoryEntry = {
  speakerFingerprint: string
  displayName: string
  usageCount?: number
  lastMeetingId?: number | null
  updatedAt?: string | null
}

const createTraceId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const withAuthHeaders = (headers?: HeadersInit): Headers => {
  const merged = new Headers(headers ?? {})
  const accessToken = getAccessToken()
  if (accessToken && !merged.has('Authorization')) {
    merged.set('Authorization', `Bearer ${accessToken}`)
  }
  if (!merged.has('x-trace-id')) {
    merged.set('x-trace-id', createTraceId())
  }
  if (!merged.has('x-request-id')) {
    merged.set('x-request-id', merged.get('x-trace-id') ?? createTraceId())
  }
  return merged
}

const fetchKnowledgeJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, {
    ...init,
    headers: withAuthHeaders(init?.headers),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || response.statusText)
  }
  return response.json() as Promise<T>
}

const normalizeSpeakerProfile = (value: Record<string, unknown>): SpeakerProfile => ({
  id: typeof value.id === 'number' ? value.id : undefined,
  meetingId: typeof value.meetingId === 'number' ? value.meetingId : undefined,
  speakerKey: String(value.speakerKey ?? value.speaker_key ?? '').trim(),
  displayName: String(value.displayName ?? value.display_name ?? '').trim(),
  color: value.color == null ? null : String(value.color),
  avatarUrl: value.avatarUrl == null && value.avatar_url == null
    ? null
    : String(value.avatarUrl ?? value.avatar_url),
  updatedAt: value.updatedAt == null && value.updated_at == null
    ? null
    : String(value.updatedAt ?? value.updated_at),
})

const normalizeKnowledgeNote = (value: Record<string, unknown>): KnowledgeNote => ({
  id: Number(value.id),
  meetingId: value.meetingId == null && value.meeting_id == null
    ? null
    : Number(value.meetingId ?? value.meeting_id),
  term: value.term == null ? null : String(value.term),
  noteType: value.noteType == null && value.note_type == null
    ? null
    : String(value.noteType ?? value.note_type),
  title: value.title == null ? null : String(value.title),
  body: String(value.body ?? ''),
  createdAt: value.createdAt == null && value.created_at == null
    ? null
    : String(value.createdAt ?? value.created_at),
  updatedAt: value.updatedAt == null && value.updated_at == null
    ? null
    : String(value.updatedAt ?? value.updated_at),
})

export const listSpeakerProfiles = async (meetingId: number): Promise<SpeakerProfile[]> => {
  const response = await fetchKnowledgeJson<{ profiles?: unknown[] }>(
    `${MEETING_API_BASE}/meetings/${meetingId}/speakers`,
  )
  return Array.isArray(response.profiles)
    ? response.profiles
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map(normalizeSpeakerProfile)
    : []
}

export const upsertSpeakerProfiles = async (
  meetingId: number,
  profiles: Array<Pick<SpeakerProfile, 'speakerKey' | 'displayName' | 'color'>>,
): Promise<SpeakerProfile[]> => {
  const response = await fetchKnowledgeJson<{ profiles?: unknown[] }>(
    `${MEETING_API_BASE}/meetings/${meetingId}/speakers`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles }),
    },
  )
  return Array.isArray(response.profiles)
    ? response.profiles
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map(normalizeSpeakerProfile)
    : []
}

export const deleteSpeakerProfile = async (meetingId: number, speakerKey: string): Promise<void> => {
  await fetchKnowledgeJson(
    `${MEETING_API_BASE}/meetings/${meetingId}/speakers/${encodeURIComponent(speakerKey)}`,
    { method: 'DELETE' },
  )
}

export const listSpeakerMemory = async (): Promise<SpeakerMemoryEntry[]> => {
  const response = await fetchKnowledgeJson<{ items?: unknown[] }>(
    `${USER_API_BASE}/api/users/me/speaker-memory`,
  )
  return Array.isArray(response.items)
    ? response.items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        speakerFingerprint: String(item.speakerFingerprint ?? item.speaker_fingerprint ?? '').trim(),
        displayName: String(item.displayName ?? item.display_name ?? '').trim(),
        usageCount: typeof item.usageCount === 'number' ? item.usageCount : undefined,
        lastMeetingId: item.lastMeetingId == null && item.last_meeting_id == null
          ? null
          : Number(item.lastMeetingId ?? item.last_meeting_id),
        updatedAt: item.updatedAt == null && item.updated_at == null
          ? null
          : String(item.updatedAt ?? item.updated_at),
      }))
      .filter((item) => item.speakerFingerprint && item.displayName)
    : []
}

export const suggestSpeakerDisplayName = async (speakerKey: string): Promise<SpeakerMemorySuggestion> => {
  const query = new URLSearchParams({ speakerKey })
  const response = await fetchKnowledgeJson<SpeakerMemorySuggestion>(
    `${USER_API_BASE}/api/users/me/speaker-memory/suggest?${query.toString()}`,
  )
  return response
}

export const rememberSpeakerDisplayName = async (
  speakerKey: string,
  displayName: string,
  meetingId?: number | null,
): Promise<void> => {
  await fetchKnowledgeJson(`${USER_API_BASE}/api/users/me/speaker-memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      speakerKey,
      speakerFingerprint: speakerKey,
      displayName,
      meetingId: meetingId ?? null,
    }),
  })
}

export const listKnowledgeNotes = async (options?: {
  q?: string
  meetingId?: number | null
}): Promise<KnowledgeNote[]> => {
  const params = new URLSearchParams()
  if (options?.q?.trim()) {
    params.set('q', options.q.trim())
  }
  if (options?.meetingId != null) {
    params.set('meetingId', String(options.meetingId))
  }
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetchKnowledgeJson<{ items?: unknown[] }>(
    `${USER_API_BASE}/api/users/me/knowledge-notes${suffix}`,
  )
  return Array.isArray(response.items)
    ? response.items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map(normalizeKnowledgeNote)
    : []
}

export const createKnowledgeNote = async (payload: {
  meetingId?: number | null
  term?: string | null
  noteType?: string | null
  title?: string | null
  body: string
}): Promise<KnowledgeNote> => {
  const response = await fetchKnowledgeJson<Record<string, unknown>>(
    `${USER_API_BASE}/api/users/me/knowledge-notes`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  )
  return normalizeKnowledgeNote(response)
}

export const updateKnowledgeNote = async (
  id: number,
  payload: Partial<Pick<KnowledgeNote, 'body' | 'term' | 'title' | 'noteType'>>,
): Promise<KnowledgeNote> => {
  const response = await fetchKnowledgeJson<Record<string, unknown>>(
    `${USER_API_BASE}/api/users/me/knowledge-notes/${id}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  )
  return normalizeKnowledgeNote(response)
}

export const deleteKnowledgeNote = async (id: number): Promise<void> => {
  await fetchKnowledgeJson(`${USER_API_BASE}/api/users/me/knowledge-notes/${id}`, {
    method: 'DELETE',
  })
}

export const explainMeetingTerm = async (
  meetingId: number,
  term: string,
): Promise<{ term: string; explanation: string; provider?: string }> => {
  const response = await fetchKnowledgeJson<{
    term?: string
    explanation?: string
    provider?: string
  }>(`${API_BASE}/processing/${meetingId}/terms/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ term }),
  })
  return {
    term: String(response.term ?? term).trim(),
    explanation: String(response.explanation ?? '').trim(),
    provider: response.provider,
  }
}
