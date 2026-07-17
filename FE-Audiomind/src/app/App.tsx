import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import StudioAuthPage from '../components/auth/StudioAuthPage'
import PublicLegalPage from '../components/legal/PublicLegalPage'
import DashboardLayout, { type DashboardScene } from '../components/dashboard/DashboardLayout'
import { useAuthRouting } from './useAuthRouting'
import { useHistorySearchFilters } from './useHistorySearchFilters'
import { useRealtimeControls } from './useRealtimeControls'
import { useRealtimeLifecycleEffects } from './useRealtimeLifecycleEffects'
import { useRealtimeSession } from './useRealtimeSession'
import { useTerminalAudioCaptureCleanup } from './useTerminalAudioCaptureCleanup'
import { useRecentMeetingsSidebar } from './useRecentMeetingsSidebar'
import { useStudioRouteSync } from './useStudioRouteSync'
import { useInitialRedirectHandling } from './useInitialRedirectHandling'
import { buildLiveAnalysisMetadata } from './liveAnalysisMetadata'
import {
  isNoTranscriptTerminalLifecycle,
  isRealtimeLanguageSelectorDisabled,
  isRealtimeSpeakerModeSelectorDisabled,
  isRecordingSourceSelectorDisabled,
  type LiveLifecycleState,
} from './liveLifecycle'
import { StudyWorkspaceProvider } from '../contexts/StudyWorkspaceProvider'
import SubjectsListScene from '../components/subjects/SubjectsListScene'
import SubjectDetailScene from '../components/subjects/SubjectDetailScene'
import UnclassifiedMeetingsScene from '../components/subjects/UnclassifiedMeetingsScene'
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
import { useAudioRecorder } from '../hooks/useAudioRecorder'
import { useDualAudioRecorder, type DualTabMicStreamId } from '../hooks/useDualAudioRecorder'
import {
    normalizeRealtimeLanguage,
    normalizeRealtimeSpeakerMode,
    useRealtimeMeetingStream,
    type RealtimeLanguage,
    type RealtimeSessionToken,
    type RealtimeSpeakerMode,
    type RealtimeStatusEvent,
    type TranscriptSegment,
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
    type VoiceActivityState,
} from '../hooks/useVoiceActivityDetection'
import { useQuotaOverview } from '../hooks/useQuotaOverview'
import {
    isBrowserTabRecordingSource,
    REALTIME_FOCUS_MEET_CAPTURE_KEY,
    REALTIME_MEET_CAPTURE_TITLE_KEY,
    type RealtimeMeetCaptureContext,
    type RecordingSource,
} from '../constants/recordingSource'
import { normalizeDomainMode, type DomainMode } from '../constants/domainMode'
import { isOnboardingDismissed, loadUserPreferences, saveUserPreferences, applyServerDomainMode } from '../utils/userPreferences'
import {
  parseStudioRouteFromLocation,
  pushStudioRoute,
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
  applyPostAuthDestination,
  buildInviteGoogleRedirectAfter,
  readOpenMeetingId,
  resolvePostAuthDestination,
} from '../utils/inviteAuth'
import { realtimeInfo, realtimeWarn } from '../utils/realtimeTelemetry'
import { ApiError, getAnalysis, getProcessingStatus, getTranscript, getUserProfile, startProcessingByPath, updateUserPreferences, uploadToMeetingApi, type AnalysisScopeOptions } from '../services/api'
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
    REALTIME_DUAL_STREAM_TAB_MIC,
    REALTIME_NOISE_SUPPRESSION_TOGGLE_ENABLED,
    REALTIME_PREROLL_ENABLED,
    REALTIME_RECORDER_TIMESLICE_MS,
    REALTIME_RESUME_PREROLL_MS,
    REALTIME_START_PREROLL_MS,
    REALTIME_VAD_DYNAMIC_ENABLED,
    REALTIME_WS_ENABLED,
} from '../services/config'
import type { AiAnalysis } from '../types'
import {
    buildTranscriptEquivalenceSignature,
    mergeTranscriptSegments,
    mergeTranscriptSegmentsForDisplay,
    normalizePersistedTranscriptSegments,
    sortTranscriptSegmentsByTimeline,
} from '../utils/transcript'

export { DEFAULT_REALTIME_LANGUAGE } from '../hooks/useRealtimeMeetingStream'
export { getStatusBadgeClass } from '../utils/statusBadge'
export {
    buildTranscriptEquivalenceSignature,
    mergeHydratedTranscriptWithLive,
} from '../utils/transcript'
export type { LiveLifecycleState } from './liveLifecycle'
export {
  isFailedAudioCaptureLifecycle,
  isNoTranscriptTerminalLifecycle,
  isRealtimeTerminalLifecycle,
  isRealtimeLanguageSelectorDisabled,
  isRealtimeSpeakerModeSelectorDisabled,
  isRecordingSourceSelectorDisabled,
  resolveVoiceActivityLifecycleUpdate,
} from './liveLifecycle'

type ResultView = {
  meetingId: number
  status: string
  transcript: string
  transcriptSegments: TranscriptSegment[]
  analysis: AiAnalysis
}

type RealtimeConnectionView = {
  title: string
  detail: string
  closeReason: string | null
  closeReasonIsError: boolean
}

type GoogleCallbackState = 'idle' | 'processing' | 'linking'

const GOOGLE_LOGIN_ENABLED = import.meta.env.VITE_GOOGLE_LOGIN_ENABLED === 'true'
const PAYOS_ENABLED = import.meta.env.VITE_PAYOS_ENABLED === 'true'

const isUploadDebugLoggingEnabled = (): boolean => {
  if (import.meta.env.VITE_UPLOAD_DEBUG === 'true') {
    return true
  }
  try {
    return window.localStorage.getItem('audiomind.upload.debug') === 'true'
  } catch {
    return false
  }
}

const readInitialStudioRoute = (): ParsedStudioRoute => {
  if (typeof window === 'undefined') {
    return { scene: 'upload', meetingId: null, subjectId: null, resultScope: null }
  }
  return parseStudioRouteFromLocation() ?? { scene: 'upload', meetingId: null, subjectId: null, resultScope: null }
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
      title: 'Đang nghe',
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
      if (isUploadDebugLoggingEnabled()) {
        console.warn(`Polling failed, retrying in ${delay}ms...`, error)
      }
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
    realtimeWarn('[Realtime] ANALYSIS_SCOPE_UNAVAILABLE', {
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
      realtimeInfo('[Realtime] STALE_ANALYSIS_POLL_IGNORED', {
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
        realtimeInfo('[Realtime] STALE_ANALYSIS_POLL_IGNORED', {
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
        realtimeInfo('[Realtime] STALE_ANALYSIS_POLL_IGNORED', {
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
  realtimeInfo('[Realtime] Post-stop transcript hydration started', { meetingId, hydrationRunId: options.hydrationRunId })

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
    realtimeInfo('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, hydrationRunId: options.hydrationRunId, phase: 'before-wait' })
    return []
  }

  await new Promise((resolve) => setTimeout(resolve, HYDRATION_INITIAL_DELAY_MS))

  if (!isHydrationActive()) {
    realtimeInfo('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, hydrationRunId: options.hydrationRunId, phase: 'after-initial-wait' })
    return []
  }

  let stableCount = 0
  let previousSignature = ''
  let firstFragmentsAttempt: number | null = null
  let hasObservedFragments = false
  const forceStableHydration = Boolean(options.backendPartial || options.backendResetRequired)

  for (let attempt = 1; attempt <= HYDRATION_MAX_ATTEMPTS; attempt += 1) {
    if (!isHydrationActive()) {
      realtimeInfo('[Realtime] STALE_HYDRATION_IGNORED', {
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
          realtimeInfo('[Realtime] STALE_HYDRATION_IGNORED', {
            meetingId,
            attempt,
            hydrationRunId: options.hydrationRunId,
            phase: 'fetch-404',
          })
          return []
        }

        realtimeInfo('[Realtime] HYDRATION_NO_FRAGMENTS_RETRY', {
          meetingId,
          attempt,
          reason: 'transcript_404',
        })

        if (attempt < HYDRATION_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, HYDRATION_RETRY_DELAY_MS))

          if (!isHydrationActive()) {
            realtimeInfo('[Realtime] STALE_HYDRATION_IGNORED', {
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
        realtimeInfo('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, attempt, hydrationRunId: options.hydrationRunId, phase: 'fetch-error' })
        return []
      }

      throw error
    }

    if (!isHydrationActive()) {
      realtimeInfo('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, attempt, hydrationRunId: options.hydrationRunId, phase: 'post-fetch' })
      return []
    }

    if (isTranscriptNotReadyPayload(transcript)) {
      realtimeInfo('[Realtime] HYDRATION_NO_FRAGMENTS_RETRY', {
        meetingId,
        attempt,
        reason: 'transcript_not_ready',
      })

      if (attempt < HYDRATION_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, HYDRATION_RETRY_DELAY_MS))

        if (!isHydrationActive()) {
          realtimeInfo('[Realtime] STALE_HYDRATION_IGNORED', {
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

    realtimeInfo('[Realtime] Post-stop transcript hydration attempt', {
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
      realtimeInfo('[Realtime] HYDRATION_PERSISTED_BEHIND_LIVE', {
        meetingId,
        attempt,
        persistedFragments: hydratedSegments.length,
        liveFragments: liveSegmentsCount,
      })
    }

    realtimeInfo('[Realtime] HYDRATION_WAITING_FOR_STABLE_TRANSCRIPT', {
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
      realtimeInfo('[Realtime] HYDRATION_STABLE_COMPLETED', {
        meetingId,
        attempts: attempt,
        persistedFragments: hydratedSegments.length,
      })
      return hydratedSegments
    }

    if (forceStableHydration && hydratedSegments.length > 0 && stableEnough) {
      realtimeInfo('[Realtime] HYDRATION_STABLE_COMPLETED', {
        meetingId,
        attempts: attempt,
        persistedFragments: hydratedSegments.length,
        partialMode: true,
      })
      return hydratedSegments
    }

    if (hydratedSegments.length === 0) {
      realtimeInfo('[Realtime] HYDRATION_NO_FRAGMENTS_RETRY', {
        meetingId,
        attempt,
      })
    }

    if (attempt < HYDRATION_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, HYDRATION_RETRY_DELAY_MS))

      if (!isHydrationActive()) {
        realtimeInfo('[Realtime] STALE_HYDRATION_IGNORED', { meetingId, attempt, hydrationRunId: options.hydrationRunId, phase: 'retry-wait' })
        return []
      }
    }
  }

  realtimeInfo('[Realtime] Post-stop transcript hydration exhausted', {
    meetingId,
    attempts: HYDRATION_MAX_ATTEMPTS,
  })
  realtimeInfo('[Realtime] HYDRATION_NO_FRAGMENTS_COMPLETED', {
    meetingId,
    attempts: HYDRATION_MAX_ATTEMPTS,
  })
  if (!hasObservedFragments) {
    realtimeInfo('[Realtime] HYDRATION_TIMEOUT_NO_TRANSCRIPT', {
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
  /** True when the owning attempt/session changed mid-flight; caller must no-op. */
  stale?: boolean
}

export type LiveRecordingStopSequenceInput = {
  meetingId: number | null
  sessionId: number
  source?: string
  stopStream?: () => Promise<boolean>
  setLifecycleState: (state: LiveLifecycleState) => void
  /** Ownership predicate checked around every async boundary and lifecycle mutation. */
  isCurrentAttempt?: () => boolean
}

export async function runLiveRecordingStopSequence(
  input: LiveRecordingStopSequenceInput,
): Promise<LiveRecordingStopSequenceResult> {
  const isCurrentAttempt = input.isCurrentAttempt ?? (() => true)

  if (!isCurrentAttempt()) {
    return { stopSent: false, stopIncomplete: false, stale: true }
  }

  realtimeInfo('[Realtime] REALTIME_STOP_REQUESTED', {
    meetingId: input.meetingId,
    sessionId: input.sessionId,
    ...(input.source ? { source: input.source } : {}),
    phase: 'stream_finalize',
  })

  if (!isCurrentAttempt()) {
    return { stopSent: false, stopIncomplete: false, stale: true }
  }
  input.setLifecycleState('stopping')

  let stopSent = false
  if (input.stopStream) {
    if (!isCurrentAttempt()) {
      return { stopSent: false, stopIncomplete: false, stale: true }
    }
    stopSent = await input.stopStream()
    if (!isCurrentAttempt()) {
      return { stopSent: false, stopIncomplete: false, stale: true }
    }
  }

  if (!isCurrentAttempt()) {
    return { stopSent: false, stopIncomplete: false, stale: true }
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
  const { authRoute, publicLegalKind, navigateAuthRoute } = useAuthRouting()
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
  const [selectedSubjectId, setSelectedSubjectId] = useState<number | null>(initialStudioRoute.subjectId ?? null)
  const [selectedUploadSubjectId, setSelectedUploadSubjectId] = useState<number | null>(null)
  const [selectedRealtimeSubjectId, setSelectedRealtimeSubjectId] = useState<number | null>(null)
  const {
    globalMeetingSearch,
    setGlobalMeetingSearch,
    historyStatusFilter,
    setHistoryStatusFilter,
    historyLanguageFilter,
    setHistoryLanguageFilter,
  } = useHistorySearchFilters()
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
  const { recentMeetings, refreshRecentMeetings } = useRecentMeetingsSidebar(isAuthenticated)
  const [joinMeetingIdInput, setJoinMeetingIdInput] = useState('')
  const [showJoinOtherMeeting, setShowJoinOtherMeeting] = useState(false)
  const [hydratedLiveTranscriptSegments, setHydratedLiveTranscriptSegments] = useState<TranscriptSegment[] | null>(null)
  const [liveLifecycleState, setLiveLifecycleState] = useState<LiveLifecycleState>('idle')
  const [activeRealtimeSessionToken, setActiveRealtimeSessionToken] = useState<RealtimeSessionToken | null>(null)
  const {
    selectedRealtimeLanguage,
    setSelectedRealtimeLanguage,
    selectedRealtimeSpeakerMode,
    setSelectedRealtimeSpeakerMode,
    selectedMicSensitivity,
    setSelectedMicSensitivity,
    selectedRecordingSource,
    selectedRecordingSourceRef,
    noiseSuppressionEnabled,
    setNoiseSuppressionEnabled,
    handleRecordingSourceChange,
    selectMeetCaptureSource,
  } = useRealtimeControls()
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
  const tabTrackEndedFinalizeRef = useRef(false)
  const gracefulStopRef = useRef<(() => Promise<void>) | null>(null)
  const quotaBillingRedirectRef = useRef(false)
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
    noiseSuppressionEnabled,
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

  const {
    failedAudioCaptureCleanupKeyRef,
    runTerminalAudioCaptureCleanupRef,
  } = useTerminalAudioCaptureCleanup({
    audioRecorder,
    realtimeStream,
    activeRealtimeSessionTokenRef,
    liveMeetingIdRef,
    liveAnalysisAbortControllerRef,
    analysisPollRunIdRef,
    setLiveLifecycleState,
    setLiveError,
    setLiveAnalysis,
    setLiveAnalysisMetadata,
    setLiveAnalysisStatus,
    setLiveAnalysisError,
    setLivePartialWarning,
    setLiveStatusMessage,
  })

  useRealtimeLifecycleEffects({
    audioRecorder,
    realtimeStream,
    voiceActivity,
    dualStreamActive,
    selectedRecordingSource,
    selectedRecordingSourceRef,
    selectedRealtimeLanguage,
    selectedRealtimeSpeakerMode,
    selectedMicSensitivity,
    noiseSuppressionEnabled,
    noiseSuppressionSupported,
    activeRealtimeSessionToken,
    activeRealtimeSessionTokenRef,
    liveLifecycleState,
    liveMeetingIdRef,
    liveAnalysisAbortControllerRef,
    analysisPollRunIdRef,
    resetRecoveryInProgressRef,
    restartAfterReconnectRef,
    tabTrackEndedFinalizeRef,
    gracefulStopRef,
    lastVoiceActivityStateRef,
    onTabAudioTrackEndedRef,
    onTabCaptureFailureRef,
    onTabPipelineStalledRef,
    runTerminalAudioCaptureCleanupRef,
    setLiveLifecycleState,
    setLiveError,
    setLiveStatusMessage,
    setLivePartialWarning,
    setLiveAnalysis,
    setLiveAnalysisMetadata,
    setLiveAnalysisStatus,
    setLiveAnalysisError,
  })


  useInitialRedirectHandling({
    abortControllerRef,
    liveAnalysisAbortControllerRef,
    setIsAuthenticated,
    setFeatureScene,
    setHistoryAnalysisMeetingId,
    setHistoryAnalysisScope,
    setMindmapSelectedMeetingId,
    setMindmapSelectedScope,
    setBillingActivationOrderCode,
    setBillingPaymentNotice,
    setGoogleIntegrationNotice,
    setZoomIntegrationNotice,
    setZoomIntegrationNoticeTone,
    setTeamsIntegrationNotice,
    setTeamsIntegrationNoticeTone,
    setOauthRefreshTick,
    setSessionPlanSyncTick,
    setGoogleCallbackState,
    setAuthError,
    setAuthNotice,
    syncUserPreferencesFromServer,
  })

  useEffect(() => {
    liveMeetingIdRef.current = liveMeetingId
  }, [liveMeetingId])

  const navigateFeatureScene = useCallback((
    scene: DashboardScene,
    options?: {
      meetingId?: number | null
      subjectId?: number | null
      resultScope?: MeetingResultScope | null
      replace?: boolean
    },
  ) => {
    setFeatureScene(scene)
    const meetingId = options?.meetingId
    const subjectId = options?.subjectId
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
    if (subjectId != null && Number.isFinite(subjectId) && subjectId > 0) {
      setSelectedSubjectId(subjectId)
    } else if (scene !== 'subjectDetail') {
      setSelectedSubjectId(null)
    }
    pushStudioRoute(scene, {
      meetingId,
      subjectId,
      resultScope: options?.resultScope ?? null,
      replace: options?.replace,
    })
  }, [])

  const handleNavigateBilling = useCallback(() => {
    navigateFeatureScene('billing')
  }, [navigateFeatureScene])


  const {
    activateRealtimeSessionToken,
    handlePrepareLiveMeeting,
    handleLiveChunkReady,
    handleLiveRecordingComplete,
    handleLiveAnalysisRetry,
    handleJoinMeeting,
    handleStopRequested,
  } = useRealtimeSession({
    audioRecorder,
    realtimeStream,
    dualStreamActive,
    selectedDomainMode,
    selectedSubjectId: selectedRealtimeSubjectId,
    selectedRealtimeLanguage,
    selectedRecordingSource,
    selectedRecordingSourceRef,
    joinMeetingIdInput,
    liveLifecycleState,
    liveAnalysisMetadata,
    activeRealtimeSessionTokenRef,
    liveMeetingIdRef,
    liveRecordingSessionIdRef,
    realtimeAttemptIdRef,
    hydrationRunIdRef,
    analysisPollRunIdRef,
    liveTinyChunkStreakRef,
    liveAnalysisAbortControllerRef,
    handleDualChunkReadyRef,
    navigateFeatureScene,
    setActiveRealtimeSessionToken,
    setLiveMeetingId,
    setLiveError,
    setLiveErrorCode,
    setLivePartialWarning,
    setLiveStatusMessage,
    setLiveAnalysis,
    setLiveAnalysisMetadata,
    setLiveAnalysisStatus,
    setLiveAnalysisError,
    setHydratedLiveTranscriptSegments,
    setLiveLifecycleState,
    setShowJoinOtherMeeting,
    runTerminalAudioCaptureCleanupRef,
    failedAudioCaptureCleanupKeyRef,
    sessionHelpers: {
      pollRealtimeAnalysisAfterStop,
      hydrateLiveTranscriptSegments,
      runLiveRecordingStopSequence,
      beginGracefulStopLifecycle,
      resolveFreshRealtimeMeetingId,
      shouldAttemptRealtimeFinalAudioFallback,
      buildFinalAudioBlobReadyLogPayload,
      resolveTranscriptPartialState,
      isCurrentLiveRecordingSession,
    },
    analysisHelpers: {
      getRealtimeAnalysisFailureMessage,
      metadataFromAnalysisError,
      hasStructuredAnalysisData,
      getAnalysisStatusValue,
      isFailedAnalysisStatus,
    },
  })

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

  useStudioRouteSync(
    {
      setFeatureScene,
      setHistoryAnalysisMeetingId,
      setHistoryAnalysisScope,
      setMindmapSelectedMeetingId,
      setMindmapSelectedScope,
      setSelectedSubjectId,
    },
    {
      setGoogleIntegrationNotice,
      setZoomIntegrationNotice,
      setZoomIntegrationNoticeTone,
      setTeamsIntegrationNotice,
      setTeamsIntegrationNoticeTone,
      bumpOauthRefreshTick: () => setOauthRefreshTick((tick) => tick + 1),
    },
  )

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

      setAuthNotice('Đăng ký thành công. Bạn được dùng gói Pro miễn phí 3 ngày sau khi đăng nhập.')
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
    selectMeetCaptureSource(source)
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
  }, [navigateFeatureScene, selectMeetCaptureSource])

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

    // Preserve canonical persisted IDs for education evidence navigation.
    // FeatureAnalysis/TranscriptDisplay handles visual grouping separately.
    const mergedTranscriptSegments = sortTranscriptSegmentsByTimeline(
      normalizePersistedTranscriptSegments(transcript.transcripts || []),
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
      if (isUploadDebugLoggingEnabled()) {
        console.info('UPLOAD_REQUEST_SEND language=' + effectiveUploadLanguage)
      }
      const meeting = await uploadToMeetingApi({
        title: file.name,
        file,
        language: effectiveUploadLanguage,
        subjectId: selectedUploadSubjectId,
      })
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

        setUploadNotice('File này đang được xử lý. Vui lòng đợi hoặc mở Lịch sử cuộc họp.')
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
      if (isUploadDebugLoggingEnabled()) {
        console.error('handleProcess error:', error)
      }
    } finally {
      abortControllerRef.current = null
      setBusy(false)
    }
  }

  const handleCancel = () => {
    abortControllerRef.current?.abort()
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
        setUploadNotice('Đã nhập cuộc họp. Kiểm tra Lịch sử cuộc họp nếu phân tích chưa chạy.')
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
          selectedSubjectId={selectedRealtimeSubjectId}
          onSubjectIdChange={setSelectedRealtimeSubjectId}
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
          onStopRequested={handleStopRequested}
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

    if (featureScene === 'subjects') {
      return (
        <SubjectsListScene
          onOpenSubject={(subjectId) => navigateFeatureScene('subjectDetail', { subjectId })}
          onNavigateUnclassified={() => navigateFeatureScene('unclassified')}
        />
      )
    }

    if (featureScene === 'subjectDetail' && selectedSubjectId != null) {
      return (
        <SubjectDetailScene
          subjectId={selectedSubjectId}
          onOpenMeeting={(meetingId) => navigateFeatureScene('analysis', { meetingId })}
          onBack={() => navigateFeatureScene('subjects')}
        />
      )
    }

    if (featureScene === 'unclassified') {
      return (
        <UnclassifiedMeetingsScene
          onOpenMeeting={(meetingId) => navigateFeatureScene('analysis', { meetingId })}
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
          statusFilter={historyStatusFilter}
          onStatusFilterChange={setHistoryStatusFilter}
          languageFilter={historyLanguageFilter}
          onLanguageFilterChange={setHistoryLanguageFilter}
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
        selectedSubjectId={selectedUploadSubjectId}
        onSubjectIdChange={setSelectedUploadSubjectId}
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
    <StudyWorkspaceProvider>
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
        globalStatusFilter={historyStatusFilter}
        onGlobalStatusFilterChange={setHistoryStatusFilter}
        globalLanguageFilter={historyLanguageFilter}
        onGlobalLanguageFilterChange={setHistoryLanguageFilter}
        onGlobalMeetingSearchSubmit={(query) => {
          setGlobalMeetingSearch(query)
          navigateFeatureScene('files')
        }}
        selectedSubjectId={selectedSubjectId}
        onNavigateSubjects={() => navigateFeatureScene('subjects')}
        onNavigateSubjectDetail={(subjectId) => navigateFeatureScene('subjectDetail', { subjectId })}
        onNavigateUnclassified={() => navigateFeatureScene('unclassified')}
      >
        <Suspense fallback={<LoadingState message="Đang tải màn hình..." />}>
          {renderDashboardScene()}
        </Suspense>
      </DashboardLayout>
    </div>
    </StudyWorkspaceProvider>
  )
}
