import { useCallback, useEffect, useState } from 'react'
import { formatQuotaPercent, getBillingOverview, type BillingOverview } from '../services/billing'

const CACHE_TTL_MS = 60_000

let cachedOverview: BillingOverview | null = null
let cachedAt = 0
let inflight: Promise<BillingOverview> | null = null

const loadOverviewCached = async (): Promise<BillingOverview> => {
  const now = Date.now()
  if (cachedOverview && now - cachedAt < CACHE_TTL_MS) {
    return cachedOverview
  }
  if (inflight) {
    return inflight
  }
  inflight = getBillingOverview()
    .then((overview) => {
      cachedOverview = overview
      cachedAt = Date.now()
      return overview
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export const clearQuotaOverviewCache = (): void => {
  cachedOverview = null
  cachedAt = 0
}

export function useQuotaOverview(enabled: boolean) {
  const [overview, setOverview] = useState<BillingOverview | null>(cachedOverview)
  const [loading, setLoading] = useState(enabled && !cachedOverview)

  const refresh = useCallback(async () => {
    if (!enabled) {
      return null
    }
    setLoading(true)
    try {
      clearQuotaOverviewCache()
      const next = await loadOverviewCached()
      setOverview(next)
      return next
    } catch {
      return null
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setOverview(null)
      setLoading(false)
      return
    }
    let active = true
    setLoading(!cachedOverview)
    void loadOverviewCached()
      .then((next) => {
        if (!active) return
        setOverview(next)
      })
      .catch(() => {
        if (!active) return
        setOverview(null)
      })
      .finally(() => {
        if (!active) return
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [enabled])

  const quota = overview?.quota
  const sttPercent = formatQuotaPercent(quota?.sttSecondsUsed ?? 0, quota?.sttSecondsLimit ?? 0)
  const geminiPercent = formatQuotaPercent(quota?.geminiInputCharsUsed ?? 0, quota?.geminiInputCharsLimit ?? 0)
  const isHighUsage = sttPercent >= 90 || geminiPercent >= 90

  return {
    overview,
    loading,
    sttPercent,
    geminiPercent,
    isHighUsage,
    refresh,
  }
}
