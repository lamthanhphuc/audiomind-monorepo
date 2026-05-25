import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizePersistedTranscriptSegments } from '../utils/transcript'
import { TranscriptDisplay } from './TranscriptDisplay'

describe('TranscriptDisplay', () => {
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

  it('renders structured upload segments as readable speaker blocks with timestamps', () => {
    const segments = normalizePersistedTranscriptSegments([
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
        text: 'Tom, I am so tired of learning English.',
      },
    ])

    act(() => {
      root.render(<TranscriptDisplay segments={segments} />)
    })

    expect(container.querySelectorAll('.transcript-display__segment')).toHaveLength(2)
    expect(container.querySelectorAll('.transcript-display__speaker')).toHaveLength(2)
    expect(container.textContent).toContain('SPEAKER_1')
    expect(container.textContent).toContain('SPEAKER_2')
    expect(container.textContent).toContain('0:07 - 0:08')
    expect(container.textContent).toContain('0:18 - 0:19')
    expect(container.textContent).toContain('Xin chào Audiomind')
    expect(container.textContent).toContain('Tom, I am so tired of learning English.')
  })

  it('renders grouped upload blocks when enableDisplayGrouping is true', () => {
    const segments = normalizePersistedTranscriptSegments([
      {
        speaker: 'Speaker 1',
        start_time: 280,
        end_time: 281,
        text: 'hoặc',
      },
      {
        speaker: 'Speaker 1',
        start_time: 285,
        end_time: 303,
        text: 'giảng viên tại các trường...',
      },
    ])

    act(() => {
      root.render(<TranscriptDisplay segments={segments} enableDisplayGrouping />)
    })

    expect(container.querySelectorAll('.transcript-display__segment')).toHaveLength(1)
    expect(container.textContent).toContain('4:40 - 5:03')
    expect(container.textContent).toContain('hoặc giảng viên tại các trường...')
  })

  it('renders highlighted IT terms in upload transcript segments', () => {
    const segments = normalizePersistedTranscriptSegments([
      {
        speaker: 'Speaker 1',
        start_time: 12,
        end_time: 18,
        text: 'WebSocket latency and JWT authentication',
      },
    ])

    act(() => {
      root.render(<TranscriptDisplay segments={segments} />)
    })

    const highlights = Array.from(container.querySelectorAll('.it-term-highlight')).map((node) => node.textContent)
    expect(highlights).toEqual(['WebSocket latency', 'JWT', 'authentication'])
    expect(container.textContent).toContain('WebSocket latency and JWT authentication')
  })

  it('renders highlighted Vietnamese IT terms in upload transcript segments', () => {
    const segments = normalizePersistedTranscriptSegments([
      {
        speaker: 'Speaker 1',
        start_time: 21,
        end_time: 30,
        text: 'Ngành công nghệ thông tin gồm hệ thống thông tin và kỹ thuật phần mềm.',
      },
    ])

    act(() => {
      root.render(<TranscriptDisplay segments={segments} />)
    })

    const highlights = Array.from(container.querySelectorAll('.it-term-highlight')).map((node) => node.textContent)
    expect(highlights).toEqual(['công nghệ thông tin', 'hệ thống thông tin', 'kỹ thuật phần mềm'])
  })

  it('keeps ungrouped behavior when enableDisplayGrouping is false', () => {
    const segments = normalizePersistedTranscriptSegments([
      {
        speaker: 'Speaker 1',
        start_time: 280,
        end_time: 281,
        text: 'hoặc',
      },
      {
        speaker: 'Speaker 1',
        start_time: 285,
        end_time: 303,
        text: 'giảng viên tại các trường...',
      },
    ])

    act(() => {
      root.render(<TranscriptDisplay segments={segments} enableDisplayGrouping={false} />)
    })

    expect(container.querySelectorAll('.transcript-display__segment')).toHaveLength(2)
    expect(container.textContent).toContain('4:40 - 4:41')
    expect(container.textContent).toContain('4:45 - 5:03')
  })

  it('splits plain transcript text into speaker blocks when speaker markers are present', () => {
    act(() => {
      root.render(
        <TranscriptDisplay
          segments={[]}
          transcriptTextFallback={'SPEAKER_1: Xin chào mọi người. SPEAKER_2: Tom, I am so tired of learning English.'}
        />,
      )
    })

    expect(container.querySelectorAll('.transcript-display__segment')).toHaveLength(2)
    expect(container.textContent).toContain('SPEAKER_1')
    expect(container.textContent).toContain('SPEAKER_2')
    expect(container.textContent).toContain('Xin chào mọi người.')
    expect(container.textContent).toContain('Tom, I am so tired of learning English.')
  })

  it('falls back to a single readable block when no speaker marker exists', () => {
    act(() => {
      root.render(
        <TranscriptDisplay
          segments={[]}
          transcriptTextFallback={'Xin chào tiếng Việt và English text vẫn giữ nguyên.'}
        />,
      )
    })

    expect(container.querySelectorAll('.transcript-display__segment')).toHaveLength(1)
    expect(container.textContent).toContain('SPEAKER_1')
    expect(container.textContent).toContain('Xin chào tiếng Việt và English text vẫn giữ nguyên.')
  })

  it('shows an empty state when no transcript exists', () => {
    act(() => {
      root.render(<TranscriptDisplay segments={[]} />)
    })

    expect(container.textContent).toContain('Không có transcript')
    expect(container.querySelectorAll('.transcript-display__segment')).toHaveLength(0)
  })
})
