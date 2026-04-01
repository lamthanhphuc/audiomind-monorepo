export type Meeting = {
  id: number
  title: string
  audioPath: string
  createdAt: string
}

export type ActionItem = {
  task: string
  owner?: string
  deadline?: string
}

export type AiAnalysis = {
  meeting_id: number
  summary: string
  keywords: string[]
  technical_terms: string[]
  action_items: ActionItem[]
  created_at: string
}

export type TranscriptSegment = {
  speaker: string
  start_time: number
  end_time: number
  text: string
}

export type TranscriptResponse = {
  meeting_id: number
  transcripts: TranscriptSegment[]
}
