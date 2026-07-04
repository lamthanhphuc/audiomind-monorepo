import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const audioRecorderMock = {
  state: 'idle' as const,
  errorMessage: null,
  audioChunks: [],
  recordingSessionId: 0,
  stopRecording: vi.fn(),
  stopRecordingGraceful: vi.fn().mockResolvedValue({
    fullBlob: new Blob(),
    sessionId: 0,
    collectedChunkCount: 0,
    postStopChunkCount: 0,
    chunks: [],
  }),
  cleanupRecordingResources: vi.fn(),
  abortRecording: vi.fn(),
  startRecording: vi.fn().mockResolvedValue(1),
  pauseRecording: vi.fn(),
  resumeRecording: vi.fn(),
  duration: 0,
  getCurrentRms: vi.fn(),
  getRollingChunks: vi.fn(() => []),
}

const realtimeStreamMock = {
  status: {
    state: 'idle',
    message: '',
    resetRequired: false,
  },
  isConnected: false,
  closeReason: '',
  isAuthenticated: false,
  keywords: [],
  transcripts: [],
  clearQueuedAudio: vi.fn(),
  disconnect: vi.fn(),
}

vi.mock('../hooks/useAudioRecorder', () => ({
  useAudioRecorder: () => audioRecorderMock,
}))

vi.mock('../hooks/useVoiceActivityDetection', () => ({
  DEFAULT_VAD_RESUMED_LABEL_MS: 400,
  DEFAULT_VAD_RESUME_DURATION_MS: 800,
  DEFAULT_VAD_SAMPLE_INTERVAL_MS: 100,
  DEFAULT_VAD_SILENCE_DURATION_MS: 1200,
  DEFAULT_VAD_SILENCE_THRESHOLD: 0.15,
  DEFAULT_VAD_SPEECH_THRESHOLD: 0.3,
  normalizeMicSensitivityMode: (value?: string | null) => value === 'low' || value === 'high' ? value : 'normal',
  useVoiceActivityDetection: () => ({ state: 'idle' }),
}))

vi.mock('../hooks/useRealtimeMeetingStream', () => ({
  DEFAULT_REALTIME_LANGUAGE: 'vi',
  DEFAULT_REALTIME_SPEAKER_MODE: 'single',
  normalizeRealtimeLanguage: (value: string) => value,
  normalizeRealtimeSpeakerMode: (value: string) => value,
  useRealtimeMeetingStream: () => realtimeStreamMock,
}))

vi.mock('../services/auth', async () => {
  const actual = await vi.importActual<typeof import('../services/auth')>('../services/auth')
  return {
    ...actual,
    getAccessToken: vi.fn(() => null),
    getCurrentUserId: vi.fn(() => null),
    exchangeGoogleLoginTicket: vi.fn(),
    getGoogleLoginUrl: vi.fn(() => 'http://localhost:8083/auth/google/start?redirect_after=%2F'),
    login: vi.fn(),
    register: vi.fn(),
    setAccessToken: vi.fn(),
    clearAccessToken: vi.fn(),
  }
})

vi.mock('../services/api', async () => {
  const actual = await vi.importActual<typeof import('../services/api')>('../services/api')
  return {
    ...actual,
    getAnalysis: vi.fn(),
    getProcessingStatus: vi.fn(),
    getTranscript: vi.fn(),
    getMeetingDetail: vi.fn(),
    startProcessingByPath: vi.fn(),
    uploadToMeetingApi: vi.fn(),
  }
})

vi.mock('../services/googleIntegration', async () => {
  const actual = await vi.importActual<typeof import('../services/googleIntegration')>('../services/googleIntegration')
  return {
    ...actual,
    getGoogleStatus: vi.fn().mockResolvedValue({
      linked: true,
      googleEmail: 'google@example.com',
      grantedScopes: [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/gmail.send',
      ],
      missingScopes: [],
    }),
    redirectToFullGoogleLink: vi.fn(),
  }
})

import { buildInviteGoogleRedirectAfter } from '../utils/inviteAuth'
import { exchangeGoogleLoginTicket, login, register, setAccessToken } from '../services/auth'
import { ApiError, getMeetingDetail } from '../services/api'
import { getGoogleStatus, redirectToFullGoogleLink } from '../services/googleIntegration'
import App from './App'

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const setNativeValue = (element: HTMLInputElement, value: string) => {
  const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set
  const prototype = Object.getPrototypeOf(element)
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
    prototypeValueSetter.call(element, value)
    return
  }
  valueSetter?.call(element, value)
}

describe('App auth entry', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    window.history.pushState({}, '', '/')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.mocked(login).mockReset()
    vi.mocked(register).mockReset()
    vi.mocked(setAccessToken).mockReset()
    vi.mocked(exchangeGoogleLoginTicket).mockReset()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('renders the register page for /register', async () => {
    window.history.pushState({}, '', '/register')

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    expect(container.textContent).toContain('Tạo tài khoản để upload audio, ghi âm realtime và nhận phân tích AI.')
    expect(container.querySelector('[data-testid="e2e-register-submit"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="invite-meeting-banner"]')).toBeNull()
  })

  it('shows public legal footer links on the guest homepage before login', async () => {
    window.history.pushState({}, '', '/')

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    const privacyLinks = container.querySelectorAll('[data-testid="public-footer-privacy"]')
    const termsLinks = container.querySelectorAll('[data-testid="public-footer-terms"]')
    expect(privacyLinks.length).toBeGreaterThan(0)
    expect(termsLinks.length).toBeGreaterThan(0)
    expect(privacyLinks[0]?.getAttribute('href')).toBe('/privacy')
    expect(termsLinks[0]?.getAttribute('href')).toBe('/terms')
    expect(container.querySelector('[data-testid="e2e-login-submit"]')).toBeTruthy()
  })

  it('renders public privacy policy without authentication', async () => {
    window.history.pushState({}, '', '/privacy')

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    expect(container.querySelector('[data-testid="public-legal-privacy"]')).toBeTruthy()
    expect(container.textContent).toContain('Chính sách quyền riêng tư')
    expect(container.textContent).toContain('Không bán dữ liệu Google')
    expect(container.querySelector('[data-testid="e2e-login-submit"]')).toBeNull()
  })

  it('renders public terms of service without authentication', async () => {
    window.history.pushState({}, '', '/terms')

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    expect(container.querySelector('[data-testid="public-legal-terms"]')).toBeTruthy()
    expect(container.textContent).toContain('Điều khoản dịch vụ')
    expect(container.querySelector('[data-testid="e2e-login-submit"]')).toBeNull()
  })

  it('shows invite banner when openMeeting is present on register', async () => {
    window.history.pushState({}, '', '/register?openMeeting=15')

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    const banner = container.querySelector('[data-testid="invite-meeting-banner"]')
    expect(banner).toBeTruthy()
    expect(banner?.textContent).toMatch(/đúng email/i)
  })

  it('keeps openMeeting when switching from register to login', async () => {
    window.history.pushState({}, '', '/register?openMeeting=15')

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    const switchLogin = container.querySelector('[data-testid="e2e-auth-switch-login"]') as HTMLButtonElement
    await act(async () => {
      switchLogin.click()
    })
    await flush()

    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('?openMeeting=15')
    expect(container.querySelector('[data-testid="invite-meeting-banner"]')).toBeTruthy()
  })

  it('shows validation errors when register passwords do not match', async () => {
    window.history.pushState({}, '', '/register')
    vi.mocked(register).mockResolvedValue({ userId: 9 })

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    const usernameInput = container.querySelector('[data-testid="e2e-register-username"]') as HTMLInputElement
    const emailInput = container.querySelector('[data-testid="e2e-register-email"]') as HTMLInputElement
    const passwordInput = container.querySelector('[data-testid="e2e-register-password"]') as HTMLInputElement
    const confirmInput = container.querySelector('[data-testid="e2e-register-confirm-password"]') as HTMLInputElement
    const submitButton = container.querySelector('[data-testid="e2e-register-submit"]') as HTMLButtonElement

    await act(async () => {
      setNativeValue(usernameInput, 'new-user')
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }))
      setNativeValue(emailInput, 'new-user@example.com')
      emailInput.dispatchEvent(new Event('input', { bubbles: true }))
      setNativeValue(passwordInput, 'secret-pass')
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
      setNativeValue(confirmInput, 'different-pass')
      confirmInput.dispatchEvent(new Event('input', { bubbles: true }))
      submitButton.click()
    })
    await flush()

    expect(container.textContent).toContain('Mật khẩu xác nhận không khớp')
    expect(register).not.toHaveBeenCalled()
  })

  it('redirects back to login after successful register without an access token', async () => {
    window.history.pushState({}, '', '/register')
    vi.mocked(register).mockResolvedValue({ userId: 11 })

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    const usernameInput = container.querySelector('[data-testid="e2e-register-username"]') as HTMLInputElement
    const emailInput = container.querySelector('[data-testid="e2e-register-email"]') as HTMLInputElement
    const passwordInput = container.querySelector('[data-testid="e2e-register-password"]') as HTMLInputElement
    const confirmInput = container.querySelector('[data-testid="e2e-register-confirm-password"]') as HTMLInputElement
    const submitButton = container.querySelector('[data-testid="e2e-register-submit"]') as HTMLButtonElement

    await act(async () => {
      setNativeValue(usernameInput, 'new-user')
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }))
      setNativeValue(emailInput, 'new-user@example.com')
      emailInput.dispatchEvent(new Event('input', { bubbles: true }))
      setNativeValue(passwordInput, 'secret-pass')
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }))
      setNativeValue(confirmInput, 'secret-pass')
      confirmInput.dispatchEvent(new Event('input', { bubbles: true }))
      submitButton.click()
    })
    await flush()

    expect(register).toHaveBeenCalledWith({
      username: 'new-user',
      email: 'new-user@example.com',
      password: 'secret-pass',
    })
    expect(window.location.pathname).toBe('/')
    expect(container.textContent).toContain('Đăng nhập studio và tiếp tục từ nơi giọng nói của bạn dừng lại.')
    expect(container.textContent).toContain('Đăng ký thành công. Vui lòng đăng nhập.')
  })

  it('switches between login and register from the guest page links', async () => {
    await act(async () => {
      root.render(<App />)
    })
    await flush()

    const registerLink = container.querySelector('[data-testid="e2e-auth-switch-register"]') as HTMLButtonElement | null
    expect(registerLink).toBeTruthy()

    await act(async () => {
      registerLink?.click()
    })
    await flush()

    expect(window.location.pathname).toBe('/register')
    expect(container.querySelector('[data-testid="e2e-register-submit"]')).toBeTruthy()

    const loginLink = container.querySelector('[data-testid="e2e-auth-switch-login"]') as HTMLButtonElement | null
    expect(loginLink).toBeTruthy()

    await act(async () => {
      loginLink?.click()
    })
    await flush()

    expect(window.location.pathname).toBe('/')
    expect(container.querySelector('[data-testid="e2e-login-submit"]')).toBeTruthy()
  })

  it('removes the one-time ticket from the URL and exchanges it for a JWT', async () => {
    window.history.pushState({}, '', '/auth/google/success?ticket=one-time-ticket')
    vi.mocked(exchangeGoogleLoginTicket).mockResolvedValue({
      token: 'google-jwt',
      expiresInSeconds: 120,
      user: { id: 15, email: 'google@example.com', name: 'Google User' },
      redirectAfter: '/',
    })

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    expect(exchangeGoogleLoginTicket).toHaveBeenCalledWith('one-time-ticket')
    expect(window.location.search).toBe('')
    expect(setAccessToken).toHaveBeenCalledWith('google-jwt', 120)
    expect(getGoogleStatus).toHaveBeenCalled()
    expect(redirectToFullGoogleLink).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/studio/upload')
  })

  it('opens analysis after google success when redirect targets invited meeting', async () => {
    window.history.pushState({}, '', '/auth/google/success?ticket=invite-ticket')
    vi.mocked(exchangeGoogleLoginTicket).mockResolvedValue({
      token: 'google-jwt',
      expiresInSeconds: 120,
      user: { id: 15, email: 'google@example.com', name: 'Google User' },
      redirectAfter: '/studio/analysis?meetingId=15',
    })

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    expect(window.location.pathname).toBe('/studio/analysis')
    expect(window.location.search).toBe('?meetingId=15')
    expect(redirectToFullGoogleLink).not.toHaveBeenCalled()
  })

  it('redirects to full Google link with analysis path when invite scopes are missing', async () => {
    window.history.pushState({}, '', '/auth/google/success?ticket=grant-invite-ticket')
    vi.mocked(exchangeGoogleLoginTicket).mockResolvedValue({
      token: 'google-jwt',
      expiresInSeconds: 120,
      user: { id: 15, email: 'google@example.com', name: 'Google User' },
      redirectAfter: '/studio/analysis?meetingId=15',
    })
    vi.mocked(getGoogleStatus).mockResolvedValue({
      linked: true,
      googleEmail: 'google@example.com',
      grantedScopes: [],
      missingScopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.send'],
    })
    vi.mocked(redirectToFullGoogleLink).mockResolvedValue(undefined)

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    expect(redirectToFullGoogleLink).toHaveBeenCalledWith('/studio/analysis?meetingId=15')
  })

  it('shows invite access notice when google success cannot open invited meeting', async () => {
    window.history.pushState({}, '', '/auth/google/success?ticket=invite-forbidden')
    vi.mocked(exchangeGoogleLoginTicket).mockResolvedValue({
      token: 'google-jwt',
      expiresInSeconds: 120,
      user: { id: 15, email: 'other@example.com', name: 'Google User' },
      redirectAfter: '/studio/analysis?meetingId=15',
    })
    vi.mocked(getMeetingDetail).mockRejectedValue(new ApiError('Forbidden', 403))

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    expect(container.querySelector('[data-testid="auth-notice-banner"]')?.textContent).toMatch(/đúng email/i)
    expect(window.location.pathname).toBe('/studio/analysis')
  })

  it('redirects to full Google link when integration scopes are missing after login', async () => {
    window.history.pushState({}, '', '/auth/google/success?ticket=grant-ticket')
    vi.mocked(exchangeGoogleLoginTicket).mockResolvedValue({
      token: 'google-jwt',
      expiresInSeconds: 120,
      user: { id: 15, email: 'google@example.com', name: 'Google User' },
      redirectAfter: '/',
    })
    vi.mocked(getGoogleStatus).mockResolvedValue({
      linked: true,
      googleEmail: 'google@example.com',
      grantedScopes: [],
      missingScopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.send'],
    })
    vi.mocked(redirectToFullGoogleLink).mockResolvedValue(undefined)

    await act(async () => {
      root.render(<App />)
    })
    await flush()

    expect(redirectToFullGoogleLink).toHaveBeenCalledWith('/studio/upload')
  })

  it('uses analysis redirect when invite query is present', async () => {
    const { getGoogleLoginUrl: realGetGoogleLoginUrl } = await vi.importActual<typeof import('../services/auth')>('../services/auth')
    const redirect = buildInviteGoogleRedirectAfter('?openMeeting=15')
    const url = new URL(realGetGoogleLoginUrl(redirect))

    expect(redirect).toBe('/studio/analysis?meetingId=15')
    expect(url.searchParams.get('redirect_after')).toBe('/studio/analysis?meetingId=15')
  })

  it('uses root redirect in google login url when invite query is absent', async () => {
    const { getGoogleLoginUrl: realGetGoogleLoginUrl } = await vi.importActual<typeof import('../services/auth')>('../services/auth')
    expect(buildInviteGoogleRedirectAfter('')).toBe('/')
    const url = new URL(realGetGoogleLoginUrl('/'))
    expect(url.searchParams.get('redirect_after')).toBe('/')
  })
})
