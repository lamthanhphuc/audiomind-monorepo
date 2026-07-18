export type SubjectEvidenceTarget = {
  meetingId: number
  segmentId: string
}

export const buildAnalysisEvidencePath = ({ meetingId, segmentId }: SubjectEvidenceTarget): string => {
  const params = new URLSearchParams({
    meetingId: String(meetingId),
    evidenceSegmentId: segmentId,
  })
  return `/studio/analysis?${params.toString()}`
}

export const readEvidenceSegmentId = (
  loc: Pick<Location, 'search'> = typeof window !== 'undefined' ? window.location : { search: '' },
): string | null => {
  const value = new URLSearchParams(loc.search).get('evidenceSegmentId')
  const trimmed = value?.trim()
  return trimmed || null
}

/**
 * Navigate to analysis with evidence segment in query + history.state.
 * Callers that own App scene state should also set analysis meetingId / scene.
 */
export const navigateToSubjectEvidence = (
  target: SubjectEvidenceTarget,
  options?: { replace?: boolean },
): void => {
  if (typeof window === 'undefined') return
  const path = buildAnalysisEvidencePath(target)
  const method = options?.replace ? 'replaceState' : 'pushState'
  window.history[method]({ evidenceSegmentId: target.segmentId }, '', path)
}
