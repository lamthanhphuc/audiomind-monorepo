import type { TranscriptScopeOptions } from '../services/api'

export type MeetingResultScopeKind = 'legacy' | 'v2'

export type MeetingResultScope = {
  scopeKind: MeetingResultScopeKind
  meetingId: number
  recordingSessionId?: number | null
  attemptId?: number | null
  finalized?: boolean
  updatedAt?: string | null
  ambiguous?: boolean
}

export type MeetingResultScopeItem = {
  scopeKind: MeetingResultScopeKind
  recordingSessionId?: number | null
  attemptId?: number | null
  finalized?: boolean
  updatedAt?: string | null
  latestSeq?: number | null
}

const toOptionalNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export const isLegacyResultScope = (scope: Pick<MeetingResultScope, 'scopeKind' | 'recordingSessionId' | 'attemptId'>): boolean =>
  scope.scopeKind === 'legacy'
  || (scope.recordingSessionId == null && scope.attemptId == null)

export const normalizeResultScopeItem = (
  meetingId: number,
  item: MeetingResultScopeItem,
): MeetingResultScope => {
  const recordingSessionId = toOptionalNumber(item.recordingSessionId)
  const attemptId = toOptionalNumber(item.attemptId)
  const scopeKind: MeetingResultScopeKind = item.scopeKind === 'legacy' || (recordingSessionId == null && attemptId == null)
    ? 'legacy'
    : 'v2'

  if (scopeKind === 'legacy') {
    return {
      scopeKind: 'legacy',
      meetingId,
      recordingSessionId: null,
      attemptId: null,
      finalized: item.finalized ?? true,
      updatedAt: item.updatedAt ?? null,
    }
  }

  if (recordingSessionId == null || attemptId == null) {
    throw new Error('Invalid v2 result scope')
  }

  return {
    scopeKind: 'v2',
    meetingId,
    recordingSessionId,
    attemptId,
    finalized: item.finalized ?? false,
    updatedAt: item.updatedAt ?? null,
  }
}

export const scopeCacheKey = (scope: MeetingResultScope): string => {
  if (isLegacyResultScope(scope)) {
    return `${scope.meetingId}:legacy`
  }
  return `${scope.meetingId}:v2:${scope.recordingSessionId}:${scope.attemptId}`
}

export const scopeToTranscriptOptions = (scope: MeetingResultScope): TranscriptScopeOptions => {
  if (isLegacyResultScope(scope)) {
    return {}
  }
  return {
    recordingSessionId: scope.recordingSessionId ?? undefined,
    attemptId: scope.attemptId ?? undefined,
  }
}

export const scopeToAnalysisOptions = scopeToTranscriptOptions

export const scopeToSearchParams = (scope: MeetingResultScope): URLSearchParams => {
  const params = new URLSearchParams()
  params.set('meetingId', String(scope.meetingId))
  if (!isLegacyResultScope(scope) && scope.recordingSessionId != null && scope.attemptId != null) {
    params.set('recordingSessionId', String(scope.recordingSessionId))
    params.set('attemptId', String(scope.attemptId))
  }
  return params
}

export const parseResultScopeFromSearchParams = (
  meetingId: number,
  params: URLSearchParams,
): MeetingResultScope | null => {
  const parsedMeetingId = toOptionalNumber(params.get('meetingId'))
  if (parsedMeetingId != null && parsedMeetingId !== meetingId) {
    return null
  }

  const recordingSessionId = toOptionalNumber(params.get('recordingSessionId'))
  const attemptId = toOptionalNumber(params.get('attemptId'))
  if (recordingSessionId == null && attemptId == null) {
    return {
      scopeKind: 'legacy',
      meetingId,
      recordingSessionId: null,
      attemptId: null,
    }
  }
  if (recordingSessionId == null || attemptId == null) {
    return null
  }
  return {
    scopeKind: 'v2',
    meetingId,
    recordingSessionId,
    attemptId,
  }
}

export const formatResultScopeLabel = (scope: MeetingResultScope): string => {
  if (isLegacyResultScope(scope)) {
    return 'Bản ghi legacy'
  }
  return `Phiên ${scope.recordingSessionId} · Lần ${scope.attemptId}`
}

export const selectDefaultResultScope = (
  meetingId: number,
  items: MeetingResultScopeItem[],
): MeetingResultScope | null => {
  if (items.length === 0) {
    return null
  }
  const normalized = items.map((item) => normalizeResultScopeItem(meetingId, item))
  const v2Items = normalized.filter((item) => !isLegacyResultScope(item))
  if (v2Items.length > 0) {
    const preferred = [...v2Items].sort((left, right) => {
      const finalizedDelta = Number(Boolean(right.finalized)) - Number(Boolean(left.finalized))
      if (finalizedDelta !== 0) {
        return finalizedDelta
      }
      const sessionDelta = (right.recordingSessionId ?? 0) - (left.recordingSessionId ?? 0)
      if (sessionDelta !== 0) {
        return sessionDelta
      }
      return (right.attemptId ?? 0) - (left.attemptId ?? 0)
    })[0]
    return preferred
  }
  return normalized[0] ?? null
}
