import { useEffect, useMemo, useRef, useState } from 'react'
import { AudioRecorderButton } from './components/AudioRecorderButton'
import { RealtimeTranscript } from './components/RealtimeTranscript'
import { useAudioRecorder } from './hooks/useAudioRecorder'
import type { RealtimeSessionToken, TranscriptSegment } from './hooks/useRealtimeMeetingStream'
import { useRealtimeMeetingStream } from './hooks/useRealtimeMeetingStream'
import { getAnalysis, getProcessingStatus, getTranscript, startProcessingByPath, uploadToMeetingApi } from './services/api'
import { clearAccessToken, getAccessToken, getCurrentUserId, login, setAccessToken } from './services/auth'
import { REALTIME_WS_ENABLED } from './services/config'
import { mergeTranscriptSegments, normalizePersistedTranscriptSegments } from './utils/transcript'

type ResultView = {
  meetingId: number
  status: string
  transcript: string
  summary: string
}

type LiveLifecycleState = 'idle' | 'connecting' | 'recording' | 'stopping' | 'stopped' | 'error'

type RealtimeConnectionView = {
  title: string
  detail: string
  closeReason: string | null
  closeReasonIsError: boolean
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

export const hydrateLiveTranscriptSegments = async (
  meetingId: number,
  fetchTranscript: typeof getTranscript = getTranscript,
  sessionToken: RealtimeSessionToken | null = null,
  isSessionActive: ((token: RealtimeSessionToken | null) => boolean) | null = null,
  options: { backendPartial?: boolean; backendResetRequired?: boolean } = {},
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
  const forceStableHydration = Boolean(options.backendPartial || options.backendResetRequired)

  for (let attempt = 1; attempt <= HYDRATION_MAX_ATTEMPTS; attempt += 1) {
    let transcript
    try {
      transcript = await fetchTranscript(meetingId)
    } catch (error) {
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

    if (!forceStableHydration && hydratedSegments.length > 0) {
      console.info('[Realtime] Post-stop transcript hydration completed', {
        meetingId,
        attempts: attempt,
        persistedFragments: hydratedSegments.length,
      })
      return hydratedSegments
    }

    if (forceStableHydration) {
      console.info('[Realtime] HYDRATION_WAITING_FOR_STABLE_TRANSCRIPT', {
        meetingId,
        attempt,
        fragments: hydratedSegments.length,
        stableCount,
      })
      if (hydratedSegments.length > 0 && stableCount >= 1) {
        console.info('[Realtime] HYDRATION_STABLE_COMPLETED', {
          meetingId,
          attempts: attempt,
          persistedFragments: hydratedSegments.length,
        })
        return hydratedSegments
      }
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
  return []
}

export default function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState<ResultView | null>(null)
  const [liveMeetingId, setLiveMeetingId] = useState<number | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [livePartialWarning, setLivePartialWarning] = useState<string | null>(null)
  const [liveStatusMessage, setLiveStatusMessage] = useState<string | null>(null)
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
  const abortControllerRef = useRef<AbortController | null>(null)
  const liveMeetingIdRef = useRef<number | null>(null)
  const liveRecordingSessionIdRef = useRef(0)
  const activeRealtimeSessionTokenRef = useRef<RealtimeSessionToken | null>(null)
  const realtimeAttemptIdRef = useRef(0)
  const resetRecoveryInProgressRef = useRef(false)
  const restartAfterReconnectRef = useRef(false)

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
    enabled: isAuthenticated && isRealtimeEnabled && viewMode === 'realtime',
    autoReconnect: true,
  })

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
    setLiveLifecycleState('idle')
    setPassword('')
    setJoinMeetingIdInput('')
    setShowJoinOtherMeeting(false)
    setViewMode('batch')
  }

  const transcriptText = useMemo(() => result?.transcript || '(empty)', [result])
  const summaryText = useMemo(() => result?.summary || '(empty)', [result])
  const liveTranscriptKeywords = useMemo(() => realtimeStream.keywords.map((keyword) => keyword.keyword), [realtimeStream.keywords])
  const liveModeActive = isRealtimeEnabled && viewMode === 'realtime' && realtimeUserId !== null
  const liveTranscriptSegments = hydratedLiveTranscriptSegments ?? realtimeStream.transcripts
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
      setStatus('uploading')
      const meeting = await uploadToMeetingApi(selectedFile.name, selectedFile)
      meetingId = meeting.id

      setStatus('processing')
      await startProcessingByPath(meetingId)

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
        summary: analysis.summary || '',
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
        const hydratedSegments = await hydrateLiveTranscriptSegments(
          activeMeetingId,
          getTranscript,
          sessionToken,
          isCurrentRealtimeSessionToken,
          { backendPartial: partialState, backendResetRequired: realtimeStream.status.resetRequired },
        )
        if (!isCurrentRealtimeSessionToken(sessionToken) || !isCurrentLiveRecordingSession(sessionId, completedMeetingId, liveRecordingSessionIdRef.current, liveMeetingIdRef.current)) {
          return
        }
        setHydratedLiveTranscriptSegments(hydratedSegments)
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
      <main style={{ maxWidth: 480, margin: '40px auto', fontFamily: 'Segoe UI, sans-serif', padding: 16 }}>
        <h1>AudioMind Login</h1>
        <p>Đăng nhập để sử dụng API thật.</p>
        <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
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
        {authError && <p style={{ color: 'crimson', marginTop: 12 }}>{authError}</p>}
      </main>
    )
  }

  return (
    <main style={{ maxWidth: 920, margin: '40px auto', fontFamily: 'Segoe UI, sans-serif', padding: 16 }}>
      <h1>AudioMind Production Flow</h1>
      <p>Flow: upload - processing - transcript - summary</p>
      <button type="button" onClick={handleLogout} style={{ marginBottom: 16 }}>
        Đăng xuất
      </button>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button
          type="button"
          onClick={() => setViewMode('batch')}
          style={{
            padding: '10px 14px',
            borderRadius: 999,
            border: '1px solid #cbd5e1',
            background: viewMode === 'batch' ? '#0f172a' : '#f8fafc',
            color: viewMode === 'batch' ? '#f8fafc' : '#0f172a',
            fontWeight: 600,
          }}
        >
          Upload File
        </button>
        {isRealtimeEnabled && (
          <button
            type="button"
            onClick={() => setViewMode('realtime')}
            style={{
              padding: '10px 14px',
              borderRadius: 999,
              border: '1px solid #cbd5e1',
              background: viewMode === 'realtime' ? '#0f172a' : '#f8fafc',
              color: viewMode === 'realtime' ? '#f8fafc' : '#0f172a',
              fontWeight: 600,
            }}
          >
            Ghi âm Trực tiếp
          </button>
        )}
      </div>

      {viewMode === 'batch' && (
        <>
          <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
            <input
              type="file"
              accept="audio/*"
              data-testid="e2e-upload-input"
              onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
              disabled={busy}
            />
            <button data-testid="e2e-process-submit" onClick={handleProcess} disabled={busy || !selectedFile}>
              Phân tích file
            </button>
            {busy && (
              <button onClick={handleCancel}>
                Hủy xử lý
              </button>
            )}
          </div>

          <p data-testid="e2e-status"><strong>Status:</strong> {status}</p>

          {errorMessage && (
            <div className="error-banner" style={{
              padding: '12px 16px',
              background: '#fee2e2',
              color: '#991b1b',
              borderRadius: 8,
              marginTop: 12,
              marginBottom: 12,
            }}>
              {errorMessage}
            </div>
          )}

          {result && (
            <section style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16 }}>
              <p><strong>ID:</strong> {result.meetingId}</p>
              <p><strong>Status:</strong> {result.status}</p>
              <p data-testid="e2e-transcript"><strong>Transcript:</strong> {transcriptText}</p>
              <p data-testid="e2e-summary"><strong>Summary:</strong> {summaryText}</p>
            </section>
          )}
        </>
      )}

      {liveModeActive && (
        <section style={{ display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <h2 style={{ margin: 0 }}>Ghi âm trực tiếp</h2>
              <p style={{ margin: '6px 0 0', color: '#475569' }}>
                {liveStatusMessage || connectionView.detail || 'Sẵn sàng tạo meeting và bắt đầu ghi âm'}
              </p>
            </div>
            {liveMeetingId && (
              <span style={{ padding: '6px 10px', borderRadius: 999, background: '#e0e7ff', color: '#312e81' }}>
                Meeting #{liveMeetingId}
              </span>
            )}
          </div>

          <AudioRecorderButton
            recorder={audioRecorder}
            lifecycleState={liveLifecycleState}
            onBeforeStartRecording={handlePrepareLiveMeeting}
            onChunkReady={handleLiveChunkReady}
            onRecordingComplete={handleLiveRecordingComplete}
          />

          {liveError && (
            <div className="error-banner" style={{
              padding: '12px 16px',
              background: '#fee2e2',
              color: '#991b1b',
              borderRadius: 8,
            }}>
              {liveError}
            </div>
          )}
          {livePartialWarning && (
            <div style={{
              padding: '10px 14px',
              background: '#fef3c7',
              color: '#92400e',
              borderRadius: 8,
            }}>
              {livePartialWarning}
            </div>
          )}

          {showJoinOtherMeeting && (
            <div style={{ display: 'grid', gap: 8, padding: 12, borderRadius: 8, background: '#f8fafc' }}>
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
                style={{ justifySelf: 'start' }}
              >
                Join Meeting
              </button>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 16 }}>
            <RealtimeTranscript
              segments={liveTranscriptSegments}
              highlightKeywords={liveTranscriptKeywords}
              maxHeight="620px"
            />

            <aside style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
              <div style={{ padding: 12, borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b' }}>
                  Connection
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                  {connectionView.title}
                </div>
                <div style={{ marginTop: 6, color: '#475569' }}>
                  {connectionView.detail}
                </div>
                {connectionView.closeReason && (
                  <div style={{ marginTop: 6, color: connectionView.closeReasonIsError ? '#991b1b' : '#475569', fontSize: 13 }}>
                    Close reason: {connectionView.closeReason}
                  </div>
                )}
              </div>

              <div style={{ padding: 12, borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b' }}>
                  Keywords
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                  {realtimeStream.keywords.length}
                </div>
              </div>

              <div style={{ padding: 12, borderRadius: 12, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b' }}>
                  User
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                  {currentUserId || 'Unknown'}
                </div>
              </div>
            </aside>
          </div>
        </section>
      )}
    </main>
  )
}
