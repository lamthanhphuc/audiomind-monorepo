import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordingSourceSelector } from './RecordingSourceSelector'

describe('RecordingSourceSelector', () => {
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

  it('renders three source cards with descriptions', () => {
    act(() => {
      root.render(
        <RecordingSourceSelector
          value="microphone"
          onChange={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain('Nguồn ghi âm')
    expect(container.textContent).toContain('Microphone')
    expect(container.textContent).toContain('Ghi âm tab trình duyệt')
    expect(container.textContent).toContain('Tab trình duyệt + Microphone')
    expect(container.textContent).toContain('Ghi âm giọng nói từ micro của bạn.')
    expect(container.querySelectorAll('.recording-source-card')).toHaveLength(3)
    expect(
      container.querySelector('[data-testid="recording-source-option-microphone"]')
        ?.classList.contains('recording-source-card--selected'),
    ).toBe(true)
  })

  it('shows tab capture guide when tab source is selected', () => {
    act(() => {
      root.render(
        <RecordingSourceSelector
          value="browser_tab"
          onChange={vi.fn()}
        />,
      )
    })

    expect(container.querySelector('[data-testid="recording-source-tab-guide"]')).not.toBeNull()
    expect(container.textContent).toContain('Meet, Teams')
    expect(container.textContent).toContain('Chia sẻ âm thanh tab')
    expect(container.textContent).not.toContain('Nên dùng tai nghe')
  })

  it('shows headphone note for tab + microphone', () => {
    act(() => {
      root.render(
        <RecordingSourceSelector
          value="browser_tab_with_mic"
          onChange={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain('Nên dùng tai nghe để tránh vọng âm.')
  })

  it('shows dual-stream quota note when enabled for tab + microphone', () => {
    act(() => {
      root.render(
        <RecordingSourceSelector
          value="browser_tab_with_mic"
          showDualStreamQuotaNote
          onChange={vi.fn()}
        />,
      )
    })

    expect(container.querySelector('[data-testid="recording-source-quota-note"]')).not.toBeNull()
    expect(container.textContent).toMatch(/hai luồng|gấp đôi quota STT/i)
  })

  it('calls onChange when another source card is clicked', () => {
    const onChange = vi.fn()

    act(() => {
      root.render(
        <RecordingSourceSelector
          value="microphone"
          onChange={onChange}
        />,
      )
    })

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="recording-source-option-browser_tab"]')?.click()
    })

    expect(onChange).toHaveBeenCalledWith('browser_tab')
  })

  it('does not call onChange when disabled', () => {
    const onChange = vi.fn()

    act(() => {
      root.render(
        <RecordingSourceSelector
          value="microphone"
          disabled
          onChange={onChange}
        />,
      )
    })

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="recording-source-option-browser_tab"]')?.click()
    })

    expect(onChange).not.toHaveBeenCalled()
  })
})
