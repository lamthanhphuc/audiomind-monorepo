import type { ActionPlanItem, MeetingActionPlanData, TranscriptEvidenceMatch } from '../services/api'
import type { EvidenceMatchPreview } from '../components/analysis/AnalysisStatusPanel'

const mapTranscriptEvidenceMatch = (match: TranscriptEvidenceMatch): EvidenceMatchPreview => ({
  verificationStatus: match.verificationStatus ?? undefined,
  score: match.score,
  snippet: match.text,
  speaker: match.speaker,
  startTime: match.startTime,
  endTime: match.endTime,
})

export const collectEvidenceMatchesFromActionPlan = (
  plan: MeetingActionPlanData | null | undefined,
): EvidenceMatchPreview[] => {
  if (!plan) {
    return []
  }

  const matches: EvidenceMatchPreview[] = []
  const seen = new Set<string>()

  const pushMatch = (item: ActionPlanItem) => {
    const evidence = item.evidence
    if (!evidence || typeof evidence !== 'object' || !('text' in evidence)) {
      return
    }
    const key = evidence.evidenceId || `${evidence.segmentId}:${evidence.startTime}:${evidence.text}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    matches.push(mapTranscriptEvidenceMatch(evidence))
  }

  for (const item of plan.actionItems) {
    pushMatch(item)
  }

  return matches
}

export const mapSearchEvidenceMatches = (
  matches: TranscriptEvidenceMatch[],
): EvidenceMatchPreview[] => matches.map(mapTranscriptEvidenceMatch)

type AnalysisEvidenceMatch = {
  verificationStatus?: string | null
  score?: number
  snippet?: string
  speaker?: string
  startTime?: number
  endTime?: number
  dedupeKey?: string | null
}

export const collectEvidenceMatchesFromAnalysis = (
  analysis: Record<string, unknown> | null | undefined,
): EvidenceMatchPreview[] => {
  if (!analysis || typeof analysis !== 'object') {
    return []
  }
  const evidence = analysis.evidence
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return []
  }
  const matches = (evidence as { matches?: unknown }).matches
  if (!Array.isArray(matches)) {
    return []
  }
  return matches
    .filter((match): match is AnalysisEvidenceMatch => Boolean(match) && typeof match === 'object')
    .map((match) => ({
      verificationStatus: match.verificationStatus ?? undefined,
      score: match.score,
      snippet: match.snippet,
      speaker: match.speaker,
      startTime: match.startTime,
      endTime: match.endTime,
    }))
}
