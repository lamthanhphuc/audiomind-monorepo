// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OAUTH_COMPLETE_MESSAGE_TYPE,
  publishOAuthComplete,
  returnToOAuthOpener,
  subscribeOAuthComplete,
  type OAuthCompleteEvent,
} from './oauthCallbackHandoff'

const sampleEvent: OAuthCompleteEvent = {
  provider: 'google',
  status: 'success',
  message: 'Đã kết nối Google.',
  route: { scene: 'integrations', meetingId: null },
}

describe('oauthCallbackHandoff', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returnToOAuthOpener posts to opener, focuses it, and closes callback tab', () => {
    const postMessage = vi.fn()
    const focus = vi.fn()
    const close = vi.fn()
    const opener = { closed: false, postMessage, focus } as unknown as Window
    vi.spyOn(window, 'close').mockImplementation(close)
    Object.defineProperty(window, 'opener', { configurable: true, value: opener })

    expect(returnToOAuthOpener(sampleEvent)).toBe(true)
    expect(postMessage).toHaveBeenCalledWith(
      { type: OAUTH_COMPLETE_MESSAGE_TYPE, ...sampleEvent },
      window.location.origin,
    )
    expect(focus).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()

    Object.defineProperty(window, 'opener', { configurable: true, value: null })
  })

  it('returnToOAuthOpener returns false when opener is missing', () => {
    Object.defineProperty(window, 'opener', { configurable: true, value: null })
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})

    expect(returnToOAuthOpener(sampleEvent)).toBe(false)
    expect(close).not.toHaveBeenCalled()
  })

  it('subscribeOAuthComplete receives postMessage events', () => {
    const handler = vi.fn()
    const unsubscribe = subscribeOAuthComplete(handler)

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: OAUTH_COMPLETE_MESSAGE_TYPE, ...sampleEvent },
    }))

    expect(handler).toHaveBeenCalledWith(sampleEvent)
    unsubscribe()
  })

  it('publishOAuthComplete broadcasts on BroadcastChannel', () => {
    const postMessage = vi.fn()
    const close = vi.fn()
    class MockBroadcastChannel {
      postMessage = postMessage
      close = close
    }
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)

    publishOAuthComplete(sampleEvent)

    expect(postMessage).toHaveBeenCalledWith(sampleEvent)
    expect(close).toHaveBeenCalled()
  })
})
