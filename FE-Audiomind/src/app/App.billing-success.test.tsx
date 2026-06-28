// @vitest-environment jsdom
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
  status: { state: 'idle', message: '', resetRequired: false },
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

const pollBillingActivation = vi.hoisted(() => vi.fn())

vi.mock('../components/features/FeatureMindmap', () => ({
  default: () => null,
}))

vi.mock('../components/features/KnowledgeVaultScene', () => ({
  default: () => null,
}))

vi.mock('../services/billing', () => ({
  pollBillingActivation,
  getBillingOverview: vi.fn(),
  getBillingOrderStatus: vi.fn(),
  checkoutProPlan: vi.fn(),
  formatQuotaPercent: vi.fn(),
  formatDurationShort: vi.fn(),
  formatCharsShort: vi.fn(),
}))

vi.mock('../services/auth', async () => {
  const actual = await vi.importActual<typeof import('../services/auth')>('../services/auth')
  return {
    ...actual,
    getAccessToken: vi.fn(() => 'billing-jwt'),
    getCurrentUserId: vi.fn(() => '1'),
    refreshAccessToken: vi.fn().mockResolvedValue({ token: 'billing-jwt', expiresInSeconds: 3600 }),
    login: vi.fn(),
    register: vi.fn(),
    setAccessToken: vi.fn(),
    clearAccessToken: vi.fn(),
    exchangeGoogleLoginTicket: vi.fn(),
    getGoogleLoginUrl: vi.fn(() => 'http://localhost:8083/auth/google/start'),
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
    listMeetingsWithParams: vi.fn().mockResolvedValue([]),
    getMeeting: vi.fn(),
  }
})

import App from './App'

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('App billing success redirect', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.history.replaceState({}, '', '/billing/success?orderCode=9001')
    pollBillingActivation.mockResolvedValue({
      invoice: { orderCode: 9001, status: 'PAID', amountVnd: 99000 },
      overview: { userId: 1, plan: 'PRO', quota: {}, invoices: [] },
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    window.history.replaceState({}, '', '/')
    vi.clearAllMocks()
  })

  it('polls PayOS order after redirect and shows Pro activation notice', async () => {
    await act(async () => {
      root.render(<App />)
    })
    await flush()
    await flush()
    await flush()

    await vi.waitFor(() => {
      expect(pollBillingActivation).toHaveBeenCalledWith(9001)
    }, { timeout: 3000 })

    expect(window.location.pathname).toBe('/studio/billing')
    expect(container.textContent).toMatch(/Thanh toán PayOS thành công|Gói Pro đã được kích hoạt/i)
  })
})
