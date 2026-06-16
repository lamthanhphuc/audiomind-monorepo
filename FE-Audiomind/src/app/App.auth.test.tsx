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
    startProcessingByPath: vi.fn(),
    uploadToMeetingApi: vi.fn(),
  }
})

import { login, register, setAccessToken } from '../services/auth'
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

  it('auto-logs in when register returns an access token', async () => {
    window.history.pushState({}, '', '/register')
    vi.mocked(register).mockResolvedValue({ userId: 12, accessToken: 'register-token', expiresInSeconds: 120 })

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

    expect(setAccessToken).toHaveBeenCalledWith('register-token', 120)
    expect(window.location.pathname).toBe('/')
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
})
