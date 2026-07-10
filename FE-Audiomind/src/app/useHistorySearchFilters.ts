import { useState } from 'react'

export type HistoryStatusFilter = '' | 'scheduled' | 'processing' | 'completed' | 'failed'
export type HistoryLanguageFilter = '' | 'vi' | 'en' | 'multi'

export const useHistorySearchFilters = () => {
  const [globalMeetingSearch, setGlobalMeetingSearch] = useState('')
  const [historyStatusFilter, setHistoryStatusFilter] = useState<HistoryStatusFilter>('')
  const [historyLanguageFilter, setHistoryLanguageFilter] = useState<HistoryLanguageFilter>('')

  return {
    globalMeetingSearch,
    setGlobalMeetingSearch,
    historyStatusFilter,
    setHistoryStatusFilter,
    historyLanguageFilter,
    setHistoryLanguageFilter,
  }
}
