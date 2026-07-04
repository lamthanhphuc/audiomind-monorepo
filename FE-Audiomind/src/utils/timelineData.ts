import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'
import { normalizeAnalysisResponse, type AiAnalysis } from '../types'
import { formatTranscriptTimestamp, sortTranscriptSegmentsByTimeline } from './transcript'

export type TimelineChapter = {
  id: string
  title: string
  startTime: number
  endTime: number
  summary?: string
}

/** Pause gap (seconds) between transcript segments that starts a new chapter. */
export const TIMELINE_CHAPTER_GAP_SECONDS = 25

const MAX_TITLE_LENGTH = 72
const MAX_SUMMARY_LENGTH = 160

const truncateText = (value: string, maxLength: number): string => {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) {
    return trimmed
  }
  return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`
}

const dedupeTitles = (titles: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const title of titles) {
    const normalized = title.trim()
    if (!normalized) {
      continue
    }
    const key = normalized.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(normalized)
  }
  return result
}

export const collectAiChapterTitles = (analysis?: AiAnalysis | null): string[] => {
  if (!analysis) {
    return []
  }

  const normalized = normalizeAnalysisResponse(analysis)
  const titles: string[] = []

  for (const section of normalized.groupedActionPlan?.sections ?? []) {
    if (section.title?.trim()) {
      titles.push(section.title.trim())
    }
  }

  for (const topic of normalized.topics ?? []) {
    if (topic.trim()) {
      titles.push(topic.trim())
    }
  }

  for (const keyword of normalized.keywords ?? []) {
    if (keyword.trim()) {
      titles.push(keyword.trim())
    }
  }

  for (const decision of normalized.keyDecisions ?? normalized.decisions ?? []) {
    if (decision.trim()) {
      titles.push(decision.trim())
    }
  }

  for (const point of normalized.key_points ?? []) {
    if (point.trim()) {
      titles.push(point.trim())
    }
  }

  for (const pain of normalized.painPoints ?? []) {
    if (pain.title?.trim()) {
      titles.push(pain.title.trim())
    }
  }

  return dedupeTitles(titles)
}

const inferTitleFromSegments = (segments: TranscriptSegment[]): string | null => {
  const firstText = segments
    .map((segment) => segment.text.trim())
    .find(Boolean)
  if (!firstText) {
    return null
  }

  const words = firstText.split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return null
  }

  return truncateText(words.slice(0, 8).join(' '), MAX_TITLE_LENGTH)
}

const previewFromSegments = (segments: TranscriptSegment[]): string | undefined => {
  const preview = segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' · ')
  return preview ? truncateText(preview, MAX_SUMMARY_LENGTH) : undefined
}

const resolveSegmentStart = (segment: TranscriptSegment): number =>
  segment.start ?? segment.timestamp ?? 0

const resolveSegmentEnd = (segment: TranscriptSegment): number => {
  const start = resolveSegmentStart(segment)
  const end = segment.end
  return Number.isFinite(end) && (end as number) > start ? (end as number) : start
}

const gapBetweenSegments = (previous: TranscriptSegment, next: TranscriptSegment): number => {
  const previousEnd = resolveSegmentEnd(previous)
  const nextStart = resolveSegmentStart(next)
  return Math.max(0, nextStart - previousEnd)
}

export const applyAiTitlesToChapters = (
  chapters: TimelineChapter[],
  analysis?: AiAnalysis | null,
): TimelineChapter[] => {
  if (chapters.length === 0) {
    return chapters
  }

  const normalized = analysis ? normalizeAnalysisResponse(analysis) : null
  const aiTitles = collectAiChapterTitles(normalized)
  const planSections = normalized?.groupedActionPlan?.sections ?? []

  return chapters.map((chapter, index) => {
    const section = planSections[index]
    const sectionTitle = section?.title?.trim()
    const sectionSummary = section?.summary?.trim()
    const aiTitle = aiTitles[index] ?? aiTitles[index % Math.max(aiTitles.length, 1)]

    return {
      ...chapter,
      title: truncateText(
        sectionTitle || aiTitle || chapter.title,
        MAX_TITLE_LENGTH,
      ),
      summary: sectionSummary
        ? truncateText(sectionSummary, MAX_SUMMARY_LENGTH)
        : chapter.summary,
    }
  })
}

export const buildTimelineChapters = (
  segments: TranscriptSegment[],
  analysis?: AiAnalysis | null,
): TimelineChapter[] => {
  if (!segments.length) {
    const painChapters = (analysis?.painPoints ?? []).slice(0, 4).map((item, index) => ({
      id: `pain-${index}`,
      title: item.title,
      startTime: index * 120,
      endTime: (index + 1) * 120,
      summary: item.evidence ?? undefined,
    }))
    return painChapters
  }

  const sorted = sortTranscriptSegmentsByTimeline(
    segments.filter((segment): segment is TranscriptSegment => Boolean(segment) && typeof segment === 'object'),
  )

  const rawChapters: Array<{ bucket: TranscriptSegment[]; bucketStart: number }> = []
  let bucket: TranscriptSegment[] = []
  let bucketStart = resolveSegmentStart(sorted[0])

  const flushBucket = () => {
    if (!bucket.length) {
      return
    }
    rawChapters.push({ bucket: [...bucket], bucketStart })
    bucket = []
  }

  sorted.forEach((segment, index) => {
    const previous = bucket[bucket.length - 1]
    if (previous && gapBetweenSegments(previous, segment) >= TIMELINE_CHAPTER_GAP_SECONDS) {
      flushBucket()
      bucketStart = resolveSegmentStart(segment)
    }

    if (bucket.length === 0) {
      bucketStart = resolveSegmentStart(segment)
    }

    bucket.push(segment)

    if (index === sorted.length - 1) {
      flushBucket()
    }
  })

  let chapters: TimelineChapter[] = rawChapters.map(({ bucket: bucketSegments, bucketStart: start }, index) => {
    const endTime = resolveSegmentEnd(bucketSegments[bucketSegments.length - 1])
    const inferredTitle = inferTitleFromSegments(bucketSegments)
    return {
      id: `chapter-${index}`,
      title: inferredTitle ?? `Phần ${index + 1}`,
      startTime: start,
      endTime,
      summary: previewFromSegments(bucketSegments),
    }
  })

  chapters = applyAiTitlesToChapters(chapters, analysis)

  if (chapters.length === 0 && analysis?.summary?.trim()) {
    const last = sorted[sorted.length - 1]
    chapters.push({
      id: 'summary',
      title: 'Tóm tắt cuộc họp',
      startTime: 0,
      endTime: resolveSegmentEnd(last),
      summary: analysis.summary.trim(),
    })
  }

  return chapters
}

export const formatChapterRange = (chapter: TimelineChapter): string => {
  return `${formatTranscriptTimestamp(chapter.startTime)} - ${formatTranscriptTimestamp(chapter.endTime)}`
}
