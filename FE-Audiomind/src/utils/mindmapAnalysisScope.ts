import type { AiAnalysis } from '../types'
import { getSavedAnalysis, resolveMeetingResultScope } from '../services/api'
import type { MeetingResultScope } from './meetingResultScope'
import { scopeCacheKey, scopeToAnalysisOptions } from './meetingResultScope'

export const canReuseMindmapSelectedScope = (
  meetingId: number,
  selectedScope: MeetingResultScope | null,
): selectedScope is MeetingResultScope =>
  selectedScope != null && selectedScope.meetingId === meetingId

export const buildMindmapAnalysisRequestKey = (
  meetingId: number,
  selectedScope: MeetingResultScope | null,
): string => {
  if (canReuseMindmapSelectedScope(meetingId, selectedScope)) {
    return scopeCacheKey(selectedScope)
  }
  return `${meetingId}:resolve`
}

export const shouldApplyMindmapLoadResult = (
  requestKey: string,
  activeRequestKey: string | null,
  signal: AbortSignal,
): boolean => !signal.aborted && activeRequestKey === requestKey

export const resolveMindmapAnalysisScope = async (
  meetingId: number,
  selectedScope: MeetingResultScope | null,
  options: { signal?: AbortSignal } = {},
): Promise<MeetingResultScope> => {
  if (canReuseMindmapSelectedScope(meetingId, selectedScope)) {
    return selectedScope
  }
  return resolveMeetingResultScope(meetingId, undefined, { signal: options.signal })
}

export const loadMindmapSavedAnalysis = async (
  meetingId: number,
  selectedScope: MeetingResultScope | null,
  options: { signal?: AbortSignal } = {},
): Promise<{ scope: MeetingResultScope; analysis: AiAnalysis }> => {
  const scope = await resolveMindmapAnalysisScope(meetingId, selectedScope, options)
  const analysis = await getSavedAnalysis(meetingId, {
    ...scopeToAnalysisOptions(scope),
    signal: options.signal,
  })
  return { scope, analysis }
}
