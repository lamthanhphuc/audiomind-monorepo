import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import StudioAuthPage from '../components/auth/StudioAuthPage'
import PublicLegalPage from '../components/legal/PublicLegalPage'
import { resolvePublicLegalKind, type PublicLegalKind } from '../utils/publicRoutes'
import DashboardLayout, { type DashboardScene } from '../components/dashboard/DashboardLayout'
import FeatureAnalysis from '../components/features/FeatureAnalysis'
import FeatureUpload from '../components/features/FeatureUpload'
import MeetingHistoryScene from '../components/features/MeetingHistoryScene'
import FeatureIntegrations from '../components/features/FeatureIntegrations'
import ExpansionDashboardScene from '../components/features/ExpansionDashboardScene'
import RealtimeDashboardScene from '../components/features/RealtimeDashboardScene'
import { LoadingState } from '../components/ui/LoadingState'
import { QuotaWarningBanner } from '../components/ui/QuotaWarningBanner'

const BillingScene = lazy(() => import('../components/features/BillingScene'))
const FeatureMindmap = lazy(() => import('../components/features/FeatureMindmap'))
const KnowledgeVaultScene = lazy(() => import('../components/features/KnowledgeVaultScene'))
import { useAudioRecorder, type AudioRecorderState } from '../hooks/useAudioRecorder'
import { useDualAudioRecorder, type DualTabMicStreamId } from '../hooks/useDualAudioRecorder'
import {
    DEFAULT_REALTIME_LANGUAGE,
    DEFAULT_REALTIME_SPEAKER_MODE,
    normalizeRealtimeLanguage,
    normalizeRealtimeSpeakerMode,
    useRealtimeMeetingStream,
    type RealtimeLanguage,
    type RealtimeSessionToken,
    type RealtimeSpeakerMode,
    type RealtimeStatusEvent,
    type TranscriptSegment,
    type RealtimeAudioStreamId,
} from '../hooks/useRealtimeMeetingStream'
import {
    DEFAULT_VAD_RESUMED_LABEL_MS,
    DEFAULT_VAD_RESUME_DURATION_MS,
    DEFAULT_VAD_SAMPLE_INTERVAL_MS,
    DEFAULT_VAD_SILENCE_DURATION_MS,
    DEFAULT_VAD_SILENCE_THRESHOLD,
    DEFAULT_VAD_SPEECH_THRESHOLD,
    normalizeMicSensitivityMode,
    useVoiceActivityDetection,
    type MicSensitivityMode,
    type VoiceActivityState,
} from '../hooks/useVoiceActivityDetection'
import { useQuotaOverview } from '../hooks/useQuotaOverview'
import {
    BROWSER_TAB_CAPTURE_TELEMETRY,
    DEFAULT_RECORDING_SOURCE,
    isBrowserTabRecordingSource,
    REALTIME_FOCUS_MEET_CAPTURE_KEY,
    REALTIME_MEET_CAPTURE_TITLE_KEY,
    RECORDING_SOURCE_ERRORS,
    getRecordingSourceTinyChunkError,
    type RealtimeMeetCaptureContext,
    type RecordingSource,
} from '../constants/recordingSource'
import { normalizeDomainMode, type DomainMode } from '../constants/domainMode'
import { isOnboardingDismissed, loadUserPreferences, saveUserPreferences, applyServerDomainMode } from '../utils/userPreferences'
import {
  applyParsedStudioRoute,
  buildStudioPath,
  parseStudioRouteFromLocation,
  pushStudioRoute,
  resolveStudioRedirectAfter,
  type ParsedStudioRoute,
} from '../utils/studioRouting'
import type { MeetingResultScope } from '../utils/meetingResultScope'
import { scopeCacheKey } from '../utils/meetingResultScope'
import {
  buildMindmapAnalysisRequestKey,
  canReuseMindmapSelectedScope,
  loadMindmapSavedAnalysis,
  shouldApplyMindmapLoadResult,
} from '../utils/mindmapAnalysisScope'
import {
  appendOpenMeetingQuery,
  applyPostAuthDestination,
  buildInviteGoogleRedirectAfter,
  readOpenMeetingId,
  resolvePostAuthDestination,
  resolveDestinationFromRedirectAfter,
} from '../utils/inviteAuth'
import { INVITE_ACCESS_NOTICE, probeInvitedMeetingAccess } from '../utils/inviteAccess'
import { returnToOAuthOpener, subscribeOAuthComplete } from '../utils/oauthCallbackHandoff'
import { ApiError, createRealtimeMeeting, getAnalysis, getProcessingStatus, getTranscript, getUserProfile, listMeetingsWithParams, reanalyzeMeetingAnalysis, startProcessingByPath, submitRealtimeFinalAudioFallback, updateUserPreferences, uploadToMeetingApi, type AnalysisScopeOptions } from '../services/api'
import { resolveBatchPipelineErrorCode, resolveErrorPresentation } from '../constants/errorCatalog'
import { ERROR_UX_ENABLED } from '../services/config'
import {
  isUserQuotaExceeded,
  resolveQuotaPresentation,
  type QuotaSignal,
  type UserPlan,
} from '../utils/quotaUx'
import { validateUploadFile } from '../hooks/useUpload'
import { getBundledUploadConfig } from '../services/configService'
import type { Meeting } from '../types'
import {
  clearAccessToken,
  exchangeGoogleLoginTicket,
  getAccessToken,
  getCurrentUserId,
  getGoogleLoginUrl,
  getJwtPlan,
  login,
  refreshAccessToken,
  register,
  setAccessToken,
} from '../services/auth'
import {
  getGoogleStatus,
  needsGoogleIntegrationGrant,
  redirectToFullGoogleLink,
} from '../services/googleIntegration'
import {
    REALTIME_DUAL_STREAM_TAB_MIC,
    REALTIME_MIC_SENSITIVITY,
    REALTIME_MIN_FALLBACK_AUDIO_BYTES,
    REALTIME_NOISE_SUPPRESSION_DEFAULT,
    REALTIME_NOISE_SUPPRESSION_TOGGLE_ENABLED,
    REALTIME_PREROLL_ENABLED,
    REALTIME_RECORDER_TIMESLICE_MS,
    REALTIME_RESUME_PREROLL_MS,
    REALTIME_START_PREROLL_MS,
    REALTIME_TINY_CHUNK_MAX_BYTES,
    REALTIME_TINY_CHUNK_MAX_RMS,
    REALTIME_TINY_CHUNK_MIN_RECORDING_SEC,
    REALTIME_TINY_CHUNK_STREAK_THRESHOLD,
    REALTIME_VAD_DYNAMIC_ENABLED,
    REALTIME_WS_ENABLED,
} from '../services/config'
import type { AiAnalysis } from '../types'
import {
    buildTranscriptEquivalenceSignature,
    mergeTranscriptSegments,
    mergeTranscriptSegmentsForDisplay,
    mergeHydratedTranscriptWithLive,
    normalizePersistedTranscriptSegments,
    sortTranscriptSegmentsByTimeline,
} from '../utils/transcript'

const resolveZoomCallbackMessage = (reason: string | null): string => {
  switch ((reason || '').toLowerCase()) {
    case 'provider_error':
      return 'Zoom từ chối yêu cầu. Hãy thử lại hoặc kiểm tra app OAuth trên Zoom Marketplace.'
    case 'missing_code':
      return 'Không nhận được mã xác thực từ Zoom. Hãy thử kết nối lại.'
    case 'zoom_account_already_linked':
      return 'Tài khoản Zoom này đã được liên kết với người dùng khác.'
    case 'zoom_oauth_not_configured':
      return 'Zoom chưa được cấu hình trên server. Liên hệ quản trị viên.'
    default:
      return 'Kết nối Zoom thất bại. Hãy thử lại.'
  }
}

const resolveTeamsCallbackMessage = (reason: string | null, kind: 'linked' | 'error'): string => {
  if (kind === 'linked') {
    return 'Đã kết nối Microsoft Teams thành công. Chọn cloud recording để import.'
  }
  switch ((reason || '').toLowerCase()) {
    case 'provider_error':
      return 'Microsoft từ chối yêu cầu. Hãy thử lại hoặc kiểm tra app Azure AD.'
    case 'missing_code':
      return 'Không nhận được mã xác thực từ Microsoft. Hãy thử kết nối lại.'
    case 'teams_account_already_linked':
      return 'Tài khoản Microsoft này đã được liên kết với người dùng khác.'
    case 'teams_oauth_not_configured':
      return 'Teams chưa được cấu hình trên server. Liên hệ quản trị viên.'
    default:
      return 'Kết nối Teams thất bại. Hãy thử lại.'
  }
}

export { DEFAULT_REALTIME_LANGUAGE } from '../hooks/useRealtimeMeetingStream'
export { getStatusBadgeClass } from '../utils/statusBadge'
export {
    buildTranscriptEquivalenceSignature,
    mergeHydratedTranscriptWithLive,
} from '../utils/transcript'

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
  | 'finalizing_recording'
  | 'finalizing_transcript'
  | 'transcript_ready'
  | 'analysis_pending'
  | 'analyzing'
  | 'analysis_completed'
  | 'analysis_failed'
  | 'no_transcript_after_finalize'
  | 'failed_audio_capture'
  | 'stopped_no_analysis'
  | 'stopped'
  | 'error'

export const isNoTranscriptTerminalLifecycle = (state: LiveLifecycleState): boolean => {
  return state === 'no_transcript_after_finalize' || state === 'stopped_no_analysis'
}

export const isFailedAudioCaptureLifecycle = (state: LiveLifecycleState): boolean => {
  return state === 'failed_audio_capture'
}

export const isRealtimeTerminalLifecycle = (state: LiveLifecycleState): boolean => {
  return isNoTranscriptTerminalLifecycle(state) || isFailedAudioCaptureLifecycle(state) || state === 'error'
}

type RealtimeConnectionView = {
  title: string
  detail: string
  closeReason: string | null
  closeReasonIsError: boolean
}

type AuthRoute = 'login' | 'register'

type GoogleCallbackState = 'idle' | 'processing' | 'linking'

const GOOGLE_LOGIN_ENABLED = import.meta.env.VITE_GOOGLE_LOGIN_ENABLED === 'true'
const PAYOS_ENABLED = import.meta.env.VITE_PAYOS_ENABLED === 'true'

const resolveAuthRouteFromLocation = (): AuthRoute => {
  if (typeof window !== 'undefined' && window.location.pathname === '/register') {
    return 'register'
  }
  return 'login'
}

const resolvePublicLegalKindFromLocation = (): PublicLegalKind | null => {
  if (typeof window === 'undefined') {
    return null
  }
  return resolvePublicLegalKind(window.location.pathname)
}

const resolveAuthPath = (route: AuthRoute): string => {
  return route === 'register' ? '/register' : '/'
}

const readInitialStudioRoute = (): ParsedStudioRoute => {
  if (typeof window === 'undefined') {
    return { scene: 'upload', meetingId: null }
  }
  return parseStudioRouteFromLocation() ?? { scene: 'upload', meetingId: null }
}

const resolveGoogleLoginError = (errorCode: string | null): string => {
  switch (errorCode) {
    case 'GOOGLE_EMAIL_CONFLICT':
      return 'Email này đã tồn tại. Hãy đăng nhập bằng mật khẩu rồi kết nối Google.'
    case 'GOOGLE_OAUTH_STATE_INVALID':
      return 'Phiên xác thực Google không hợp lệ. Vui lòng thử lại.'
    default:
      return 'Đăng nhập Google thất bại. Vui lòng thử lại.'
  }
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
  { value: 'single', label: 'Một người nói' },
  { value: 'multiple', label: 'Nhiều người nói' },
]

export const isRealtimeLanguageSelectorDisabled = (lifecycleState: LiveLifecycleState): boolean => {
  return (
    lifecycleState === 'connecting'
    || lifecycleState === 'recording'
    || lifecycleState === 'silent_paused'
    || lifecycleState === 'listening_resumed'
    || lifecycleState === 'stopping'
    || lifecycleState === 'finalizing_recording'
    || lifecycleState === 'finalizing_transcript'
  )
}

export const isRealtimeSpeakerModeSelectorDisabled = (lifecycleState: LiveLifecycleState): boolean => {
  return isRealtimeLanguageSelectorDisabled(lifecycleState)
}

export const isRecordingSourceSelectorDisabled = (lifecycleState: LiveLifecycleState): boolean => {
  return isRealtimeLanguageSelectorDisabled(lifecycleState)
}

export const getRealtimeConnectionView = (
  lifecycleState: LiveLifecycleState,
  realtimeState: string,
  realtimeMessage: string | undefined,
  isConnected: boolean,
  closeReason: string,
): RealtimeConnectionView => {
  if (isNoTranscriptTerminalLifecycle(lifecycleState)) {
    return {
      title: 'Chưa có transcript',
      detail: 'Không có nội dung để phân tích',
      closeReason: null,
      closeReasonIsError: false,
    }
  }

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
const STREAM_STOP_DISCONNECT_FALLBACK_DELAY_MS = 500
const LIVE_STATUS_LISTENING = 'Đang lắng nghe...'
const LIVE_STATUS_PAUSED = 'Paused while silent — speak to continue'
const LIVE_STATUS_RESUMED = 'Resumed — continuing to listen...'

const buildHydrationStabilitySignature = buildTranscriptEquivalenceSignature

export const resolveTranscriptPartialState = (input: {
  stopIncomplete: boolean
  resetRequired?: boolean
  statusMessage?: string | null
}): boolean => {
  return Boolean(
    input.stopIncomplete
    || input.resetRequired
    || input.statusMessage?.includes('chưa đầy đủ'),
  )
}

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

  if (
    liveLifecycleState === 'stopping'
    || liveLifecycleState === 'stopped'
    || liveLifecycleState === 'no_transcript_after_finalize'
    || liveLifecycleState === 'stopped_no_analysis'
    || liveLifecycleState === 'error'
  ) {
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
      const errorMessage = status.error || 'Processing failed'
      const pipelineErrorCode = resolveBatchPipelineErrorCode(errorMessage)
      if (pipelineErrorCode === 'QUOTA_EXCEEDED') {
        throw new ApiError(errorMessage, 402, undefined, 'QUOTA_EXCEEDED')
      }
      if (pipelineErrorCode) {
        throw new ApiError(errorMessage, 500, undefined, pipelineErrorCode)
      }
      throw new Error(errorMessage)
    }

    if (i < maxAttempts - 1) {
      await waitWithSignal(delayMs, signal)
      delayMs = Math.min(Math.floor(delayMs * 1.35), 8000)
    }
  }

  throw new Error('Processing timeout exceeded')
}

const REALTIME_ANALYSIS_POLL_INTERVAL_MS = 2000
const REALTIME_ANALYSIS_POLL_MAX_ATTEMPTS = 45

type LiveAnalysisStatus = 'idle' | 'polling' | 'completed' | 'pending' | 'failed'

type RealtimeAnalysisPollResult = {
  status: 'completed' | 'pending' | 'failed'
  analysis: AiAnalysis | null
  metadata: AiAnalysis | null
  reason?: string
}

type RealtimeAnalysisPollOptions = {
  sessionToken?: RealtimeSessionToken | null
  isSessionActive?: (token: RealtimeSessionToken | null) => boolean
  analysisPollRunId?: number
  analysisScope?: Pick<AnalysisScopeOptions, 'recordingSessionId' | 'attemptId'>
}

type RealtimeAnalysisPollScopeResolution = {
  scope?: Pick<AnalysisScopeOptions, 'recordingSessionId' | 'attemptId'>
  reason?: 'missing_session_token' | 'stale_session_token' | 'partial_scope' | 'scope_mismatch'
}

export const resolveRealtimeAnalysisPollScope = (
  meetingId: number,
  options: RealtimeAnalysisPollOptions,
): RealtimeAnalysisPollScopeResolution => {
  if (options.sessionToken == null) {
    return { reason: 'missing_session_token' }
  }
  if (options.sessionToken.meetingId !== meetingId) {
    return { reason: 'stale_session_token' }
  }
  if (
    options.analysisScope?.recordingSessionId != null
    && options.analysisScope?.attemptId != null
  ) {
    if (
      options.analysisScope.recordingSessionId !== options.sessionToken.recordingSessionId
      || options.analysisScope.attemptId !== options.sessionToken.attemptId
    ) {
      return { reason: 'scope_mismatch' }
    }
    return {
      scope: {
        recordingSessionId: options.analysisScope.recordingSessionId,
        attemptId: options.analysisScope.attemptId,
      },
    }
  }
  if (options.analysisScope?.recordingSessionId != null || options.analysisScope?.attemptId != null) {
    return { reason: 'partial_scope' }
  }
  if (
    options.sessionToken.recordingSessionId != null
    && options.sessionToken.attemptId != null
  ) {
    return {
      scope: {
        recordingSessionId: options.sessionToken.recordingSessionId,
        attemptId: options.sessionToken.attemptId,
      },
    }
  }
  return { reason: 'partial_scope' }
}

type HydrationOptions = {
  backendPartial?: boolean
  backendResetRequired?: boolean
  currentLiveSegments?: TranscriptSegment[]
  hydrationRunId?: number
  isHydrationRunActive?: (hydrationRunId: number) => boolean
}

const isTranscriptNotReadyPayload = (value: {
  status?: unknown
  errorCode?: unknown
  transcriptNotReady?: unknown
} | null | undefined): boolean => {
  if (!value) {
    return false
  }
  return value.transcriptNotReady === true
    || String(value.status ?? '').toUpperCase() === 'NOT_READY'
    || String(value.errorCode ?? '').toUpperCase() === 'TRANSCRIPT_NOT_READY'
}

const buildLiveAnalysisMetadata = (
  meetingId: number,
  status: string,
  overrides: Partial<AiAnalysis> = {},
): AiAnalysis => ({
  meetingId,
  meeting_id: meetingId,
  status,
  analysisStatus: status,
  summary: '',
  keywords: [],
  technicalTerms: [],
  painPoints: [],
  actionItems: [],
  domainMode: 'it',
  ...overrides,
})

const hasStructuredAnalysisData = (analysis: AiAnalysis | null): boolean => {
  if (!analysis) {
    return false
  }
  return Boolean(
    analysis.summary?.trim()
    || analysis.meetingSummary?.trim()
    || (analysis.keywords?.length ?? 0) > 0
    || (analysis.technicalTerms?.length ?? 0) > 0
    || (analysis.painPoints?.length ?? 0) > 0
    || (analysis.actionItems?.length ?? 0) > 0
    || (analysis.businessActionItems?.length ?? 0) > 0
  )
}

const getAnalysisStatusValue = (analysis: AiAnalysis | null): string => {
  return String(analysis?.analysisStatus ?? analysis?.status ?? '').trim().toUpperCase()
}

const isFailedAnalysisStatus = (status: string): boolean => {
  return status === 'FAILED'
    || status === 'ANALYSIS_FAILED_RETRYABLE'
    || status === 'RATE_LIMITED'
    || status === 'QUOTA_BLOCKED'
}

const isPendingAnalysisStatus = (status: string): boolean => {
  return status === 'ANALYZING'
    || status === 'RUNNING'
    || status === 'QUEUED'
    || status === 'PENDING'
    || status === 'SKIPPED'
}

const getRealtimeAnalysisFailureMessage = (metadata: AiAnalysis | null, fallback?: string): string => {
  const retryAfter = metadata?.retryAfterSeconds
  const errorCode = metadata?.errorCode
  const errorMessage = metadata?.errorMessage
  const analysisStatus = getAnalysisStatusValue(metadata)
  const isRetryable = metadata?.retryable === true
    || String(metadata?.analysisStatus ?? metadata?.status ?? '').trim().toUpperCase() === 'ANALYSIS_FAILED_RETRYABLE'

  if (isUserQuotaExceeded({ errorCode, analysisStatus, fallbackMessage: errorMessage ?? undefined })) {
    const plan = (getJwtPlan() || 'FREE') as UserPlan
    return resolveQuotaPresentation(
      { errorCode, analysisStatus, fallbackMessage: errorMessage ?? undefined },
      plan,
      ERROR_UX_ENABLED,
    ).message
  }

  if (isRetryable) {
    const retrySuffix = retryAfter && retryAfter > 0 ? ` Thử lại sau ${retryAfter}s.` : ''
    if (metadata?.transcriptSaved) {
      return `Transcript đã lưu. Phân tích AI tạm thời chưa sẵn sàng (${errorCode || 'temporary'}).${retrySuffix}`
    }
    return `Phân tích AI tạm thời chưa sẵn sàng (${errorCode || 'temporary'}).${retrySuffix}`
  }

  const details = [errorCode, errorMessage].filter(Boolean).join(': ')
  const retrySuffix = retryAfter && retryAfter > 0 ? ` Retry after ${retryAfter}s.` : ''
  return `${fallback || 'Analysis failed temporarily. Retry available.'}${details ? ` ${details}.` : ''}${retrySuffix}`
}

const metadataFromAnalysisError = (meetingId: number, error: ApiError): AiAnalysis => {
  if (error.status === 402 || error.errorCode === 'QUOTA_EXCEEDED') {
    const plan = (getJwtPlan() || 'FREE') as UserPlan
    const presentation = resolveQuotaPresentation(
      {
        httpStatus: error.status,
        errorCode: error.errorCode,
        fallbackMessage: error.message,
      },
      plan,
      ERROR_UX_ENABLED,
    )
    return buildLiveAnalysisMetadata(meetingId, 'QUOTA_BLOCKED', {
      errorCode: 'QUOTA_EXCEEDED',
      errorMessage: presentation.message,
      retryable: false,
      transcriptSaved: true,
    })
  }

  const errorCode = error.errorCode
    ?? (error.status === 429
      ? 'GEMINI_RATE_LIMITED'
      : error.status >= 500
        ? 'GEMINI_UNAVAILABLE'
        : undefined)
  const retryable = error.status === 429 || error.status === 503 || error.errorCode === 'CIRCUIT_OPEN' || error.errorCode === 'GEMINI_UNAVAILABLE'
  const status = error.status === 429
    ? 'RATE_LIMITED'
    : retryable
      ? 'ANALYSIS_FAILED_RETRYABLE'
      : 'FAILED'
  return buildLiveAnalysisMetadata(meetingId, status, {
    errorCode,
    errorMessage: error.message,
    retryAfterSeconds: error.retryAfterSeconds,
    retryable,
    transcriptSaved: true,
  })
}

export const pollRealtimeAnalysisAfterStop = async (
  meetingId: number,
  signal: AbortSignal,
  fetchAnalysis: typeof getAnalysis = getAnalysis,
  maxAttempts = REALTIME_ANALYSIS_POLL_MAX_ATTEMPTS,
  options: RealtimeAnalysisPollOptions = {},
): Promise<RealtimeAnalysisPollResult> => {
  let latestMetadata: AiAnalysis | null = null
  let latestRetryableError: ApiError | null = null
  const isPollingActive = () => {
    if (options.sessionToken === undefined || options.isSessionActive === undefined) {
      return true
    }

    return options.isSessionActive(options.sessionToken)
  }

  const pollScopeResolution = resolveRealtimeAnalysisPollScope(meetingId, options)
  const pollScope = pollScopeResolution.scope
  if (!pollScope) {
    console.warn('[Realtime] ANALYSIS_SCOPE_UNAVAILABLE', {
      meetingId,
      analysisPollRunId: options.analysisPollRunId,
      reason: pollScopeResolution.reason,
    })
    return {
      status: 'pending',
      analysis: null,
      metadata: buildLiveAnalysisMetadata(meetingId, 'ANALYSIS_SCOPE_UNAVAILABLE', {
        errorCode: 'ANALYSIS_SCOPE_UNAVAILABLE',
      }),
      reason: 'analysis_scope_unavailable',
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal.aborted) {
      throw new DOMException('Polling aborted', 'AbortError')
    }
    if (!isPollingActive()) {
      console.info('[Realtime] STALE_ANALYSIS_POLL_IGNORED', {
        meetingId,
        attempt,
        analysisPollRunId: options.analysisPollRunId,
        phase: 'before-fetch',
      })
      return {
        status: 'pending',
        analysis: null,
        metadata: latestMetadata ?? buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS'),
        reason: 'stale_session',
      }
    }

    try {
      const analysis = await fetchAnalysis(meetingId, { ...pollScope, signal })
      if (!isPollingActive()) {
        console.info('[Realtime] STALE_ANALYSIS_POLL_IGNORED', {
          meetingId,
          attempt,
          analysisPollRunId: options.analysisPollRunId,
          phase: 'post-fetch',
        })
        return {
          status: 'pending',
          analysis: null,
          metadata: latestMetadata ?? buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS'),
          reason: 'stale_session',
        }
      }
      latestMetadata = analysis
      const analysisStatus = getAnalysisStatusValue(analysis)

      if (analysis?.errorCode === 'NO_TRANSCRIPT_AFTER_FINALIZE' || analysisStatus === 'NO_TRANSCRIPT_AFTER_FINALIZE') {
        return {
          status: 'pending',
          analysis: null,
          metadata: buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS', {
            errorCode: 'NO_TRANSCRIPT_AFTER_FINALIZE',
            transcriptRows: 0,
          }),
          reason: 'no_transcript_after_finalize',
        }
      }

      if (isFailedAnalysisStatus(analysisStatus)) {
        return {
          status: 'failed',
          analysis: null,
          metadata: analysis,
          reason: getRealtimeAnalysisFailureMessage(analysis),
        }
      }

      if (hasStructuredAnalysisData(analysis)) {
        return { status: 'completed', analysis, metadata: analysis }
      }

      if (analysisStatus === 'NO_ANALYSIS' || analysisStatus === 'NOT_FOUND' || isPendingAnalysisStatus(analysisStatus)) {
        latestMetadata = analysis
      }
    } catch (error: any) {
      if (error instanceof ApiError && error.status === 404) {
        latestMetadata = buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS')
      } else if (error instanceof ApiError && error.status >= 500) {
        latestRetryableError = error
        latestMetadata = metadataFromAnalysisError(meetingId, error)
      } else {
        const metadata = error instanceof ApiError
          ? metadataFromAnalysisError(meetingId, error)
          : buildLiveAnalysisMetadata(meetingId, 'FAILED', {
            errorMessage: error instanceof Error ? error.message : 'Unable to load realtime analysis',
          })
        return {
          status: 'failed',
          analysis: null,
          metadata,
          reason: getRealtimeAnalysisFailureMessage(metadata, error instanceof Error ? error.message : undefined),
        }
      }
    }

    if (attempt < maxAttempts) {
      await waitWithSignal(REALTIME_ANALYSIS_POLL_INTERVAL_MS, signal)
      if (!isPollingActive()) {
        console.info('[Realtime] STALE_ANALYSIS_POLL_IGNORED', {
          meetingId,
          attempt,
          analysisPollRunId: options.analysisPollRunId,
          phase: 'after-wait',
        })
        return {
          status: 'pending',
          analysis: null,
          metadata: latestMetadata ?? buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS'),
          reason: 'stale_session',
        }
      }
    }
  }

  if (latestRetryableError) {
    const metadata = latestMetadata ?? metadataFromAnalysisError(meetingId, latestRetryableError)
    return {
      status: 'failed',
      analysis: null,
      metadata,
      reason: getRealtimeAnalysisFailureMessage(metadata),
    }
  }

  return {
    status: 'pending',
    analysis: null,
    metadata: latestMetadata ?? buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS'),
    reason: 'analysis_timeout',
  }
}

export const hydrateLiveTranscriptSegments = async (
  meetingId: number,
  fetchTranscript: typeof getTranscript = getTranscript,
  sessionToken: RealtimeSessionToken | null = null,
  isSessionActive: ((token: RealtimeSessionToken | null) => boolean) | null = null,
  options: HydrationOptions = {},
): Promise<TranscriptSegment[]> => {
  console.info('[Realtime] Post-stop transcript hydration started', { meetingId, hydrationRunId: options.hydrationRunId })

  const isHydrationActive = () => {
    if (sessionToken === null || isSessionActive === null) {
      return options.hydrationRunId === undefined
        || options.isHydrationRunActive === undefined
        || options.isHydrationRunActive(options.hydrationRunId)
    }

    const sessionIsActive = isSessionActive(sessionToken)
    const runIsActive = options.hydrationRunId === undefined
      || options.isHydrationRunActive === undefined
      || options.isHydrationRunActive(options.hydrationRunId)
    return sessionIsActive && runIsActive
  }

  if (!isHydrationActive()) {
    console.info('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, hydrationRunId: options.hydrationRunId, phase: 'before-wait' })
    return []
  }

  await new Promise((resolve) => setTimeout(resolve, HYDRATION_INITIAL_DELAY_MS))

  if (!isHydrationActive()) {
    console.info('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, hydrationRunId: options.hydrationRunId, phase: 'after-initial-wait' })
    return []
  }

  let stableCount = 0
  let previousSignature = ''
  let firstFragmentsAttempt: number | null = null
  let hasObservedFragments = false
  const forceStableHydration = Boolean(options.backendPartial || options.backendResetRequired)

  for (let attempt = 1; attempt <= HYDRATION_MAX_ATTEMPTS; attempt += 1) {
    if (!isHydrationActive()) {
      console.info('[Realtime] STALE_HYDRATION_IGNORED', {
        meetingId,
        attempt,
        hydrationRunId: options.hydrationRunId,
        phase: 'before-fetch',
      })
      return []
    }

    let transcript
    try {
      transcript = sessionToken
        ? await fetchTranscript(meetingId, {
            recordingSessionId: sessionToken.recordingSessionId,
            attemptId: sessionToken.attemptId,
          })
        : await fetchTranscript(meetingId)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        if (!isHydrationActive()) {
          console.info('[Realtime] STALE_HYDRATION_IGNORED', {
            meetingId,
            attempt,
            hydrationRunId: options.hydrationRunId,
            phase: 'fetch-404',
          })
          return []
        }

        console.info('[Realtime] HYDRATION_NO_FRAGMENTS_RETRY', {
          meetingId,
          attempt,
          reason: 'transcript_404',
        })

        if (attempt < HYDRATION_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, HYDRATION_RETRY_DELAY_MS))

          if (!isHydrationActive()) {
            console.info('[Realtime] STALE_HYDRATION_IGNORED', {
              meetingId,
              attempt,
              hydrationRunId: options.hydrationRunId,
              phase: 'transcript-404-retry-wait',
            })
            return []
          }

          continue
        }

        break
      }
      if (!isHydrationActive()) {
        console.info('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, attempt, hydrationRunId: options.hydrationRunId, phase: 'fetch-error' })
        return []
      }

      throw error
    }

    if (!isHydrationActive()) {
      console.info('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, attempt, hydrationRunId: options.hydrationRunId, phase: 'post-fetch' })
      return []
    }

    if (isTranscriptNotReadyPayload(transcript)) {
      console.info('[Realtime] HYDRATION_NO_FRAGMENTS_RETRY', {
        meetingId,
        attempt,
        reason: 'transcript_not_ready',
      })

      if (attempt < HYDRATION_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, HYDRATION_RETRY_DELAY_MS))

        if (!isHydrationActive()) {
          console.info('[Realtime] STALE_HYDRATION_IGNORED', {
            meetingId,
            attempt,
            hydrationRunId: options.hydrationRunId,
            phase: 'transcript-not-ready-retry-wait',
          })
          return []
        }

        continue
      }
    }

    const hydratedSegments = sortTranscriptSegmentsByTimeline(
      mergeTranscriptSegments(
        normalizePersistedTranscriptSegments(transcript.transcripts || [], { fallbackSpeaker: 'SPEAKER_1' }),
      ),
    )

    console.info('[Realtime] Post-stop transcript hydration attempt', {
      meetingId,
      attempt,
      fragments: hydratedSegments.length,
    })

    const hydrationSignature = buildHydrationStabilitySignature(hydratedSegments)
    if (hydrationSignature === previousSignature) {
      stableCount += 1
    } else {
      stableCount = 0
      previousSignature = hydrationSignature
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
        console.info('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, attempt, hydrationRunId: options.hydrationRunId, phase: 'retry-wait' })
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

export const resolveFreshRealtimeMeetingId = (meeting: { id?: unknown; existingMeetingId?: unknown; duplicate?: unknown }): number => {
  const normalizedMeetingId = Number(meeting.id)
  if (!Number.isFinite(normalizedMeetingId) || normalizedMeetingId <= 0) {
    throw new Error('Meeting ID returned from realtime create is invalid')
  }
  if (meeting.duplicate || meeting.existingMeetingId != null) {
    throw new Error('Realtime meeting creation returned a reused meeting')
  }
  return normalizedMeetingId
}

export type LiveRecordingStopSequenceResult = {
  stopSent: boolean
  stopIncomplete: boolean
}

export type LiveRecordingStopSequenceInput = {
  meetingId: number | null
  sessionId: number
  source?: string
  stopStream?: () => Promise<boolean>
  setLifecycleState: (state: LiveLifecycleState) => void
}

export async function runLiveRecordingStopSequence(
  input: LiveRecordingStopSequenceInput,
): Promise<LiveRecordingStopSequenceResult> {
  console.info('[Realtime] REALTIME_STOP_REQUESTED', {
    meetingId: input.meetingId,
    sessionId: input.sessionId,
    ...(input.source ? { source: input.source } : {}),
    phase: 'stream_finalize',
  })
  input.setLifecycleState('stopping')

  let stopSent = false
  if (input.stopStream) {
    stopSent = await input.stopStream()
  }

  input.setLifecycleState('finalizing_transcript')

  return {
    stopSent,
    stopIncomplete: !stopSent,
  }
}

export const beginGracefulStopLifecycle = (
  setLifecycleState: (state: LiveLifecycleState) => void,
  scheduleDeferred: (callback: () => void) => number | void = (callback) => window.setTimeout(callback, 0),
): void => {
  setLifecycleState('stopping')
  scheduleDeferred(() => setLifecycleState('finalizing_recording'))
}

export type RealtimeFinalAudioFallbackInput = {
  mergedTranscriptCount: number
  fullAudioBytes: number
  minFallbackAudioBytes: number
  stopIncomplete: boolean
  partialState: boolean
  resetRequired: boolean
  streamState: RealtimeStatusEvent['state']
}

export const shouldAttemptRealtimeFinalAudioFallback = (
  input: RealtimeFinalAudioFallbackInput,
): boolean => {
  return input.mergedTranscriptCount === 0
    && input.fullAudioBytes >= input.minFallbackAudioBytes
    && (
      input.stopIncomplete
      || input.partialState
      || input.resetRequired
      || input.streamState === 'error'
    )
}

export const buildFinalAudioBlobReadyLogPayload = (
  meetingId: number | null,
  bytes: number,
): { meetingId: number | null; bytes: number } => ({
  meetingId,
  bytes,
})

const RECENT_MEETINGS_LIMIT = 8

const getMeetingLabel = (meeting: Pick<Meeting, 'id' | 'title' | 'originalFileName'>): string => {
  return meeting.title?.trim() || meeting.originalFileName?.trim() || `Meeting #${meeting.id}`
}

export default function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [selectedUploadLanguage, setSelectedUploadLanguage] = useState<'vi' | 'en' | 'multi'>('vi')
  const [selectedDomainMode, setSelectedDomainMode] = useState<DomainMode>(() => loadUserPreferences().domainMode)
  const [showOnboarding, setShowOnboarding] = useState(() => !isOnboardingDismissed())
  const handleDomainModeChange = useCallback((mode: DomainMode) => {
    const normalized = normalizeDomainMode(mode)
    setSelectedDomainMode(normalized)
    saveUserPreferences({ domainMode: normalized })
    void updateUserPreferences(normalized).catch(() => {
      // Local preference still applies when offline or unauthenticated.
    })
  }, [])
  const syncUserPreferencesFromServer = useCallback(async () => {
    try {
      const profile = await getUserProfile()
      const normalized = applyServerDomainMode(profile.domainMode)
      if (normalized) {
        setSelectedDomainMode(normalized)
      }
    } catch {
      // Keep local preferences when profile fetch fails.
    }
  }, [])
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [uploadErrorCode, setUploadErrorCode] = useState<string | null>(null)
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState<ResultView | null>(null)
  const [uploadNotice, setUploadNotice] = useState<string | null>(null)
  const [zoomIntegrationNotice, setZoomIntegrationNotice] = useState<string | null>(null)
  const [zoomIntegrationNoticeTone, setZoomIntegrationNoticeTone] = useState<'success' | 'error' | 'info'>('info')
  const [teamsIntegrationNotice, setTeamsIntegrationNotice] = useState<string | null>(null)
  const [teamsIntegrationNoticeTone, setTeamsIntegrationNoticeTone] = useState<'success' | 'error' | 'info'>('info')
  const [historyFocusMeetingId, setHistoryFocusMeetingId] = useState<number | null>(null)
  const [liveMeetingId, setLiveMeetingId] = useState<number | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [liveErrorCode, setLiveErrorCode] = useState<string | null>(null)
  const [livePartialWarning, setLivePartialWarning] = useState<string | null>(null)
  const [liveStatusMessage, setLiveStatusMessage] = useState<string | null>(null)
  const [liveAnalysis, setLiveAnalysis] = useState<AiAnalysis | null>(null)
  const [liveAnalysisMetadata, setLiveAnalysisMetadata] = useState<AiAnalysis | null>(null)
  const [liveAnalysisStatus, setLiveAnalysisStatus] = useState<LiveAnalysisStatus>('idle')
  const [liveAnalysisError, setLiveAnalysisError] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [authNotice, setAuthNotice] = useState('')
  const [authRoute, setAuthRoute] = useState<AuthRoute>(resolveAuthRouteFromLocation)
  const [publicLegalKind, setPublicLegalKind] = useState<PublicLegalKind | null>(
    resolvePublicLegalKindFromLocation,
  )
  const [googleCallbackState, setGoogleCallbackState] = useState<GoogleCallbackState>(() =>
    window.location.pathname === '/auth/google/success' ? 'processing' : 'idle',
  )
  const [registerUsername, setRegisterUsername] = useState('')
  const [registerEmail, setRegisterEmail] = useState('')
  const [registerPassword, setRegisterPassword] = useState('')
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState('')
  const [registerError, setRegisterError] = useState('')
  const [registerBusy, setRegisterBusy] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [sessionPlanSyncTick, setSessionPlanSyncTick] = useState(0)
  const initialStudioRoute = readInitialStudioRoute()
  const [featureScene, setFeatureScene] = useState<DashboardScene>(initialStudioRoute.scene)
  const [globalMeetingSearch, setGlobalMeetingSearch] = useState('')
  const [googleIntegrationNotice, setGoogleIntegrationNotice] = useState<string | null>(null)
  const [oauthRefreshTick, setOauthRefreshTick] = useState(0)
  const [billingPaymentNotice, setBillingPaymentNotice] = useState<string | null>(null)
  const [billingActivationOrderCode, setBillingActivationOrderCode] = useState<number | null>(null)
  const [mindmapAnalysis, setMindmapAnalysis] = useState<AiAnalysis | null>(null)
  const [mindmapSelectedMeetingId, setMindmapSelectedMeetingId] = useState<number | null>(
    initialStudioRoute.scene === 'mindmap' ? initialStudioRoute.meetingId : null,
  )
  const [mindmapSelectedTitle, setMindmapSelectedTitle] = useState<string | null>(null)
  const mindmapAbortRef = useRef<AbortController | null>(null)
  const mindmapLoadRequestKeyRef = useRef<string | null>(null)
  const [historyAnalysisMeetingId, setHistoryAnalysisMeetingId] = useState<number | null>(
    initialStudioRoute.scene === 'analysis' ? initialStudioRoute.meetingId : null,
  )
  const [historyAnalysisScope, setHistoryAnalysisScope] = useState<MeetingResultScope | null>(
    initialStudioRoute.scene === 'analysis' ? initialStudioRoute.resultScope ?? null : null,
  )
  const [historyAnalysisTitle, setHistoryAnalysisTitle] = useState<string | null>(null)
  const [mindmapSelectedScope, setMindmapSelectedScope] = useState<MeetingResultScope | null>(
    initialStudioRoute.scene === 'mindmap' ? initialStudioRoute.resultScope ?? null : null,
  )
  const [mindmapDisplayScopeKey, setMindmapDisplayScopeKey] = useState<string | null>(null)
  const [recentMeetings, setRecentMeetings] = useState<Meeting[]>([])
  const [recentMeetingsReloadTick, setRecentMeetingsReloadTick] = useState(0)
  const [joinMeetingIdInput, setJoinMeetingIdInput] = useState('')
  const [showJoinOtherMeeting, setShowJoinOtherMeeting] = useState(false)
  const [hydratedLiveTranscriptSegments, setHydratedLiveTranscriptSegments] = useState<TranscriptSegment[] | null>(null)
  const [liveLifecycleState, setLiveLifecycleState] = useState<LiveLifecycleState>('idle')
  const [activeRealtimeSessionToken, setActiveRealtimeSessionToken] = useState<RealtimeSessionToken | null>(null)
  const [selectedRealtimeLanguage, setSelectedRealtimeLanguage] = useState<RealtimeLanguage>(DEFAULT_REALTIME_LANGUAGE)
  const [selectedRealtimeSpeakerMode, setSelectedRealtimeSpeakerMode] = useState<RealtimeSpeakerMode>(DEFAULT_REALTIME_SPEAKER_MODE)
  const [selectedMicSensitivity, setSelectedMicSensitivity] = useState<MicSensitivityMode>(
    normalizeMicSensitivityMode(REALTIME_MIC_SENSITIVITY),
  )
  const [selectedRecordingSource, setSelectedRecordingSource] = useState<RecordingSource>(DEFAULT_RECORDING_SOURCE)
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(REALTIME_NOISE_SUPPRESSION_DEFAULT)
  const [noiseSuppressionSupported] = useState(() => {
    return Boolean(navigator.mediaDevices?.getSupportedConstraints?.().noiseSuppression)
  })
  const abortControllerRef = useRef<AbortController | null>(null)
  const liveAnalysisAbortControllerRef = useRef<AbortController | null>(null)
  const liveMeetingIdRef = useRef<number | null>(null)
  const liveRecordingSessionIdRef = useRef(0)
  const activeRealtimeSessionTokenRef = useRef<RealtimeSessionToken | null>(null)
  const realtimeAttemptIdRef = useRef(0)
  const hydrationRunIdRef = useRef(0)
  const analysisPollRunIdRef = useRef(0)
  const resetRecoveryInProgressRef = useRef(false)
  const restartAfterReconnectRef = useRef(false)
  const liveTinyChunkStreakRef = useRef(0)
  const selectedRecordingSourceRef = useRef<RecordingSource>(DEFAULT_RECORDING_SOURCE)
  const tabTrackEndedFinalizeRef = useRef(false)
  const gracefulStopRef = useRef<(() => Promise<void>) | null>(null)
  const quotaBillingRedirectRef = useRef(false)
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
  const onTabAudioTrackEndedRef = useRef<(() => void) | undefined>(undefined)
  const onTabCaptureFailureRef = useRef<((message: string, reason: 'track' | 'stall') => void) | undefined>(undefined)
  const onTabPipelineStalledRef = useRef<(() => void) | undefined>(undefined)
  const recorderTimesliceMs = isBrowserTabRecordingSource(selectedRecordingSource)
    ? Math.min(REALTIME_RECORDER_TIMESLICE_MS, 120)
    : REALTIME_RECORDER_TIMESLICE_MS
  const dualStreamActive = REALTIME_DUAL_STREAM_TAB_MIC && selectedRecordingSource === 'browser_tab_with_mic'
  const singleAudioRecorder = useAudioRecorder(liveMeetingId, {
    noiseSuppressionEnabled,
    recordingSource: selectedRecordingSource,
    onTrackEnded: () => onTabAudioTrackEndedRef.current?.(),
    onCaptureError: (message) => onTabCaptureFailureRef.current?.(message, 'track'),
    onPipelineStalled: () => onTabPipelineStalledRef.current?.(),
    timesliceMs: recorderTimesliceMs,
    preRollWindowMs: REALTIME_PREROLL_ENABLED
      ? Math.max(REALTIME_START_PREROLL_MS, REALTIME_RESUME_PREROLL_MS)
      : 0,
  })
  const handleDualChunkReadyRef = useRef<(chunk: Blob, streamId: DualTabMicStreamId, sessionId: number) => void>(() => {})
  const dualAudioRecorder = useDualAudioRecorder({
    diagnosticMeetingId: liveMeetingId,
    timesliceMs: recorderTimesliceMs,
    onTrackEnded: () => onTabAudioTrackEndedRef.current?.(),
    onCaptureError: (message) => onTabCaptureFailureRef.current?.(message, 'track'),
    onPipelineStalled: () => onTabPipelineStalledRef.current?.(),
    onChunkReady: (chunk, streamId, sessionId) => {
      handleDualChunkReadyRef.current(chunk, streamId, sessionId)
    },
  })
  const audioRecorder = dualStreamActive ? dualAudioRecorder : singleAudioRecorder
  const voiceActivity = useVoiceActivityDetection({
    enabled: audioRecorder.state === 'recording' && selectedRecordingSource === 'microphone',
    getRmsLevel: audioRecorder.getCurrentRms,
    silenceThreshold: DEFAULT_VAD_SILENCE_THRESHOLD,
    speechThreshold: DEFAULT_VAD_SPEECH_THRESHOLD,
    silenceDurationMs: DEFAULT_VAD_SILENCE_DURATION_MS,
    resumeDurationMs: DEFAULT_VAD_RESUME_DURATION_MS,
    sampleIntervalMs: DEFAULT_VAD_SAMPLE_INTERVAL_MS,
    resumedLabelMs: DEFAULT_VAD_RESUMED_LABEL_MS,
    dynamicEnabled: REALTIME_VAD_DYNAMIC_ENABLED,
    sensitivityMode: selectedMicSensitivity,
  })
  const realtimeStream = useRealtimeMeetingStream({
    meetingId: liveMeetingId,
    userId: realtimeUserId,
    token: realtimeToken,
    sessionToken: activeRealtimeSessionToken,
    language: selectedRealtimeLanguage,
    speakerMode: selectedRealtimeSpeakerMode,
    domainMode: selectedDomainMode,
    enabled: isAuthenticated && isRealtimeEnabled && featureScene === 'realtime',
    autoReconnect: true,
    dualStream: dualStreamActive,
    activeStreams: dualStreamActive
      ? (audioRecorder.getActiveStreamIds?.() ?? ['tab'])
      : undefined,
  })

  useEffect(() => {
    selectedRecordingSourceRef.current = selectedRecordingSource
  }, [selectedRecordingSource])

  useEffect(() => {
    onTabAudioTrackEndedRef.current = () => {
      if (!isBrowserTabRecordingSource(selectedRecordingSourceRef.current)) {
        return
      }
      if (tabTrackEndedFinalizeRef.current) {
        return
      }
      tabTrackEndedFinalizeRef.current = true
      setLiveStatusMessage(RECORDING_SOURCE_ERRORS.tabStopSharing)
      console.info('[Realtime] REALTIME_STOP_REQUESTED', {
        meetingId: liveMeetingIdRef.current,
        source: selectedRecordingSourceRef.current,
        reason: 'tab_track_ended',
      })
      void gracefulStopRef.current?.()
    }
    onTabCaptureFailureRef.current = (message, reason) => {
      if (!isBrowserTabRecordingSource(selectedRecordingSourceRef.current)) {
        return
      }
      if (audioRecorder.state !== 'recording' && audioRecorder.state !== 'paused' && audioRecorder.state !== 'connecting') {
        return
      }
      console.warn('[Realtime] TAB_AUDIO_CAPTURE_FAILURE', {
        meetingId: liveMeetingIdRef.current,
        source: selectedRecordingSourceRef.current,
        reason,
        message,
      })
      setLiveError(message)
      setLiveLifecycleState('failed_audio_capture')
      setLiveStatusMessage('Lỗi thu âm tab')
      setLivePartialWarning(message)
      audioRecorder.abortRecording()
      const activeToken = activeRealtimeSessionTokenRef.current
      realtimeStream.clearQueuedAudio?.()
      if (activeToken) {
        realtimeStream.disconnect(activeToken)
      }
    }
    onTabPipelineStalledRef.current = () => {
      if (!isBrowserTabRecordingSource(selectedRecordingSourceRef.current)) {
        return
      }
      if (audioRecorder.state !== 'recording' && audioRecorder.state !== 'paused' && audioRecorder.state !== 'connecting') {
        return
      }
      console.warn('[Realtime] TAB_AUDIO_PIPELINE_DEGRADED', {
        meetingId: liveMeetingIdRef.current,
        source: selectedRecordingSourceRef.current,
        reason: 'output_mismatch',
      })
      setLivePartialWarning(RECORDING_SOURCE_ERRORS.tabCaptureStalled)
      setLiveStatusMessage(RECORDING_SOURCE_ERRORS.tabCaptureStalled)
    }
  }, [audioRecorder, realtimeStream])

  useEffect(() => {
    console.info('[Realtime] RECORDING_SOURCE_SELECTED', {
      source: selectedRecordingSource,
      lifecycleState: liveLifecycleState,
    })

  }, [liveLifecycleState, selectedRecordingSource])

  const handleRecordingSourceChange = useCallback((source: RecordingSource) => {
    const previous = selectedRecordingSourceRef.current
    setSelectedRecordingSource(source)
    if (isBrowserTabRecordingSource(source) && !isBrowserTabRecordingSource(previous)) {
      setSelectedRealtimeSpeakerMode('multiple')
    }
  }, [liveLifecycleState])

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

  useEffect(() => {
    console.info('[Realtime] MIC_SENSITIVITY_CHANGED', {
      mode: selectedMicSensitivity,
    })
  }, [selectedMicSensitivity])

  useEffect(() => {
    console.info('[Realtime] MIC_NOISE_SUPPRESSION_SELECTED', {
      mode: noiseSuppressionEnabled ? 'on' : 'off',
    })
  }, [noiseSuppressionEnabled])

  useEffect(() => {
    if (REALTIME_NOISE_SUPPRESSION_TOGGLE_ENABLED && !noiseSuppressionSupported) {
      console.info('[Realtime] MIC_CONSTRAINT_UNSUPPORTED', {
        constraint: 'noiseSuppression',
      })
    }
  }, [noiseSuppressionSupported])

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
    hydrationRunIdRef.current += 1
    analysisPollRunIdRef.current += 1
    activeRealtimeSessionTokenRef.current = token
    setActiveRealtimeSessionToken(token)
  }

  const isCurrentHydrationRun = (hydrationRunId: number): boolean => {
    return hydrationRunId === hydrationRunIdRef.current
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
      dualStream: dualStreamActive,
    })
    realtimeStream.clearQueuedAudio?.()
    audioRecorder.abortRecording()
    setLivePartialWarning('Transcript có thể chưa đầy đủ')

    void audioRecorder.startRecording()
      .then(() => {
        if (dualStreamActive && audioRecorder.getActiveStreamIds) {
          realtimeStream.configureDualStreams(audioRecorder.getActiveStreamIds())
        }
      })
      .catch((error) => {
      setLiveError(error instanceof Error ? error.message : 'Không thể khởi động lại ghi âm')
    })
  }, [audioRecorder, realtimeStream, realtimeStream.status.resetRequired])

  useEffect(() => {
    const noTranscriptStatus =
      realtimeStream.status.state === 'NO_TRANSCRIPT_AFTER_FINALIZE'
      || realtimeStream.status.errorCode === 'NO_TRANSCRIPT_AFTER_FINALIZE'
      || realtimeStream.status.errorCode === 'NO_TRANSCRIPT'
      || realtimeStream.status.status === 'NO_TRANSCRIPT'
    if (!noTranscriptStatus) {
      return
    }

    const meetingId = liveMeetingIdRef.current
    if (meetingId === null) {
      return
    }

    liveAnalysisAbortControllerRef.current?.abort()
    liveAnalysisAbortControllerRef.current = null
    analysisPollRunIdRef.current += 1
    setLiveLifecycleState('no_transcript_after_finalize')
    setLiveAnalysis(null)
    setLiveAnalysisMetadata(buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS', {
      errorCode: 'NO_TRANSCRIPT_AFTER_FINALIZE',
      transcriptRows: 0,
      finalized: true,
    }))
    setLiveAnalysisStatus('pending')
    setLiveAnalysisError(null)
    setLivePartialWarning('Chưa có transcript. Có thể do im lặng, mic tắt hoặc âm lượng quá thấp.')
    setLiveStatusMessage('Đã dừng ghi âm (chưa có transcript)')
  }, [realtimeStream.status.errorCode, realtimeStream.status.state, realtimeStream.status.status])

  useEffect(() => {
    const failedAudioCapture =
      realtimeStream.status.state === 'FAILED_AUDIO_CAPTURE'
      || realtimeStream.status.errorCode === 'FAILED_AUDIO_CAPTURE'
      || realtimeStream.status.status === 'FAILED_AUDIO_CAPTURE'
    if (!failedAudioCapture) {
      return
    }

    const meetingId = liveMeetingIdRef.current
    if (meetingId === null) {
      return
    }

    liveAnalysisAbortControllerRef.current?.abort()
    liveAnalysisAbortControllerRef.current = null
    analysisPollRunIdRef.current += 1
    setLiveLifecycleState('failed_audio_capture')
    setLiveAnalysis(null)
    setLiveAnalysisMetadata(buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS', {
      errorCode: 'FAILED_AUDIO_CAPTURE',
      transcriptRows: 0,
      finalized: true,
    }))
    setLiveAnalysisStatus('pending')
    setLiveAnalysisError(null)
    setLivePartialWarning('Không thu được audio hợp lệ. Kiểm tra quyền mic và thử ghi lại.')
    setLiveStatusMessage('Lỗi thu âm')
  }, [realtimeStream.status.errorCode, realtimeStream.status.state, realtimeStream.status.status])

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

    if (isBrowserTabRecordingSource(selectedRecordingSourceRef.current)) {
      restartAfterReconnectRef.current = false
      setLiveError('Mất kết nối realtime trong khi ghi âm tab. Hãy dừng và bắt đầu lại để chọn lại tab trình duyệt.')
      setLiveLifecycleState('error')
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
      setLiveLifecycleState('recording')
    }
  }, [liveLifecycleState, realtimeStream.isAuthenticated])

  useEffect(() => {
    if (audioRecorder.state === 'connecting') {
      setLiveLifecycleState('connecting')
      return
    }

    if (audioRecorder.state === 'recording') {
      if (
        liveLifecycleState === 'stopping'
        || liveLifecycleState === 'finalizing_transcript'
        || isNoTranscriptTerminalLifecycle(liveLifecycleState)
      ) {
        return
      }
      if (liveLifecycleState === 'connecting' && !realtimeStream.isAuthenticated) {
        return
      }
      setLiveLifecycleState('recording')
      return
    }

    if (audioRecorder.state === 'stopped') {
      if (
        liveLifecycleState === 'stopping'
        || liveLifecycleState === 'finalizing_transcript'
        || liveLifecycleState === 'transcript_ready'
        || liveLifecycleState === 'analysis_pending'
        || liveLifecycleState === 'analyzing'
        || liveLifecycleState === 'analysis_completed'
        || liveLifecycleState === 'analysis_failed'
        || isNoTranscriptTerminalLifecycle(liveLifecycleState)
      ) {
        return
      }
      setLiveLifecycleState('stopped')
      return
    }

    if (audioRecorder.state === 'error') {
      setLiveLifecycleState('error')
      return
    }
  }, [audioRecorder.state, liveLifecycleState, realtimeStream.isAuthenticated])

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
    let active = true
    const path = window.location.pathname

    if (path === '/billing/success') {
      const orderCode = Number(new URLSearchParams(window.location.search).get('orderCode') || 0)
      window.history.replaceState({}, '', buildStudioPath('billing'))
      setIsAuthenticated(Boolean(getAccessToken()))
      setFeatureScene('billing')
      setBillingActivationOrderCode(orderCode > 0 ? orderCode : null)
      if (orderCode <= 0) {
        setBillingPaymentNotice('Thanh toán PayOS thành công. Đang đồng bộ gói Pro…')
      }
      void refreshAccessToken().catch(() => {
        if (!active) return
        setBillingPaymentNotice('Thanh toán thành công. Gói đã cập nhật trên server — bấm "Đồng bộ JWT" nếu badge vẫn hiện Free.')
      })
    } else if (path === '/billing/cancel') {
      window.history.replaceState({}, '', buildStudioPath('billing'))
      setIsAuthenticated(Boolean(getAccessToken()))
      setFeatureScene('billing')
      setBillingPaymentNotice('Bạn đã hủy thanh toán. Bạn có thể thử lại bất cứ lúc nào.')
    } else if (path === '/settings/integrations/google/success') {
      const redirectAfter = new URLSearchParams(window.location.search).get('redirectAfter')
      const route = resolveStudioRedirectAfter(redirectAfter)
      const message = 'Đã kết nối Google và cập nhật quyền truy cập.'
      if (returnToOAuthOpener({
        provider: 'google',
        status: 'success',
        message,
        route,
        tone: 'success',
      })) {
        return () => {
          active = false
          abortControllerRef.current?.abort()
          liveAnalysisAbortControllerRef.current?.abort()
        }
      }
      window.history.replaceState({}, '', buildStudioPath(route.scene, { meetingId: route.meetingId }))
      setIsAuthenticated(Boolean(getAccessToken()))
      applyParsedStudioRoute(route, {
        setFeatureScene,
        setHistoryAnalysisMeetingId,
        setHistoryAnalysisScope,
        setMindmapSelectedMeetingId,
        setMindmapSelectedScope,
      })
      setGoogleIntegrationNotice(message)
      setOauthRefreshTick((tick) => tick + 1)
    } else if (path === '/settings/integrations/google/error') {
      const errorCode = new URLSearchParams(window.location.search).get('errorCode')
      const message = errorCode === 'GOOGLE_ACCOUNT_ALREADY_LINKED'
        ? 'Tài khoản Google này đã được liên kết với người dùng khác.'
        : 'Không thể kết nối Google. Vui lòng thử lại.'
      const route: ParsedStudioRoute = { scene: 'integrations', meetingId: null }
      if (returnToOAuthOpener({
        provider: 'google',
        status: 'error',
        message,
        route,
        tone: 'error',
      })) {
        return () => {
          active = false
          abortControllerRef.current?.abort()
          liveAnalysisAbortControllerRef.current?.abort()
        }
      }
      window.history.replaceState({}, '', buildStudioPath('integrations'))
      setIsAuthenticated(Boolean(getAccessToken()))
      setFeatureScene('integrations')
      setGoogleIntegrationNotice(message)
      setOauthRefreshTick((tick) => tick + 1)
    } else if (path === '/auth/google/success') {
      const ticket = new URLSearchParams(window.location.search).get('ticket')
      window.history.replaceState({}, '', '/auth/google/success')
      if (!ticket) {
        setGoogleCallbackState('idle')
        setAuthError('Phiên đăng nhập Google không hợp lệ. Vui lòng thử lại.')
        window.history.replaceState({}, '', '/')
      } else {
        void exchangeGoogleLoginTicket(ticket)
          .then(async (response) => {
            if (!active) return
            setAccessToken(response.token, response.expiresInSeconds)
            setIsAuthenticated(true)
            void syncUserPreferencesFromServer()
            const redirectAfter = response.redirectAfter?.startsWith('/') ? response.redirectAfter : '/studio/upload'
            const destination = resolveDestinationFromRedirectAfter(redirectAfter)
            const studioPath = destination.scene === 'analysis'
              ? buildStudioPath('analysis', { meetingId: destination.meetingId })
              : buildStudioPath('upload')

            if (destination.scene === 'analysis') {
              const accessController = new AbortController()
              const accessTimeout = window.setTimeout(() => accessController.abort(), 3000)
              try {
                const access = await probeInvitedMeetingAccess(destination.meetingId, {
                  signal: accessController.signal,
                })
                if (access === 'forbidden') {
                  setAuthNotice(INVITE_ACCESS_NOTICE)
                }
              } finally {
                window.clearTimeout(accessTimeout)
              }
            }

            try {
              const googleStatus = await getGoogleStatus()
              if (needsGoogleIntegrationGrant(googleStatus)) {
                setGoogleCallbackState('linking')
                await redirectToFullGoogleLink(studioPath)
                return
              }
            } catch {
              setGoogleIntegrationNotice('Không kiểm tra được quyền Google. Vào Tích hợp và bấm「Kết nối Calendar」trước khi tạo Meet.')
            }

            window.history.replaceState({}, '', studioPath)
            applyPostAuthDestination(destination, {
              setFeatureScene,
              setHistoryAnalysisMeetingId,
              setMindmapSelectedMeetingId,
            })
            setOauthRefreshTick((tick) => tick + 1)
            setGoogleCallbackState('idle')
          })
          .catch((error) => {
            if (!active) return
            setAuthError(error instanceof Error ? error.message : 'Đăng nhập Google thất bại')
            setGoogleCallbackState('idle')
            window.history.replaceState({}, '', '/')
          })
      }
    } else if (path === '/auth/google/error') {
      const errorCode = new URLSearchParams(window.location.search).get('errorCode')
      window.history.replaceState({}, '', '/')
      setAuthError(resolveGoogleLoginError(errorCode))
      setIsAuthenticated(false)
    } else {
      const hasToken = Boolean(getAccessToken())
      setIsAuthenticated(hasToken)
      if (hasToken) {
        void refreshAccessToken()
          .then(() => {
            if (active) setSessionPlanSyncTick((tick) => tick + 1)
          })
          .catch(() => {})
        void syncUserPreferencesFromServer()
      }
      const params = new URLSearchParams(window.location.search)
      const zoom = params.get('zoom')
      const teams = params.get('teams')
      if (zoom || teams) {
        const redirectAfter = params.get('redirectAfter')
        const route = resolveStudioRedirectAfter(redirectAfter)
        if (zoom === 'linked') {
          const message = 'Đã kết nối Zoom thành công. Chọn cloud recording để import.'
          if (returnToOAuthOpener({
            provider: 'zoom',
            status: 'success',
            message,
            route,
            tone: 'success',
          })) {
            return () => {
              active = false
              abortControllerRef.current?.abort()
              liveAnalysisAbortControllerRef.current?.abort()
            }
          }
        } else if (zoom === 'error') {
          const message = resolveZoomCallbackMessage(params.get('reason'))
          if (returnToOAuthOpener({
            provider: 'zoom',
            status: 'error',
            message,
            route,
            tone: 'error',
          })) {
            return () => {
              active = false
              abortControllerRef.current?.abort()
              liveAnalysisAbortControllerRef.current?.abort()
            }
          }
        }
        if (teams === 'linked') {
          const message = resolveTeamsCallbackMessage(null, 'linked')
          if (returnToOAuthOpener({
            provider: 'teams',
            status: 'success',
            message,
            route,
            tone: 'success',
          })) {
            return () => {
              active = false
              abortControllerRef.current?.abort()
              liveAnalysisAbortControllerRef.current?.abort()
            }
          }
        } else if (teams === 'error') {
          const message = resolveTeamsCallbackMessage(params.get('reason'), 'error')
          if (returnToOAuthOpener({
            provider: 'teams',
            status: 'error',
            message,
            route,
            tone: 'error',
          })) {
            return () => {
              active = false
              abortControllerRef.current?.abort()
              liveAnalysisAbortControllerRef.current?.abort()
            }
          }
        }
        window.history.replaceState({}, '', buildStudioPath('integrations'))
        setFeatureScene('integrations')
        if (zoom === 'linked') {
          setZoomIntegrationNotice('Đã kết nối Zoom thành công. Chọn cloud recording để import.')
          setZoomIntegrationNoticeTone('success')
        } else if (zoom === 'error') {
          setZoomIntegrationNotice(resolveZoomCallbackMessage(params.get('reason')))
          setZoomIntegrationNoticeTone('error')
        }
        if (teams === 'linked') {
          setTeamsIntegrationNotice(resolveTeamsCallbackMessage(null, 'linked'))
          setTeamsIntegrationNoticeTone('success')
        } else if (teams === 'error') {
          setTeamsIntegrationNotice(resolveTeamsCallbackMessage(params.get('reason'), 'error'))
          setTeamsIntegrationNoticeTone('error')
        }
      }
      if (hasToken) {
        const inviteDestination = resolvePostAuthDestination(params.toString())
        if (inviteDestination.scene === 'analysis') {
          applyPostAuthDestination(inviteDestination, {
            setFeatureScene,
            setHistoryAnalysisMeetingId,
            setMindmapSelectedMeetingId,
          })
        } else {
          const studioRoute = parseStudioRouteFromLocation()
          if (studioRoute) {
            applyParsedStudioRoute(studioRoute, {
              setFeatureScene,
              setHistoryAnalysisMeetingId,
              setHistoryAnalysisScope,
              setMindmapSelectedMeetingId,
              setMindmapSelectedScope,
            })
          }
        }
      }
    }
    return () => {
      active = false
      abortControllerRef.current?.abort()
      liveAnalysisAbortControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const syncAuthRoute = () => {
      setPublicLegalKind(resolvePublicLegalKindFromLocation())
      setAuthRoute(resolveAuthRouteFromLocation())
    }

    window.addEventListener('popstate', syncAuthRoute)
    syncAuthRoute()

    return () => {
      window.removeEventListener('popstate', syncAuthRoute)
    }
  }, [])

  useEffect(() => {
    liveMeetingIdRef.current = liveMeetingId
  }, [liveMeetingId])

  const navigateFeatureScene = useCallback((
    scene: DashboardScene,
    options?: {
      meetingId?: number | null
      resultScope?: MeetingResultScope | null
      replace?: boolean
    },
  ) => {
    setFeatureScene(scene)
    const meetingId = options?.meetingId
    if (meetingId != null && Number.isFinite(meetingId) && meetingId > 0) {
      if (scene === 'analysis') {
        setHistoryAnalysisMeetingId(meetingId)
        setHistoryAnalysisScope(options?.resultScope ?? null)
      } else if (scene === 'mindmap') {
        setMindmapSelectedMeetingId(meetingId)
        setMindmapSelectedScope(options?.resultScope ?? null)
      } else if (scene === 'files') {
        setHistoryFocusMeetingId(meetingId)
      }
    }
    pushStudioRoute(scene, {
      meetingId,
      resultScope: options?.resultScope ?? null,
      replace: options?.replace,
    })
  }, [])

  const handleNavigateBilling = useCallback(() => {
    navigateFeatureScene('billing')
  }, [navigateFeatureScene])

  const handleQuotaExceeded = useCallback((signal: QuotaSignal) => {
    const plan = (getJwtPlan() || 'FREE') as UserPlan
    const presentation = resolveQuotaPresentation(signal, plan, ERROR_UX_ENABLED)
    setBillingPaymentNotice(presentation.message)
    if (!quotaBillingRedirectRef.current) {
      quotaBillingRedirectRef.current = true
      navigateFeatureScene('billing')
    }
    return presentation
  }, [navigateFeatureScene])

  useEffect(() => {
    if (featureScene !== 'billing') {
      quotaBillingRedirectRef.current = false
    }
  }, [featureScene])

  useEffect(() => {
    if (featureScene !== 'realtime') {
      return
    }
    const streamStatus = realtimeStream.status
    if (
      streamStatus.state === 'error'
      && isUserQuotaExceeded({
        errorCode: streamStatus.errorCode,
        fallbackMessage: streamStatus.message,
      })
    ) {
      const presentation = handleQuotaExceeded({
        errorCode: streamStatus.errorCode,
        fallbackMessage: streamStatus.message,
      })
      setLiveError(presentation.message)
      setLiveErrorCode('QUOTA_EXCEEDED')
      setLiveLifecycleState('error')
    }
  }, [
    featureScene,
    handleQuotaExceeded,
    realtimeStream.status,
    realtimeStream.status.errorCode,
    realtimeStream.status.message,
    realtimeStream.status.state,
  ])

  useEffect(() => {
    if (featureScene !== 'realtime' || !liveAnalysisMetadata) {
      return
    }
    const analysisStatus = getAnalysisStatusValue(liveAnalysisMetadata)
    if (
      isUserQuotaExceeded({
        errorCode: liveAnalysisMetadata.errorCode,
        analysisStatus,
      })
    ) {
      const presentation = handleQuotaExceeded({
        errorCode: liveAnalysisMetadata.errorCode,
        analysisStatus,
        fallbackMessage: liveAnalysisMetadata.errorMessage ?? undefined,
      })
      setLiveAnalysisError(presentation.message)
      setLiveErrorCode('QUOTA_EXCEEDED')
    }
  }, [featureScene, handleQuotaExceeded, liveAnalysisMetadata])

  const { sttPercent, geminiPercent, isHighUsage } = useQuotaOverview(isAuthenticated)

  const renderQuotaWarningBanner = () => {
    if (!isHighUsage) {
      return null
    }
    return (
      <QuotaWarningBanner
        sttPercent={sttPercent}
        geminiPercent={geminiPercent}
        onNavigateBilling={handleNavigateBilling}
      />
    )
  }

  useEffect(() => {
    const syncStudioRouteFromBrowser = () => {
      const parsed = parseStudioRouteFromLocation()
      if (!parsed) return
      applyParsedStudioRoute(parsed, {
        setFeatureScene,
        setHistoryAnalysisMeetingId,
        setHistoryAnalysisScope,
        setMindmapSelectedMeetingId,
        setMindmapSelectedScope,
      })
    }
    window.addEventListener('popstate', syncStudioRouteFromBrowser)
    return () => window.removeEventListener('popstate', syncStudioRouteFromBrowser)
  }, [])

  useEffect(() => {
    return subscribeOAuthComplete((event) => {
      if (event.route) {
        applyParsedStudioRoute(event.route, {
          setFeatureScene,
          setHistoryAnalysisMeetingId,
          setHistoryAnalysisScope,
          setMindmapSelectedMeetingId,
          setMindmapSelectedScope,
        })
        pushStudioRoute(event.route.scene, {
          meetingId: event.route.meetingId,
          resultScope: event.route.resultScope ?? null,
          replace: true,
        })
      }
      if (event.provider === 'google') {
        setGoogleIntegrationNotice(event.message)
      } else if (event.provider === 'zoom') {
        setZoomIntegrationNotice(event.message)
        setZoomIntegrationNoticeTone(event.tone ?? (event.status === 'success' ? 'success' : 'error'))
      } else if (event.provider === 'teams') {
        setTeamsIntegrationNotice(event.message)
        setTeamsIntegrationNoticeTone(event.tone ?? (event.status === 'success' ? 'success' : 'error'))
      }
      setOauthRefreshTick((tick) => tick + 1)
    })
  }, [])

  const navigateAuthRoute = (route: AuthRoute, replace = false) => {
    const nextPath = appendOpenMeetingQuery(resolveAuthPath(route), window.location.search)
    if (typeof window !== 'undefined') {
      const historyMethod = replace ? 'replaceState' : 'pushState'
      window.history[historyMethod]({}, '', nextPath)
    }
    setAuthRoute(route)
  }

  const postAuthHandlers = {
    setFeatureScene,
    setHistoryAnalysisMeetingId,
    setHistoryAnalysisScope,
    setMindmapSelectedMeetingId,
    setMindmapSelectedScope,
    navigateFeatureScene,
  }

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
      setAuthNotice('')
      const auth = await login({
        username: username.trim(),
        password,
      })
      setAccessToken(auth.accessToken, auth.expiresInSeconds)
      setIsAuthenticated(true)
      void syncUserPreferencesFromServer()
      applyPostAuthDestination(resolvePostAuthDestination(), postAuthHandlers)
    } catch (loginError) {
      setAuthError(loginError instanceof Error ? loginError.message : 'Đăng nhập thất bại')
    }
  }

  const handleGoogleLogin = () => {
    setAuthError('')
    window.location.assign(getGoogleLoginUrl(buildInviteGoogleRedirectAfter()))
  }

  const handleRegister = async () => {
    const normalizedUsername = registerUsername.trim()
    const normalizedEmail = registerEmail.trim()

    if (!normalizedUsername) {
      setRegisterError('Vui lòng nhập username')
      return
    }
    if (!normalizedEmail) {
      setRegisterError('Vui lòng nhập email')
      return
    }
    if (!registerPassword) {
      setRegisterError('Vui lòng nhập mật khẩu')
      return
    }
    if (registerPassword !== registerConfirmPassword) {
      setRegisterError('Mật khẩu xác nhận không khớp')
      return
    }

    try {
      setRegisterBusy(true)
      setRegisterError('')
      setAuthError('')
      await register({
        username: normalizedUsername,
        email: normalizedEmail,
        password: registerPassword,
      })

      setAuthNotice('Đăng ký thành công. Vui lòng đăng nhập.')
      setUsername(normalizedUsername)
      setPassword('')
      navigateAuthRoute('login', true)
    } catch (registerError) {
      setRegisterError(registerError instanceof Error ? registerError.message : 'Đăng ký thất bại')
    } finally {
      setRegisterBusy(false)
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
    setLiveAnalysisMetadata(null)
    setLiveAnalysisStatus('idle')
    setLiveAnalysisError(null)
    setLiveLifecycleState('idle')
    setPassword('')
    setRegisterPassword('')
    setRegisterConfirmPassword('')
    setRegisterEmail('')
    setRegisterUsername('')
    setRegisterError('')
    setAuthNotice('')
    setJoinMeetingIdInput('')
    setUploadNotice(null)
    setShowJoinOtherMeeting(false)
    setFeatureScene('upload')
    navigateAuthRoute('login', true)
  }

  const refreshRecentMeetings = useCallback(() => {
    setRecentMeetingsReloadTick((value) => value + 1)
  }, [])

  useEffect(() => {
    if (!isAuthenticated) {
      setRecentMeetings([])
      return
    }

    let cancelled = false
    const loadRecentMeetings = async () => {
      try {
        const meetings = await listMeetingsWithParams({ sort: 'created_desc' })
        if (!cancelled) {
          setRecentMeetings(meetings)
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to load recent meetings for sidebar', error)
        }
      }
    }

    void loadRecentMeetings()
    return () => {
      cancelled = true
    }
  }, [isAuthenticated, recentMeetingsReloadTick])

  useEffect(() => {
    if (featureScene === 'integrations' && isAuthenticated) {
      refreshRecentMeetings()
    }
  }, [featureScene, isAuthenticated, refreshRecentMeetings])

  const analysis = result?.analysis
  const liveTranscriptKeywords = useMemo(() => realtimeStream.keywords.map((keyword) => keyword.keyword), [realtimeStream.keywords])
  const liveTranscriptSegments = hydratedLiveTranscriptSegments ?? realtimeStream.transcripts
  const liveTranscriptSegmentsForDisplay = useMemo(() => {
    const shouldMergeForDisplay = hydratedLiveTranscriptSegments !== null || liveLifecycleState === 'stopped'
    if (!shouldMergeForDisplay) {
      return sortTranscriptSegmentsByTimeline(liveTranscriptSegments)
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
      setLiveAnalysisMetadata(null)
      setLiveAnalysisStatus('idle')
      setLiveAnalysisError(null)
    }
  }, [liveMeetingId, featureScene])

  useEffect(() => {
    if (featureScene !== 'upload') {
      setZoomIntegrationNotice(null)
      setTeamsIntegrationNotice(null)
    }
    if (featureScene !== 'files') {
      setHistoryFocusMeetingId(null)
    }
    if (featureScene !== 'analysis') {
      setHistoryAnalysisMeetingId(null)
      setHistoryAnalysisTitle(null)
    }
  }, [featureScene])

  useEffect(() => {
    if (featureScene !== 'mindmap') {
      return undefined
    }

    const mindmapMeetingId = mindmapSelectedMeetingId
      ?? result?.meetingId
      ?? liveMeetingId
      ?? recentMeetings[0]?.id
      ?? null

    if (!mindmapMeetingId) {
      setMindmapAnalysis(null)
      setMindmapDisplayScopeKey(null)
      return undefined
    }

    mindmapAbortRef.current?.abort()
    const controller = new AbortController()
    mindmapAbortRef.current = controller

    const requestKey = buildMindmapAnalysisRequestKey(mindmapMeetingId, mindmapSelectedScope)
    mindmapLoadRequestKeyRef.current = requestKey
    if (!canReuseMindmapSelectedScope(mindmapMeetingId, mindmapSelectedScope)) {
      setMindmapDisplayScopeKey(null)
    }

    const load = async () => {
      try {
        const { scope, analysis } = await loadMindmapSavedAnalysis(
          mindmapMeetingId,
          mindmapSelectedScope,
          { signal: controller.signal },
        )
        if (!shouldApplyMindmapLoadResult(requestKey, mindmapLoadRequestKeyRef.current, controller.signal)) {
          return
        }
        setMindmapDisplayScopeKey(scopeCacheKey(scope))
        setMindmapAnalysis(analysis)
      } catch {
        if (shouldApplyMindmapLoadResult(requestKey, mindmapLoadRequestKeyRef.current, controller.signal)) {
          setMindmapAnalysis(null)
        }
      }
    }

    void load()

    return () => {
      controller.abort()
    }
  }, [featureScene, mindmapSelectedMeetingId, mindmapSelectedScope, liveMeetingId, recentMeetings, result?.meetingId])

  const handleNavigateRealtimeMeetCapture = useCallback((source: RecordingSource, context?: RealtimeMeetCaptureContext) => {
    setSelectedRecordingSource(source)
    setSelectedRealtimeSpeakerMode('multiple')
    setLiveError(null)
    setLivePartialWarning(null)
    navigateFeatureScene('realtime')
    try {
      sessionStorage.setItem(REALTIME_FOCUS_MEET_CAPTURE_KEY, '1')
      const captureTitle = context?.title?.trim()
      if (captureTitle) {
        sessionStorage.setItem(REALTIME_MEET_CAPTURE_TITLE_KEY, captureTitle)
      }
    } catch {
      // ignore storage errors
    }
  }, [navigateFeatureScene])

  const handleOpenMeetingAnalysisFromHistory = (
    meetingId: number,
    context?: { title?: string; scope?: MeetingResultScope | null },
  ) => {
    setHistoryAnalysisTitle(context?.title?.trim() || null)
    navigateFeatureScene('analysis', { meetingId, resultScope: context?.scope ?? null })
  }

  const handleOpenMindmapFromHistory = (
    meetingId: number,
    context?: { title?: string; scope?: MeetingResultScope | null },
  ) => {
    setMindmapSelectedTitle(context?.title?.trim() || null)
    navigateFeatureScene('mindmap', { meetingId, resultScope: context?.scope ?? null })
  }

  const handleRecentFileClick = (meetingIdRaw: string) => {
    const meetingId = Number(meetingIdRaw)
    if (!Number.isFinite(meetingId) || meetingId <= 0) {
      return
    }
    if (featureScene === 'mindmap') {
      const meeting = recentMeetings.find((item) => item.id === meetingId)
      setMindmapSelectedMeetingId(meetingId)
      setMindmapSelectedScope(null)
      setMindmapSelectedTitle(meeting ? getMeetingLabel(meeting) : null)
      pushStudioRoute('mindmap', { meetingId })
      return
    }
    handleOpenMeetingFromDashboard(meetingId)
  }

  const handleMindmapMeetingSelect = (meetingId: number) => {
    const meeting = recentMeetings.find((item) => item.id === meetingId)
    setMindmapSelectedMeetingId(meetingId)
    setMindmapSelectedScope(null)
    setMindmapSelectedTitle(meeting ? getMeetingLabel(meeting) : null)
    pushStudioRoute('mindmap', { meetingId })
  }

  const handleOpenMeetingFromDashboard = (meetingId: number) => {
    if (!Number.isFinite(meetingId) || meetingId <= 0) {
      return
    }

    if (result?.meetingId === meetingId) {
      setHistoryAnalysisMeetingId(null)
      setHistoryAnalysisTitle(null)
      navigateFeatureScene('analysis', { meetingId })
      return
    }

    const meeting = recentMeetings.find((item) => item.id === meetingId)
    handleOpenMeetingAnalysisFromHistory(
      meetingId,
      meeting ? { title: getMeetingLabel(meeting) } : undefined,
    )
  }

  const handleBackToHistory = () => {
    navigateFeatureScene('files')
  }

  const openAnalysisForMeeting = async (meetingId: number, statusValue: string = 'COMPLETED') => {
    setHistoryAnalysisMeetingId(null)
    setHistoryAnalysisTitle(null)
    setStatus('fetching-result')
    const [transcript, analysis] = await Promise.all([
      getTranscript(meetingId),
      getAnalysis(meetingId),
    ])

    const mergedTranscriptSegments = sortTranscriptSegmentsByTimeline(
      mergeTranscriptSegments(
        normalizePersistedTranscriptSegments(transcript.transcripts || []),
      ),
    )

    const mergedTranscript = mergedTranscriptSegments
      .map((segment) => `${segment.speaker}: ${segment.text}`)
      .join(' ')
      .trim()

    setResult({
      meetingId,
      status: statusValue,
      transcript: mergedTranscript,
      transcriptSegments: mergedTranscriptSegments,
      analysis,
    })
    setStatus('completed')
    navigateFeatureScene('analysis', { meetingId })
    refreshRecentMeetings()
  }

  const handleProcess = async (fileOverride?: File) => {
    const file = fileOverride ?? selectedFile
    if (!file) {
      setErrorMessage('Vui lòng chọn file audio trước khi xử lý')
      return
    }

    const preflight = validateUploadFile(file, getBundledUploadConfig())
    if (!preflight.ok) {
      setErrorMessage(preflight.message)
      setStatus('failed')
      return
    }

    setBusy(true)
    setErrorMessage(null)
    setUploadErrorCode(null)
    setUploadNotice(null)
    setResult(null)
    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()

    let meetingId: number | null = null

    try {
      const effectiveUploadLanguage = normalizeRealtimeLanguage(selectedUploadLanguage)
      setStatus('uploading')
      navigateFeatureScene('upload')
      console.info('UPLOAD_REQUEST_SEND language=' + effectiveUploadLanguage)
      const meeting = await uploadToMeetingApi(file.name, file, effectiveUploadLanguage)
      meetingId = Number(meeting.existingMeetingId ?? meeting.id)
      if (!Number.isFinite(meetingId) || meetingId <= 0) {
        throw new Error('Meeting ID trả về không hợp lệ')
      }
      const duplicateStatus = String(meeting.status ?? '').trim().toLowerCase()
      const isDuplicate = Boolean(meeting.duplicate)

      if (isDuplicate) {
        if (duplicateStatus === 'completed' && meeting.reused && meetingId > 0) {
          setUploadNotice('File âm thanh này đã được phân tích trước đó. Đang mở kết quả cũ.')
          await openAnalysisForMeeting(meetingId, 'COMPLETED')
          return
        }

        if (duplicateStatus === 'failed') {
          setUploadNotice('Đang thử xử lý lại file đã thất bại trước đó...')
          setStatus('processing')
          await startProcessingByPath(meetingId, effectiveUploadLanguage, selectedDomainMode)
          await pollUntilCompleted(meetingId, abortControllerRef.current.signal)
          await openAnalysisForMeeting(meetingId, 'COMPLETED')
          return
        }

        setUploadNotice('File này đang được xử lý. Vui lòng đợi hoặc mở Lịch sử meeting.')
        setStatus('processing')
        return
      }

      setStatus('processing')
      await startProcessingByPath(meetingId, effectiveUploadLanguage, selectedDomainMode)

      await pollUntilCompleted(meetingId, abortControllerRef.current.signal)
      await openAnalysisForMeeting(meetingId, 'COMPLETED')
    } catch (error: any) {
      setStatus('failed')
      if (error instanceof DOMException && error.name === 'AbortError') {
        setErrorMessage('Processing cancelled')
      } else if (error instanceof ApiError) {
        const resolvedCode = error.errorCode || (error.status === 402 ? 'QUOTA_EXCEEDED' : undefined)
        const quotaSignal: QuotaSignal = {
          httpStatus: error.status,
          errorCode: resolvedCode,
          fallbackMessage: error.message,
        }
        if (isUserQuotaExceeded(quotaSignal)) {
          const presentation = handleQuotaExceeded(quotaSignal)
          setErrorMessage(presentation.message)
          setUploadErrorCode('QUOTA_EXCEEDED')
        } else {
          const presentation = resolveErrorPresentation(resolvedCode, error.message, ERROR_UX_ENABLED)
          setErrorMessage(presentation.message)
          setUploadErrorCode(resolvedCode ?? null)
        }
        if (error.errorCode === 'UNAUTHORIZED' || error.status === 401) {
          handleLogout()
        }
      } else {
        const pipelineErrorCode = resolveBatchPipelineErrorCode(error?.message)
        if (pipelineErrorCode) {
          const quotaSignal: QuotaSignal = {
            errorCode: pipelineErrorCode,
            fallbackMessage: error.message,
          }
          if (isUserQuotaExceeded(quotaSignal)) {
            const presentation = handleQuotaExceeded(quotaSignal)
            setErrorMessage(presentation.message)
            setUploadErrorCode('QUOTA_EXCEEDED')
          } else {
            const presentation = resolveErrorPresentation(pipelineErrorCode, error.message, ERROR_UX_ENABLED)
            setErrorMessage(presentation.message)
            setUploadErrorCode(pipelineErrorCode)
          }
        } else {
          const message = error.message || 'Lỗi không xác định, vui lòng thử lại'
          setErrorMessage(message)
          setUploadErrorCode(null)
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
    setLiveAnalysisMetadata(null)
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
    navigateFeatureScene('realtime')
  }

  const handleDashboardUpload = async (_title: string, file: File) => {
    setSelectedFile(file)
    await handleProcess(file)
  }

  const handleImportedMeeting = async (
    meetingId: number,
    meta: { duplicate: boolean; reused: boolean; processingStarted: boolean },
  ) => {
    if (!Number.isFinite(meetingId) || meetingId <= 0) {
      setErrorMessage('Meeting ID import không hợp lệ')
      return
    }
    setBusy(true)
    setErrorMessage(null)
    setUploadNotice(null)
    abortControllerRef.current?.abort()
    abortControllerRef.current = new AbortController()
    try {
      navigateFeatureScene('upload')
      if (meta.duplicate && meta.reused) {
        setUploadNotice('Recording đã được phân tích trước đó. Đang mở kết quả cũ.')
        await openAnalysisForMeeting(meetingId, 'COMPLETED')
        return
      }
      if (!meta.processingStarted) {
        setUploadNotice('Đã import meeting. Kiểm tra Lịch sử meeting nếu phân tích chưa chạy.')
        setStatus('processing')
        return
      }
      setStatus('processing')
      await pollUntilCompleted(meetingId, abortControllerRef.current.signal)
      await openAnalysisForMeeting(meetingId, 'COMPLETED')
    } catch (error: unknown) {
      setStatus('failed')
      if (error instanceof DOMException && error.name === 'AbortError') {
        setErrorMessage('Processing cancelled')
      } else if (error instanceof ApiError) {
        setErrorMessage(error.message)
      } else if (error instanceof Error) {
        setErrorMessage(error.message)
      } else {
        setErrorMessage('Import cloud recording thất bại')
      }
    } finally {
      abortControllerRef.current = null
      setBusy(false)
    }
  }

  const dashboardUser = useMemo(() => ({
    name: username.trim() || `User ${currentUserId || ''}`.trim() || 'AudioMind',
    email: currentUserId ? `user-${currentUserId}@audiomind` : undefined,
    plan: getJwtPlan(),
  }), [currentUserId, username, sessionPlanSyncTick])

  const recentFiles = useMemo(() => {
    const activeMeetingId = featureScene === 'analysis'
      ? (historyAnalysisMeetingId ?? result?.meetingId ?? null)
      : featureScene === 'mindmap'
        ? (mindmapSelectedMeetingId ?? result?.meetingId ?? liveMeetingId ?? recentMeetings[0]?.id ?? null)
        : null
    const items: Array<{ id: string; label: string; active?: boolean }> = []
    const seen = new Set<number>()

    const addItem = (meetingId: number, label: string) => {
      if (seen.has(meetingId)) {
        return
      }
      seen.add(meetingId)
      items.push({
        id: String(meetingId),
        label,
        active: activeMeetingId === meetingId,
      })
    }

    if (result?.meetingId) {
      addItem(
        result.meetingId,
        selectedFile?.name?.trim() || `Meeting #${result.meetingId}`,
      )
    }

    for (const meeting of recentMeetings) {
      if (items.length >= RECENT_MEETINGS_LIMIT) {
        break
      }
      addItem(meeting.id, getMeetingLabel(meeting))
    }

    return items
  }, [featureScene, historyAnalysisMeetingId, liveMeetingId, mindmapSelectedMeetingId, recentMeetings, result, selectedFile])

  const resolvedMindmapMeetingId = mindmapSelectedMeetingId
    ?? result?.meetingId
    ?? liveMeetingId
    ?? recentMeetings[0]?.id
    ?? null

  const renderDashboardScene = () => {
    if (featureScene === 'billing') {
      return (
        <BillingScene
          payosEnabled={PAYOS_ENABLED}
          paymentNotice={billingPaymentNotice}
          activationOrderCode={billingActivationOrderCode}
          onActivationHandled={() => setBillingActivationOrderCode(null)}
          onRefreshTokenHint={() => {
            void refreshAccessToken()
              .then(() => setBillingPaymentNotice('Đã đồng bộ JWT với gói trên server.'))
              .catch(() => setBillingPaymentNotice('Không đồng bộ được JWT. Hãy đăng xuất và đăng nhập lại.'))
          }}
        />
      )
    }
    if (featureScene === 'integrations') {
      return (
        <FeatureIntegrations
          meetings={recentMeetings}
          callbackNotice={googleIntegrationNotice}
          oauthEnabled={GOOGLE_LOGIN_ENABLED}
          realtimeEnabled={isRealtimeEnabled}
          uploadLanguage={selectedUploadLanguage}
          zoomCallbackNotice={zoomIntegrationNotice}
          zoomCallbackNoticeTone={zoomIntegrationNoticeTone}
          teamsCallbackNotice={teamsIntegrationNotice}
          teamsCallbackNoticeTone={teamsIntegrationNoticeTone}
          integrationsBusy={busy}
          oauthRefreshTick={oauthRefreshTick}
          onNavigateRealtimeMeetCapture={handleNavigateRealtimeMeetCapture}
          onMeetingImported={handleImportedMeeting}
        />
      )
    }
    if (featureScene === 'mindmap') {
      const inlineAnalysis = resolvedMindmapMeetingId != null && result?.meetingId === resolvedMindmapMeetingId
        ? result.analysis ?? null
        : resolvedMindmapMeetingId != null && liveMeetingId === resolvedMindmapMeetingId
          ? liveAnalysis
          : null
      return (
        <FeatureMindmap
          key={
            canReuseMindmapSelectedScope(resolvedMindmapMeetingId ?? -1, mindmapSelectedScope)
              ? scopeCacheKey(mindmapSelectedScope)
              : mindmapDisplayScopeKey ?? `mindmap-${resolvedMindmapMeetingId ?? 'none'}`
          }
          meetings={recentMeetings}
          selectedMeetingId={resolvedMindmapMeetingId}
          meetingTitle={mindmapSelectedTitle ?? selectedFile?.name ?? undefined}
          onMeetingSelect={handleMindmapMeetingSelect}
          getMeetingLabel={getMeetingLabel}
          meetingId={resolvedMindmapMeetingId}
          analysis={mindmapAnalysis ?? inlineAnalysis ?? null}
          busy={busy}
          onLoadAnalysis={async () => {
            if (!resolvedMindmapMeetingId) return
            mindmapAbortRef.current?.abort()
            const controller = new AbortController()
            mindmapAbortRef.current = controller
            const requestKey = buildMindmapAnalysisRequestKey(
              resolvedMindmapMeetingId,
              mindmapSelectedScope,
            )
            mindmapLoadRequestKeyRef.current = requestKey
            try {
              const { scope, analysis } = await loadMindmapSavedAnalysis(
                resolvedMindmapMeetingId,
                mindmapSelectedScope,
                { signal: controller.signal },
              )
              if (!shouldApplyMindmapLoadResult(requestKey, mindmapLoadRequestKeyRef.current, controller.signal)) {
                return
              }
              setMindmapDisplayScopeKey(scopeCacheKey(scope))
              setMindmapAnalysis(analysis)
            } catch {
              if (shouldApplyMindmapLoadResult(requestKey, mindmapLoadRequestKeyRef.current, controller.signal)) {
                setMindmapAnalysis(null)
              }
            }
          }}
        />
      )
    }
    if (featureScene === 'knowledge') {
      return (
        <KnowledgeVaultScene
          onOpenMeeting={(meetingId) => {
            handleOpenMeetingAnalysisFromHistory(meetingId)
          }}
        />
      )
    }
    if (featureScene === 'insights') {
      return (
        <ExpansionDashboardScene
          embeddingSearchEnabled={import.meta.env.VITE_EMBEDDING_SEARCH_ENABLED !== 'false'}
          onOpenMeeting={(meetingId) => {
            handleOpenMeetingAnalysisFromHistory(meetingId)
          }}
        />
      )
    }
    if (featureScene === 'realtime' && isRealtimeEnabled && realtimeUserId !== null) {
      return (
        <>
          {renderQuotaWarningBanner()}
          <RealtimeDashboardScene
          liveStatusMessage={liveStatusMessage}
          connectionView={connectionView}
          selectedRealtimeLanguage={selectedRealtimeLanguage}
          selectedDomainMode={selectedDomainMode}
          onDomainModeChange={handleDomainModeChange}
          selectedRealtimeSpeakerMode={selectedRealtimeSpeakerMode}
          selectedMicSensitivity={selectedMicSensitivity}
          selectedRecordingSource={selectedRecordingSource}
          noiseSuppressionEnabled={noiseSuppressionEnabled}
          noiseSuppressionToggleEnabled={REALTIME_NOISE_SUPPRESSION_TOGGLE_ENABLED}
          noiseSuppressionSupported={noiseSuppressionSupported}
          liveLifecycleState={liveLifecycleState}
          onRealtimeLanguageChange={(value) => setSelectedRealtimeLanguage(normalizeRealtimeLanguage(value))}
          onRealtimeSpeakerModeChange={(value) => {
            setSelectedRealtimeSpeakerMode(normalizeRealtimeSpeakerMode(value))
          }}
          onMicSensitivityChange={(value) => {
            setSelectedMicSensitivity(normalizeMicSensitivityMode(value))
          }}
          onRecordingSourceChange={handleRecordingSourceChange}
          onNoiseSuppressionChange={setNoiseSuppressionEnabled}
          isRealtimeLanguageSelectorDisabled={isRealtimeLanguageSelectorDisabled(liveLifecycleState)}
          isRealtimeSpeakerModeSelectorDisabled={isRealtimeSpeakerModeSelectorDisabled(liveLifecycleState)}
          isRecordingSourceSelectorDisabled={isRecordingSourceSelectorDisabled(liveLifecycleState)}
          liveMeetingId={liveMeetingId}
          audioRecorder={audioRecorder}
          onBeforeStartRecording={handlePrepareLiveMeeting}
          onChunkReady={dualStreamActive ? undefined : handleLiveChunkReady}
          onRecordingComplete={handleLiveRecordingComplete}
          onStopRequested={() => {
            console.info('[Realtime] REALTIME_STOP_REQUESTED', {
              meetingId: liveMeetingIdRef.current,
              source: selectedRecordingSource,
              phase: 'recorder_stop',
            })
            beginGracefulStopLifecycle(setLiveLifecycleState)
          }}
          gracefulStopRef={gracefulStopRef}
          liveError={liveError}
          liveErrorCode={liveErrorCode}
          onNavigateBilling={handleNavigateBilling}
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
          liveAnalysisMetadata={liveAnalysisMetadata}
          liveAnalysisStatus={liveAnalysisStatus}
          liveAnalysisError={liveAnalysisError}
          showLiveAnalysis={
            liveLifecycleState === 'stopped'
            || liveLifecycleState === 'stopped_no_analysis'
            || liveLifecycleState === 'no_transcript_after_finalize'
            || liveAnalysisStatus !== 'idle'
          }
          onLiveAnalysisRetry={() => void handleLiveAnalysisRetry()}
          onUpgradePlan={handleNavigateBilling}
          dualStreamActive={dualStreamActive}
          dualStreamBackendEnabled={realtimeStream.status.dualStreamBackendEnabled}
          sttQuotaPercent={sttPercent}
        />
        </>
      )
    }

    if (featureScene === 'analysis') {
      if (historyAnalysisMeetingId !== null) {
        return (
          <FeatureAnalysis
            meetingId={historyAnalysisMeetingId}
            meetingTitle={historyAnalysisTitle ?? undefined}
            resultScope={historyAnalysisScope}
            hydrateFromApi
            onBackToHistory={handleBackToHistory}
            preferredDomainMode={selectedDomainMode}
          />
        )
      }

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
          preferredDomainMode={selectedDomainMode}
        />
      )
    }

    if (featureScene === 'files') {
      return (
        <MeetingHistoryScene
          focusMeetingId={historyFocusMeetingId}
          onOpenAnalysis={handleOpenMeetingAnalysisFromHistory}
          onOpenMindmap={handleOpenMindmapFromHistory}
          searchQuery={globalMeetingSearch}
          onSearchQueryChange={setGlobalMeetingSearch}
          onNavigateUpload={() => navigateFeatureScene('upload')}
          onNavigateRealtime={() => navigateFeatureScene('realtime')}
          onNavigateBilling={handleNavigateBilling}
          preferredDomainMode={selectedDomainMode}
          oauthRefreshTick={oauthRefreshTick}
        />
      )
    }

    return (
      <>
        {renderQuotaWarningBanner()}
        <FeatureUpload
        disabled={busy}
        userName={dashboardUser.name}
        uploadLanguage={selectedUploadLanguage}
        onUploadLanguageChange={setSelectedUploadLanguage}
        domainMode={selectedDomainMode}
        onDomainModeChange={handleDomainModeChange}
        showOnboarding={showOnboarding}
        onDismissOnboarding={() => setShowOnboarding(false)}
        onNavigateRealtime={() => navigateFeatureScene('realtime')}
        onNavigateIntegrations={() => navigateFeatureScene('integrations')}
        status={status}
        errorMessage={errorMessage}
        errorCode={uploadErrorCode ?? undefined}
        onNavigateBilling={handleNavigateBilling}
        duplicateNotice={uploadNotice}
        onUpload={handleDashboardUpload}
        onCancel={handleCancel}
      />
      </>
    )
  }

  const handlePrepareLiveMeeting = async (recordingSessionId?: number): Promise<void> => {
    setLiveError(null)
    setLiveErrorCode(null)
    setLivePartialWarning(null)
    liveAnalysisAbortControllerRef.current?.abort()
    liveAnalysisAbortControllerRef.current = null
    setLiveAnalysis(null)
    setLiveAnalysisMetadata(null)
    setLiveAnalysisStatus('idle')
    setLiveAnalysisError(null)
    setLiveStatusMessage('Đang tạo meeting mới...')
    setHydratedLiveTranscriptSegments(null)
    setLiveLifecycleState('connecting')
    liveTinyChunkStreakRef.current = 0
    realtimeStream.clearQueuedAudio?.()
    realtimeStream.disconnect(activeRealtimeSessionTokenRef.current)
    realtimeStream.clearTranscripts?.()
    realtimeStream.clearKeywords?.()
    setLiveMeetingId(null)
    liveMeetingIdRef.current = null
    const sessionId = recordingSessionId ?? audioRecorder.recordingSessionId + 1
    const attemptId = realtimeAttemptIdRef.current + 1
    realtimeAttemptIdRef.current = attemptId
    let meetingCreated = false
    let sessionToken: RealtimeSessionToken | null = null

    try {
      const resolveRealtimeMeetingTitle = (): string => {
        try {
          const stored = sessionStorage.getItem(REALTIME_MEET_CAPTURE_TITLE_KEY)?.trim()
          if (stored) {
            sessionStorage.removeItem(REALTIME_MEET_CAPTURE_TITLE_KEY)
            return stored
          }
        } catch {
          // ignore storage errors
        }
        return 'Live recording session'
      }
      const meeting = await createRealtimeMeeting(resolveRealtimeMeetingTitle(), selectedRealtimeLanguage, selectedDomainMode)
      const normalizedMeetingId = resolveFreshRealtimeMeetingId(meeting)
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
        source: selectedRecordingSourceRef.current,
      })
      if (isBrowserTabRecordingSource(selectedRecordingSourceRef.current)) {
        console.info('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.REALTIME_STARTED, {
          meetingId: normalizedMeetingId,
          source: selectedRecordingSourceRef.current,
        })
      }
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
      if (dualStreamActive && audioRecorder.getActiveStreamIds) {
        realtimeStream.configureDualStreams(audioRecorder.getActiveStreamIds())
      }
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
      audioRecorder.abortRecording()
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

  const handleLiveChunkReady = async (
    chunk: Blob,
    sessionId: number,
    streamId?: RealtimeAudioStreamId,
  ) => {
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

    const chunkBytes = chunk.size
    const recordingDurationSec = audioRecorder.duration
    const isTabCaptureSource = isBrowserTabRecordingSource(selectedRecordingSourceRef.current)
    const validateMicTinyChunks = streamId === 'mic' || (!streamId && !isTabCaptureSource)
    const currentRms = audioRecorder.getCurrentRms()
    const isTinyChunk = chunkBytes > 0 && chunkBytes < REALTIME_TINY_CHUNK_MAX_BYTES
    const isSilentCapture = currentRms === null || currentRms <= REALTIME_TINY_CHUNK_MAX_RMS
    if (validateMicTinyChunks && isTinyChunk && isSilentCapture) {
      liveTinyChunkStreakRef.current += 1
    } else if (chunkBytes >= REALTIME_TINY_CHUNK_MAX_BYTES) {
      liveTinyChunkStreakRef.current = 0
    }

    if (
      validateMicTinyChunks
      && recordingDurationSec >= REALTIME_TINY_CHUNK_MIN_RECORDING_SEC
      && liveTinyChunkStreakRef.current >= REALTIME_TINY_CHUNK_STREAK_THRESHOLD
    ) {
      const captureError = getRecordingSourceTinyChunkError(selectedRecordingSourceRef.current)
      console.warn('[Realtime] REALTIME_TINY_CHUNK_STREAK_CLIENT', {
        meetingId: activeMeetingId,
        sessionId,
        streak: liveTinyChunkStreakRef.current,
        chunkBytes,
        rms: currentRms,
        recordingDurationSec,
      })
      liveTinyChunkStreakRef.current = 0
      setLiveError(captureError)
      setLiveLifecycleState('failed_audio_capture')
      setLiveStatusMessage('Không nhận được âm thanh hợp lệ')
      audioRecorder.abortRecording()
      realtimeStream.clearQueuedAudio?.()
      realtimeStream.disconnect(activeToken)
      return
    }

    try {
      await realtimeStream.sendAudioChunk(chunk, String(activeMeetingId), streamId)
    } catch (error) {
      console.error('Failed to send audio chunk:', error)
      setLiveError(error instanceof Error ? error.message : 'Không thể gửi audio chunk')
      setLiveLifecycleState('error')
    }
  }

  useEffect(() => {
    handleDualChunkReadyRef.current = (chunk, streamId, sessionId) => {
      void handleLiveChunkReady(chunk, sessionId, streamId)
    }
  })

  const startRealtimeAnalysisPolling = (
    meetingId: number,
    sessionId: number,
    sessionToken: RealtimeSessionToken,
  ) => {
    liveAnalysisAbortControllerRef.current?.abort()
    const controller = new AbortController()
    const analysisPollRunId = analysisPollRunIdRef.current + 1
    analysisPollRunIdRef.current = analysisPollRunId
    liveAnalysisAbortControllerRef.current = controller
    setLiveAnalysis(null)
    setLiveAnalysisMetadata(buildLiveAnalysisMetadata(meetingId, 'ANALYZING'))
    setLiveAnalysisStatus('polling')
    setLiveAnalysisError(null)

    void (async () => {
      try {
        const pollResult = await pollRealtimeAnalysisAfterStop(meetingId, controller.signal, getAnalysis, REALTIME_ANALYSIS_POLL_MAX_ATTEMPTS, {
          sessionToken,
          isSessionActive: isCurrentRealtimeSessionToken,
          analysisPollRunId,
          analysisScope: {
            recordingSessionId: sessionToken.recordingSessionId,
            attemptId: sessionToken.attemptId,
          },
        })
        if (
          analysisPollRunId !== analysisPollRunIdRef.current
          || pollResult.reason === 'stale_session'
          || !isCurrentRealtimeSessionToken(sessionToken)
          || !isCurrentLiveRecordingSession(sessionId, meetingId, liveRecordingSessionIdRef.current, liveMeetingIdRef.current)
        ) {
          return
        }

        if (pollResult.reason === 'no_transcript_after_finalize') {
          setLiveLifecycleState('stopped_no_analysis')
          setLiveAnalysis(null)
          setLiveAnalysisMetadata(pollResult.metadata ?? buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS', {
            errorCode: 'NO_TRANSCRIPT_AFTER_FINALIZE',
            transcriptRows: 0,
            finalized: true,
          }))
          setLiveAnalysisStatus('pending')
          setLiveAnalysisError(null)
          return
        }

        if (pollResult.status === 'completed' && pollResult.analysis) {
          setLiveAnalysis(pollResult.analysis)
          setLiveAnalysisMetadata(pollResult.metadata ?? pollResult.analysis)
          setLiveAnalysisStatus('completed')
          setLiveAnalysisError(null)
          return
        }

        if (pollResult.status === 'failed') {
          setLiveAnalysis(null)
          setLiveAnalysisMetadata(pollResult.metadata ?? buildLiveAnalysisMetadata(meetingId, 'FAILED'))
          setLiveAnalysisStatus('failed')
          setLiveAnalysisError(pollResult.reason || 'Analysis failed temporarily. Retry available.')
          return
        }

        setLiveAnalysis(null)
        setLiveAnalysisMetadata(pollResult.metadata ?? buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS'))
        setLiveAnalysisStatus('pending')
        setLiveAnalysisError(null)
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
        const metadata = error instanceof ApiError
          ? metadataFromAnalysisError(meetingId, error)
          : buildLiveAnalysisMetadata(meetingId, 'FAILED', {
            errorMessage: error instanceof Error ? error.message : 'Unable to load realtime analysis',
          })
        setLiveAnalysis(null)
        setLiveAnalysisMetadata(metadata)
        setLiveAnalysisStatus('failed')
        setLiveAnalysisError(getRealtimeAnalysisFailureMessage(metadata, error instanceof Error ? error.message : undefined))
      }
    })()
  }

  const handleLiveAnalysisRetry = async () => {
    const meetingId = liveMeetingIdRef.current
    if (meetingId === null) {
      return
    }
    if (
      isNoTranscriptTerminalLifecycle(liveLifecycleState)
      || liveAnalysisMetadata?.errorCode === 'NO_TRANSCRIPT_AFTER_FINALIZE'
    ) {
      setLiveAnalysisError(null)
      return
    }

    const retryAfterSeconds = liveAnalysisMetadata?.retryAfterSeconds ?? 0
    if (retryAfterSeconds > 0) {
      setLiveAnalysisError(`Retry available after ${retryAfterSeconds}s.`)
      return
    }

    liveAnalysisAbortControllerRef.current?.abort()
    liveAnalysisAbortControllerRef.current = null
    setLiveAnalysis(null)
    setLiveAnalysisMetadata(buildLiveAnalysisMetadata(meetingId, 'ANALYZING'))
    setLiveAnalysisStatus('polling')
    setLiveAnalysisError(null)

    try {
      const response = await reanalyzeMeetingAnalysis(meetingId, {
        mode: 'force',
        reason: 'manual_reanalyze',
        domainMode: selectedDomainMode,
      })
      const responseStatus = getAnalysisStatusValue(response)
      setLiveAnalysisMetadata(response)

      if (hasStructuredAnalysisData(response)) {
        setLiveAnalysis(response)
        setLiveAnalysisStatus('completed')
        setLiveAnalysisError(null)
        return
      }

      if (isFailedAnalysisStatus(responseStatus)) {
        setLiveAnalysis(null)
        setLiveAnalysisStatus('failed')
        setLiveAnalysisError(getRealtimeAnalysisFailureMessage(response))
        return
      }

      setLiveAnalysis(null)
      setLiveAnalysisStatus('pending')
      setLiveAnalysisError(null)
    } catch (error) {
      const metadata = error instanceof ApiError
        ? metadataFromAnalysisError(meetingId, error)
        : buildLiveAnalysisMetadata(meetingId, 'FAILED', {
          errorMessage: error instanceof Error ? error.message : 'Unable to retry realtime analysis',
        })
      setLiveAnalysis(null)
      setLiveAnalysisMetadata(metadata)
      setLiveAnalysisStatus('failed')
      setLiveAnalysisError(getRealtimeAnalysisFailureMessage(metadata, error instanceof Error ? error.message : undefined))
    }
  }

  const handleLiveRecordingComplete = async (fullAudio: Blob, sessionId: number) => {
    const sessionToken = activeRealtimeSessionTokenRef.current
    const completedMeetingId = liveMeetingIdRef.current
    let noTranscriptAfterFinalize = false
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
    console.info('[Realtime] FINAL_AUDIO_BLOB_READY', buildFinalAudioBlobReadyLogPayload(completedMeetingId, fullAudio.size))
    try {
      if (!isCurrentRealtimeSessionToken(sessionToken)) {
        console.info('[Realtime] STALE_SESSION_COMPLETE_IGNORED', {
          meetingId: completedMeetingId,
          sessionId,
        })
        return
      }

      const { stopIncomplete } = await runLiveRecordingStopSequence({
        meetingId: completedMeetingId,
        sessionId,
        stopStream: realtimeStream?.stopStream
          ? () => realtimeStream.stopStream()
          : undefined,
        setLifecycleState: setLiveLifecycleState,
      })
      if (stopIncomplete) {
        console.warn('[Realtime] STREAM_STOP_INCOMPLETE_DISCONNECT_FALLBACK', {
          meetingId: completedMeetingId,
          sessionId,
        })
        realtimeStream?.disconnect?.(sessionToken)
        await new Promise((resolve) => setTimeout(resolve, STREAM_STOP_DISCONNECT_FALLBACK_DELAY_MS))
      }

      const activeMeetingId = liveMeetingIdRef.current
      if (activeMeetingId) {
        const hydrationRunId = hydrationRunIdRef.current + 1
        hydrationRunIdRef.current = hydrationRunId
        const partialState = resolveTranscriptPartialState({
          stopIncomplete,
          resetRequired: Boolean(realtimeStream.status.resetRequired),
          statusMessage: realtimeStream.status.message,
        })
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
            hydrationRunId,
            isHydrationRunActive: isCurrentHydrationRun,
          },
        )
        if (
          !isCurrentHydrationRun(hydrationRunId)
          || !isCurrentRealtimeSessionToken(sessionToken)
          || !isCurrentLiveRecordingSession(sessionId, completedMeetingId, liveRecordingSessionIdRef.current, liveMeetingIdRef.current)
        ) {
          return
        }
        const mergedHydration = mergeHydratedTranscriptWithLive(liveSnapshot, hydratedSegments)
        setHydratedLiveTranscriptSegments(mergedHydration)
        if (mergedHydration.length === 0) {
          noTranscriptAfterFinalize = true
        }
        const shouldAttemptFinalAudioFallback = shouldAttemptRealtimeFinalAudioFallback({
          mergedTranscriptCount: mergedHydration.length,
          fullAudioBytes: fullAudio.size,
          minFallbackAudioBytes: REALTIME_MIN_FALLBACK_AUDIO_BYTES,
          stopIncomplete,
          partialState,
          resetRequired: Boolean(realtimeStream.status.resetRequired),
          streamState: realtimeStream.status.state,
        })
        if (shouldAttemptFinalAudioFallback) {
          setLiveStatusMessage('Đang thử chuyển sang nhận dạng giọng nói dự phòng...')
          console.info('[Realtime] REALTIME_FINAL_AUDIO_FALLBACK_REQUESTED', {
            meetingId: activeMeetingId,
            sessionId,
            audioBytes: fullAudio.size,
            stopIncomplete,
            partialState,
            resetRequired: realtimeStream.status.resetRequired,
          })
          try {
            const fallbackFile = new File(
              [fullAudio],
              `realtime-fallback-${activeMeetingId}.webm`,
              { type: fullAudio.type || 'audio/webm' },
            )
            const fallbackResponse = await submitRealtimeFinalAudioFallback(
              activeMeetingId,
              fallbackFile,
              selectedRealtimeLanguage,
            )
            const fallbackRows = Number(
              fallbackResponse.transcriptRows ?? fallbackResponse.transcript_count ?? 0,
            )
            if (fallbackRows > 0) {
              noTranscriptAfterFinalize = false
              const fallbackTranscript = sessionToken
                ? await getTranscript(activeMeetingId, {
                    recordingSessionId: sessionToken.recordingSessionId,
                    attemptId: sessionToken.attemptId,
                  })
                : await getTranscript(activeMeetingId)
              const fallbackSegments = mergeTranscriptSegments(
                normalizePersistedTranscriptSegments(fallbackTranscript.transcripts || []),
              )
              setHydratedLiveTranscriptSegments(fallbackSegments)
              setLivePartialWarning(null)
              setLiveStatusMessage('Đã nhận dạng transcript từ audio dự phòng')
              console.info('[Realtime] REALTIME_FINAL_AUDIO_FALLBACK_SUCCEEDED', {
                meetingId: activeMeetingId,
                sessionId,
                transcriptRows: fallbackRows,
              })
            } else {
              const fallbackStatus = String(fallbackResponse.status ?? fallbackResponse.errorCode ?? 'NO_TRANSCRIPT')
              if (fallbackStatus === 'FAILED_AUDIO_CAPTURE') {
                setLiveLifecycleState('failed_audio_capture')
                setLiveError('Không nhận được âm thanh hợp lệ để nhận dạng.')
              } else if (fallbackStatus === 'FINAL_AUDIO_FALLBACK_UNAVAILABLE') {
                setLivePartialWarning('Transcript đã lưu nhưng không thể khôi phục phần đuôi từ audio fallback (WebM continuation không khả dụng).')
                console.info('[Realtime] REALTIME_FINAL_AUDIO_TAIL_RECOVERY_UNAVAILABLE', {
                  meetingId: activeMeetingId,
                  sessionId,
                  persistedTranscriptRows: mergedHydration.length,
                })
              }
              console.info('[Realtime] REALTIME_FINAL_AUDIO_FALLBACK_EMPTY', {
                meetingId: activeMeetingId,
                sessionId,
                status: fallbackStatus,
              })
            }
          } catch (fallbackError) {
            console.warn('[Realtime] REALTIME_FINAL_AUDIO_FALLBACK_FAILED', {
              meetingId: activeMeetingId,
              sessionId,
              error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            })
          }
        }
        if (noTranscriptAfterFinalize) {
          liveAnalysisAbortControllerRef.current?.abort()
          liveAnalysisAbortControllerRef.current = null
          analysisPollRunIdRef.current += 1
          setLiveLifecycleState('no_transcript_after_finalize')
          setLivePartialWarning('Chưa có transcript')
          setLiveStatusMessage('Đã dừng ghi âm (chưa có transcript)')
          setLiveAnalysis(null)
          setLiveAnalysisMetadata(buildLiveAnalysisMetadata(activeMeetingId, 'NO_ANALYSIS', {
            errorCode: 'NO_TRANSCRIPT_AFTER_FINALIZE',
            transcriptRows: 0,
            finalized: true,
          }))
          setLiveAnalysisStatus('pending')
          setLiveAnalysisError(null)
        }
        if (partialState && !noTranscriptAfterFinalize) {
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

      if (noTranscriptAfterFinalize) {
        setLiveLifecycleState('stopped_no_analysis')
      } else {
        setLiveLifecycleState('stopped')
      }
      setLiveError(null)
      if (!noTranscriptAfterFinalize) {
        setLiveStatusMessage('Đã dừng ghi âm')
      }
      if (completedMeetingId !== null && isCurrentRealtimeSessionToken(sessionToken) && !noTranscriptAfterFinalize) {
        startRealtimeAnalysisPolling(completedMeetingId, sessionId, sessionToken)
      }

      console.info('[Realtime] REALTIME_CLEANUP_DONE', {
        meetingId: liveMeetingIdRef.current,
        sessionId,
      })
      audioRecorder.cleanupRecordingResources()
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

  if (googleCallbackState === 'processing' || googleCallbackState === 'linking') {
    return (
      <main className="studio-auth-callback" aria-live="polite">
        <p>
          {googleCallbackState === 'linking'
            ? 'Đang chuyển sang Google để cấp quyền Calendar và Gmail…'
            : 'Đang hoàn tất đăng nhập Google...'}
        </p>
      </main>
    )
  }

  // Public legal pages must render without auth (Google OAuth branding verification).
  if (publicLegalKind) {
    return <PublicLegalPage kind={publicLegalKind} />
  }

  if (!isAuthenticated) {
    return (
      <StudioAuthPage
        authRoute={authRoute}
        onNavigate={navigateAuthRoute}
        username={username}
        password={password}
        onUsernameChange={setUsername}
        onPasswordChange={setPassword}
        onLogin={handleLogin}
        onGoogleLogin={handleGoogleLogin}
        googleLoginEnabled={GOOGLE_LOGIN_ENABLED}
        authError={authError}
        authNotice={authNotice}
        inviteMeetingId={readOpenMeetingId()}
        registerUsername={registerUsername}
        registerEmail={registerEmail}
        registerPassword={registerPassword}
        registerConfirmPassword={registerConfirmPassword}
        onRegisterUsernameChange={setRegisterUsername}
        onRegisterEmailChange={setRegisterEmail}
        onRegisterPasswordChange={setRegisterPassword}
        onRegisterConfirmPasswordChange={setRegisterConfirmPassword}
        onRegister={handleRegister}
        registerBusy={registerBusy}
        registerError={registerError}
      />
    )
  }

  return (
    <div className="app app--dashboard app--studio">
      {authNotice ? (
        <p className="studio-auth__notice studio-auth__notice--dashboard" data-testid="auth-notice-banner" role="status">
          {authNotice}
        </p>
      ) : null}
      <DashboardLayout
        user={dashboardUser}
        onLogout={handleLogout}
        activeMenu={featureScene}
        onNavigate={navigateFeatureScene}
        showRealtime={isRealtimeEnabled}
        recentFiles={recentFiles}
        onRecentFileClick={handleRecentFileClick}
        onOpenMeeting={handleOpenMeetingFromDashboard}
        globalMeetingSearch={globalMeetingSearch}
        onGlobalMeetingSearchChange={setGlobalMeetingSearch}
        onGlobalMeetingSearchSubmit={(query) => {
          setGlobalMeetingSearch(query)
          navigateFeatureScene('files')
        }}
      >
        <Suspense fallback={<LoadingState message="Đang tải màn hình..." />}>
          {renderDashboardScene()}
        </Suspense>
      </DashboardLayout>
    </div>
  )
}
