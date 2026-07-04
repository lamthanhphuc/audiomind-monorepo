// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import { TranscriptDisplay } from './TranscriptDisplay'

const legalLexiconTerms = [{ canonical: 'hợp đồng', aliases: ['hop dong', 'hop_dong'] }]
const itLexiconTerms = [{ canonical: 'microservice', aliases: ['micro-service'] }]

vi.mock('../../hooks/useDomainLexiconTerms', () => ({
  useDomainLexiconTerms: (domainMode?: string | null) => {
    if (domainMode === 'legal') {
      return legalLexiconTerms
    }
    if (domainMode === 'it') {
      return itLexiconTerms
    }
    return []
  },
}))

const segment = (text: string): TranscriptSegment => ({
  id: 'seg-1',
  speaker: 'SPEAKER_1',
  text,
  start: 0,
  end: 5,
  timestamp: 0,
  isFinal: true,
})

describe('TranscriptDisplay lexicon highlighting', () => {
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
  })

  it('highlights legal domain lexicon terms when domainMode is legal', () => {
    act(() => {
      root.render(
        <TranscriptDisplay
          segments={[segment('Bên A ký hợp đồng mới')]}
          domainMode="legal"
        />,
      )
    })

    const highlights = Array.from(container.querySelectorAll('.it-term-highlight')).map((node) => node.textContent)
    expect(highlights).toContain('hợp đồng')
    expect(container.textContent).toContain('Bên A ký hợp đồng mới')
  })

  it('highlights IT domain lexicon terms when domainMode is it', () => {
    act(() => {
      root.render(
        <TranscriptDisplay
          segments={[segment('Kiến trúc microservice trên Kubernetes')]}
          domainMode="it"
        />,
      )
    })

    const highlights = Array.from(container.querySelectorAll('.it-term-highlight')).map((node) => node.textContent)
    expect(highlights).toContain('microservice')
  })

  it('uses default IT terms only when domainMode is unset', () => {
    act(() => {
      root.render(
        <TranscriptDisplay
          segments={[segment('JWT authentication flow')]}
        />,
      )
    })

    const highlights = Array.from(container.querySelectorAll('.it-term-highlight')).map((node) => node.textContent)
    expect(highlights).toContain('JWT')
    expect(highlights).not.toContain('hợp đồng')
  })
})
