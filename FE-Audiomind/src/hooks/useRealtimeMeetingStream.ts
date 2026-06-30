import { useCallback, useEffect, useRef, useState } from 'react'
import { getAccessToken } from '../services/auth'
import { REALTIME_WS_BASE_URL } from '../services/config'
import { normalizeTranscriptEvent, upsertTranscriptSegment } from '../utils/transcript'

export interface TranscriptSegment {
  id: string
  mergeKey?: string
  speaker: string
  text: string
  start: number
  end: number
  timestamp?: number
  confidence?: number
  language?: string
  isFinal?: boolean
  source?: 'live' | 'hydration'
  streamId?: 'tab' | 'mic'
  providerSpeaker?: string
  originalSpeaker?: string
  providerSpeakers?: string[]
  originalSpeakers?: string[]
  originalIndex?: number
}

export interface KeywordHit {
  id: string
  keyword: string
  confidence: number
  position: number
  definition?: string
}

export interface RealtimeStatusEvent {
  state: 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'stopped' | 'completed' | 'NO_TRANSCRIPT_AFTER_FINALIZE' | 'FAILED_AUDIO_CAPTURE'
  activeConnections?: number
  lagMs?: number
  message?: string
  resetRequired?: boolean
  status?: string
  errorCode?: string
  analysisStatus?: string
  transcriptRows?: number
  finalized?: boolean
  dualStreamBackendEnabled?: boolean
}

export type RealtimeLanguage = 'vi' | 'en' | 'multi'
export type RealtimeSpeakerMode = 'single' | 'multiple'

export const REALTIME_MAX_CHUNK_BYTES = 1_048_576

export const DEFAULT_REALTIME_LANGUAGE: RealtimeLanguage = 'vi'
export const DEFAULT_REALTIME_SPEAKER_MODE: RealtimeSpeakerMode = 'single'

export const normalizeRealtimeLanguage = (language?: string | null): RealtimeLanguage => {
  if (language === 'en' || language === 'multi') {
    return language
  }

  return DEFAULT_REALTIME_LANGUAGE
}

export const normalizeRealtimeSpeakerMode = (speakerMode?: string | null): RealtimeSpeakerMode => {
  if (speakerMode === 'multiple') {
    return speakerMode
  }

  return DEFAULT_REALTIME_SPEAKER_MODE
}

export type RealtimeAudioStreamId = 'tab' | 'mic'

interface UseRealtimeMeetingStreamOptions {
  meetingId: number | null
  userId: number | null
  token?: string
  sessionToken?: RealtimeSessionToken | null
  language?: RealtimeLanguage
  speakerMode?: RealtimeSpeakerMode
  domainMode?: string
  enabled?: boolean
  dualStream?: boolean
  activeStreams?: RealtimeAudioStreamId[]
  onTranscript?: (segment: TranscriptSegment) => void
  onKeyword?: (hit: KeywordHit) => void
  onStatusChange?: (status: RealtimeStatusEvent) => void
  autoReconnect?: boolean
  reconnectAttempts?: number
  reconnectDelay?: number
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

type PendingAudioChunk = {
  type: 'audio.chunk'
  metadata: Record<string, unknown>
  binary: ArrayBuffer
  sessionToken: RealtimeSessionToken
}

type PendingQueueItem =
  | { kind: 'raw'; payload: string }
  | { kind: 'audio'; payload: PendingAudioChunk }

export interface RealtimeSessionToken {
  meetingId: number
  recordingSessionId: number
  attemptId: number
  connectionSeq: number
}

type SessionReadyWaiter = {
  expectedMeetingId: number | null
  expectedConnectionSeq: number
  expectedRecordingSessionId: number
  expectedAttemptId: number
  resolve: () => void
  reject: (error: Error) => void
  timeoutId: number
}

const DEFAULT_WS_URL = REALTIME_WS_BASE_URL
const AUDIO_SAMPLE_RATE = 48_000
const STOP_DRAIN_TIMEOUT_MS = 1500
const STOP_DRAIN_POLL_MS = 25

const toNumber = (...values: unknown[]): number => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }

  return 0
}

const toStringValue = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }

  return ''
}

const readBlobAsArrayBuffer = async (blob: Blob): Promise<ArrayBuffer> => {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer()
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(reader.result as ArrayBuffer)
    }
    reader.onerror = () => {
      reject(reader.error ?? new Error('Failed to read blob'))
    }
    reader.readAsArrayBuffer(blob)
  })
}

export const useRealtimeMeetingStream = (options: UseRealtimeMeetingStreamOptions) => {
  const {
    meetingId,
    userId,
    token,
    sessionToken = null,
    language = DEFAULT_REALTIME_LANGUAGE,
    speakerMode = DEFAULT_REALTIME_SPEAKER_MODE,
    domainMode = 'it',
    enabled = true,
    onTranscript,
    onKeyword,
    onStatusChange,
    autoReconnect = true,
    reconnectAttempts = 5,
    reconnectDelay = 1000,
    dualStream = false,
    activeStreams = ['tab', 'mic'],
  } = options

  const [isConnected, setIsConnected] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [transcripts, setTranscripts] = useState<TranscriptSegment[]>([])
  const [keywords, setKeywords] = useState<KeywordHit[]>([])
  const [status, setStatus] = useState<RealtimeStatusEvent>({ state: 'disconnected' })
  const [closeReason, setCloseReason] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const reconnectCountRef = useRef(0)
  const pendingQueueRef = useRef<PendingQueueItem[]>([])
  const sessionReadyWaitersRef = useRef<SessionReadyWaiter[]>([])
  const activeSessionTokenRef = useRef<RealtimeSessionToken | null>(null)
  const audioSequenceRef = useRef(0)
  const tabAudioSequenceRef = useRef(0)
  const micAudioSequenceRef = useRef(0)
  const sendChainRef = useRef(Promise.resolve())
  const dualStreamRef = useRef(dualStream)
  const activeStreamsRef = useRef<RealtimeAudioStreamId[]>(activeStreams)
  const connectionSequenceRef = useRef(0)
  const readyConnectionSeqRef = useRef(0)
  const readyMeetingIdRef = useRef<number | null>(null)
  const lastTranscriptAtRef = useRef<number>(0)
  const lastChunkSentAtRef = useRef<number>(0)
  const firstChunkSentAtRef = useRef<number>(0)
  const stalledWarningLoggedRef = useRef(false)
  const effectRunCountRef = useRef(0)
  const connectRef = useRef<() => void>(() => {})
  const userStopRequestedRef = useRef(false)
  const streamStopSentRef = useRef(false)
  const selectedLanguageRef = useRef<RealtimeLanguage>(DEFAULT_REALTIME_LANGUAGE)
  const selectedSpeakerModeRef = useRef<RealtimeSpeakerMode>(DEFAULT_REALTIME_SPEAKER_MODE)
  const selectedDomainModeRef = useRef<string>('it')

  const resolvedToken = token || getAccessToken() || ''
  const canConnect = enabled && meetingId !== null && userId !== null && resolvedToken.trim().length > 0 && sessionToken !== null

  useEffect(() => {
    selectedLanguageRef.current = normalizeRealtimeLanguage(language)
  }, [language])

  useEffect(() => {
    selectedSpeakerModeRef.current = normalizeRealtimeSpeakerMode(speakerMode)
  }, [speakerMode])

  useEffect(() => {
    selectedDomainModeRef.current = String(domainMode || 'it').trim() || 'it'
  }, [domainMode])

  useEffect(() => {
    dualStreamRef.current = dualStream
    activeStreamsRef.current = activeStreams
  }, [activeStreams, dualStream])

  const isSameSessionToken = useCallback((left: RealtimeSessionToken | null, right: RealtimeSessionToken | null) => {
    if (!left || !right) {
      return false
    }

    return (
      left.meetingId === right.meetingId
      && left.recordingSessionId === right.recordingSessionId
      && left.attemptId === right.attemptId
      && left.connectionSeq === right.connectionSeq
    )
  }, [])

  const isActiveSessionToken = useCallback((candidate: RealtimeSessionToken | null) => {
    return isSameSessionToken(candidate, activeSessionTokenRef.current)
  }, [isSameSessionToken])

  useEffect(() => {
    activeSessionTokenRef.current = sessionToken
  }, [sessionToken])

  const updateStatus = useCallback((newStatus: RealtimeStatusEvent) => {
    setStatus(newStatus)
    onStatusChange?.(newStatus)
  }, [onStatusChange])

  const sendRaw = useCallback((message: JsonValue) => {
    const serialized = JSON.stringify(message)
    if (!wsRef.current) {
      console.warn('[Realtime] WebSocket not initialized, queuing message')
      pendingQueueRef.current.push({ kind: 'raw', payload: serialized })
      return
    }

    try {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(serialized)
        return
      }

      if (wsRef.current.readyState === WebSocket.CONNECTING) {
        pendingQueueRef.current.push({ kind: 'raw', payload: serialized })
        return
      }

      console.warn('[Realtime] WebSocket not open (state=' + wsRef.current.readyState + '), queuing message')
      pendingQueueRef.current.push({ kind: 'raw', payload: serialized })
    } catch (error) {
      console.error('[Realtime] Error in sendRaw:', error)
      pendingQueueRef.current.push({ kind: 'raw', payload: serialized })
    }
  }, [])

  const flushPendingMessages = useCallback((allowAudio: boolean) => {
    const websocket = wsRef.current
    const stats = { queuedAudioChunks: 0, flushedAudioChunks: 0, flushedBytes: 0, droppedStaleAudioChunks: 0 }
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      return stats
    }

    stats.queuedAudioChunks = pendingQueueRef.current.filter((item) => item.kind === 'audio').length

    // Drain the unified pending queue in FIFO order. Each item is either a raw
    // serialized string or a paired audio package. This preserves enqueue
    // ordering across both kinds and guarantees metadata is immediately
    // followed by its binary buffer.
    while (pendingQueueRef.current.length > 0) {
      const item = pendingQueueRef.current.shift()
      if (!item) continue

      if (item.kind === 'raw') {
        try {
          websocket.send(item.payload)
        } catch (err) {
          console.error('[Realtime] Failed to send queued raw message:', err)
          // push back and abort flush to avoid reordering
          pendingQueueRef.current.unshift(item)
          break
        }
        continue
      }

      if (!allowAudio) {
        pendingQueueRef.current.unshift(item)
        break
      }

      if (!isActiveSessionToken(item.payload.sessionToken)) {
        stats.droppedStaleAudioChunks += 1
        console.warn('[Realtime] REALTIME_DROP_AUDIO_CHUNK', {
          meetingId: item.payload.sessionToken.meetingId,
          recordingSessionId: item.payload.sessionToken.recordingSessionId,
          attemptId: item.payload.sessionToken.attemptId,
          connectionSeq: connectionSequenceRef.current,
          reason: 'stale_session_token_flush',
        })
        continue
      }

      // audio item
      try {
        websocket.send(JSON.stringify(item.payload.metadata))
      } catch (err) {
        console.error('[Realtime] Failed to send queued metadata:', err)
        pendingQueueRef.current.unshift(item)
        break
      }

      try {
        websocket.send(item.payload.binary)
        stats.flushedAudioChunks += 1
        stats.flushedBytes += item.payload.binary.byteLength
        console.info('[Realtime] AUDIO_CHUNK_SEND_FLUSHED', {
          meetingId: item.payload.sessionToken.meetingId,
          recordingSessionId: item.payload.sessionToken.recordingSessionId,
          attemptId: item.payload.sessionToken.attemptId,
          seq: item.payload.metadata.seq,
          queueDepth: pendingQueueRef.current.filter((queued) => queued.kind === 'audio').length,
          bufferedAmount: websocket.bufferedAmount,
          tsMs: item.payload.metadata.ts_ms,
        })
      } catch (err) {
        console.error('[Realtime] Failed to send queued audio binary:', err)
        pendingQueueRef.current.unshift(item)
        break
      }
    }
    return stats
  }, [isActiveSessionToken])

  const clearPendingQueue = useCallback((reason = 'manual') => {
    const lastSeq = audioSequenceRef.current
    const queueDepth = pendingQueueRef.current.length
    pendingQueueRef.current = []
    audioSequenceRef.current = 0
    tabAudioSequenceRef.current = 0
    micAudioSequenceRef.current = 0
    sendChainRef.current = Promise.resolve()
    console.info('[Realtime] REALTIME_QUEUE_CLEARED', {
      meetingId,
      lastSeq,
      queueDepth,
      reason,
    })
  }, [meetingId])

  const waitForBufferedAmountToDrain = useCallback(async (timeoutMs = STOP_DRAIN_TIMEOUT_MS) => {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      const websocket = wsRef.current
      if (!websocket || websocket.readyState !== WebSocket.OPEN || websocket.bufferedAmount <= 0) {
        return true
      }

      await new Promise((resolve) => window.setTimeout(resolve, STOP_DRAIN_POLL_MS))
    }

    return (wsRef.current?.bufferedAmount ?? 0) <= 0
  }, [])

  const clearSessionReadyState = useCallback(() => {
    readyConnectionSeqRef.current = 0
    readyMeetingIdRef.current = null
  }, [])

  const rejectSessionReadyWaiters = useCallback((reason: string, expectedMeetingId: number | null, expectedAttemptId: number, expectedRecordingSessionId: number) => {
    const remainingWaiters: SessionReadyWaiter[] = []

    sessionReadyWaitersRef.current.forEach((waiter) => {
      const isMatchingWaiter =
        waiter.expectedMeetingId === expectedMeetingId &&
        waiter.expectedAttemptId === expectedAttemptId &&
        waiter.expectedRecordingSessionId === expectedRecordingSessionId

      if (!isMatchingWaiter) {
        remainingWaiters.push(waiter)
        return
      }

      window.clearTimeout(waiter.timeoutId)
      waiter.reject(new Error(reason))
    })

    sessionReadyWaitersRef.current = remainingWaiters
  }, [])

  const resolveSessionReadyWaiters = useCallback((expectedMeetingId: number | null, actualConnectionSeq: number, expectedAttemptId: number, expectedRecordingSessionId: number) => {
    const remainingWaiters: SessionReadyWaiter[] = []

    sessionReadyWaitersRef.current.forEach((waiter) => {
      const isMatchingWaiter =
        waiter.expectedMeetingId === expectedMeetingId &&
        waiter.expectedAttemptId === expectedAttemptId &&
        waiter.expectedRecordingSessionId === expectedRecordingSessionId

      if (!isMatchingWaiter) {
        remainingWaiters.push(waiter)
        return
      }

      window.clearTimeout(waiter.timeoutId)
      console.info('[Realtime] READY_WAITER_RESOLVED', {
        meetingId: waiter.expectedMeetingId,
        attemptId: waiter.expectedAttemptId,
        connectionSeq: actualConnectionSeq,
      })
      waiter.resolve()
    })

    sessionReadyWaitersRef.current = remainingWaiters
  }, [])

  const clearQueuedAudio = useCallback(() => {
    clearPendingQueue()
  }, [clearPendingQueue])

  const disconnect = useCallback((expectedToken?: RealtimeSessionToken | null) => {
    const tokenToUse = expectedToken ?? activeSessionTokenRef.current
    if (!isActiveSessionToken(tokenToUse)) {
      return
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    // Keep disconnect logs short and session-scoped for restart debugging.
    // eslint-disable-next-line no-console
    console.info('[Realtime] REALTIME_WS_DISCONNECT', {
      meetingId,
      connectionSeq: connectionSequenceRef.current,
    })

    clearPendingQueue('disconnect')
    rejectSessionReadyWaiters(
      'Realtime session disconnected before it became ready',
      meetingId,
      tokenToUse?.attemptId ?? 0,
      tokenToUse?.recordingSessionId ?? 0,
    )
    clearSessionReadyState()

    if (wsRef.current) {
      wsRef.current.close()
    }

    setIsAuthenticated(false)
    setIsConnected(false)
  }, [clearPendingQueue, clearSessionReadyState, isActiveSessionToken, meetingId, rejectSessionReadyWaiters])

  const connect = useCallback(() => {
    if (!canConnect || meetingId === null || userId === null) {
      return
    }

    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return
    }

    try {
      const wsUrl = new URL(DEFAULT_WS_URL)
      wsUrl.pathname = `/ws/meetings/${meetingId}`

      connectionSequenceRef.current += 1
      const connectionSeq = connectionSequenceRef.current
      clearSessionReadyState()

      const websocket = new WebSocket(wsUrl.toString())
      const isCurrentConnection = () => wsRef.current === websocket && connectionSequenceRef.current === connectionSeq

      websocket.onopen = () => {
        if (!isCurrentConnection()) {
          return
        }

        userStopRequestedRef.current = false
        setIsConnected(true)
        setIsAuthenticated(false)
        reconnectCountRef.current = 0
        updateStatus({ state: 'connected', activeConnections: 1 })

        console.info('[Realtime] REALTIME_WS_OPEN', {
          meetingId,
          connectionSeq,
        })

        console.info('[Realtime] REALTIME_AUTH_INIT_SEND', {
          meetingId,
          connectionSeq,
          language: selectedLanguageRef.current,
          speakerMode: selectedSpeakerModeRef.current,
        })

        websocket.send(JSON.stringify({
          type: 'auth.init',
          token: resolvedToken,
          userId,
          meetingId,
          language: selectedLanguageRef.current,
          speakerMode: selectedSpeakerModeRef.current,
          domainMode: selectedDomainModeRef.current,
          ...(dualStreamRef.current
            ? {
                dualStream: true,
                activeStreams: activeStreamsRef.current,
              }
            : {}),
        }))

        flushPendingMessages(false)
      }

      websocket.onmessage = (event) => {
        if (!isCurrentConnection()) {
          return
        }

        try {
          const data = JSON.parse(event.data) as Record<string, unknown>
          const messageType = toStringValue(data.type)

          switch (messageType) {
            case 'session.ready': {
              console.info('[Realtime] REALTIME_SESSION_READY', {
                meetingId,
                connectionSeq,
              })
              updateStatus({
                state: 'connected',
                activeConnections: toNumber(data.activeConnections),
                dualStreamBackendEnabled: data.dualStreamBackendEnabled === undefined
                  ? undefined
                  : Boolean(data.dualStreamBackendEnabled),
              })
              // mark authenticated when backend indicates it
              const authenticated = Boolean(data.authenticated || data.auth || false)
              const readyMeetingId = toNumber(data.meetingId, data.meeting_id, meetingId)
              if (authenticated && readyMeetingId !== meetingId) {
                console.warn('[Realtime] REALTIME_DROP_STALE_READY', {
                  readyMeetingId,
                  currentMeetingId: meetingId,
                  connectionSeq,
                })
                break
              }
              if (authenticated) {
                readyConnectionSeqRef.current = connectionSeq
                readyMeetingIdRef.current = meetingId
                setIsAuthenticated(true)
                // flush queued messages and binary now that session is ready
                const flushStats = flushPendingMessages(true)
                console.info('[Realtime] RECORDING_WS_READY', {
                  meetingId,
                  recordingSessionId: sessionToken?.recordingSessionId ?? null,
                  attemptId: sessionToken?.attemptId ?? null,
                  connectionSeq,
                  queuedAudioChunks: flushStats.queuedAudioChunks,
                  flushedChunks: flushStats.flushedAudioChunks,
                  flushedBytes: flushStats.flushedBytes,
                  droppedStaleAudioChunks: flushStats.droppedStaleAudioChunks,
                  flushStartPreroll: flushStats.flushedAudioChunks > 0,
                })
                resolveSessionReadyWaiters(
                  meetingId,
                  connectionSeq,
                  sessionToken?.attemptId ?? 0,
                  sessionToken?.recordingSessionId ?? 0,
                )
              }
              break
            }
            case 'transcript.partial':
            case 'transcript.final': {
              const nextSegment = normalizeTranscriptEvent(data, messageType, { fallbackSpeaker: 'SPEAKER_1' })
              if (!nextSegment) {
                break
              }

              lastTranscriptAtRef.current = Date.now()
              stalledWarningLoggedRef.current = false

              setTranscripts((current) => {
                return upsertTranscriptSegment(current, nextSegment).segments
              })
              onTranscript?.(nextSegment)
              break
            }
            case 'keyword.hit': {
              const ranges = Array.isArray(data.ranges) ? data.ranges : []
              const hit: KeywordHit = {
                id: toStringValue(data.keywordId, data.keyword_id, data.id, `kw-${Date.now()}`),
                keyword: toStringValue(data.term, data.keyword),
                confidence: typeof data.confidence === 'number' ? data.confidence : 0.8,
                position: toNumber(ranges[0]),
                definition: toStringValue(data.definition) || undefined,
              }

              setKeywords((current) => [...current, hit])
              onKeyword?.(hit)
              break
            }
            case 'stream.status': {
              const incomingState = toStringValue(data.state, data.status)
              const nextState =
                incomingState === 'reconnecting'
                  ? 'reconnecting'
                  : incomingState === 'NO_TRANSCRIPT'
                    || incomingState === 'NO_TRANSCRIPT_AFTER_FINALIZE'
                    ? 'NO_TRANSCRIPT_AFTER_FINALIZE'
                  : incomingState === 'FAILED_AUDIO_CAPTURE'
                    ? 'FAILED_AUDIO_CAPTURE'
                  : incomingState === 'FINALIZING'
                    ? 'connected'
                  : incomingState === 'partial'
                    ? 'completed'
                  : incomingState === 'completed_with_no_speech_detected'
                    ? 'completed'
                    : incomingState === 'completed' || incomingState === 'stopped'
                      ? incomingState
                      : 'connected'
              updateStatus({
                state: nextState,
                activeConnections: toNumber(data.activeConnections),
                lagMs: toNumber(data.lagMs),
                message: toStringValue(data.message) || undefined,
                resetRequired: Boolean(data.resetRequired || data.reset_required),
                status: toStringValue(data.status) || undefined,
                errorCode: toStringValue(data.errorCode, data.error_code) || undefined,
                analysisStatus: toStringValue(data.analysisStatus, data.analysis_status) || undefined,
                transcriptRows: toNumber(data.transcriptRows, data.transcript_rows),
                finalized: Boolean(data.finalized),
              })
              break
            }
            case 'error': {
              const errorCode = toStringValue(data.errorCode, data.error_code) || undefined
              const message = toStringValue(data.message) || 'Stream error'
              updateStatus({ state: 'error', message, errorCode, resetRequired: true })
              break
            }
            case 'stream.error': {
              const errorCode = toStringValue(data.errorCode, data.error_code) || undefined
              const message = toStringValue(data.message) || 'Stream error'
              const resetRequired = Boolean(data.resetRequired || data.reset_required)
              updateStatus({ state: 'error', message, errorCode, resetRequired })
              if (data.recoverable === false) {
                websocket.close()
              }
              break
            }
            default:
              break
          }
        } catch (error) {
          console.error('[Realtime] Failed to parse message:', error, event)
        }
      }

      websocket.onerror = (event) => {
        if (!isCurrentConnection()) {
          return
        }

        console.error('[Realtime] WebSocket error:', event)
        updateStatus({ state: 'error', message: 'WebSocket error' })
      }

      websocket.onclose = (closeEvent) => {
        if (!isCurrentConnection()) {
          return
        }

        const reason = closeEvent.reason?.trim() || `WebSocket closed (${closeEvent.code})`
        console.info('[Realtime] REALTIME_WS_CLOSE', {
          meetingId,
          connectionSeq,
          reason,
        })
        const isAuthFailure = closeEvent.code === 1008 || /authentication/i.test(reason)
        const isUserStop =
          userStopRequestedRef.current ||
          closeEvent.reason?.trim() === 'Stream stopped by client'
        const isNormalClose = closeEvent.code === 1000 || closeEvent.code === 1001

        setIsConnected(false)
        setIsAuthenticated(false)
        wsRef.current = null
        setCloseReason('')
        userStopRequestedRef.current = false
        clearPendingQueue('ws_close')
        clearSessionReadyState()

        if (isAuthFailure) {
          rejectSessionReadyWaiters(
            reason,
            meetingId,
            sessionToken?.attemptId ?? 0,
            sessionToken?.recordingSessionId ?? 0,
          )
          updateStatus({ state: 'error', message: reason })
          return
        }

        if (isUserStop) {
          console.info('[Realtime] NORMAL_WS_CLOSE_AFTER_STOP', {
            meetingId,
            connectionSeq,
            reason,
          })
          updateStatus({ state: 'stopped', message: reason })
          return
        }

        if (isNormalClose) {
          rejectSessionReadyWaiters(
            reason,
            meetingId,
            sessionToken?.attemptId ?? 0,
            sessionToken?.recordingSessionId ?? 0,
          )
          updateStatus({ state: 'completed', message: reason })
          return
        }

        setCloseReason(reason)

        if (autoReconnect && reconnectCountRef.current < reconnectAttempts && canConnect) {
          reconnectCountRef.current += 1
          const delay = reconnectDelay * Math.pow(1.5, reconnectCountRef.current - 1)
          updateStatus({ state: 'reconnecting', message: `${reason}. Reconnecting in ${Math.round(delay / 1000)}s...` })
          const reconnectToken = sessionToken
          reconnectTimeoutRef.current = window.setTimeout(() => {
            if (!isSameSessionToken(reconnectToken, activeSessionTokenRef.current)) {
              return
            }

            connectRef.current()
          }, delay)
          return
        }

        rejectSessionReadyWaiters(
          reason,
          meetingId,
          sessionToken?.attemptId ?? 0,
          sessionToken?.recordingSessionId ?? 0,
        )
        updateStatus({ state: 'error', message: reason })
      }

      wsRef.current = websocket
    } catch (error) {
      console.error('[Realtime] Failed to establish connection:', error)
      updateStatus({ state: 'error', message: 'Failed to connect' })
    }
  }, [autoReconnect, canConnect, clearPendingQueue, clearSessionReadyState, flushPendingMessages, meetingId, reconnectAttempts, reconnectDelay, rejectSessionReadyWaiters, resolveSessionReadyWaiters, resolvedToken, sendRaw, sessionToken, updateStatus, userId])

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  const waitForSessionReady = useCallback((timeoutMs = 15000, expectedMeetingId = meetingId, expectedSessionToken: RealtimeSessionToken | null = sessionToken) => {
    const isCurrentSessionReady =
      wsRef.current?.readyState === WebSocket.OPEN &&
      isConnected &&
      isAuthenticated &&
      readyConnectionSeqRef.current === connectionSequenceRef.current &&
      readyMeetingIdRef.current === expectedMeetingId &&
      isSameSessionToken(expectedSessionToken, activeSessionTokenRef.current)

    if (isCurrentSessionReady) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      const expectedConnectionSeq = connectionSequenceRef.current

      const waiter: SessionReadyWaiter = {
        expectedMeetingId,
        expectedConnectionSeq,
        expectedRecordingSessionId: expectedSessionToken?.recordingSessionId ?? 0,
        expectedAttemptId: expectedSessionToken?.attemptId ?? 0,
        resolve,
        reject,
        timeoutId: 0,
      }
      console.info('[Realtime] READY_WAITER_CREATED', {
        meetingId: expectedMeetingId,
        attemptId: waiter.expectedAttemptId,
        expectedConnectionSeq,
      })

      waiter.timeoutId = window.setTimeout(() => {
        sessionReadyWaitersRef.current = sessionReadyWaitersRef.current.filter((item) => item !== waiter)
        const activeToken = activeSessionTokenRef.current
        const isStaleTimeout =
          !isSameSessionToken(expectedSessionToken, activeToken) ||
          waiter.expectedMeetingId !== activeToken?.meetingId ||
          waiter.expectedAttemptId !== (activeToken?.attemptId ?? 0) ||
          waiter.expectedRecordingSessionId !== (activeToken?.recordingSessionId ?? 0)
        if (isStaleTimeout) {
          console.info('[Realtime] STALE_READY_TIMEOUT_IGNORED', {
            meetingId: expectedMeetingId,
            attemptId: waiter.expectedAttemptId,
            timeoutConnectionSeq: expectedConnectionSeq,
            activeConnectionSeq: connectionSequenceRef.current,
          })
          reject(new Error('Stale realtime ready timeout ignored'))
          return
        }

        console.info('[Realtime] REALTIME_READY_TIMEOUT', {
          meetingId: expectedMeetingId,
          connectionSeq: expectedConnectionSeq,
        })

        reject(new Error('Realtime session did not become ready in time'))
      }, timeoutMs)

      sessionReadyWaitersRef.current.push(waiter)
    })
  }, [activeSessionTokenRef, isAuthenticated, isConnected, isSameSessionToken, meetingId, sessionToken])

  useEffect(() => {
    if (isConnected && isAuthenticated) {
      resolveSessionReadyWaiters(
        readyMeetingIdRef.current,
        readyConnectionSeqRef.current,
        sessionToken?.attemptId ?? 0,
        sessionToken?.recordingSessionId ?? 0,
      )
    }
  }, [isAuthenticated, isConnected, resolveSessionReadyWaiters, sessionToken])

  const sendAudioChunk = useCallback(async (
    audioChunk: Blob,
    meetingIdValue: string,
    streamId?: RealtimeAudioStreamId,
  ) => {
    const executeSend = async () => {
    if (meetingId === null) {
      console.error('[Realtime] STARTUP_INVARIANT_BROKEN', {
        reason: 'send_audio_chunk_without_active_meeting',
        connectionSeq: connectionSequenceRef.current,
      })
      throw new Error('Realtime meeting is not active')
    }

    const normalizedMeetingId = Number(meetingIdValue)
    if (!Number.isFinite(normalizedMeetingId)) {
      throw new Error('Invalid meeting ID for audio chunk')
    }

    if (userStopRequestedRef.current || streamStopSentRef.current) {
      console.warn('[Realtime] REALTIME_DROP_AUDIO_CHUNK', {
        meetingId: normalizedMeetingId,
        connectionSeq: connectionSequenceRef.current,
        reason: 'stream_stopped',
      })
      return
    }

    if (audioChunk.size > REALTIME_MAX_CHUNK_BYTES) {
      console.warn('[Realtime] REALTIME_CLIENT_CHUNK_SKIPPED', {
        meetingId: normalizedMeetingId,
        size: audioChunk.size,
        maxChunkBytes: REALTIME_MAX_CHUNK_BYTES,
        connectionSeq: connectionSequenceRef.current,
      })
      return
    }

    if (meetingId !== null && normalizedMeetingId !== meetingId) {
      console.warn('[Realtime] REALTIME_DROP_AUDIO_CHUNK', {
        chunkMeetingId: normalizedMeetingId,
        currentMeetingId: meetingId,
        connectionSeq: connectionSequenceRef.current,
        reason: 'stale_meeting',
      })
      return
    }

    const tokenAtSendStart = activeSessionTokenRef.current
    if (!isActiveSessionToken(tokenAtSendStart) || tokenAtSendStart?.meetingId !== normalizedMeetingId) {
      console.warn('[Realtime] REALTIME_DROP_AUDIO_CHUNK', {
        meetingId: normalizedMeetingId,
        recordingSessionId: tokenAtSendStart?.recordingSessionId ?? null,
        attemptId: tokenAtSendStart?.attemptId ?? null,
        connectionSeq: connectionSequenceRef.current,
        reason: 'missing_or_stale_session_token',
      })
      return
    }

    // Send metadata as JSON first
    const isDual = dualStreamRef.current && streamId
    const seq = isDual
      ? (streamId === 'tab' ? (tabAudioSequenceRef.current += 1) : (micAudioSequenceRef.current += 1))
      : (audioSequenceRef.current += 1)
    const tsMs = Date.now()
    lastChunkSentAtRef.current = tsMs
    if (firstChunkSentAtRef.current <= 0) {
      firstChunkSentAtRef.current = tsMs
    }
    const metadata: JsonValue = {
      type: 'audio.chunk',
      meeting_id: normalizedMeetingId,
      seq,
      ts_ms: tsMs,
      sample_rate: AUDIO_SAMPLE_RATE,
      channels: 1,
      encoding: 'webm-opus',
      size: audioChunk.size,
      mime_type: audioChunk.type || 'audio/webm; codecs=opus',
      recording_session_id: tokenAtSendStart.recordingSessionId,
      attempt_id: tokenAtSendStart.attemptId,
      ...(isDual && streamId ? { stream_id: streamId } : {}),
    }

    // Convert audio Blob to ArrayBuffer now so we can queue/send atomically
    let buffer: ArrayBuffer
    try {
      buffer = await readBlobAsArrayBuffer(audioChunk)
    } catch (err) {
      console.error('[Realtime] Failed to read audio chunk for seq=' + seq + ':', err)
      return
    }

    if (!isActiveSessionToken(tokenAtSendStart)) {
      console.warn('[Realtime] REALTIME_DROP_AUDIO_CHUNK', {
        meetingId: normalizedMeetingId,
        recordingSessionId: tokenAtSendStart.recordingSessionId,
        attemptId: tokenAtSendStart.attemptId,
        connectionSeq: connectionSequenceRef.current,
        seq,
        reason: 'stale_session_token_after_blob_read',
      })
      return
    }

    const queuedItem: PendingAudioChunk = {
      type: 'audio.chunk',
      metadata: metadata as Record<string, unknown>,
      binary: buffer,
      sessionToken: tokenAtSendStart,
    }

    const websocket = wsRef.current
    const isSocketReady = websocket?.readyState === WebSocket.OPEN
    const willQueue = !isSocketReady || !isAuthenticated

    console.info('[Realtime] AUDIO_CHUNK_SEND_ENQUEUED', {
      meetingId: normalizedMeetingId,
      recordingSessionId: tokenAtSendStart.recordingSessionId,
      attemptId: tokenAtSendStart.attemptId,
      connectionSeq: connectionSequenceRef.current,
      seq,
      byteLength: audioChunk.size,
      queueDepth: pendingQueueRef.current.filter((item) => item.kind === 'audio').length + (willQueue ? 1 : 0),
      tsMs,
      queued: willQueue,
      authenticated: isAuthenticated,
    })

    // Queue only while the session is still bootstrapping; do not replay the
    // same WebM buffer across reconnects or after a closed socket.
    if (willQueue) {
      if (!websocket || websocket.readyState === WebSocket.CLOSED) {
        console.warn('[Realtime] REALTIME_DROP_AUDIO_CHUNK', {
          meetingId: normalizedMeetingId,
          connectionSeq: connectionSequenceRef.current,
          seq,
          reason: 'socket_closed',
        })
        if (canConnect && autoReconnect) {
          updateStatus({ state: 'reconnecting', message: 'WebSocket closed while recording, reconnecting...' })
          connectRef.current()
        }
        throw new Error('Realtime WebSocket closed while recording')
      }

      console.warn('[Realtime] REALTIME_QUEUE_AUDIO_CHUNK', {
        meetingId: normalizedMeetingId,
        connectionSeq: connectionSequenceRef.current,
        seq,
        reason: 'awaiting_auth',
      })
      pendingQueueRef.current.push({ kind: 'audio', payload: queuedItem })
      return
    }

    // Send metadata as text message
    try {
      websocket.send(JSON.stringify(queuedItem.metadata))
    } catch (err) {
      console.error('[Realtime] Failed to send metadata, dropping package seq=' + seq + ':', err)
      return
    }

    // Send audio as binary for efficiency (no base64 overhead)
    try {
      websocket.send(queuedItem.binary)
      console.info('[Realtime] AUDIO_CHUNK_SEND_FLUSHED', {
        meetingId: normalizedMeetingId,
        recordingSessionId: tokenAtSendStart.recordingSessionId,
        attemptId: tokenAtSendStart.attemptId,
        seq,
        queueDepth: pendingQueueRef.current.filter((item) => item.kind === 'audio').length,
        bufferedAmount: websocket.bufferedAmount,
        tsMs,
      })
    } catch (error) {
      console.error('[Realtime] REALTIME_DROP_AUDIO_CHUNK', {
        meetingId: normalizedMeetingId,
        connectionSeq: connectionSequenceRef.current,
        seq,
        reason: 'send_failed',
        error,
      })
    }
    }

    sendChainRef.current = sendChainRef.current
      .then(() => executeSend())
      .catch((error) => {
        console.error('[Realtime] REALTIME_SEND_CHAIN_ERROR', {
          meetingId,
          streamId: streamId ?? null,
          error,
        })
      })
    return sendChainRef.current
  }, [autoReconnect, canConnect, isActiveSessionToken, isAuthenticated, meetingId, updateStatus])

  const pause = useCallback(() => {
    sendRaw({ type: 'stream.pause' })
  }, [sendRaw])

  const stopStream = useCallback(async () => {
    const tokenAtStop = activeSessionTokenRef.current
    if (!tokenAtStop || !isActiveSessionToken(tokenAtStop)) {
      clearPendingQueue('stale_stop')
      return false
    }

    userStopRequestedRef.current = true

    if (streamStopSentRef.current) {
      console.info('[Realtime] STREAM_STOP_DUPLICATE_IGNORED', {
        meetingId,
        lastSeq: audioSequenceRef.current,
        queueDepth: pendingQueueRef.current.length,
      })
      clearPendingQueue('duplicate_stop')
      return true
    }

    const flushStats = flushPendingMessages(true)
    const drained = await waitForBufferedAmountToDrain()
    const websocket = wsRef.current
    const bufferedAmount = websocket?.bufferedAmount ?? 0

    if (!drained && bufferedAmount > 0) {
      console.warn('[Realtime] STREAM_STOP_BUFFER_DRAIN_TIMEOUT', {
        meetingId: tokenAtStop.meetingId,
        recordingSessionId: tokenAtStop.recordingSessionId,
        attemptId: tokenAtStop.attemptId,
        lastSeq: audioSequenceRef.current,
        bufferedAmount,
        drainTimeoutMs: STOP_DRAIN_TIMEOUT_MS,
      })
    }

    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      console.warn('[Realtime] STREAM_STOP_FAILED', {
        meetingId: tokenAtStop.meetingId,
        recordingSessionId: tokenAtStop.recordingSessionId,
        attemptId: tokenAtStop.attemptId,
        lastSeq: audioSequenceRef.current,
        queueDepth: pendingQueueRef.current.length,
        reason: 'socket_not_open',
      })
      clearPendingQueue('stop_socket_not_open')
      return false
    }

    console.info('[Realtime] REALTIME_FINALIZE_AFTER_CLIENT_DRAIN', {
      meetingId: tokenAtStop.meetingId,
      recordingSessionId: tokenAtStop.recordingSessionId,
      attemptId: tokenAtStop.attemptId,
      lastSeq: audioSequenceRef.current,
      queueDepth: pendingQueueRef.current.length,
      bufferedAmount: websocket.bufferedAmount,
    })

    try {
      websocket.send(JSON.stringify({
        type: 'stream.stop',
        meetingId: tokenAtStop.meetingId,
        timestamp: Date.now(),
        recording_session_id: tokenAtStop.recordingSessionId,
        attempt_id: tokenAtStop.attemptId,
      }))
    } catch (error) {
      console.warn('[Realtime] STREAM_STOP_FAILED', {
        meetingId: tokenAtStop.meetingId,
        recordingSessionId: tokenAtStop.recordingSessionId,
        attemptId: tokenAtStop.attemptId,
        lastSeq: audioSequenceRef.current,
        queueDepth: pendingQueueRef.current.length,
        reason: 'send_failed',
      })
      clearPendingQueue('stop_send_failed')
      return false
    }

    streamStopSentRef.current = true

    console.info('[Realtime] STREAM_STOP_AFTER_FLUSH', {
      meetingId: tokenAtStop.meetingId,
      recordingSessionId: tokenAtStop.recordingSessionId,
      attemptId: tokenAtStop.attemptId,
      lastSeq: audioSequenceRef.current,
      queuedAudioChunks: flushStats.queuedAudioChunks,
      flushedChunks: flushStats.flushedAudioChunks,
      queueDepth: pendingQueueRef.current.length,
      bufferedAmount: websocket.bufferedAmount,
    })
    clearPendingQueue('stream_stop_sent')
    return true
  }, [clearPendingQueue, flushPendingMessages, isActiveSessionToken, meetingId, waitForBufferedAmountToDrain])

  const resume = useCallback(() => {
    sendRaw({ type: 'stream.resume' })
  }, [sendRaw])

  const configureDualStreams = useCallback((streams: RealtimeAudioStreamId[]) => {
    activeStreamsRef.current = streams
    if (!dualStreamRef.current) {
      return
    }
    sendRaw({
      type: 'dual_stream.configure',
      dualStream: true,
      activeStreams: streams,
    })
  }, [sendRaw])

  const clearTranscripts = useCallback(() => {
    setTranscripts([])
  }, [])

  const clearKeywords = useCallback(() => {
    setKeywords([])
    audioSequenceRef.current = 0
  }, [])

  useEffect(() => {
    if (!isConnected) {
      return undefined
    }

    const timerId = window.setInterval(() => {
      const now = Date.now()
      if (
        lastChunkSentAtRef.current > 0 &&
        now - lastChunkSentAtRef.current <= 2_000 &&
        (
          (lastTranscriptAtRef.current > 0 && now - lastTranscriptAtRef.current >= 10_000) ||
          (lastTranscriptAtRef.current <= 0 && firstChunkSentAtRef.current > 0 && now - firstChunkSentAtRef.current >= 15_000)
        ) &&
        !stalledWarningLoggedRef.current
      ) {
        stalledWarningLoggedRef.current = true
        console.warn('[Realtime] LIVE_SEGMENT_STALLED', {
          meetingId,
          connectionSeq: connectionSequenceRef.current,
          lastTranscriptAt: lastTranscriptAtRef.current || null,
          lastChunkSentAt: lastChunkSentAtRef.current,
          firstChunkSentAt: firstChunkSentAtRef.current || null,
          elapsedSinceFirstChunkMs: firstChunkSentAtRef.current > 0 ? now - firstChunkSentAtRef.current : null,
        })
      }
    }, 2000)

    return () => {
      window.clearInterval(timerId)
    }
  }, [isConnected, meetingId])

  useEffect(() => {
    effectRunCountRef.current += 1
    if (!canConnect) {
      disconnect(sessionToken)
      return undefined
    }

    setTranscripts([])
    setKeywords([])
    streamStopSentRef.current = false
    userStopRequestedRef.current = false
    pendingQueueRef.current = []
    audioSequenceRef.current = 0
    firstChunkSentAtRef.current = 0
    lastTranscriptAtRef.current = 0
    lastChunkSentAtRef.current = 0
    connect()

    return () => {
      disconnect(sessionToken)
    }
  }, [canConnect, connect, disconnect, meetingId, resolvedToken, sessionToken, userId])

  return {
    isConnected,
    isAuthenticated,
    status,
    closeReason,
    transcripts,
    keywords,
    connect,
    disconnect,
    sendAudioChunk,
    waitForSessionReady,
    stopStream,
    pause,
    resume,
    clearTranscripts,
    clearKeywords,
    clearQueuedAudio,
    configureDualStreams,
  }
}



