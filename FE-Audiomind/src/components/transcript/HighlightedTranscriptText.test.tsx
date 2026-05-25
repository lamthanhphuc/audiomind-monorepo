import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HighlightedTranscriptText } from './HighlightedTranscriptText'

describe('HighlightedTranscriptText', () => {
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

  it('renders mark nodes for matched IT terms', () => {
    act(() => {
      root.render(<HighlightedTranscriptText text="JWT authentication with Docker deployment" />)
    })

    const highlights = Array.from(container.querySelectorAll('.it-term-highlight')).map((node) => node.textContent)
    expect(highlights).toEqual(['JWT', 'authentication', 'Docker', 'deployment'])
  })

  it('does not rely on dangerouslySetInnerHTML', () => {
    act(() => {
      root.render(<HighlightedTranscriptText text={'API <img src=x onerror=alert(1) />'} />)
    })

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('API <img src=x onerror=alert(1) />')
  })

  it('preserves text order exactly', () => {
    const text = 'WebSocket latency and JWT authentication are tracked.'
    act(() => {
      root.render(<HighlightedTranscriptText text={text} />)
    })

    expect(container.textContent).toBe(text)
  })

  it('renders plain text when disabled', () => {
    act(() => {
      root.render(<HighlightedTranscriptText text="JWT authentication" enabled={false} />)
    })

    expect(container.querySelectorAll('.it-term-highlight')).toHaveLength(0)
    expect(container.textContent).toBe('JWT authentication')
  })

  it('renders plain text when no term matches', () => {
    act(() => {
      root.render(<HighlightedTranscriptText text="Xin chao moi nguoi" />)
    })

    expect(container.querySelectorAll('.it-term-highlight')).toHaveLength(0)
    expect(container.textContent).toBe('Xin chao moi nguoi')
  })

  it('renders Vietnamese IT phrase highlights safely', () => {
    const text = 'Ngành công nghệ thông tin đào tạo kỹ thuật phần mềm và quản trị mạng.'
    act(() => {
      root.render(<HighlightedTranscriptText text={text} />)
    })

    const highlights = Array.from(container.querySelectorAll('.it-term-highlight')).map((node) => node.textContent)
    expect(highlights).toEqual(['công nghệ thông tin', 'kỹ thuật phần mềm', 'quản trị mạng'])
    expect(container.textContent).toBe(text)
  })

  it('renders AI-domain highlights and skips lowercase pronoun it', () => {
    const text = "Anthropic says AI agent is one thing while imagining it."
    act(() => {
      root.render(<HighlightedTranscriptText text={text} />)
    })

    const highlights = Array.from(container.querySelectorAll('.it-term-highlight')).map((node) => node.textContent)
    expect(highlights).toEqual(['Anthropic', 'AI agent'])
    expect(container.textContent).toBe(text)
  })
})
