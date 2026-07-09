import { useCallback, useEffect, useState } from 'react'
import { listMeetingsWithParams } from '../services/api'
import type { Meeting } from '../types'

export function useRecentMeetingsSidebar(isAuthenticated: boolean) {
  const [recentMeetings, setRecentMeetings] = useState<Meeting[]>([])
  const [recentMeetingsReloadTick, setRecentMeetingsReloadTick] = useState(0)

  const refreshRecentMeetings = useCallback(() => {
    setRecentMeetingsReloadTick((value) => value + 1)
  }, [])

  useEffect(() => {
    if (!isAuthenticated) {
      setRecentMeetings([])
      return
    }

    let cancelled = false
    const loadRecentMeetings = async () => {
      try {
        const meetings = await listMeetingsWithParams({ sort: 'created_desc' })
        if (!cancelled) {
          setRecentMeetings(meetings)
        }
      } catch (error) {
        if (!cancelled && import.meta.env.MODE !== 'test') {
          console.warn('Failed to load recent meetings for sidebar', error)
        }
      }
    }

    void loadRecentMeetings()
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, recentMeetingsReloadTick])

  return {
    recentMeetings,
    refreshRecentMeetings,
  }
}
