import { useCallback, useEffect, useRef, useState } from 'react'
import { getAccessToken } from '../services/auth'
import { REALTIME_WS_BASE_URL } from '../services/config'

export interface TranscriptSegment {
  id: string
  speaker: string
  text: string
  start: number
  end: number
  timestamp?: number
  confidence?: number
  language?: string
  isFinal?: boolean
}

export interface KeywordHit {
  id: string
  keyword: string
  confidence: number
  position: number
  definition?: string
}

export interface RealtimeStatusEvent {
  state: 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'stopped' | 'completed'
  activeConnections?: number
  lagMs?: number
  message?: string
}

interface UseRealtimeMeetingStreamOptions {
  meetingId: number | null
  userId: number | null
  token?: string
  enabled?: boolean
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
}

type PendingQueueItem =
  | { kind: 'raw'; payload: string }
  | { kind: 'audio'; payload: PendingAudioChunk }

const DEFAULT_WS_URL = REALTIME_WS_BASE_URL
const AUDIO_SAMPLE_RATE = 48_000

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

const isLikelySequenceId = (value: string): boolean => /^seq-\d+$/i.test(value) || /^\d+$/.test(value)

const normalizeSegmentText = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase()

const resolveTranscriptTiming = (data: Record<string, unknown>): { start: number; end: number } | null => {
  const start = toNumber(data.startTime, data.start_time, data.start)
  const end = toNumber(data.endTime, data.end_time, data.end)
  const duration = toNumber(data.duration, data.duration_ms, data.durationMs)

  const resolvedEnd = end > 0 ? end : start > 0 && duration > 0 ? start + duration : 0
  if (start <= 0 && resolvedEnd <= 0) {
    return null
  }

  return {
    start,
    end: resolvedEnd > 0 ? resolvedEnd : start,
  }
}

const resolveTranscriptSegmentId = (data: Record<string, unknown>): string => {
  const explicitId = toStringValue(data.segmentId, data.segment_id, data.id)
  const timing = resolveTranscriptTiming(data)
  const speaker = normalizeSegmentText(toStringValue(data.speaker))

  if (explicitId && !isLikelySequenceId(explicitId)) {
    return explicitId
  }

  if (timing) {
    const speakerPart = speaker ? `-${speaker}` : ''
    return `time-${timing.start.toFixed(3)}${speakerPart}`
  }

  if (explicitId) {
    return explicitId
  }

  const seq = toNumber(data.seq)
  if (seq > 0) {
    return `seq-${seq}`
  }

  return `seg-${Date.now()}`
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
    enabled = true,
    onTranscript,
    onKeyword,
    onStatusChange,
    autoReconnect = true,
    reconnectAttempts = 5,
    reconnectDelay = 1000,
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
  const audioSequenceRef = useRef(0)
  const connectionSequenceRef = useRef(0)
  const effectRunCountRef = useRef(0)
  const connectRef = useRef<() => void>(() => {})
  const userStopRequestedRef = useRef(false)

  const resolvedToken = token || getAccessToken() || ''
  const canConnect = enabled && meetingId !== null && userId !== null && resolvedToken.trim().length > 0

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
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      return
    }

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
      } catch (err) {
        console.error('[Realtime] Failed to send queued audio binary:', err)
        pendingQueueRef.current.unshift(item)
        break
      }
    }
  }, [])

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    setIsConnected(false)
  }, [])

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

      const websocket = new WebSocket(wsUrl.toString())

      websocket.onopen = () => {
        userStopRequestedRef.current = false
        setIsConnected(true)
        setIsAuthenticated(false)
        reconnectCountRef.current = 0
        updateStatus({ state: 'connected', activeConnections: 1 })

        websocket.send(JSON.stringify({
          type: 'auth.init',
          token: resolvedToken,
          userId,
          meetingId,
        }))

        flushPendingMessages(false)
      }

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as Record<string, unknown>
          const messageType = toStringValue(data.type)

          switch (messageType) {
            case 'session.ready': {
              updateStatus({
                state: 'connected',
                activeConnections: toNumber(data.activeConnections),
              })
              // mark authenticated when backend indicates it
              const authenticated = Boolean(data.authenticated || data.auth || false)
              if (authenticated) {
                setIsAuthenticated(true)
                // flush queued messages and binary now that session is ready
                flushPendingMessages(true)
              }
              break
            }
            case 'transcript.partial':
            case 'transcript.final': {
              const text = toStringValue(data.text)
              if (text.trim().length === 0) {
                break
              }

              const timing = resolveTranscriptTiming(data)
              const start = timing?.start ?? toNumber(data.startTime, data.start_time, data.timestamp)
              const end = timing?.end ?? toNumber(data.endTime, data.end_time, start)
              const segmentId = resolveTranscriptSegmentId(data)
              const nextSegment: TranscriptSegment = {
                id: segmentId,
                speaker: toStringValue(data.speaker),
                text,
                start,
                end,
                timestamp: start,
                confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
                language: toStringValue(data.language) || undefined,
                isFinal: messageType === 'transcript.final' || Boolean(data.isFinal || data.is_final),
              }

              let visibleSegment = nextSegment
              setTranscripts((current) => {
                const existingIndex = current.findIndex((item) => item.id === segmentId)
                if (existingIndex < 0) {
                  visibleSegment = nextSegment
                  return [...current, nextSegment]
                }

                const existing = current[existingIndex]
                const mergedSegment: TranscriptSegment = {
                  ...existing,
                  ...nextSegment,
                  speaker: nextSegment.speaker.trim().length > 0 ? nextSegment.speaker : existing.speaker,
                  start: Number.isFinite(start) && start > 0 ? start : existing.start,
                  end: Number.isFinite(end) && end >= start ? end : existing.end,
                  timestamp: Number.isFinite(start) && start > 0 ? start : existing.timestamp,
                  isFinal: Boolean(existing.isFinal || nextSegment.isFinal),
                }

                visibleSegment = mergedSegment
                const updated = [...current]
                updated[existingIndex] = mergedSegment
                return updated
              })
              onTranscript?.(visibleSegment)
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
              })
              break
            }
            case 'stream.error': {
              const message = toStringValue(data.message) || 'Stream error'
              updateStatus({ state: 'error', message })
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
        console.error('[Realtime] WebSocket error:', event)
        updateStatus({ state: 'error', message: 'WebSocket error' })
      }

      websocket.onclose = (closeEvent) => {
        const reason = closeEvent.reason?.trim() || `WebSocket closed (${closeEvent.code})`
        const isAuthFailure = closeEvent.code === 1008 || /authentication/i.test(reason)
        const isUserStop =
          userStopRequestedRef.current ||
          closeEvent.reason?.trim() === 'Stream stopped by client'
        const isNormalClose = closeEvent.code === 1000 || closeEvent.code === 1001

        setIsConnected(false)
        setIsAuthenticated(false)
        wsRef.current = null
        setCloseReason(reason)
        userStopRequestedRef.current = false

        if (isAuthFailure) {
          updateStatus({ state: 'error', message: reason })
          return
        }

        if (isUserStop) {
          updateStatus({ state: 'stopped', message: reason })
          return
        }

        if (isNormalClose) {
          updateStatus({ state: 'completed', message: reason })
          return
        }

        if (autoReconnect && reconnectCountRef.current < reconnectAttempts && canConnect) {
          reconnectCountRef.current += 1
          const delay = reconnectDelay * Math.pow(1.5, reconnectCountRef.current - 1)
          updateStatus({ state: 'reconnecting', message: `${reason}. Reconnecting in ${Math.round(delay / 1000)}s...` })
          reconnectTimeoutRef.current = window.setTimeout(() => connectRef.current(), delay)
          return
        }

        updateStatus({ state: 'error', message: reason })
      }

      wsRef.current = websocket
    } catch (error) {
      console.error('[Realtime] Failed to establish connection:', error)
      updateStatus({ state: 'error', message: 'Failed to connect' })
    }
  }, [autoReconnect, canConnect, flushPendingMessages, meetingId, reconnectAttempts, reconnectDelay, resolvedToken, sendRaw, updateStatus, userId])

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  const sendAudioChunk = useCallback(async (audioChunk: Blob, meetingIdValue: string) => {
    const normalizedMeetingId = Number(meetingIdValue)
    if (!Number.isFinite(normalizedMeetingId)) {
      throw new Error('Invalid meeting ID for audio chunk')
    }

    // Send metadata as JSON first
    const seq = (audioSequenceRef.current += 1)
    const tsMs = Date.now()
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
    }

    // Convert audio Blob to ArrayBuffer now so we can queue/send atomically
    let buffer: ArrayBuffer
    try {
      buffer = await readBlobAsArrayBuffer(audioChunk)
    } catch (err) {
      console.error('[Realtime] Failed to read audio chunk for seq=' + seq + ':', err)
      return
    }

    const queuedItem: PendingAudioChunk = {
      type: 'audio.chunk',
      metadata: metadata as Record<string, unknown>,
      binary: buffer,
    }

    // If socket is not fully authenticated yet, keep the audio queued.
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !isAuthenticated) {
      console.warn('[Realtime] Queueing audio package until session authenticated seq=' + seq)
      pendingQueueRef.current.push({ kind: 'audio', payload: queuedItem })
      return
    }

    // Send metadata as text message
    try {
      wsRef.current.send(JSON.stringify(queuedItem.metadata))
    } catch (err) {
      console.error('[Realtime] Failed to send metadata, queueing package seq=' + seq + ':', err)
      pendingQueueRef.current.push({ kind: 'audio', payload: queuedItem })
      return
    }

    // Send audio as binary for efficiency (no base64 overhead)
    try {
      if (seq === 1) {
        try {
          const first16 = Array.from(new Uint8Array(queuedItem.binary.slice(0, 16)))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
          // eslint-disable-next-line no-console
          console.log(`AUDIO HASH FRONTEND seq=${seq} size=${queuedItem.binary.byteLength} first16hex=${first16}`)
        } catch {
          // ignore logging errors
        }
      }
      wsRef.current.send(queuedItem.binary)
    } catch (error) {
      console.error('[Realtime] Error sending audio chunk seq=' + seq + ':', error)
      // push into pending queue for retry
      pendingQueueRef.current.push({ kind: 'audio', payload: queuedItem })
    }
  }, [isAuthenticated, sendRaw])

  const pause = useCallback(() => {
    sendRaw({ type: 'stream.pause' })
  }, [sendRaw])

  const stopStream = useCallback(() => {
    userStopRequestedRef.current = true
    sendRaw({
      type: 'stream.stop',
      meetingId: meetingId,
      timestamp: Date.now(),
    })
    return true
  }, [meetingId, sendRaw])

  const resume = useCallback(() => {
    sendRaw({ type: 'stream.resume' })
  }, [sendRaw])

  const clearTranscripts = useCallback(() => {
    setTranscripts([])
  }, [])

  const clearKeywords = useCallback(() => {
    setKeywords([])
    audioSequenceRef.current = 0
  }, [])

  useEffect(() => {
    effectRunCountRef.current += 1
    if (!canConnect) {
      disconnect()
      return undefined
    }

    setTranscripts([])
    setKeywords([])
    pendingQueueRef.current = []
    audioSequenceRef.current = 0
    connect()

    return () => {
      disconnect()
    }
  }, [canConnect, connect, disconnect, meetingId, userId, resolvedToken])

  return {
    isConnected,
    status,
    closeReason,
    transcripts,
    keywords,
    connect,
    disconnect,
    sendAudioChunk,
    stopStream,
    pause,
    resume,
    clearTranscripts,
    clearKeywords,
  }
}



