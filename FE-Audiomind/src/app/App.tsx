import { useEffect, useMemo, useRef, useState } from 'react'
import DashboardLayout, { type DashboardScene } from '../components/dashboard/DashboardLayout'
import SubjectsList from '../components/dashboard/SubjectsList'
import FeatureAnalysis from '../components/features/FeatureAnalysis'
import FeatureUpload from '../components/features/FeatureUpload'
import MeetingHistoryScene from '../components/features/MeetingHistoryScene'
import RealtimeDashboardScene from '../components/features/RealtimeDashboardScene'
import { useAudioRecorder, type AudioRecorderState } from '../hooks/useAudioRecorder'
import {
    DEFAULT_REALTIME_LANGUAGE,
    DEFAULT_REALTIME_SPEAKER_MODE,
    normalizeRealtimeLanguage,
    normalizeRealtimeSpeakerMode,
    type RealtimeLanguage,
    type RealtimeSessionToken,
    type RealtimeSpeakerMode,
    type TranscriptSegment,
    useRealtimeMeetingStream,
} from '../hooks/useRealtimeMeetingStream'
import {
  DEFAULT_VAD_RESUMED_LABEL_MS,
  DEFAULT_VAD_RESUME_DURATION_MS,
  DEFAULT_VAD_SAMPLE_INTERVAL_MS,
  DEFAULT_VAD_SILENCE_DURATION_MS,
  DEFAULT_VAD_SILENCE_THRESHOLD,
  DEFAULT_VAD_SPEECH_THRESHOLD,
  type VoiceActivityState,
  useVoiceActivityDetection,
} from '../hooks/useVoiceActivityDetection'
import { ApiError, getAnalysis, getProcessingStatus, getTranscript, startProcessingByPath, uploadToMeetingApi } from '../services/api'
import { clearAccessToken, getAccessToken, getCurrentUserId, login, setAccessToken } from '../services/auth'
import { REALTIME_WS_ENABLED } from '../services/config'
import type { AiAnalysis } from '../types'
import { mergeTranscriptSegments, mergeTranscriptSegmentsForDisplay, normalizePersistedTranscriptSegments } from '../utils/transcript'

export { DEFAULT_REALTIME_LANGUAGE } from '../hooks/useRealtimeMeetingStream'
export { getStatusBadgeClass } from '../utils/statusBadge'

type ResultView = {
  meetingId: number
  status: string
  transcript: string
  transcriptSegments: TranscriptSegment[]
  analysis: AiAnalysis
}

export type LiveLifecycleState =
  | 'idle'
  | 'connecting'
  | 'recording'
  | 'silent_paused'
  | 'listening_resumed'
  | 'stopping'
  | 'stopped'
  | 'error'

type RealtimeConnectionView = {
  title: string
  detail: string
  closeReason: string | null
  closeReasonIsError: boolean
}

export const REALTIME_LANGUAGE_OPTIONS: Array<{ value: RealtimeLanguage; label: string }> = [
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'en', label: 'English' },
  { value: 'multi', label: 'Việt + Anh' },
]
export const UPLOAD_LANGUAGE_OPTIONS: Array<{ value: RealtimeLanguage; label: string }> = [
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'en', label: 'English' },
  { value: 'multi', label: 'Việt + Anh (experimental)' },
]

export const REALTIME_SPEAKER_MODE_OPTIONS: Array<{ value: RealtimeSpeakerMode; label: string }> = [
  { value: 'single', label: 'Single speaker' },
  { value: 'multiple', label: 'Multiple speakers' },
]

export const isRealtimeLanguageSelectorDisabled = (lifecycleState: LiveLifecycleState): boolean => {
  return (
    lifecycleState === 'connecting'
    || lifecycleState === 'recording'
    || lifecycleState === 'silent_paused'
    || lifecycleState === 'listening_resumed'
    || lifecycleState === 'stopping'
  )
}

export const isRealtimeSpeakerModeSelectorDisabled = (lifecycleState: LiveLifecycleState): boolean => {
  return isRealtimeLanguageSelectorDisabled(lifecycleState)
}

export const getRealtimeConnectionView = (
  lifecycleState: LiveLifecycleState,
  realtimeState: string,
  realtimeMessage: string | undefined,
  isConnected: boolean,
  closeReason: string,
): RealtimeConnectionView => {
  if (lifecycleState === 'silent_paused') {
    return {
      title: 'Paused',
      detail: 'Paused while silent — speak to continue',
      closeReason: null,
      closeReasonIsError: false,
    }
  }

  if (lifecycleState === 'listening_resumed') {
    return {
      title: 'Resumed',
      detail: 'Đang lắng nghe trở lại...',
      closeReason: null,
      closeReasonIsError: false,
    }
  }

  if (lifecycleState === 'stopped') {
    return {
      title: 'Hoàn tất',
      detail: 'Đã lưu transcript',
      closeReason: null,
      closeReasonIsError: false,
    }
  }

  if (lifecycleState === 'stopping') {
    return {
      title: 'Đang dừng',
      detail: 'Đang dừng và lưu transcript...',
      closeReason: null,
      closeReasonIsError: false,
    }
  }

  if (lifecycleState === 'recording') {
    return {
      title: 'Listening',
      detail: 'Đang lắng nghe...',
      closeReason: null,
      closeReasonIsError: false,
    }
  }

  if (lifecycleState === 'connecting') {
    return {
      title: 'Đang kết nối',
      detail: 'Đang kết nối realtime...',
      closeReason: null,
      closeReasonIsError: false,
    }
  }

  if (lifecycleState === 'error' || realtimeState === 'error') {
    return {
      title: 'Lỗi',
      detail: realtimeMessage || 'Đã xảy ra lỗi realtime',
      closeReason: closeReason || null,
      closeReasonIsError: true,
    }
  }

  return {
    title: realtimeState,
    detail: isConnected ? 'WebSocket đang mở' : (realtimeMessage || 'Sẵn sàng tạo meeting và bắt đầu ghi âm'),
    closeReason: null,
    closeReasonIsError: false,
  }
}

const HYDRATION_INITIAL_DELAY_MS = 1500
const HYDRATION_RETRY_DELAY_MS = 800
const HYDRATION_MAX_ATTEMPTS = 10
const HYDRATION_STABLE_COUNT_REQUIRED = 2
const HYDRATION_MIN_ATTEMPTS_AFTER_FIRST_FRAGMENTS = 2
const LIVE_STATUS_LISTENING = 'Đang lắng nghe...'
const LIVE_STATUS_PAUSED = 'Paused while silent — speak to continue'
const LIVE_STATUS_RESUMED = 'Resumed — continuing to listen...'

type ResolveVoiceActivityLifecycleInput = {
  recorderState: AudioRecorderState
  liveLifecycleState: LiveLifecycleState
  previousVoiceActivityState: VoiceActivityState | null
  voiceActivityState: VoiceActivityState
}

type ResolveVoiceActivityLifecycleResult = {
  nextTrackedVoiceActivityState: VoiceActivityState | null
  nextLifecycleState: LiveLifecycleState | null
  nextStatusMessage: string | null
}

export const resolveVoiceActivityLifecycleUpdate = ({
  recorderState,
  liveLifecycleState,
  previousVoiceActivityState,
  voiceActivityState,
}: ResolveVoiceActivityLifecycleInput): ResolveVoiceActivityLifecycleResult => {
  if (recorderState !== 'recording') {
    return {
      nextTrackedVoiceActivityState: null,
      nextLifecycleState: null,
      nextStatusMessage: null,
    }
  }

  if (liveLifecycleState === 'stopping' || liveLifecycleState === 'stopped' || liveLifecycleState === 'error') {
    return {
      nextTrackedVoiceActivityState: previousVoiceActivityState,
      nextLifecycleState: null,
      nextStatusMessage: null,
    }
  }

  if (previousVoiceActivityState === voiceActivityState) {
    return {
      nextTrackedVoiceActivityState: previousVoiceActivityState,
      nextLifecycleState: null,
      nextStatusMessage: null,
    }
  }

  if (voiceActivityState === 'silent_paused') {
    return {
      nextTrackedVoiceActivityState: voiceActivityState,
      nextLifecycleState: 'silent_paused',
      nextStatusMessage: LIVE_STATUS_PAUSED,
    }
  }

  if (voiceActivityState === 'listening_resumed') {
    return {
      nextTrackedVoiceActivityState: voiceActivityState,
      nextLifecycleState: 'listening_resumed',
      nextStatusMessage: LIVE_STATUS_RESUMED,
    }
  }

  return {
    nextTrackedVoiceActivityState: voiceActivityState,
    nextLifecycleState:
      liveLifecycleState === 'silent_paused' || liveLifecycleState === 'listening_resumed'
        ? 'recording'
        : null,
    nextStatusMessage: LIVE_STATUS_LISTENING,
  }
}

export const isCurrentLiveRecordingSession = (
  completedSessionId: number,
  completedMeetingId: number | null,
  currentSessionId: number,
  currentMeetingId: number | null,
): boolean => {
  return (
    completedMeetingId !== null &&
    completedSessionId === currentSessionId &&
    completedMeetingId === currentMeetingId
  )
}

const waitWithSignal = (delayMs: number, signal: AbortSignal): Promise<void> => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)

    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Polling aborted', 'AbortError'))
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const pollWithRetry = async (meetingId: number, retries = 3, delay = 2000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await getProcessingStatus(meetingId)
    } catch (error: any) {
      // Không retry lỗi 4xx (client error)
      if (error.status >= 400 && error.status < 500) throw error
      if (i === retries - 1) throw error
      console.warn(`Polling failed, retrying in ${delay}ms...`, error)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error('Unreachable')
}


const pollUntilCompleted = async (
  meetingId: number,
  signal: AbortSignal,
  maxAttempts = 120,
): Promise<void> => {
  let delayMs = 1000

  for (let i = 0; i < maxAttempts; i += 1) {
    if (signal.aborted) {
      throw new DOMException('Polling aborted', 'AbortError')
    }

    const status = await pollWithRetry(meetingId)
    const value = String(status.status || '').toUpperCase()

    if (value === 'COMPLETED') {
      return
    }

    if (value === 'FAILED') {
      throw new Error(status.error || 'Processing failed')
    }

    if (i < maxAttempts - 1) {
      await waitWithSignal(delayMs, signal)
      delayMs = Math.min(Math.floor(delayMs * 1.35), 8000)
    }
  }

  throw new Error('Processing timeout exceeded')
}

const REALTIME_ANALYSIS_POLL_INTERVAL_MS = 2000
const REALTIME_ANALYSIS_POLL_MAX_ATTEMPTS = 25

export const pollRealtimeAnalysisAfterStop = async (
  meetingId: number,
  signal: AbortSignal,
  fetchAnalysis: typeof getAnalysis = getAnalysis,
  maxAttempts = REALTIME_ANALYSIS_POLL_MAX_ATTEMPTS,
): Promise<{ status: 'completed' | 'pending' | 'failed'; analysis: AiAnalysis | null; reason?: string }> => {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal.aborted) {
      throw new DOMException('Polling aborted', 'AbortError')
    }

    try {
      const analysis = await fetchAnalysis(meetingId)
      const analysisStatus = String((analysis as AiAnalysis & { status?: string }).status ?? '').toUpperCase()
      if (analysisStatus === 'FAILED') {
        return {
          status: 'failed',
          analysis: null,
          reason: 'analysis_failed',
        }
      }
      const hasStructuredData = Boolean(
        analysis.summary?.trim()
        || (analysis.keywords?.length ?? 0) > 0
        || (analysis.technicalTerms?.length ?? 0) > 0
        || (analysis.painPoints?.length ?? 0) > 0
        || (analysis.actionItems?.length ?? 0) > 0,
      )

      if (hasStructuredData) {
        return { status: 'completed', analysis }
      }
    } catch (error: any) {
      if (error instanceof ApiError && error.status === 404) {
        // Analysis not ready yet.
      } else if (error instanceof ApiError && error.status >= 500) {
        // transient backend error: keep polling
      } else {
        return {
          status: 'failed',
          analysis: null,
          reason: error instanceof Error ? error.message : 'Không thể tải phân tích realtime',
        }
      }
    }

    if (attempt < maxAttempts) {
      await waitWithSignal(REALTIME_ANALYSIS_POLL_INTERVAL_MS, signal)
    }
  }

  return { status: 'pending', analysis: null, reason: 'analysis_timeout' }
}

export const hydrateLiveTranscriptSegments = async (
  meetingId: number,
  fetchTranscript: typeof getTranscript = getTranscript,
  sessionToken: RealtimeSessionToken | null = null,
  isSessionActive: ((token: RealtimeSessionToken | null) => boolean) | null = null,
  options: { backendPartial?: boolean; backendResetRequired?: boolean; currentLiveSegments?: TranscriptSegment[] } = {},
): Promise<TranscriptSegment[]> => {
  console.info('[Realtime] Post-stop transcript hydration started', { meetingId })

  const isHydrationActive = () => {
    if (sessionToken === null || isSessionActive === null) {
      return true
    }

    return isSessionActive(sessionToken)
  }

  if (!isHydrationActive()) {
    console.info('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, phase: 'before-wait' })
    return []
  }

  await new Promise((resolve) => setTimeout(resolve, HYDRATION_INITIAL_DELAY_MS))

  if (!isHydrationActive()) {
    console.info('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, phase: 'after-initial-wait' })
    return []
  }

  let stableCount = 0
  let previousFragments = -1
  let firstFragmentsAttempt: number | null = null
  let hasObservedFragments = false
  const forceStableHydration = Boolean(options.backendPartial || options.backendResetRequired)

  for (let attempt = 1; attempt <= HYDRATION_MAX_ATTEMPTS; attempt += 1) {
    let transcript
    try {
      transcript = await fetchTranscript(meetingId)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        console.info('[Realtime] HYDRATION_NO_FRAGMENTS_RETRY', {
          meetingId,
          attempt,
          reason: 'transcript_404',
        })
        if (attempt < HYDRATION_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, HYDRATION_RETRY_DELAY_MS))
          continue
        }
        break
      }

      if (!isHydrationActive()) {
        console.info('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, attempt, phase: 'fetch-error' })
        return []
      }

      throw error
    }

    if (!isHydrationActive()) {
      console.info('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, attempt, phase: 'post-fetch' })
      return []
    }

    const hydratedSegments = mergeTranscriptSegments(
      normalizePersistedTranscriptSegments(transcript.transcripts || [], { fallbackSpeaker: 'SPEAKER_1' }),
    )

    console.info('[Realtime] Post-stop transcript hydration attempt', {
      meetingId,
      attempt,
      fragments: hydratedSegments.length,
    })

    if (hydratedSegments.length === previousFragments) {
      stableCount += 1
    } else {
      stableCount = 0
      previousFragments = hydratedSegments.length
    }

    if (hydratedSegments.length > 0 && firstFragmentsAttempt === null) {
      firstFragmentsAttempt = attempt
    }
    if (hydratedSegments.length > 0) {
      hasObservedFragments = true
    }

    const attemptsSinceFirstFragments = firstFragmentsAttempt === null ? 0 : attempt - firstFragmentsAttempt
    const liveSegmentsCount = options.currentLiveSegments?.length ?? 0
    const persistedBehindLive = liveSegmentsCount > 0 && hydratedSegments.length < liveSegmentsCount
    if (persistedBehindLive) {
      console.info('[Realtime] HYDRATION_PERSISTED_BEHIND_LIVE', {
        meetingId,
        attempt,
        persistedFragments: hydratedSegments.length,
        liveFragments: liveSegmentsCount,
      })
    }

    console.info('[Realtime] HYDRATION_WAITING_FOR_STABLE_TRANSCRIPT', {
      meetingId,
      attempt,
      fragments: hydratedSegments.length,
      stableCount,
      attemptsSinceFirstFragments,
      persistedBehindLive,
      forceStableHydration,
    })

    const stableEnough = stableCount >= HYDRATION_STABLE_COUNT_REQUIRED
      && attemptsSinceFirstFragments >= HYDRATION_MIN_ATTEMPTS_AFTER_FIRST_FRAGMENTS

    if (hydratedSegments.length > 0 && stableEnough && !persistedBehindLive) {
      console.info('[Realtime] HYDRATION_STABLE_COMPLETED', {
        meetingId,
        attempts: attempt,
        persistedFragments: hydratedSegments.length,
      })
      return hydratedSegments
    }

    if (forceStableHydration && hydratedSegments.length > 0 && stableEnough) {
      console.info('[Realtime] HYDRATION_STABLE_COMPLETED', {
        meetingId,
        attempts: attempt,
        persistedFragments: hydratedSegments.length,
        partialMode: true,
      })
      return hydratedSegments
    }

    if (hydratedSegments.length === 0) {
      console.info('[Realtime] HYDRATION_NO_FRAGMENTS_RETRY', {
        meetingId,
        attempt,
      })
    }

    if (attempt < HYDRATION_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, HYDRATION_RETRY_DELAY_MS))

      if (!isHydrationActive()) {
        console.info('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, attempt, phase: 'retry-wait' })
        return []
      }
    }
  }

  console.info('[Realtime] Post-stop transcript hydration exhausted', {
    meetingId,
    attempts: HYDRATION_MAX_ATTEMPTS,
  })
  console.info('[Realtime] HYDRATION_NO_FRAGMENTS_COMPLETED', {
    meetingId,
    attempts: HYDRATION_MAX_ATTEMPTS,
  })
  if (!hasObservedFragments) {
    console.info('[Realtime] HYDRATION_TIMEOUT_NO_TRANSCRIPT', {
      meetingId,
    })
  }
  return []
}

export const mergeHydratedTranscriptWithLive = (
  liveSegments: TranscriptSegment[],
  hydratedSegments: TranscriptSegment[],
): TranscriptSegment[] => {
  const mergedHydration = mergeTranscriptSegments([
    ...liveSegments,
    ...hydratedSegments,
  ])
  const canonicalSpeaker = (value: string): string => {
    const normalized = value.trim().toLowerCase()
    if (!normalized || normalized === 'unknown' || normalized === 'system') {
      return 'speaker_1'
    }
    return normalized
  }
  const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()
  const hasTextOverlap = (a: string, b: string): boolean => {
    const left = normalizeText(a)
    const right = normalizeText(b)
    if (!left || !right) {
      return false
    }
    return left.includes(right) || right.includes(left)
  }
  const sameStartSpeaker = (a: TranscriptSegment, b: TranscriptSegment): boolean => {
    return (
      canonicalSpeaker(a.speaker) === canonicalSpeaker(b.speaker)
      && Math.abs((a.start ?? 0) - (b.start ?? 0)) <= 0.4
    )
  }
  const hasHeavyOverlap = (a: TranscriptSegment, b: TranscriptSegment): boolean => {
    const overlap = Math.min(a.end ?? a.start ?? 0, b.end ?? b.start ?? 0) - Math.max(a.start ?? 0, b.start ?? 0)
    return overlap > 1.0
  }
  const filteredHydration = mergedHydration.filter((segment) => {
    if (segment.source !== 'live' || segment.isFinal) {
      return true
    }

    const cleanerFinal = mergedHydration.find((candidate) => {
      if (!candidate.isFinal) {
        return false
      }
      if (canonicalSpeaker(candidate.speaker) !== canonicalSpeaker(segment.speaker)) {
        return false
      }

      if (sameStartSpeaker(segment, candidate)) {
        return true
      }

      return hasHeavyOverlap(segment, candidate) && hasTextOverlap(segment.text, candidate.text)
    })

    return !cleanerFinal
  })
  if (hydratedSegments.length < liveSegments.length) {
    console.info('[Realtime] HYDRATION_MERGE_KEEP_LIVE_SEGMENT', {
      persistedFragments: hydratedSegments.length,
      liveFragments: liveSegments.length,
      mergedFragments: filteredHydration.length,
    })
  }
  return filteredHydration
}

export default function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [selectedUploadLanguage, setSelectedUploadLanguage] = useState<'vi' | 'en' | 'multi'>('vi')
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState<ResultView | null>(null)
  const [liveMeetingId, setLiveMeetingId] = useState<number | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [livePartialWarning, setLivePartialWarning] = useState<string | null>(null)
  const [liveStatusMessage, setLiveStatusMessage] = useState<string | null>(null)
  const [liveAnalysis, setLiveAnalysis] = useState<AiAnalysis | null>(null)
  const [liveAnalysisStatus, setLiveAnalysisStatus] = useState<'idle' | 'polling' | 'completed' | 'pending' | 'failed'>('idle')
  const [liveAnalysisError, setLiveAnalysisError] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [featureScene, setFeatureScene] = useState<DashboardScene>('upload')
  const [joinMeetingIdInput, setJoinMeetingIdInput] = useState('')
  const [showJoinOtherMeeting, setShowJoinOtherMeeting] = useState(false)
  const [hydratedLiveTranscriptSegments, setHydratedLiveTranscriptSegments] = useState<TranscriptSegment[] | null>(null)
  const [liveLifecycleState, setLiveLifecycleState] = useState<LiveLifecycleState>('idle')
  const [activeRealtimeSessionToken, setActiveRealtimeSessionToken] = useState<RealtimeSessionToken | null>(null)
  const [selectedRealtimeLanguage, setSelectedRealtimeLanguage] = useState<RealtimeLanguage>(DEFAULT_REALTIME_LANGUAGE)
  const [selectedRealtimeSpeakerMode, setSelectedRealtimeSpeakerMode] = useState<RealtimeSpeakerMode>(DEFAULT_REALTIME_SPEAKER_MODE)
  const abortControllerRef = useRef<AbortController | null>(null)
  const liveAnalysisAbortControllerRef = useRef<AbortController | null>(null)
  const liveMeetingIdRef = useRef<number | null>(null)
  const liveRecordingSessionIdRef = useRef(0)
  const activeRealtimeSessionTokenRef = useRef<RealtimeSessionToken | null>(null)
  const realtimeAttemptIdRef = useRef(0)
  const resetRecoveryInProgressRef = useRef(false)
  const restartAfterReconnectRef = useRef(false)
  const lastLoggedRealtimeLanguageRef = useRef<RealtimeLanguage | null>(null)
  const lastLoggedRealtimeSpeakerModeRef = useRef<RealtimeSpeakerMode | null>(null)
  const lastVoiceActivityStateRef = useRef<VoiceActivityState | null>(null)

  const isRealtimeEnabled = REALTIME_WS_ENABLED
  const currentUserId = getCurrentUserId()
  const parsedRealtimeUserId = currentUserId ? Number(currentUserId) : null
  const realtimeUserId = parsedRealtimeUserId !== null && Number.isFinite(parsedRealtimeUserId)
    ? parsedRealtimeUserId
    : null
  const realtimeToken = getAccessToken() ?? ''
  const audioRecorder = useAudioRecorder(liveMeetingId)
  const voiceActivity = useVoiceActivityDetection({
    enabled: audioRecorder.state === 'recording',
    getRmsLevel: audioRecorder.getCurrentRms,
    silenceThreshold: DEFAULT_VAD_SILENCE_THRESHOLD,
    speechThreshold: DEFAULT_VAD_SPEECH_THRESHOLD,
    silenceDurationMs: DEFAULT_VAD_SILENCE_DURATION_MS,
    resumeDurationMs: DEFAULT_VAD_RESUME_DURATION_MS,
    sampleIntervalMs: DEFAULT_VAD_SAMPLE_INTERVAL_MS,
    resumedLabelMs: DEFAULT_VAD_RESUMED_LABEL_MS,
  })
  const realtimeStream = useRealtimeMeetingStream({
    meetingId: liveMeetingId,
    userId: realtimeUserId,
    token: realtimeToken,
    sessionToken: activeRealtimeSessionToken,
    language: selectedRealtimeLanguage,
    speakerMode: selectedRealtimeSpeakerMode,
    enabled: isAuthenticated && isRealtimeEnabled && featureScene === 'realtime',
    autoReconnect: true,
  })

  useEffect(() => {
    const normalizedLanguage = normalizeRealtimeLanguage(selectedRealtimeLanguage)
    if (lastLoggedRealtimeLanguageRef.current === normalizedLanguage) {
      return
    }

    lastLoggedRealtimeLanguageRef.current = normalizedLanguage
    console.info('[Realtime] REALTIME_LANGUAGE_SELECTED', {
      language: normalizedLanguage,
      lifecycleState: liveLifecycleState,
    })
  }, [liveLifecycleState, selectedRealtimeLanguage])

  useEffect(() => {
    const normalizedSpeakerMode = normalizeRealtimeSpeakerMode(selectedRealtimeSpeakerMode)
    if (lastLoggedRealtimeSpeakerModeRef.current === normalizedSpeakerMode) {
      return
    }

    lastLoggedRealtimeSpeakerModeRef.current = normalizedSpeakerMode
    console.info('[Realtime] FE_REALTIME_SPEAKER_MODE_SELECTED', {
      speakerMode: normalizedSpeakerMode,
      lifecycleState: liveLifecycleState,
    })
  }, [liveLifecycleState, selectedRealtimeSpeakerMode])

  useEffect(() => {
    activeRealtimeSessionTokenRef.current = activeRealtimeSessionToken
  }, [activeRealtimeSessionToken])

  const isCurrentRealtimeSessionToken = (candidate: RealtimeSessionToken | null): boolean => {
    const active = activeRealtimeSessionTokenRef.current
    if (!candidate || !active) {
      return false
    }

    return (
      candidate.meetingId === active.meetingId
      && candidate.recordingSessionId === active.recordingSessionId
      && candidate.attemptId === active.attemptId
      && candidate.connectionSeq === active.connectionSeq
    )
  }

  const activateRealtimeSessionToken = (token: RealtimeSessionToken | null) => {
    activeRealtimeSessionTokenRef.current = token
    setActiveRealtimeSessionToken(token)
  }

  useEffect(() => {
    if (!realtimeStream.status.resetRequired) {
      resetRecoveryInProgressRef.current = false
      return
    }

    if (resetRecoveryInProgressRef.current) {
      return
    }

    if (audioRecorder.state !== 'recording' && audioRecorder.state !== 'paused') {
      return
    }

    resetRecoveryInProgressRef.current = true
    console.info('[Realtime] FRONTEND_RESET_RECORDER_AFTER_RESET_REQUIRED', {
      meetingId: liveMeetingIdRef.current,
      recorderState: audioRecorder.state,
    })
    realtimeStream.clearQueuedAudio?.()
    audioRecorder.abortRecording()
    setLivePartialWarning('Transcript có thể chưa đầy đủ')

    void audioRecorder.startRecording().catch((error) => {
      setLiveError(error instanceof Error ? error.message : 'Không thể khởi động lại ghi âm')
    })
  }, [audioRecorder, realtimeStream, realtimeStream.status.resetRequired])

  useEffect(() => {
    const isRealtimeRecordingActive = audioRecorder.state === 'recording' || audioRecorder.state === 'paused'
    if (!isRealtimeRecordingActive) {
      return
    }

    if (realtimeStream.status.state !== 'reconnecting') {
      return
    }

    restartAfterReconnectRef.current = true
    realtimeStream.clearQueuedAudio?.()
    audioRecorder.abortRecording()
    setLiveStatusMessage('WebSocket bị ngắt, đang khôi phục kết nối...')
  }, [audioRecorder, realtimeStream, realtimeStream.status.state])

  useEffect(() => {
    if (!restartAfterReconnectRef.current) {
      return
    }

    if (!realtimeStream.isAuthenticated) {
      return
    }

    if (audioRecorder.state !== 'idle' || liveMeetingIdRef.current === null) {
      return
    }

    restartAfterReconnectRef.current = false
    setLiveStatusMessage('Đang ghi âm...')
    setLiveError(null)
    setLiveLifecycleState('recording')
    void audioRecorder.startRecording().catch((error) => {
      setLiveError(error instanceof Error ? error.message : 'Không thể khôi phục ghi âm sau khi reconnect')
    })
  }, [audioRecorder, realtimeStream.isAuthenticated, audioRecorder.state])

  useEffect(() => {
    if (!realtimeStream.isAuthenticated) {
      return
    }

    if (liveLifecycleState === 'connecting') {
      setLiveStatusMessage(LIVE_STATUS_LISTENING)
    }
  }, [liveLifecycleState, realtimeStream.isAuthenticated])

  useEffect(() => {
    if (audioRecorder.state === 'connecting') {
      setLiveLifecycleState('connecting')
      return
    }

    if (audioRecorder.state === 'recording') {
      setLiveLifecycleState('recording')
      return
    }

    if (audioRecorder.state === 'stopped') {
      setLiveLifecycleState('stopped')
      return
    }

    if (audioRecorder.state === 'error') {
      setLiveLifecycleState('error')
      return
    }
  }, [audioRecorder.state])

  useEffect(() => {
    const voiceActivityUpdate = resolveVoiceActivityLifecycleUpdate({
      recorderState: audioRecorder.state,
      liveLifecycleState,
      previousVoiceActivityState: lastVoiceActivityStateRef.current,
      voiceActivityState: voiceActivity.state,
    })

    lastVoiceActivityStateRef.current = voiceActivityUpdate.nextTrackedVoiceActivityState

    if (voiceActivityUpdate.nextLifecycleState !== null) {
      setLiveLifecycleState(voiceActivityUpdate.nextLifecycleState)
    }

    if (voiceActivityUpdate.nextStatusMessage !== null) {
      setLiveStatusMessage(voiceActivityUpdate.nextStatusMessage)
    }
  }, [audioRecorder.state, liveLifecycleState, voiceActivity.state])

  useEffect(() => {
    setIsAuthenticated(Boolean(getAccessToken()))
    return () => {
      abortControllerRef.current?.abort()
      liveAnalysisAbortControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    liveMeetingIdRef.current = liveMeetingId
  }, [liveMeetingId])

  useEffect(() => {
    if (featureScene !== 'realtime' && (audioRecorder.state === 'recording' || audioRecorder.state === 'paused')) {
      audioRecorder.stopRecording()
    }
  }, [audioRecorder, featureScene])

  const handleLogin = async () => {
    if (!username.trim() || !password) {
      setAuthError('Vui lòng nhập username và mật khẩu')
      return
    }

    try {
      setAuthError('')
      const auth = await login({
        username: username.trim(),
        password,
      })
      setAccessToken(auth.accessToken, auth.expiresInSeconds)
      setIsAuthenticated(true)
    } catch (loginError) {
      setAuthError(loginError instanceof Error ? loginError.message : 'Đăng nhập thất bại')
    }
  }

  const handleLogout = () => {
    audioRecorder.stopRecording()
    realtimeStream.disconnect(activeRealtimeSessionTokenRef.current)
    liveAnalysisAbortControllerRef.current?.abort()
    liveAnalysisAbortControllerRef.current = null
    activateRealtimeSessionToken(null)
    clearAccessToken()
    setIsAuthenticated(false)
    setResult(null)
    setLiveMeetingId(null)
    liveMeetingIdRef.current = null
    liveRecordingSessionIdRef.current = 0
    realtimeAttemptIdRef.current = 0
    setHydratedLiveTranscriptSegments(null)
    setStatus('idle')
    setErrorMessage(null)
    setLiveError(null)
    setLivePartialWarning(null)
    setLiveStatusMessage(null)
    setLiveAnalysis(null)
    setLiveAnalysisStatus('idle')
    setLiveAnalysisError(null)
    setLiveLifecycleState('idle')
    setPassword('')
    setJoinMeetingIdInput('')
    setShowJoinOtherMeeting(false)
    setFeatureScene('upload')
  }

  const analysis = result?.analysis
  const liveTranscriptKeywords = useMemo(() => realtimeStream.keywords.map((keyword) => keyword.keyword), [realtimeStream.keywords])
  const liveTranscriptSegments = hydratedLiveTranscriptSegments ?? realtimeStream.transcripts
  const liveTranscriptSegmentsForDisplay = useMemo(() => {
    const shouldMergeForDisplay = hydratedLiveTranscriptSegments !== null || liveLifecycleState === 'stopped'
    if (!shouldMergeForDisplay) {
      return liveTranscriptSegments
    }
    return mergeTranscriptSegmentsForDisplay(liveTranscriptSegments, { maxGapSeconds: 1.0 })
  }, [hydratedLiveTranscriptSegments, liveLifecycleState, liveTranscriptSegments])
  const connectionView = useMemo(
    () => getRealtimeConnectionView(
      liveLifecycleState,
      realtimeStream.status.state,
      realtimeStream.status.message,
      realtimeStream.isConnected,
      realtimeStream.closeReason,
    ),
    [liveLifecycleState, realtimeStream.closeReason, realtimeStream.isConnected, realtimeStream.status.message, realtimeStream.status.state],
  )

  useEffect(() => {
    if (featureScene !== 'realtime' || liveMeetingId === null) {
      setHydratedLiveTranscriptSegments(null)
      liveAnalysisAbortControllerRef.current?.abort()
      liveAnalysisAbortControllerRef.current = null
      setLiveAnalysis(null)
      setLiveAnalysisStatus('idle')
      setLiveAnalysisError(null)
    }
  }, [liveMeetingId, featureScene])

  const handleProcess = async (fileOverride?: File) => {
    const file = fileOverride ?? selectedFile
    if (!file) {
      setErrorMessage('Vui lòng chọn file audio trước khi xử lý')
      return
    }

    setBusy(true)
    setErrorMessage(null)
    setResult(null)
    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()

    let meetingId: number | null = null

    try {
      const effectiveUploadLanguage = normalizeRealtimeLanguage(selectedUploadLanguage)
      setStatus('uploading')
      setFeatureScene('upload')
      console.info('UPLOAD_REQUEST_SEND language=' + effectiveUploadLanguage)
      const meeting = await uploadToMeetingApi(file.name, file, effectiveUploadLanguage)
      meetingId = meeting.id

      setStatus('processing')
      await startProcessingByPath(meetingId, effectiveUploadLanguage)

      await pollUntilCompleted(meetingId, abortControllerRef.current.signal)

      setStatus('fetching-result')
      const [transcript, analysis] = await Promise.all([
        getTranscript(meetingId),
        getAnalysis(meetingId),
      ])

      const mergedTranscriptSegments = mergeTranscriptSegments(
        normalizePersistedTranscriptSegments(transcript.transcripts || []),
      )

      const mergedTranscript = mergedTranscriptSegments
        .map((segment) => `${segment.speaker}: ${segment.text}`)
        .join(' ')
        .trim()

      setResult({
        meetingId,
        status: 'COMPLETED',
        transcript: mergedTranscript,
        transcriptSegments: mergedTranscriptSegments,
        analysis,
      })
      setStatus('completed')
      setFeatureScene('analysis')
    } catch (error: any) {
      setStatus('failed')
      if (error instanceof DOMException && error.name === 'AbortError') {
        setErrorMessage('Processing cancelled')
      } else {
        const message = error.status === 401
          ? 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại'
          : error.status === 413
          ? 'File quá lớn (tối đa 200MB)'
          : error.status === 415
          ? 'Định dạng file không được hỗ trợ'
          : error.message || 'Lỗi không xác định, vui lòng thử lại'

        setErrorMessage(message)

        if (error.status === 401) {
          handleLogout()
        }
      }
      console.error('handleProcess error:', error)
    } finally {
      abortControllerRef.current = null
      setBusy(false)
    }
  }

  const handleCancel = () => {
    abortControllerRef.current?.abort()
  }

  const handleJoinMeeting = () => {
    const parsedMeetingId = Number(joinMeetingIdInput)
    if (!Number.isFinite(parsedMeetingId) || parsedMeetingId <= 0) {
      setLiveError('Vui lòng nhập Meeting ID hợp lệ')
      return
    }

    setLiveError(null)
    setLivePartialWarning(null)
    liveAnalysisAbortControllerRef.current?.abort()
    liveAnalysisAbortControllerRef.current = null
    setLiveAnalysis(null)
    setLiveAnalysisStatus('idle')
    setLiveAnalysisError(null)
    setHydratedLiveTranscriptSegments(null)
    realtimeStream.clearQueuedAudio?.()
    realtimeStream.disconnect(activeRealtimeSessionTokenRef.current)
    activateRealtimeSessionToken(null)
    setLiveMeetingId(parsedMeetingId)
    liveMeetingIdRef.current = parsedMeetingId
    liveRecordingSessionIdRef.current = 0
    setLiveLifecycleState('idle')
    setShowJoinOtherMeeting(false)
    setFeatureScene('realtime')
  }

  const handleDashboardUpload = async (_title: string, file: File) => {
    setSelectedFile(file)
    await handleProcess(file)
  }

  const dashboardUser = useMemo(() => ({
    name: username.trim() || `User ${currentUserId || ''}`.trim() || 'AudioMind',
    email: currentUserId ? `user-${currentUserId}@audiomind` : undefined,
  }), [currentUserId, username])

  const recentFiles = useMemo(() => {
    if (!result && !selectedFile) return []
    const items = []
    if (result) {
      items.push({
        id: String(result.meetingId),
        label: selectedFile?.name || `Meeting #${result.meetingId}`,
        active: featureScene === 'analysis',
      })
    }
    return items
  }, [featureScene, result, selectedFile])

  const renderDashboardScene = () => {
    if (featureScene === 'realtime' && isRealtimeEnabled && realtimeUserId !== null) {
      return (
        <RealtimeDashboardScene
          liveStatusMessage={liveStatusMessage}
          connectionView={connectionView}
          selectedRealtimeLanguage={selectedRealtimeLanguage}
          selectedRealtimeSpeakerMode={selectedRealtimeSpeakerMode}
          liveLifecycleState={liveLifecycleState}
          onRealtimeLanguageChange={(value) => setSelectedRealtimeLanguage(normalizeRealtimeLanguage(value))}
          onRealtimeSpeakerModeChange={(value) => setSelectedRealtimeSpeakerMode(normalizeRealtimeSpeakerMode(value))}
          isRealtimeLanguageSelectorDisabled={isRealtimeLanguageSelectorDisabled(liveLifecycleState)}
          isRealtimeSpeakerModeSelectorDisabled={isRealtimeSpeakerModeSelectorDisabled(liveLifecycleState)}
          liveMeetingId={liveMeetingId}
          audioRecorder={audioRecorder}
          onBeforeStartRecording={handlePrepareLiveMeeting}
          onChunkReady={handleLiveChunkReady}
          onRecordingComplete={handleLiveRecordingComplete}
          liveError={liveError}
          livePartialWarning={livePartialWarning}
          showJoinOtherMeeting={showJoinOtherMeeting}
          joinMeetingIdInput={joinMeetingIdInput}
          onJoinMeetingIdChange={setJoinMeetingIdInput}
          onJoinMeeting={handleJoinMeeting}
          liveTranscriptSegments={liveTranscriptSegmentsForDisplay}
          liveTranscriptKeywords={liveTranscriptKeywords}
          realtimeKeywordCount={realtimeStream.keywords.length}
          currentUserId={currentUserId}
          connectionViewForAside={connectionView}
          liveAnalysis={liveAnalysis}
          liveAnalysisStatus={liveAnalysisStatus}
          liveAnalysisError={liveAnalysisError}
          showLiveAnalysis={liveLifecycleState === 'stopped' || liveAnalysisStatus !== 'idle'}
        />
      )
    }

    if (featureScene === 'analysis') {
      return (
        <FeatureAnalysis
          meetingId={result?.meetingId}
          meetingTitle={selectedFile?.name}
          fileName={selectedFile?.name}
          busy={busy}
          analysis={analysis ?? null}
          transcriptSegments={result?.transcriptSegments}
          transcriptText={result?.transcript}
          statusLabel={status}
        />
      )
    }

    if (featureScene === 'files') return <MeetingHistoryScene />
    if (featureScene === 'subjects') return <SubjectsList />

    return (
      <FeatureUpload
        disabled={busy}
        userName={dashboardUser.name}
        uploadLanguage={selectedUploadLanguage}
        onUploadLanguageChange={setSelectedUploadLanguage}
        status={status}
        errorMessage={errorMessage}
        onUpload={handleDashboardUpload}
        onCancel={handleCancel}
      />
    )
  }

  const handlePrepareLiveMeeting = async (): Promise<void> => {
    setLiveError(null)
    setLivePartialWarning(null)
    liveAnalysisAbortControllerRef.current?.abort()
    liveAnalysisAbortControllerRef.current = null
    setLiveAnalysis(null)
    setLiveAnalysisStatus('idle')
    setLiveAnalysisError(null)
    setLiveStatusMessage('Đang tạo meeting mới...')
    setHydratedLiveTranscriptSegments(null)
    setLiveLifecycleState('connecting')
    realtimeStream.clearQueuedAudio?.()
    realtimeStream.disconnect(activeRealtimeSessionTokenRef.current)
    audioRecorder.abortRecording()
    setLiveMeetingId(null)
    liveMeetingIdRef.current = null
    const sessionId = audioRecorder.recordingSessionId + 1
    const attemptId = realtimeAttemptIdRef.current + 1
    realtimeAttemptIdRef.current = attemptId
    let meetingCreated = false
    let sessionToken: RealtimeSessionToken | null = null

    try {
      const bootstrapFile = createLiveMeetingBootstrapFile()
      const meeting = await uploadToMeetingApi('Live recording session', bootstrapFile)
      const normalizedMeetingId = Number(meeting.id)
      if (!Number.isFinite(normalizedMeetingId)) {
        throw new Error('Meeting ID trả về không hợp lệ')
      }

      if (realtimeAttemptIdRef.current !== attemptId) {
        console.info('[Realtime] STALE_SESSION_PREPARE_IGNORED', {
          meetingId: normalizedMeetingId,
          attemptId,
          recordingSessionId: sessionId,
        })
        throw new Error('Stale realtime session prepare ignored')
      }

      sessionToken = {
        meetingId: normalizedMeetingId,
        recordingSessionId: sessionId,
        attemptId,
        connectionSeq: 0,
      }
      liveRecordingSessionIdRef.current = sessionId
      setLiveMeetingId(normalizedMeetingId)
      liveMeetingIdRef.current = normalizedMeetingId
      activateRealtimeSessionToken(sessionToken)
      meetingCreated = true
      // Minimal audit log for session lifecycle.
      // eslint-disable-next-line no-console
      console.info('[Realtime] REALTIME_START', {
        meetingId: normalizedMeetingId,
        sessionId,
        language: selectedRealtimeLanguage,
      })
      setLiveStatusMessage(`Meeting ${normalizedMeetingId} đang kết nối realtime...`)

      await realtimeStream.waitForSessionReady(undefined, normalizedMeetingId, sessionToken)

      if (
        !isCurrentRealtimeSessionToken(sessionToken)
        || liveRecordingSessionIdRef.current !== sessionId
        || liveMeetingIdRef.current !== normalizedMeetingId
      ) {
        throw new Error('Stale realtime session prepare ignored')
      }

      setLiveStatusMessage(`Meeting ${normalizedMeetingId} sẵn sàng ghi âm`)
      return
    } catch (error) {
      if (sessionToken !== null && !isCurrentRealtimeSessionToken(sessionToken)) {
        console.info('[Realtime] STALE_SESSION_PREPARE_IGNORED', {
          meetingId: liveMeetingIdRef.current,
          attemptId,
          recordingSessionId: sessionId,
        })
        throw error instanceof Error ? error : new Error('Stale realtime session prepare ignored')
      }

      const message = error instanceof Error ? error.message : 'Không thể tạo meeting mới'
      setLiveError(message)
      setLiveStatusMessage(null)
      setLiveLifecycleState('error')
      if (meetingCreated) {
        realtimeStream.clearQueuedAudio?.()
        realtimeStream.disconnect(sessionToken)
        setLiveMeetingId(null)
        liveMeetingIdRef.current = null
      }
      liveRecordingSessionIdRef.current = 0
      throw error
    }
  }

  const handleLiveChunkReady = async (chunk: Blob, sessionId: number) => {
    const activeToken = activeRealtimeSessionTokenRef.current
    const activeMeetingId = liveMeetingIdRef.current
    if (!activeMeetingId || sessionId !== liveRecordingSessionIdRef.current || !activeToken) {
      if (!activeMeetingId) {
        // eslint-disable-next-line no-console
        console.error('[Realtime] STARTUP_INVARIANT_BROKEN', {
          reason: 'chunk_received_without_active_meeting',
          sessionId,
          activeSessionId: liveRecordingSessionIdRef.current,
        })
      }
      // eslint-disable-next-line no-console
      console.warn('[Realtime] REALTIME_DROP_STALE_CHUNK', {
        currentMeetingId: activeMeetingId,
        sessionId,
        activeSessionId: liveRecordingSessionIdRef.current,
      })
      return
    }

    if (!isCurrentRealtimeSessionToken(activeToken)) {
      // eslint-disable-next-line no-console
      console.warn('[Realtime] REALTIME_DROP_STALE_CHUNK', {
        currentMeetingId: activeMeetingId,
        sessionId,
        activeSessionId: liveRecordingSessionIdRef.current,
        reason: 'stale_session_token',
      })
      return
    }

    try {
      // eslint-disable-next-line no-console
      console.info('[Realtime] REALTIME_CHUNK_SEND', {
        meetingId: activeMeetingId,
        sessionId,
        size: chunk.size,
      })
      await realtimeStream.sendAudioChunk(chunk, String(activeMeetingId))
    } catch (error) {
      console.error('Failed to send audio chunk:', error)
      setLiveError(error instanceof Error ? error.message : 'Không thể gửi audio chunk')
      setLiveLifecycleState('error')
    }
  }

  const startRealtimeAnalysisPolling = (
    meetingId: number,
    sessionId: number,
    sessionToken: RealtimeSessionToken,
  ) => {
    liveAnalysisAbortControllerRef.current?.abort()
    const controller = new AbortController()
    liveAnalysisAbortControllerRef.current = controller
    setLiveAnalysis(null)
    setLiveAnalysisStatus('polling')
    setLiveAnalysisError(null)

    void (async () => {
      try {
        const pollResult = await pollRealtimeAnalysisAfterStop(meetingId, controller.signal)
        if (
          !isCurrentRealtimeSessionToken(sessionToken)
          || !isCurrentLiveRecordingSession(sessionId, meetingId, liveRecordingSessionIdRef.current, liveMeetingIdRef.current)
        ) {
          return
        }

        if (pollResult.status === 'completed' && pollResult.analysis) {
          setLiveAnalysis(pollResult.analysis)
          setLiveAnalysisStatus('completed')
          setLiveAnalysisError(null)
          return
        }

        if (pollResult.status === 'failed') {
          setLiveAnalysisStatus('failed')
          setLiveAnalysisError(pollResult.reason || 'Không thể tải phân tích realtime')
          return
        }

        setLiveAnalysisStatus('pending')
        setLiveAnalysisError('Phân tích realtime đang xử lý, vui lòng thử lại sau')
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }
        if (
          !isCurrentRealtimeSessionToken(sessionToken)
          || !isCurrentLiveRecordingSession(sessionId, meetingId, liveRecordingSessionIdRef.current, liveMeetingIdRef.current)
        ) {
          return
        }
        setLiveAnalysisStatus('failed')
        setLiveAnalysisError(error instanceof Error ? error.message : 'Không thể tải phân tích realtime')
      }
    })()
  }

  const handleLiveRecordingComplete = async (fullAudio: Blob, sessionId: number) => {
    const sessionToken = activeRealtimeSessionTokenRef.current
    const completedMeetingId = liveMeetingIdRef.current
    if (!sessionToken || !isCurrentLiveRecordingSession(sessionId, completedMeetingId, liveRecordingSessionIdRef.current, liveMeetingIdRef.current)) {
      // eslint-disable-next-line no-console
      console.warn('[Realtime] REALTIME_DROP_STALE_CHUNK', {
        currentMeetingId: completedMeetingId,
        sessionId,
        activeSessionId: liveRecordingSessionIdRef.current,
      })
      return
    }

    setLiveStatusMessage(`Đã ghi âm ${Math.max(1, Math.round(fullAudio.size / 1024))} KB`)
    try {
      if (!isCurrentRealtimeSessionToken(sessionToken)) {
        console.info('[Realtime] STALE_SESSION_COMPLETE_IGNORED', {
          meetingId: completedMeetingId,
          sessionId,
        })
        return
      }

      setLiveLifecycleState('stopping')
      // eslint-disable-next-line no-console
      console.info('[Realtime] REALTIME_STOP', {
        meetingId: liveMeetingIdRef.current,
        sessionId,
      })

      if (realtimeStream?.stopStream) {
        realtimeStream.stopStream()
      }

      const activeMeetingId = liveMeetingIdRef.current
      if (activeMeetingId) {
        const partialState = Boolean(realtimeStream.status.resetRequired || realtimeStream.status.message?.includes('chưa đầy đủ'))
        const liveSnapshot = [...realtimeStream.transcripts]
        const hydratedSegments = await hydrateLiveTranscriptSegments(
          activeMeetingId,
          getTranscript,
          sessionToken,
          isCurrentRealtimeSessionToken,
          {
            backendPartial: partialState,
            backendResetRequired: realtimeStream.status.resetRequired,
            currentLiveSegments: liveSnapshot,
          },
        )
        if (!isCurrentRealtimeSessionToken(sessionToken) || !isCurrentLiveRecordingSession(sessionId, completedMeetingId, liveRecordingSessionIdRef.current, liveMeetingIdRef.current)) {
          return
        }
        const mergedHydration = mergeHydratedTranscriptWithLive(liveSnapshot, hydratedSegments)
        setHydratedLiveTranscriptSegments(mergedHydration)
        if (mergedHydration.length === 0) {
          setLivePartialWarning('Chưa có transcript')
          setLiveStatusMessage('Đã dừng ghi âm (chưa có transcript)')
        }
        if (partialState) {
          setLivePartialWarning('Transcript có thể chưa đầy đủ')
          console.info('[Realtime] TRANSCRIPT_PARTIAL_WARNING', {
            meetingId: activeMeetingId,
            fragments: hydratedSegments.length,
          })
        }
      } else {
        if (!isCurrentRealtimeSessionToken(sessionToken)) {
          return
        }
        setHydratedLiveTranscriptSegments([])
      }

      // Close connection gracefully
      if (
        isCurrentLiveRecordingSession(
          sessionId,
          completedMeetingId,
          liveRecordingSessionIdRef.current,
          liveMeetingIdRef.current,
        ) && realtimeStream?.disconnect
      ) {
        realtimeStream.disconnect(sessionToken)
      }

      setLiveLifecycleState('stopped')
      setLiveError(null)
      setLiveStatusMessage('Đã dừng ghi âm')
      if (completedMeetingId !== null && isCurrentRealtimeSessionToken(sessionToken)) {
        startRealtimeAnalysisPolling(completedMeetingId, sessionId, sessionToken)
      }

      // eslint-disable-next-line no-console
      console.info('[Realtime] REALTIME_CLEANUP_DONE', {
        meetingId: liveMeetingIdRef.current,
        sessionId,
      })
    } catch (err) {
      if (!isCurrentRealtimeSessionToken(sessionToken)) {
        console.info('[Realtime] STALE_HYDRATION_IGNORED', {
          meetingId: completedMeetingId,
          sessionId,
        })
        return
      }

      console.error('Error during finalization after recording stop:', err)
      setHydratedLiveTranscriptSegments([])
      setLiveLifecycleState('error')
    }
  }

  const createLiveMeetingBootstrapFile = () => {
    const bootstrapBytes = new Uint8Array([0])
    return new File([bootstrapBytes], `live-recording-${Date.now()}.webm`, {
      type: 'audio/webm; codecs=opus',
    })
  }

  if (!isAuthenticated) {
    return (
      <div className="app app--guest">
        <div className="login-modal login-modal--page">
          <main className="login-card">
            <div className="login-panel__brand">
              <span className="login-panel__logo" aria-hidden="true">🎙</span>
              <h2>AudioMind</h2>
            </div>
            <p>Đăng nhập để upload audio, ghi âm realtime và nhận phân tích AI.</p>
            <input
              type="text"
              placeholder="Username"
              data-testid="e2e-login-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <input
              type="password"
              placeholder="Password"
              data-testid="e2e-login-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button type="button" data-testid="e2e-login-submit" onClick={handleLogin}>
              Đăng nhập
            </button>
            {authError && <p className="login-panel__error">{authError}</p>}
          </main>
        </div>
      </div>
    )
  }

  return (
    <div className="app app--dashboard">
      <DashboardLayout
        user={dashboardUser}
        onLogout={handleLogout}
        activeMenu={featureScene}
        onNavigate={setFeatureScene}
        showRealtime={isRealtimeEnabled}
        recentFiles={recentFiles}
      >
        {renderDashboardScene()}
      </DashboardLayout>
    </div>
  )
}
