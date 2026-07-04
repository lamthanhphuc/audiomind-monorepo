import { describe, expect, it } from 'vitest'
import type { TranscriptSegment } from '../hooks/useRealtimeMeetingStream'
import type { AiAnalysis } from '../types'
import {
  applyAiTitlesToChapters,
  buildTimelineChapters,
  collectAiChapterTitles,
  TIMELINE_CHAPTER_GAP_SECONDS,
  type TimelineChapter,
} from './timelineData'

const segment = (
  start: number,
  end: number,
  text: string,
  id = `seg-${start}`,
): TranscriptSegment => ({
  id,
  text,
  start,
  end,
  timestamp: start,
  speaker: 'A',
})

const planSection = (title: string, summary?: string, order = 0) => ({
  id: `section-${order}`,
  order,
  title,
  summary,
  items: [{ id: `item-${order}`, title: 'Task', subtasks: [] }],
})

describe('buildTimelineChapters', () => {
  it('splits chapters when pause gap meets threshold', () => {
    const segments = [
      segment(0, 10, 'Mở đầu cuộc họp'),
      segment(12, 20, 'Tiếp tục phần một'),
      segment(60, 70, 'Sau khi nghỉ dài'),
      segment(72, 80, 'Phần hai tiếp tục'),
    ]

    const chapters = buildTimelineChapters(segments)

    expect(chapters).toHaveLength(2)
    expect(chapters[0].startTime).toBe(0)
    expect(chapters[0].endTime).toBe(20)
    expect(chapters[1].startTime).toBe(60)
    expect(chapters[1].endTime).toBe(80)
  })

  it('does not split on short pauses below gap threshold', () => {
    const pause = TIMELINE_CHAPTER_GAP_SECONDS - 5
    const duration = 10
    const segments: TranscriptSegment[] = []
    let start = 0

    for (let index = 0; index < 8; index += 1) {
      segments.push(segment(start, start + duration, `Đoạn ${index + 1}`))
      start += duration + pause
    }

    const chapters = buildTimelineChapters(segments)

    expect(chapters).toHaveLength(1)
  })

  it('prefers AI section titles over inferred transcript titles', () => {
    const segments = [
      segment(0, 10, 'Xin chào mọi người hôm nay'),
      segment(40, 50, 'Chúng ta bàn về ngân sách'),
    ]

    const analysis = {
      groupedActionPlan: {
        sections: [
          planSection('Khai mạc', 'Chào hỏi và mục tiêu', 0),
          planSection('Ngân sách Q3', 'Thảo luận chi phí', 1),
        ],
      },
      topics: ['Roadmap'],
    } as unknown as AiAnalysis

    const chapters = buildTimelineChapters(segments, analysis)

    expect(chapters).toHaveLength(2)
    expect(chapters[0].title).toBe('Khai mạc')
    expect(chapters[0].summary).toBe('Chào hỏi và mục tiêu')
    expect(chapters[1].title).toBe('Ngân sách Q3')
  })
})

describe('collectAiChapterTitles', () => {
  it('collects titles from grouped plan, topics, and decisions', () => {
    const analysis = {
      groupedActionPlan: {
        sections: [planSection('Phần A', undefined, 0)],
      },
      topics: ['Chiến lược'],
      keyDecisions: ['Chốt deadline'],
      keywords: ['Chiến lược'],
    } as unknown as AiAnalysis

    expect(collectAiChapterTitles(analysis)).toEqual(['Phần A', 'Chiến lược', 'Chốt deadline'])
  })
})

describe('applyAiTitlesToChapters', () => {
  it('maps section titles by chapter index', () => {
    const chapters: TimelineChapter[] = [
      { id: 'c0', title: 'Phần 1', startTime: 0, endTime: 10 },
      { id: 'c1', title: 'Phần 2', startTime: 30, endTime: 40 },
    ]

    const analysis = {
      groupedActionPlan: {
        sections: [planSection('Kickoff', undefined, 0), planSection('Review', undefined, 1)],
      },
    } as unknown as AiAnalysis

    const updated = applyAiTitlesToChapters(chapters, analysis)

    expect(updated[0].title).toBe('Kickoff')
    expect(updated[1].title).toBe('Review')
  })
})
