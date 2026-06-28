import type { ParsedStudioRoute } from './studioRouting'

export const OAUTH_COMPLETE_MESSAGE_TYPE = 'audiomind.oauth.complete' as const
const OAUTH_BROADCAST_CHANNEL = 'audiomind.oauth.complete'

export type OAuthProvider = 'google' | 'zoom' | 'teams'

export type OAuthCompleteEvent = {
  provider: OAuthProvider
  status: 'success' | 'error'
  message: string
  route?: ParsedStudioRoute | null
  tone?: 'success' | 'error' | 'info'
}

const isOAuthCompleteEvent = (value: unknown): value is OAuthCompleteEvent => {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<OAuthCompleteEvent>
  return (
    (event.provider === 'google' || event.provider === 'zoom' || event.provider === 'teams')
    && (event.status === 'success' || event.status === 'error')
    && typeof event.message === 'string'
  )
}

export const publishOAuthComplete = (event: OAuthCompleteEvent): void => {
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(OAUTH_BROADCAST_CHANNEL)
    channel.postMessage(event)
    channel.close()
  }
}

/**
 * Notify the tab that opened OAuth, focus it, and close this callback tab.
 * Returns false when there is no opener (same-tab OAuth fallback).
 */
export const returnToOAuthOpener = (event: OAuthCompleteEvent): boolean => {
  publishOAuthComplete(event)

  const opener = window.opener
  if (!opener || opener.closed) {
    return false
  }

  try {
    opener.postMessage({ type: OAUTH_COMPLETE_MESSAGE_TYPE, ...event }, window.location.origin)
    opener.focus()
    window.close()
    return true
  } catch {
    return false
  }
}

export const subscribeOAuthComplete = (
  handler: (event: OAuthCompleteEvent) => void,
): (() => void) => {
  const onMessage = (messageEvent: MessageEvent) => {
    if (messageEvent.origin !== window.location.origin) return
    const payload = messageEvent.data
    if (payload?.type !== OAUTH_COMPLETE_MESSAGE_TYPE) return
    if (!isOAuthCompleteEvent(payload)) return
    const { type: _type, ...event } = payload as OAuthCompleteEvent & { type?: string }
    handler(event)
  }

  window.addEventListener('message', onMessage)

  let channel: BroadcastChannel | null = null
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(OAUTH_BROADCAST_CHANNEL)
    channel.onmessage = (messageEvent) => {
      if (!isOAuthCompleteEvent(messageEvent.data)) return
      handler(messageEvent.data)
    }
  }

  return () => {
    window.removeEventListener('message', onMessage)
    channel?.close()
  }
}
