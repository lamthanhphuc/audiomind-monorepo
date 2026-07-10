// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MeetingAudioPlayer from './MeetingAudioPlayer'

describe('MeetingAudioPlayer', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
  })

  it('plays a local audio file', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'demo.mp3', { type: 'audio/mpeg' })
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:demo')
    globalThis.URL.revokeObjectURL = vi.fn()

    await act(async () => {
      root.render(<MeetingAudioPlayer label="demo.mp3" audioFile={file} />)
    })

    const playButton = container.querySelector('[data-testid="meeting-audio-play"]') as HTMLButtonElement
    expect(playButton.disabled).toBe(false)

    await act(async () => {
      playButton.click()
    })

    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
  })

  it('shows unavailable message without source', async () => {
    await act(async () => {
      root.render(<MeetingAudioPlayer label="Không có audio" />)
    })

    expect(container.textContent).toMatch(/Chưa có file âm thanh/)
    expect((container.querySelector('[data-testid="meeting-audio-play"]') as HTMLButtonElement).disabled).toBe(true)
  })
})

