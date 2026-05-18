import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
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
})