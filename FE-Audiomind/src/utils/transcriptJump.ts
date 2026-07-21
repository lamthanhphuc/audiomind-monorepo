export type TranscriptHighlightRange = {
  startTime: number
  endTime: number
}

export const highlightRangeFromTime = (
  startTime: number,
  endTime?: number,
): TranscriptHighlightRange => ({
  startTime,
  endTime: endTime != null && endTime > startTime ? endTime : startTime + 3,
})

const SCROLL_RETRY_ATTEMPTS = 5
const SCROLL_INITIAL_DELAY_MS = 50

const findHighlightTarget = (range: TranscriptHighlightRange): HTMLElement | null => {
  const segments = Array.from(document.querySelectorAll<HTMLElement>('[data-segment-start]'))
  let target: HTMLElement | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (const element of segments) {
    const start = Number(element.dataset.segmentStart)
    const end = Number(element.dataset.segmentEnd ?? element.dataset.segmentStart)
    if (!Number.isFinite(start)) {
      continue
    }

    const resolvedEnd = Number.isFinite(end) ? end : start
    const overlaps = start <= range.endTime && resolvedEnd >= range.startTime
    const delta = Math.abs(start - range.startTime)
    const score = overlaps ? 0 : delta

    if (score < bestScore) {
      bestScore = score
      target = element
    }
  }

  return target ?? document.querySelector<HTMLElement>('.transcript-display__segment--highlight')
}

const scheduleRetry = (callback: () => void): void => {
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(callback)
    return
  }
  window.setTimeout(callback, 16)
}

/**
 * Scrolls the transcript container to the highlighted range. The transcript
 * DOM may not have re-rendered yet (e.g. right after a tab switch mounts the
 * container), so this retries across a few animation frames before giving up.
 */
export const scrollTranscriptToHighlight = (
  range: TranscriptHighlightRange,
  retries: number = SCROLL_RETRY_ATTEMPTS,
): void => {
  if (typeof document === 'undefined') {
    return
  }

  const attempt = (remaining: number): void => {
    const target = findHighlightTarget(range)
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    if (remaining > 0) {
      scheduleRetry(() => attempt(remaining - 1))
    }
  }

  window.setTimeout(() => attempt(retries), SCROLL_INITIAL_DELAY_MS)
}
