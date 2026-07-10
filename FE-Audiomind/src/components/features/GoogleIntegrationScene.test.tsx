// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GoogleIntegrationScene from './GoogleIntegrationScene'
import * as googleIntegration from '../../services/googleIntegration'

vi.mock('../../services/googleIntegration', async () => {
  const actual = await vi.importActual<typeof googleIntegration>('../../services/googleIntegration')
  return {
    ...actual,
    getGoogleStatus: vi.fn(),
    getGoogleCalendarStatus: vi.fn(),
    listGoogleCalendarMeetings: vi.fn(),
    pollGoogleCalendarStatus: vi.fn(),
  }
})

describe('GoogleIntegrationScene', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.mocked(googleIntegration.getGoogleStatus).mockResolvedValue({
      linked: true,
      googleEmail: 'user@example.com',
      grantedScopes: [googleIntegration.GOOGLE_CALENDAR_EVENTS_SCOPE],
      missingScopes: [googleIntegration.GOOGLE_GMAIL_SEND_SCOPE],
    })
    vi.mocked(googleIntegration.getGoogleCalendarStatus).mockResolvedValue({
      meetingId: 7,
      creationStatus: 'not_created',
      conferenceStatus: 'none',
      googleCalendarEventId: null,
      meetUri: null,
      hangoutLink: null,
      htmlLink: null,
      errorCode: null,
    })
    vi.mocked(googleIntegration.listGoogleCalendarMeetings).mockResolvedValue([])
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
  })

  it('renders linked Google account status', async () => {
    await act(async () => {
      root.render(<GoogleIntegrationScene meetings={[]} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('user@example.com')
    expect(container.textContent).toContain('Ghi âm Google Meet')
    expect(container.querySelector('[data-testid="google-calendar-connect"]')).toBeNull()
    expect(container.querySelector('[data-testid="google-gmail-connect"]')).not.toBeNull()
    expect(googleIntegration.getGoogleStatus).toHaveBeenCalled()
  })

  it('navigates to realtime meet capture when CTA clicked', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(
        <GoogleIntegrationScene
          meetings={[]}
          realtimeEnabled
          onNavigateRealtimeMeetCapture={onNavigate}
        />,
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    const withMic = container.querySelector<HTMLButtonElement>('[data-testid="google-meet-capture-with-mic"]')
    await act(async () => {
      withMic?.click()
    })
    expect(onNavigate).toHaveBeenCalledWith('browser_tab_with_mic', undefined)
  })

  it('shows meetings table with join button on existing tab', async () => {
    vi.mocked(googleIntegration.listGoogleCalendarMeetings).mockResolvedValue([{
      linkId: 1,
      meetingId: 7,
      title: 'Họp sprint',
      scheduledStartAt: '2026-06-27T12:00:00+07:00',
      scheduledEndAt: '2026-06-27T13:00:00+07:00',
      creationStatus: 'success',
      meetUri: 'https://meet.google.com/abc-defg-hij',
      htmlLink: 'https://www.google.com/calendar/event?eid=abc123',
    }])

    const onNavigate = vi.fn()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    await act(async () => {
      root.render(
        <GoogleIntegrationScene
          meetings={[{
            id: 7,
            title: 'Họp sprint',
            audioPath: '',
            createdAt: '2026-06-27T00:00:00Z',
            scheduledStartAt: '2026-06-27T12:00:00Z',
            scheduledEndAt: '2026-06-27T13:00:00Z',
          }]}
          onNavigateRealtimeMeetCapture={onNavigate}
        />,
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    const existingTab = Array.from(container.querySelectorAll('.google-integration__mode button'))
      .find((button) => button.textContent?.includes('Lịch & Google Meet'))
    await act(async () => {
      existingTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(googleIntegration.listGoogleCalendarMeetings).toHaveBeenCalled()
    expect(container.querySelector('[data-testid="google-calendar-meetings-table"]')).not.toBeNull()
    expect(container.textContent).toContain('Audiomind - Họp sprint')

    const joinBtn = container.querySelector<HTMLButtonElement>('[data-testid="google-calendar-join-row-1"]')
    await act(async () => {
      joinBtn?.click()
    })

    expect(onNavigate).toHaveBeenCalledWith('browser_tab_with_mic', { title: 'Họp sprint' })
    expect(openSpy).toHaveBeenCalledWith('https://meet.google.com/abc-defg-hij', '_blank', 'noopener,noreferrer')
    openSpy.mockRestore()
  })
})

