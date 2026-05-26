import { useEffect, useMemo, useRef, useState } from 'react'
import { AnalysisPanel } from '../components/analysis/AnalysisPanel'
import { AudioRecorderButton } from '../components/realtime/AudioRecorderButton'
import { RealtimeTranscript } from '../components/transcript/RealtimeTranscript'
import { TranscriptDisplay } from '../components/transcript/TranscriptDisplay'
import { ErrorState } from '../components/ui/ErrorState'
import '../styles/app.css'
import { useAudioRecorder } from '../hooks/useAudioRecorder'
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
import { ApiError, getAnalysis, getProcessingStatus, getTranscript, startProcessingByPath, uploadToMeetingApi } from '../services/api'
import { clearAccessToken, getAccessToken, getCurrentUserId, login, setAccessToken } from '../services/auth'
import { REALTIME_WS_ENABLED } from '../services/config'
import type { AiAnalysis } from '../types'
import { mergeTranscriptSegments, mergeTranscriptSegmentsForDisplay, normalizePersistedTranscriptSegments } from '../utils/transcript'

export { DEFAULT_REALTIME_LANGUAGE } from '../hooks/useRealtimeMeetingStream'

type ResultView = {
  meetingId: number
  status: string
  transcript: string
  transcriptSegments: TranscriptSegment[]
  analysis: AiAnalysis
}

type LiveLifecycleState = 'idle' | 'connecting' | 'recording' | 'stopping' | 'stopped' | 'error'

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
  return lifecycleState === 'connecting' || lifecycleState === 'recording' || lifecycleState === 'stopping'
}

export const isRealtimeSpeakerModeSelectorDisabled = (lifecycleState: LiveLifecycleState): boolean => {
  return isRealtimeLanguageSelectorDisabled(lifecycleState)
}

export const getStatusBadgeClass = (statusText: string): string => {
  const normalized = statusText.toLowerCase()
  if (normalized.includes('completed') || normalized.includes('hoàn tất')) {
    return 'status-badge status-badge--completed'
  }
  if (normalized.includes('failed') || normalized.includes('lỗi')) {
    return 'status-badge status-badge--failed'
  }
  if (
    normalized.includes('process')
    || normalized.includes('upload')
    || normalized.includes('queue')
    || normalized.includes('running')
    || normalized.includes('đang')
  ) {
    return 'status-badge status-badge--processing'
  }
  return 'status-badge status-badge--idle'
}

export const getRealtimeConnectionView = (
  lifecycleState: LiveLifecycleState,
  realtimeState: string,
  realtimeMessage: string | undefined,
  isConnected: boolean,
  closeReason: string,
): RealtimeConnectionView => {
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
      title: 'Đang ghi âm',
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
  const [viewMode, setViewMode] = useState<'batch' | 'realtime'>('batch')
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

  const isRealtimeEnabled = REALTIME_WS_ENABLED
  const currentUserId = getCurrentUserId()
  const parsedRealtimeUserId = currentUserId ? Number(currentUserId) : null
  const realtimeUserId = parsedRealtimeUserId !== null && Number.isFinite(parsedRealtimeUserId)
    ? parsedRealtimeUserId
    : null
  const realtimeToken = getAccessToken() ?? ''
  const audioRecorder = useAudioRecorder(liveMeetingId)
  const realtimeStream = useRealtimeMeetingStream({
    meetingId: liveMeetingId,
    userId: realtimeUserId,
    token: realtimeToken,
    sessionToken: activeRealtimeSessionToken,
    language: selectedRealtimeLanguage,
    speakerMode: selectedRealtimeSpeakerMode,
    enabled: isAuthenticated && isRealtimeEnabled && viewMode === 'realtime',
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
      setLiveStatusMessage('Đang lắng nghe...')
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
    if (viewMode !== 'realtime' && (audioRecorder.state === 'recording' || audioRecorder.state === 'paused')) {
      audioRecorder.stopRecording()
    }
  }, [audioRecorder, viewMode])

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
    setViewMode('batch')
  }

  const analysis = result?.analysis
  const liveTranscriptKeywords = useMemo(() => realtimeStream.keywords.map((keyword) => keyword.keyword), [realtimeStream.keywords])
  const liveModeActive = isRealtimeEnabled && viewMode === 'realtime' && realtimeUserId !== null
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
    if (viewMode !== 'realtime' || liveMeetingId === null) {
      setHydratedLiveTranscriptSegments(null)
      liveAnalysisAbortControllerRef.current?.abort()
      liveAnalysisAbortControllerRef.current = null
      setLiveAnalysis(null)
      setLiveAnalysisStatus('idle')
      setLiveAnalysisError(null)
    }
  }, [liveMeetingId, viewMode])

  const handleProcess = async () => {
    if (!selectedFile) {
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
      console.info('UPLOAD_REQUEST_SEND language=' + effectiveUploadLanguage)
      const meeting = await uploadToMeetingApi(selectedFile.name, selectedFile, effectiveUploadLanguage)
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
    setViewMode('realtime')
  }

  const handlePrepareLiveMeeting = async (): Promise<{ expectedSessionId: number }> => {
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
      return { expectedSessionId: sessionId }
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
      <div className="login-shell">
      <main className="login-panel">
        <div className="login-panel__brand">
          <span className="login-panel__logo" aria-hidden="true">🎙</span>
          <h1>AudioMind</h1>
        </div>
        <p>Đăng nhập để upload audio, ghi âm realtime và nhận phân tích AI.</p>
        <div className="login-panel__form">
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
          <button type="button" data-testid="e2e-login-submit" onClick={handleLogin}>Đăng nhập</button>
        </div>
        {authError && <p className="login-panel__error">{authError}</p>}
      </main>
      </div>
    )
  }

  return (
    <main className="production-app">
      <header className="production-app__header">
        <div className="production-app__brand">
          <span className="production-app__logo" aria-hidden="true">🎙</span>
          <div>
            <h1 className="production-app__title">AudioMind</h1>
            <p className="production-app__subtitle">Upload file hoặc ghi âm trực tiếp — transcript và phân tích AI</p>
          </div>
        </div>
        <button type="button" className="production-app__logout" onClick={handleLogout}>
          Đăng xuất
        </button>
      </header>

      <div className="view-tabs">
        <button
          type="button"
          className={`view-tabs__button ${viewMode === 'batch' ? 'view-tabs__button--active' : ''}`}
          onClick={() => setViewMode('batch')}
        >
          Upload File
        </button>
        {isRealtimeEnabled && (
          <button
            type="button"
            className={`view-tabs__button ${viewMode === 'realtime' ? 'view-tabs__button--active' : ''}`}
            onClick={() => setViewMode('realtime')}
          >
            Ghi âm Trực tiếp
          </button>
        )}
      </div>

      {viewMode === 'batch' && (
        <>
          <section className="upload-panel">
            <div className="upload-card">
              <h2 className="upload-card__title">Upload & phân tích</h2>
              <p className="upload-card__desc">Chọn ngôn ngữ, tải file audio và nhận transcript cùng tóm tắt Gemini.</p>
            <div className="upload-panel__controls">
              <label className="upload-panel__label">
                <span className="upload-panel__label-text">Ngôn ngữ</span>
                <select
                  className="upload-panel__select"
                  value={selectedUploadLanguage}
                  onChange={(event) => {
                    const nextLanguage = normalizeRealtimeLanguage(event.target.value)
                    setSelectedUploadLanguage(nextLanguage)
                    console.info(`FE_UPLOAD_LANGUAGE_SELECTED language=${nextLanguage}`)
                  }}
                  disabled={busy}
                  data-testid="e2e-upload-language-select"
                >
                  {UPLOAD_LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="file-dropzone">
                <span className="file-dropzone__icon" aria-hidden="true">📁</span>
                <span className="file-dropzone__title">Chọn file audio</span>
                <span className="file-dropzone__hint">MP3, WAV, M4A — tối đa theo giới hạn server</span>
                {selectedFile && (
                  <span className="file-dropzone__name">{selectedFile.name}</span>
                )}
                <input
                  className="file-dropzone__input"
                  type="file"
                  accept="audio/*"
                  data-testid="e2e-upload-input"
                  onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
                  disabled={busy}
                />
              </label>
              <div className="upload-panel__actions">
                <button
                  type="button"
                  className="upload-panel__submit"
                  data-testid="e2e-process-submit"
                  onClick={handleProcess}
                  disabled={busy || !selectedFile}
                >
                  Phân tích file
                </button>
                {busy && (
                  <button type="button" className="upload-panel__cancel" onClick={handleCancel}>
                    Hủy xử lý
                  </button>
                )}
              </div>
            </div>
            </div>
          </section>

          <p className="status-line" data-testid="e2e-status">
            <span>Trạng thái</span>
            <span className={getStatusBadgeClass(status)}>{status}</span>
          </p>

          {errorMessage && <ErrorState message={errorMessage} title="Lỗi xử lý" />}

          {result && (
            <div className="result-layout result-layout--split">
              <section className="result-card">
                <div className="result-card__header">
                  <h3 className="result-card__heading">Transcript</h3>
                  <div className="result-card__meta">
                    <span className="meta-pill">ID <strong>{result.meetingId}</strong></span>
                    <span className="meta-pill">Status <strong>{result.status}</strong></span>
                  </div>
                </div>
                <div className="result-card__transcript" data-testid="e2e-transcript">
                    <TranscriptDisplay
                      segments={result.transcriptSegments}
                      transcriptTextFallback={result.transcript}
                      emptyMessage="Không có transcript"
                      maxHeight="420px"
                      enableDisplayGrouping
                    />
                </div>
              </section>
              <AnalysisPanel
                title="Phân tích upload"
                analysis={analysis ?? null}
                status={analysis ? 'ready' : 'empty'}
                testId="e2e-analysis"
                summaryTestId="e2e-summary"
                summaryFallback="(empty)"
              />
            </div>
          )}
        </>
      )}

      {liveModeActive && (
        <section className="realtime-panel">
          <div className="realtime-hero">
          <div className="realtime-panel__header">
            <div>
              <h2 className="realtime-panel__title">Ghi âm trực tiếp</h2>
              <p className="realtime-panel__status">
                {liveStatusMessage || connectionView.detail || 'Sẵn sàng tạo meeting và bắt đầu ghi âm'}
              </p>
              <div className="realtime-panel__settings">
                <label className="upload-panel__label">
                  <span className="upload-panel__label-text">Language mode</span>
                  <select
                    className="upload-panel__select"
                    value={selectedRealtimeLanguage}
                    onChange={(event) => setSelectedRealtimeLanguage(normalizeRealtimeLanguage(event.target.value))}
                    disabled={isRealtimeLanguageSelectorDisabled(liveLifecycleState)}
                  >
                    {REALTIME_LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="realtime-panel__hint">Chọn Việt + Anh nếu audio có thuật ngữ tiếng Anh.</p>
                <label className="upload-panel__label">
                  <span className="upload-panel__label-text">Speaker mode</span>
                  <select
                    className="upload-panel__select"
                    value={selectedRealtimeSpeakerMode}
                    onChange={(event) => setSelectedRealtimeSpeakerMode(normalizeRealtimeSpeakerMode(event.target.value))}
                    disabled={isRealtimeSpeakerModeSelectorDisabled(liveLifecycleState)}
                  >
                    {REALTIME_SPEAKER_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="realtime-panel__hint">Single speaker disables diarization. Multiple speakers turns it on.</p>
              </div>
            </div>
            {liveMeetingId && (
              <span className="realtime-panel__meeting-badge">Meeting #{liveMeetingId}</span>
            )}
          </div>

          <div className="realtime-panel__recorder-wrap">
          <AudioRecorderButton
            recorder={audioRecorder}
            lifecycleState={liveLifecycleState}
            onBeforeStartRecording={handlePrepareLiveMeeting}
            onChunkReady={handleLiveChunkReady}
            onRecordingComplete={handleLiveRecordingComplete}
          />
          </div>
          </div>

          {liveError && <ErrorState message={liveError} title="Lỗi realtime" />}
          {livePartialWarning && <div className="warning-banner">{livePartialWarning}</div>}

          {showJoinOtherMeeting && (
            <div className="join-meeting-panel">
              <strong>Tham gia Meeting khác</strong>
              <input
                type="number"
                placeholder="Meeting ID"
                value={joinMeetingIdInput}
                onChange={(e) => setJoinMeetingIdInput(e.target.value)}
              />
              <button
                type="button"
                onClick={handleJoinMeeting}
                disabled={!joinMeetingIdInput.trim()}
              >
                Join Meeting
              </button>
            </div>
          )}

          <div className="realtime-panel__grid">
            <RealtimeTranscript
              segments={liveTranscriptSegmentsForDisplay}
              highlightKeywords={liveTranscriptKeywords}
              maxHeight="620px"
            />

            <aside className="realtime-panel__aside">
              <div className="status-card status-card--live">
                <div className="status-card__label">Connection</div>
                <div className="status-card__value">{connectionView.title}</div>
                <div className="status-card__detail">{connectionView.detail}</div>
                {connectionView.closeReason && (
                  <div className={`status-card__detail ${connectionView.closeReasonIsError ? 'status-card__detail--error' : ''}`}>
                    Close reason: {connectionView.closeReason}
                  </div>
                )}
              </div>

              <div className="status-card">
                <div className="status-card__label">Keywords</div>
                <div className="status-card__value">{realtimeStream.keywords.length}</div>
              </div>

              <div className="status-card">
                <div className="status-card__label">User</div>
                <div className="status-card__value">{currentUserId || 'Unknown'}</div>
              </div>
            </aside>
          </div>

          {(liveLifecycleState === 'stopped' || liveAnalysisStatus !== 'idle') && (
            <div className="realtime-analysis-section">
            <AnalysisPanel
              title="Phân tích realtime"
              analysis={liveAnalysis}
              status={
                liveAnalysisStatus === 'polling'
                  ? 'loading'
                  : liveAnalysis
                    ? 'ready'
                    : liveAnalysisError
                      ? 'empty'
                      : 'empty'
              }
              loadingMessage="Đang phân tích transcript sau khi dừng ghi âm..."
              errorMessage={liveAnalysisError}
              emptyMessage="Chưa có kết quả phân tích realtime"
              summaryFallback="(đang chờ phân tích)"
              testId="e2e-live-analysis"
            />
            </div>
          )}
        </section>
      )}
    </main>
  )
}
