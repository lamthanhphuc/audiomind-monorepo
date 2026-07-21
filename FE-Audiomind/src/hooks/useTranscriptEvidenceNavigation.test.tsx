import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTranscriptEvidenceNavigation } from './useTranscriptEvidenceNavigation'
import type { TranscriptSegment } from './useRealtimeMeetingStream'
import type { EvidenceClickHandler } from '../utils/transcriptEvidence'

vi.mock('../utils/transcriptJump', async () => {
  const actual = await vi.importActual<typeof import('../utils/transcriptJump')>('../utils/transcriptJump')
  return {
    ...actual,
    scrollTranscriptToHighlight: vi.fn(),
  }
})

import { scrollTranscriptToHighlight } from '../utils/transcriptJump'

const makeSegment = (overrides: Partial<TranscriptSegment>): TranscriptSegment => ({
  id: 'meeting-1-start-1.500-alice',
  speaker: 'alice',
  text: 'hello',
  start: 1.5,
  end: 3.5,
  ...overrides,
})

describe('useTranscriptEvidenceNavigation', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let navigateToSegment: EvidenceClickHandler
  let onHighlightChange: ReturnType<typeof vi.fn>
  let onNavigateSuccess: ReturnType<typeof vi.fn>
  let onMissingSegment: ReturnType<typeof vi.fn>

  const mount = (segments: TranscriptSegment[]) => {
    onHighlightChange = vi.fn()
    onNavigateSuccess = vi.fn()
    onMissingSegment = vi.fn()

    function Harness() {
      const result = useTranscriptEvidenceNavigation({
        segments,
        onHighlightChange,
        onNavigateSuccess,
        onMissingSegment,
      })
      navigateToSegment = result.navigateToSegment
      return null
    }

    act(() => {
      root.render(<Harness />)
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('resolves a single segment and reports success', () => {
    mount([makeSegment({ id: 'meeting-1-start-1.500-alice', start: 1.5, end: 3.5 })])

    act(() => {
      navigateToSegment(['meeting-1-start-1.500-alice'])
    })

    expect(onNavigateSuccess).toHaveBeenCalledTimes(1)
    expect(onHighlightChange).toHaveBeenCalledWith({ startTime: 1.5, endTime: 3.5 })
    expect(scrollTranscriptToHighlight).toHaveBeenCalledWith({ startTime: 1.5, endTime: 3.5 })
    expect(onMissingSegment).not.toHaveBeenCalled()
  })

  it('resolves multiple segments into a merged highlight range', () => {
    mount([
      makeSegment({ id: 'meeting-1-start-1.500-alice', start: 1.5, end: 3.5 }),
      makeSegment({ id: 'meeting-1-start-5.000-bob', start: 5, end: 8 }),
    ])

    act(() => {
      navigateToSegment(['meeting-1-start-1.500-alice', 'meeting-1-start-5.000-bob'])
    })

    expect(onNavigateSuccess).toHaveBeenCalledTimes(1)
    expect(onHighlightChange).toHaveBeenCalledWith({ startTime: 1.5, endTime: 8 })
  })

  it('reports missing segment and does not switch tab when nothing matches', () => {
    mount([makeSegment({ id: 'meeting-1-start-1.500-alice', start: 1.5, end: 3.5 })])

    act(() => {
      navigateToSegment(['meeting-99-start-1.500-nobody'])
    })

    expect(onMissingSegment).toHaveBeenCalledWith(['meeting-99-start-1.500-nobody'])
    expect(onNavigateSuccess).not.toHaveBeenCalled()
    expect(onHighlightChange).not.toHaveBeenCalled()
    expect(scrollTranscriptToHighlight).not.toHaveBeenCalled()
  })

  it('ignores empty/whitespace segment id arrays without calling any callback', () => {
    mount([makeSegment({})])

    act(() => {
      navigateToSegment(['', '   '])
    })

    expect(onMissingSegment).not.toHaveBeenCalled()
    expect(onNavigateSuccess).not.toHaveBeenCalled()

    act(() => {
      navigateToSegment([])
    })
    expect(onMissingSegment).not.toHaveBeenCalled()
  })

  it('does not throw on malformed ids', () => {
    mount([makeSegment({})])
    expect(() => {
      act(() => {
        navigateToSegment(['garbage', 'meeting-not-a-valid-id'])
      })
    }).not.toThrow()
  })
})
