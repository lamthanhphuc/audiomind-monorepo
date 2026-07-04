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

export const scrollTranscriptToHighlight = (range: TranscriptHighlightRange): void => {
  if (typeof document === 'undefined') {
    return
  }

  window.setTimeout(() => {
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

    target ??= document.querySelector<HTMLElement>('.transcript-display__segment--highlight')
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, 50)
}
