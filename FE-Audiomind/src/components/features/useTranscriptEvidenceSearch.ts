import { useCallback, useState } from 'react'

import { searchMeetingTranscriptEvidence } from '../../services/api'
import type { TranscriptEvidenceMatch } from '../../services/api'
import type { Meeting } from '../../types'
import type { TranscriptSearchState } from './MeetingHistoryPanels'

type UseTranscriptEvidenceSearchOptions = {
  selectedMeetingSummary: Meeting | null | undefined
}

export function useTranscriptEvidenceSearch({
  selectedMeetingSummary,
}: UseTranscriptEvidenceSearchOptions) {
  const [transcriptEvidenceQuery, setTranscriptEvidenceQuery] = useState('')
  const [transcriptEvidenceState, setTranscriptEvidenceState] = useState<TranscriptSearchState>('idle')
  const [transcriptEvidenceResults, setTranscriptEvidenceResults] = useState<TranscriptEvidenceMatch[]>([])
  const [transcriptEvidenceError, setTranscriptEvidenceError] = useState<string | null>(null)

  const resetTranscriptEvidence = useCallback(() => {
    setTranscriptEvidenceQuery('')
    setTranscriptEvidenceState('idle')
    setTranscriptEvidenceResults([])
    setTranscriptEvidenceError(null)
  }, [])

  const handleTranscriptEvidenceSearch = async () => {
    if (!selectedMeetingSummary) return
    const query = transcriptEvidenceQuery.trim()
    if (query.length < 2) {
      setTranscriptEvidenceState('error')
      setTranscriptEvidenceResults([])
      setTranscriptEvidenceError('Nhập ít nhất 2 ký tự để tìm trong transcript.')
      return
    }
    setTranscriptEvidenceState('loading')
    setTranscriptEvidenceError(null)
    try {
      const response = await searchMeetingTranscriptEvidence(selectedMeetingSummary.id, query, { limit: 10, context: 1 })
      setTranscriptEvidenceResults(response.matches)
      setTranscriptEvidenceState(response.matches.length > 0 ? 'ready' : 'empty')
    } catch (error) {
      setTranscriptEvidenceResults([])
      setTranscriptEvidenceState('error')
      setTranscriptEvidenceError(error instanceof Error ? error.message : 'Không thể tìm trong transcript')
    }
  }

  return {
    transcriptEvidenceQuery,
    setTranscriptEvidenceQuery,
    transcriptEvidenceState,
    transcriptEvidenceResults,
    transcriptEvidenceError,
    handleTranscriptEvidenceSearch,
    resetTranscriptEvidence,
  }
}
