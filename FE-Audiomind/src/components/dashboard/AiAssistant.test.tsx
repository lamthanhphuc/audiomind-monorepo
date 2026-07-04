// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AiAssistant from './AiAssistant'

describe('AiAssistant', () => {
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

  it('shows meeting welcome when meetingId is set', () => {
    act(() => {
      root.render(<AiAssistant meetingId={3} onAsk={vi.fn().mockResolvedValue('ok')} />)
    })
    expect(container.textContent).toContain('Hỏi về tóm tắt')
  })

  it('disables send while busy', () => {
    act(() => {
      root.render(<AiAssistant meetingId={3} busy onAsk={vi.fn()} />)
    })
    const sendButton = container.querySelector('.btn-send') as HTMLButtonElement
    expect(sendButton.disabled).toBe(true)
  })

  it('shows demo messages when no meetingId', () => {
    act(() => {
      root.render(<AiAssistant onAsk={vi.fn()} />)
    })
    expect(container.textContent).toContain('tóm tắt')
  })
})
