// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createScheduledMeeting, getGoogleStatus, GoogleIntegrationError, hasGoogleCalendarScope, isGoogleLinkedWithoutCalendarGrant, needsGoogleIntegrationGrant, missingGoogleLinkScopes, pollGoogleCalendarStatus, redirectToFullGoogleLink, resolveGoogleConnectionState, GOOGLE_CALENDAR_EVENTS_SCOPE, GOOGLE_GMAIL_SEND_SCOPE, FULL_GOOGLE_LINK_SCOPES } from './googleIntegration'

describe('googleIntegration service', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('audiomind.access_token', 'test-jwt')
    vi.restoreAllMocks()
  })

  it('sends the Audiomind JWT when loading Google status', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      linked: true,
      googleEmail: 'person@example.com',
      grantedScopes: [],
      missingScopes: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(getGoogleStatus()).resolves.toMatchObject({ linked: true })
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer test-jwt')
  })

  it('reads the canonical error field and missing scopes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'GOOGLE_SCOPE_MISSING',
      message: 'Required Google permission is missing',
      details: { missingScopes: ['https://www.googleapis.com/auth/calendar.events'] },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }))

    const error = await getGoogleStatus().catch(cause => cause)
    expect(error).toBeInstanceOf(GoogleIntegrationError)
    expect(error).toMatchObject({
      status: 403,
      errorCode: 'GOOGLE_SCOPE_MISSING',
      missingScopes: ['https://www.googleapis.com/auth/calendar.events'],
    })
  })

  it('creates a scheduled Audiomind meeting before Calendar linking', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 42,
      title: 'Future sync',
      status: 'scheduled',
      scheduledStartAt: '2026-06-24T03:00:00Z',
      scheduledEndAt: '2026-06-24T04:00:00Z',
      scheduledTimezone: 'Asia/Ho_Chi_Minh',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(createScheduledMeeting({
      title: 'Future sync',
      startDateTime: '2026-06-24T03:00:00Z',
      endDateTime: '2026-06-24T04:00:00Z',
      timeZone: 'Asia/Ho_Chi_Minh',
    })).resolves.toMatchObject({ id: 42, status: 'scheduled' })

    expect(fetchMock.mock.calls[0][0]).toContain('/meetings/scheduled')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ title: 'Future sync' })
  })

  it('needsGoogleIntegrationGrant is true when any full link scope is missing', () => {
    expect(missingGoogleLinkScopes({
      linked: true,
      googleEmail: 'a@b.com',
      grantedScopes: [],
      missingScopes: [...FULL_GOOGLE_LINK_SCOPES],
    })).toEqual([...FULL_GOOGLE_LINK_SCOPES])
    expect(isGoogleLinkedWithoutCalendarGrant({
      linked: true,
      googleEmail: 'a@b.com',
      grantedScopes: [],
      missingScopes: [...FULL_GOOGLE_LINK_SCOPES],
    })).toBe(true)
    expect(resolveGoogleConnectionState({
      linked: true,
      googleEmail: 'a@b.com',
      grantedScopes: [],
      missingScopes: [...FULL_GOOGLE_LINK_SCOPES],
    })).toBe('needs_calendar')
    expect(needsGoogleIntegrationGrant({
      linked: true,
      googleEmail: 'a@b.com',
      grantedScopes: [],
      missingScopes: [...FULL_GOOGLE_LINK_SCOPES],
    })).toBe(true)
    expect(needsGoogleIntegrationGrant({
      linked: true,
      googleEmail: 'a@b.com',
      grantedScopes: [GOOGLE_CALENDAR_EVENTS_SCOPE],
      missingScopes: [GOOGLE_GMAIL_SEND_SCOPE],
    })).toBe(true)
    expect(hasGoogleCalendarScope({
      linked: true,
      googleEmail: 'a@b.com',
      grantedScopes: [GOOGLE_CALENDAR_EVENTS_SCOPE],
      missingScopes: [GOOGLE_GMAIL_SEND_SCOPE],
    })).toBe(true)
    expect(needsGoogleIntegrationGrant({
      linked: true,
      googleEmail: 'a@b.com',
      grantedScopes: [...FULL_GOOGLE_LINK_SCOPES],
      missingScopes: [],
    })).toBe(false)
  })

  it('redirectToFullGoogleLink requests calendar and gmail scopes then assigns location', async () => {
    const assign = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?scope=calendar',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await redirectToFullGoogleLink('/studio/upload')

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      additionalScopes: [...FULL_GOOGLE_LINK_SCOPES],
      redirectAfter: '/studio/upload',
    })
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?scope=calendar')

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    })
  })

  it('pollGoogleCalendarStatus keeps polling while creationStatus is creating', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        meetingId: 42,
        creationStatus: 'creating',
        conferenceStatus: 'pending',
        googleCalendarEventId: 'evt-1',
        meetUri: null,
        hangoutLink: null,
        htmlLink: null,
        errorCode: null,
      }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        meetingId: 42,
        creationStatus: 'success',
        conferenceStatus: 'success',
        googleCalendarEventId: 'evt-1',
        meetUri: 'https://meet.google.com/abc-defg-hij',
        hangoutLink: null,
        htmlLink: null,
        errorCode: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const pollPromise = pollGoogleCalendarStatus(42, { maxAttempts: 2 })
    await vi.advanceTimersByTimeAsync(1000)
    const result = await pollPromise

    expect(result.creationStatus).toBe('success')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
