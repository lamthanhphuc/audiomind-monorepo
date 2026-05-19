import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { RealtimeTranscript } from './RealtimeTranscript'
import { mergeTranscriptSegments, normalizePersistedTranscriptSegments } from '../utils/transcript'

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
})