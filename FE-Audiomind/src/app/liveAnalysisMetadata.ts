import type { AiAnalysis } from '../types'

export const buildLiveAnalysisMetadata = (
  meetingId: number,
  status: string,
  overrides: Partial<AiAnalysis> = {},
): AiAnalysis => ({
  meetingId,
  meeting_id: meetingId,
  status,
  analysisStatus: status,
  summary: '',
  keywords: [],
  technicalTerms: [],
  painPoints: [],
  actionItems: [],
  domainMode: 'it',
  ...overrides,
})
