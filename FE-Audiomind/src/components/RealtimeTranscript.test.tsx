import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as transcriptUtils from '../utils/transcript'
import { mergeTranscriptSegments, normalizePersistedTranscriptSegments } from '../utils/transcript'
import { RealtimeTranscript } from './RealtimeTranscript'

describe('RealtimeTranscript', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
  })

  it('formats seconds-based transcript timestamps without treating them as milliseconds', () => {
    act(() => {
      root.render(
        <RealtimeTranscript
          segments={[
            {
              id: 'meeting-2-start-7.810',
              mergeKey: 'segment:meeting-2-start-7.810',
              speaker: 'Speaker 1',
              text: 'Xin chào Audiomind',
              start: 7.81,
              end: 12.57,
              timestamp: 7.81,
            },
            {
              id: 'meeting-2-start-18.940',
              mergeKey: 'segment:meeting-2-start-18.940',
              speaker: 'Speaker 2',
              text: 'Đây là câu hoàn chỉnh',
              start: 18.94,
              end: 18.94,
              timestamp: 18.94,
            },
          ]}
        />,
      )
    })

    const timestamps = Array.from(container.querySelectorAll('.segment-timestamp')).map((node) => node.textContent)
    expect(timestamps).toEqual(['0:07 - 0:12', '0:18'])
  })

  it('renders multiple rows from hydrated persisted fragments', () => {
    const hydratedSegments = mergeTranscriptSegments(
      normalizePersistedTranscriptSegments([
        {
          speaker: 'Speaker 1',
          start_time: 7.81,
          end_time: 8.48,
          text: 'Xin chào Audiomind',
        },
        {
          speaker: 'Speaker 2',
          start_time: 18.94,
          end_time: 19.4,
          text: 'Đây là câu hoàn chỉnh',
        },
      ]),
    )

    act(() => {
      root.render(<RealtimeTranscript segments={hydratedSegments} />)
    })

    expect(container.querySelector('.segment-count')?.textContent).toBe('2 segments')
    const transcriptRows = Array.from(container.querySelectorAll('.transcript-segment'))
    expect(transcriptRows).toHaveLength(2)

    const timestamps = Array.from(container.querySelectorAll('.segment-timestamp')).map((node) => node.textContent)
    expect(timestamps).toEqual(['0:07 - 0:08', '0:18 - 0:19'])
  })

  it('shows the waiting state when hydration returns no fragments', () => {
    act(() => {
      root.render(<RealtimeTranscript segments={[]} />)
    })

    expect(container.textContent).toContain('Waiting for transcript...')
    expect(container.querySelector('.segment-count')).toBeNull()
  })

  it('ignores persisted aggregate rows without meaningful timing or segment identity', () => {
    const hydratedSegments = mergeTranscriptSegments(
      normalizePersistedTranscriptSegments([
        {
          speaker: 'Speaker 0',
          text: 'Tổng hợp nhưng không có thời gian',
          start_time: 0,
          end_time: 0,
        },
      ]),
    )

    act(() => {
      root.render(<RealtimeTranscript segments={hydratedSegments} />)
    })

    expect(hydratedSegments).toHaveLength(0)
    expect(container.textContent).toContain('Waiting for transcript...')
    expect(container.querySelector('.segment-count')).toBeNull()
    expect(container.querySelectorAll('.transcript-segment')).toHaveLength(0)
  })

  it('renders missing or system speakers as SPEAKER_1 in realtime transcript UI', () => {
    act(() => {
      root.render(
        <RealtimeTranscript
          segments={[
            {
              id: 'meeting-2-start-1.000',
              mergeKey: 'segment:meeting-2-start-1.000',
              speaker: 'system',
              text: 'Xin chào',
              start: 1,
              end: 2,
              timestamp: 1,
            },
            {
              id: 'meeting-2-start-2.000',
              mergeKey: 'segment:meeting-2-start-2.000',
              speaker: '',
              text: 'Audiomind',
              start: 2,
              end: 3,
              timestamp: 2,
            },
          ]}
        />,
      )
    })

    const speakers = Array.from(container.querySelectorAll('.segment-speaker')).map((node) => node.textContent)
    expect(speakers).toEqual(['SPEAKER_1', 'SPEAKER_1'])
  })

  it('does not call upload display grouping utility in realtime render path', () => {
    const groupingSpy = vi.spyOn(transcriptUtils, 'groupUploadTranscriptSegmentsForDisplay')

    act(() => {
      root.render(
        <RealtimeTranscript
          segments={[
            {
              id: 'meeting-1-start-7.810',
              mergeKey: 'segment:meeting-1-start-7.810',
              speaker: 'Speaker 1',
              text: 'Xin chào',
              start: 7.81,
              end: 8.4,
              timestamp: 7.81,
            },
          ]}
        />,
      )
    })

    expect(groupingSpy).not.toHaveBeenCalled()
  })

  it('renders highlighted IT terms in realtime transcript rows', () => {
    act(() => {
      root.render(
        <RealtimeTranscript
          segments={[
            {
              id: 'meeting-3-start-1.000',
              mergeKey: 'segment:meeting-3-start-1.000',
              speaker: 'Speaker 1',
              text: 'Testing WebSocket latency with Docker deployment',
              start: 1,
              end: 4,
              timestamp: 1,
            },
          ]}
        />,
      )
    })

    const highlights = Array.from(container.querySelectorAll('.it-term-highlight')).map((node) => node.textContent)
    expect(highlights).toEqual(['WebSocket latency', 'Docker', 'deployment'])
    expect(container.querySelectorAll('.transcript-segment')).toHaveLength(1)
  })

  it('highlights keyword prop terms using the same safe render path', () => {
    act(() => {
      root.render(
        <RealtimeTranscript
          highlightKeywords={['Audiomind']}
          segments={[
            {
              id: 'meeting-3-start-5.000',
              mergeKey: 'segment:meeting-3-start-5.000',
              speaker: 'Speaker 1',
              text: 'Audiomind still appears as normal text source',
              start: 5,
              end: 6,
              timestamp: 5,
            },
          ]}
        />,
      )
    })

    expect(container.querySelectorAll('.it-term-highlight')).toHaveLength(1)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Audiomind still appears as normal text source')
  })

  it('renders AI-domain highlights in realtime and does not highlight pronoun it', () => {
    act(() => {
      root.render(
        <RealtimeTranscript
          segments={[
            {
              id: 'meeting-4-start-2.000',
              mergeKey: 'segment:meeting-4-start-2.000',
              speaker: 'Speaker 1',
              text: "Anthropic says AI agent is one thing. OpenAI says AI agents are different. These are the biggest AI labs and it's fine.",
              start: 2,
              end: 8,
              timestamp: 2,
            },
          ]}
        />,
      )
    })

    const highlights = Array.from(container.querySelectorAll('.it-term-highlight')).map((node) => node.textContent)
    expect(highlights).toEqual(['Anthropic', 'AI agent', 'OpenAI', 'AI agents', 'AI labs'])
    expect(highlights).not.toContain('it')
    expect(highlights).not.toContain('It')
  })
})
