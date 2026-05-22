import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    mergeTranscriptSegments,
    normalizePersistedTranscriptSegments,
    normalizeTranscriptEvent,
} from '../utils/transcript'
import { useRealtimeMeetingStream, type RealtimeSessionToken } from './useRealtimeMeetingStream'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  readonly sent: (string | ArrayBuffer)[] = []

  readonly url: string

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send = vi.fn((payload: string | ArrayBuffer) => {
    this.sent.push(payload)
  })

  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({})
  })

  closeWith(code: number, reason: string) {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code, reason })
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.({})
  }

  receive(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

const originalWebSocket = globalThis.WebSocket
const originalActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const createSessionToken = (meetingId: number, recordingSessionId: number, attemptId: number): RealtimeSessionToken => ({
  meetingId,
  recordingSessionId,
  attemptId,
  connectionSeq: 0,
})

describe('useRealtimeMeetingStream', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let latest: ReturnType<typeof useRealtimeMeetingStream> | null = null
  let currentSessionToken: RealtimeSessionToken | null = null

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    currentSessionToken = createSessionToken(88, 1, 1)

    function Harness() {
      latest = useRealtimeMeetingStream({
        meetingId: 88,
        userId: 12,
        token: 'jwt-token',
        sessionToken: currentSessionToken,
        enabled: true,
        autoReconnect: false,
      })
      return null
    }

    act(() => {
      root.render(<Harness />)
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    for (const socket of MockWebSocket.instances) {
      if (socket.readyState === MockWebSocket.OPEN || socket.readyState === MockWebSocket.CONNECTING) {
        socket.close()
      }
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
    }
    MockWebSocket.instances = []
    vi.clearAllTimers()
    vi.useRealTimers()
    container.remove()
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
    vi.stubGlobal('WebSocket', originalWebSocket as typeof WebSocket)
    vi.restoreAllMocks()
  })

  it('connects, sends audio chunks and parses transcript events', async () => {
    expect(MockWebSocket.instances).toHaveLength(1)
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
    })

    await flush()

    expect(latest?.isConnected).toBe(true)

    await act(async () => {
      await latest!.sendAudioChunk(new Blob(['abc'], { type: 'audio/webm; codecs=opus' }), '88')
    })

    const textMessagesBeforeReady = socket.send.mock.calls
      .map(([payload]) => {
        try {
          return typeof payload === 'string' ? (JSON.parse(payload) as Record<string, unknown>) : null
        } catch {
          return null
        }
      })
      .filter((msg): msg is Record<string, unknown> => msg !== null)

    const binaryMessagesBeforeReady = socket.send.mock.calls
      .map(([payload]) => (payload instanceof ArrayBuffer ? payload : null))
      .filter((msg): msg is ArrayBuffer => msg !== null)

    expect(textMessagesBeforeReady).toHaveLength(1)
    expect(textMessagesBeforeReady[0]).toMatchObject({
      type: 'auth.init',
      token: 'jwt-token',
      userId: 12,
      meetingId: 88,
    })
    expect(binaryMessagesBeforeReady).toHaveLength(0)

    act(() => {
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    // Extract text messages (JSON) and binary messages separately
    const textMessages = socket.send.mock.calls
      .map(([payload]) => {
        try {
          return typeof payload === 'string' ? (JSON.parse(payload) as Record<string, unknown>) : null
        } catch {
          return null
        }
      })
      .filter((msg): msg is Record<string, unknown> => msg !== null)

    const binaryMessages = socket.send.mock.calls
      .map(([payload]) => (payload instanceof ArrayBuffer ? payload : null))
      .filter((msg): msg is ArrayBuffer => msg !== null)

    expect(textMessages[0]).toMatchObject({
      type: 'auth.init',
      token: 'jwt-token',
      userId: 12,
      meetingId: 88,
    })

    const audioMessage = textMessages.find((message) => message.type === 'audio.chunk')
    expect(audioMessage).toMatchObject({
      meeting_id: 88,
      sample_rate: 48_000,
      size: 3, // "abc" is 3 bytes
    })
    expect(audioMessage).not.toHaveProperty('pcm_chunk')

    // Verify binary audio was sent
    expect(binaryMessages).toHaveLength(1)
    expect(binaryMessages[0]!.byteLength).toBe(3)

    act(() => {
      socket.receive({
        type: 'transcript.partial',
        segmentId: 'seg-1',
        speaker: 'Speaker 1',
        startTime: 1.25,
        endTime: 2.5,
        text: 'Xin chào',
        language: 'vi',
        versionHash: 'v1',
      })
      socket.receive({
        type: 'keyword.hit',
        keywordId: 'kw-1',
        term: 'meeting',
        confidence: 0.97,
        ranges: [4, 11],
        definition: 'Keyword',
      })
    })

    await flush()

    expect(latest?.transcripts).toHaveLength(1)
    expect(latest?.transcripts[0]).toMatchObject({
      id: 'seg-1',
      speaker: 'Speaker 1',
      text: 'Xin chào',
      start: 1.25,
      end: 2.5,
      language: 'vi',
    })
    expect(latest?.keywords).toHaveLength(1)
    expect(latest?.keywords[0]).toMatchObject({
      id: 'kw-1',
      keyword: 'meeting',
      confidence: 0.97,
      position: 4,
    })
  })

  it('ignores empty transcript partials and keeps status-only updates out of the transcript list', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    act(() => {
      socket.receive({
        type: 'transcript.partial',
        seq: 12,
        speaker: 'Unknown',
        text: '',
      })
    })

    await flush()

    expect(latest?.transcripts).toHaveLength(0)
  })

  it('replaces a partial segment when the same utterance finalizes', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    act(() => {
      socket.receive({
        type: 'transcript.partial',
        seq: 7,
        segmentId: 'meeting-88-start-1.250-speaker_1-1',
        speaker: 'Speaker 1',
        startTime: 1.25,
        endTime: 2.5,
        text: 'Xin chào',
        language: 'vi',
      })
      socket.receive({
        type: 'transcript.final',
        seq: 7,
        segmentId: 'meeting-88-start-1.250-speaker_1-1',
        speaker: 'Speaker 1',
        startTime: 1.25,
        endTime: 3.1,
        text: 'Xin chào Audiomind',
        language: 'vi',
        isFinal: true,
      })
    })

    await flush()

    expect(latest?.transcripts).toHaveLength(1)
    expect(latest?.transcripts[0]).toMatchObject({
      id: 'meeting-88-start-1.250-speaker_1-1',
      mergeKey: 'segment:meeting-88-start-1.250-speaker_1-1',
      speaker: 'Speaker 1',
      text: 'Xin chào Audiomind',
      start: 1.25,
      end: 3.1,
      language: 'vi',
      isFinal: true,
    })
  })

  it('replaces progressive partial updates for the same segment instead of appending', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    act(() => {
      socket.receive({
        type: 'transcript.partial',
        segmentId: 'meeting-2-start-7.810',
        speaker: 'Speaker 1',
        startTime: 7.81,
        endTime: 8.12,
        text: 'Xin chào',
        language: 'vi',
      })
      socket.receive({
        type: 'transcript.partial',
        segmentId: 'meeting-2-start-7.810',
        speaker: 'Speaker 1',
        startTime: 7.81,
        endTime: 8.48,
        text: 'Xin chào Audiomind',
        language: 'vi',
      })
    })

    await flush()

    expect(latest?.transcripts).toHaveLength(1)
    expect(latest?.transcripts[0]).toMatchObject({
      id: 'meeting-2-start-7.810',
      mergeKey: 'segment:meeting-2-start-7.810',
      text: 'Xin chào Audiomind',
      start: 7.81,
      end: 8.48,
      isFinal: false,
    })
  })

  it('keeps two live segments separate when stable segmentId values are different', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    act(() => {
      socket.receive({
        type: 'transcript.partial',
        segmentId: 'meeting-88-start-12.340-speaker_1-1',
        speaker: 'Speaker 1',
        startTime: 12.34,
        endTime: 13.1,
        text: 'Segment one',
      })
      socket.receive({
        type: 'transcript.partial',
        segmentId: 'meeting-88-start-14.220-speaker_1-2',
        speaker: 'Speaker 1',
        startTime: 14.22,
        endTime: 15.0,
        text: 'Segment two',
      })
    })

    await flush()

    expect(latest?.transcripts).toHaveLength(2)
    expect(latest?.transcripts.map((segment) => segment.id)).toEqual([
      'meeting-88-start-12.340-speaker_1-1',
      'meeting-88-start-14.220-speaker_1-2',
    ])
  })

  it('keeps the final transcript when a later partial arrives for the same segment', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    act(() => {
      socket.receive({
        type: 'transcript.final',
        segmentId: 'meeting-2-start-18.940',
        speaker: 'Speaker 2',
        startTime: 18.94,
        endTime: 20.12,
        text: 'Đây là câu hoàn chỉnh',
        language: 'vi',
        isFinal: true,
      })
      socket.receive({
        type: 'transcript.partial',
        segmentId: 'meeting-2-start-18.940',
        speaker: 'Speaker 2',
        startTime: 18.94,
        endTime: 19.1,
        text: 'Đây là câu',
        language: 'vi',
      })
    })

    await flush()

    expect(latest?.transcripts).toHaveLength(1)
    expect(latest?.transcripts[0]).toMatchObject({
      id: 'meeting-2-start-18.940',
      text: 'Đây là câu hoàn chỉnh',
      start: 18.94,
      end: 20.12,
      isFinal: true,
    })
  })

  it('ignores duplicate segment updates with identical text', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    act(() => {
      socket.receive({
        type: 'transcript.partial',
        segmentId: 'meeting-88-start-12.340-speaker_1-1',
        speaker: 'Speaker 1',
        startTime: 12.34,
        endTime: 12.9,
        text: 'Xin chào',
      })
      socket.receive({
        type: 'transcript.partial',
        segmentId: 'meeting-88-start-12.340-speaker_1-1',
        speaker: 'Speaker 1',
        startTime: 12.34,
        endTime: 13.1,
        text: 'Xin chào',
      })
    })

    await flush()

    expect(latest?.transcripts).toHaveLength(1)
    expect(latest?.transcripts[0]).toMatchObject({
      id: 'meeting-88-start-12.340-speaker_1-1',
      text: 'Xin chào',
      end: 12.9,
    })
  })

  it('accepts transcript events with missing speaker and timing without crashing', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    act(() => {
      socket.receive({
        type: 'transcript.partial',
        segmentId: 'meeting-88-temp-1',
        text: 'fallback event',
      })
    })

    await flush()

    expect(latest?.transcripts).toHaveLength(1)
    expect(latest?.transcripts[0]).toMatchObject({
      id: 'meeting-88-temp-1',
      speaker: 'SPEAKER_1',
      start: 0,
      end: 0,
      text: 'fallback event',
    })
  })

  it('merges persisted transcript rows into an existing realtime segment without duplicates', () => {
    const realtimeSegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      segmentId: 'meeting-2-start-7.810',
      speaker: 'Speaker 1',
      startTime: 7.81,
      endTime: 8.12,
      text: 'Xin chào',
      language: 'vi',
    }, 'transcript.partial')

    const persistedSegments = normalizePersistedTranscriptSegments([
      {
        speaker: 'Speaker 1',
        start_time: 7.81,
        end_time: 8.48,
        text: 'Xin chào Audiomind',
      },
    ])

    const merged = mergeTranscriptSegments([
      ...(realtimeSegment ? [realtimeSegment] : []),
      ...persistedSegments,
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'meeting-2-start-7.810',
      text: 'Xin chào Audiomind',
      start: 7.81,
      end: 8.48,
    })
  })

  it('canonicalizes legacy live segment id and merges with hydration id without duplicates', () => {
    const realtimeSegment = normalizeTranscriptEvent({
      type: 'transcript.partial',
      segmentId: 'meeting-11-0.000-speaker_1-1',
      speaker: 'Speaker 1',
      startTime: 0,
      endTime: 0.8,
      text: 'Xin chào',
    }, 'transcript.partial')

    const persistedSegments = normalizePersistedTranscriptSegments([
      {
        segment_id: 'meeting-11-start-0.000-speaker_1',
        speaker: 'Speaker 1',
        start_time: 0,
        end_time: 1.1,
        text: 'Xin chào Audiomind',
      },
    ])

    const merged = mergeTranscriptSegments([
      ...(realtimeSegment ? [realtimeSegment] : []),
      ...persistedSegments,
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      id: 'meeting-11-start-0.000-speaker_1',
      text: 'Xin chào Audiomind',
    })
  })

  it('ignores aggregate seq=-1 finals without real segment timing so rows stay separate', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    act(() => {
      socket.receive({
        type: 'transcript.partial',
        segmentId: 'meeting-2-start-7.810',
        speaker: 'Speaker 1',
        startTime: 7.81,
        endTime: 8.12,
        text: 'Xin chào',
        language: 'vi',
      })
      socket.receive({
        type: 'transcript.partial',
        segmentId: 'meeting-2-start-18.940',
        speaker: 'Speaker 2',
        startTime: 18.94,
        endTime: 19.4,
        text: 'Đây là câu hoàn chỉnh',
        language: 'vi',
      })
      socket.receive({
        type: 'transcript.final',
        seq: -1,
        segmentId: '-1',
        speaker: '',
        text: 'Xin chào Đây là câu hoàn chỉnh',
        language: 'vi',
        isFinal: true,
      })
    })

    await flush()

    expect(latest?.transcripts).toHaveLength(2)
    expect(latest?.transcripts.map((segment) => segment.text)).toEqual([
      'Xin chào',
      'Đây là câu hoàn chỉnh',
    ])
  })

  it('allows seq=-1 finals with a real segment id and timing to replace the partial', () => {
    const partial = normalizeTranscriptEvent({
      type: 'transcript.partial',
      seq: -1,
      segmentId: 'meeting-2-start-7.810',
      speaker: 'Speaker 1',
      startTime: 7.81,
      endTime: 8.12,
      text: 'Xin chào',
      language: 'vi',
    }, 'transcript.partial')

    const finalSegment = normalizeTranscriptEvent({
      type: 'transcript.final',
      seq: -1,
      segmentId: 'meeting-2-start-7.810',
      speaker: 'Speaker 1',
      startTime: 7.81,
      endTime: 8.48,
      text: 'Xin chào Audiomind',
      language: 'vi',
      isFinal: true,
    }, 'transcript.final')

    expect(partial).not.toBeNull()
    expect(finalSegment).not.toBeNull()
    expect(finalSegment).toMatchObject({
      id: 'meeting-2-start-7.810',
      text: 'Xin chào Audiomind',
      start: 7.81,
      end: 8.48,
      isFinal: true,
    })
  })

  it('falls back to SPEAKER_1 when realtime speaker data is missing or system', () => {
    const missingSpeaker = normalizeTranscriptEvent({
      type: 'transcript.partial',
      segmentId: 'meeting-2-start-1.000',
      startTime: 1,
      endTime: 2,
      text: 'Xin chào',
      language: 'vi',
    }, 'transcript.partial', { fallbackSpeaker: 'SPEAKER_1' })

    const systemSpeaker = normalizeTranscriptEvent({
      type: 'transcript.partial',
      segmentId: 'meeting-2-start-2.000',
      speaker: 'system',
      startTime: 2,
      endTime: 3,
      text: 'Audiomind',
      language: 'vi',
    }, 'transcript.partial', { fallbackSpeaker: 'SPEAKER_1' })

    expect(missingSpeaker).toMatchObject({
      speaker: 'SPEAKER_1',
    })
    expect(systemSpeaker).toMatchObject({
      speaker: 'SPEAKER_1',
    })
  })

  it('keeps distinct utterances as separate rows', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    act(() => {
      socket.receive({
        type: 'transcript.partial',
        speaker: 'Speaker 1',
        startTime: 1.25,
        endTime: 2.0,
        text: 'Đáng sợ, mọi con quái bạn đối',
        language: 'vi',
      })
      socket.receive({
        type: 'transcript.partial',
        speaker: 'Speaker 1',
        startTime: 4.75,
        endTime: 5.5,
        text: 'Một câu chuyện khác bắt đầu',
        language: 'vi',
      })
    })

    await flush()

    expect(latest?.transcripts).toHaveLength(2)
    expect(latest?.transcripts.map((segment) => segment.text)).toEqual([
      'Đáng sợ, mọi con quái bạn đối',
      'Một câu chuyện khác bắt đầu',
    ])
  })

  it('marks local stop as stopped instead of error', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    act(() => {
      latest?.stopStream()
      socket.closeWith(1000, '')
    })

    await flush()

    expect(latest?.status.state).toBe('stopped')
    expect(latest?.status.message).not.toMatch(/error/i)
    expect(latest?.closeReason).toBe('')
  })

  it('marks server stop reason as stopped instead of error', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.closeWith(1000, 'Stream stopped by client')
    })

    await flush()

    expect(latest?.status.state).toBe('stopped')
    expect(latest?.closeReason).toBe('')
  })

  it('marks abnormal close as error', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.closeWith(1006, 'network reset')
    })

    await flush()

    expect(latest?.status.state).toBe('error')
    expect(latest?.status.message).toBe('network reset')
  })

  it('maps no-speech completion status to completed', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.receive({
        type: 'stream.status',
        status: 'completed_with_no_speech_detected',
        message: 'Không phát hiện giọng nói',
      })
    })

    await flush()

    expect(latest?.status.state).toBe('completed')
    expect(latest?.status.message).toBe('Không phát hiện giọng nói')
  })

  it('waits for session.ready before reporting readiness', async () => {
    const socket = MockWebSocket.instances[0]
    let resolved = false

    const readyPromise = latest!.waitForSessionReady()
    readyPromise.then(() => {
      resolved = true
    })

    await flush()
    expect(resolved).toBe(false)

    act(() => {
      socket.open()
    })

    await flush()
    expect(resolved).toBe(false)

    act(() => {
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    expect(resolved).toBe(true)
    expect(latest?.isAuthenticated).toBe(true)
  })

  it('waits for the caller supplied meeting id when the hook render has not updated yet', async () => {
    let currentMeetingId: number | null = null
    let resolved = false

    function HarnessWithDeferredMeeting() {
      latest = useRealtimeMeetingStream({
        meetingId: currentMeetingId,
        userId: 12,
        token: 'jwt-token',
        sessionToken: currentSessionToken,
        enabled: true,
        autoReconnect: false,
      })

      return null
    }

    act(() => {
      root.render(<HarnessWithDeferredMeeting />)
    })

    await flush()
    currentMeetingId = 501
    currentSessionToken = createSessionToken(501, 1, 1)

    act(() => {
      root.render(<HarnessWithDeferredMeeting />)
    })

    await flush()
    const socket = MockWebSocket.instances.at(-1)
    expect(socket).not.toBeUndefined()

    const readyPromise = latest!.waitForSessionReady(15000, 501, currentSessionToken)
    readyPromise.then(() => {
      resolved = true
    })

    act(() => {
      socket!.open()
      socket!.receive({
        type: 'session.ready',
        meetingId: 501,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    expect(resolved).toBe(true)
    expect(latest?.isAuthenticated).toBe(true)
  })

  it('resolves an existing ready waiter when session.ready arrives on a newer connection sequence', async () => {
    const token = createSessionToken(88, 1, 1)

    function HarnessWithStableToken() {
      latest = useRealtimeMeetingStream({
        meetingId: 88,
        userId: 12,
        token: 'jwt-token',
        sessionToken: token,
        enabled: true,
        autoReconnect: false,
      })
      return null
    }

    act(() => {
      root.render(<HarnessWithStableToken />)
    })
    await flush()

    const firstSocket = MockWebSocket.instances.at(-1)!
    const waiterPromise = latest!.waitForSessionReady(1000, 88, token)

    // Simulate a dead transport that never emitted onclose; this forces a new
    // connection sequence while keeping the existing waiter alive.
    firstSocket.readyState = MockWebSocket.CLOSED

    act(() => {
      latest!.connect()
    })
    await flush()

    const secondSocket = MockWebSocket.instances.at(-1)!
    expect(secondSocket).not.toBe(firstSocket)

    act(() => {
      secondSocket.open()
      secondSocket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await expect(waiterPromise).resolves.toBeUndefined()
    expect(latest?.isAuthenticated).toBe(true)
  })

  it('ignores stale ready timeout from an old token and keeps the new socket active', async () => {
    vi.useFakeTimers()

    let currentToken = createSessionToken(88, 1, 1)

    function HarnessWithSwappedToken() {
      latest = useRealtimeMeetingStream({
        meetingId: 88,
        userId: 12,
        token: 'jwt-token',
        sessionToken: currentToken,
        enabled: true,
        autoReconnect: false,
      })
      return null
    }

    act(() => {
      root.render(<HarnessWithSwappedToken />)
    })

    const staleReadyPromise = latest!.waitForSessionReady(100, 88, currentToken)
    void staleReadyPromise.catch(() => {})

    currentToken = createSessionToken(88, 2, 2)
    act(() => {
      root.render(<HarnessWithSwappedToken />)
    })

    const activeSocket = MockWebSocket.instances.at(-1)!
    act(() => {
      activeSocket.open()
      activeSocket.receive({ type: 'session.ready', meetingId: 88, authenticated: true, activeConnections: 1 })
    })

    await vi.advanceTimersByTimeAsync(100)

    await expect(staleReadyPromise).rejects.toThrow(
      /Stale realtime ready timeout ignored|Realtime session disconnected before it became ready/,
    )
    expect(activeSocket.readyState).toBe(MockWebSocket.OPEN)
    expect(latest?.isConnected).toBe(true)
    expect(latest?.isAuthenticated).toBe(true)
  })

  it('fails the current ready timeout when the active token never becomes ready', async () => {
    vi.useFakeTimers()

    const currentToken = createSessionToken(88, 1, 1)

    function HarnessWithTimedOutToken() {
      latest = useRealtimeMeetingStream({
        meetingId: 88,
        userId: 12,
        token: 'jwt-token',
        sessionToken: currentToken,
        enabled: true,
        autoReconnect: false,
      })
      return null
    }

    act(() => {
      root.render(<HarnessWithTimedOutToken />)
    })

    const readyPromise = latest!.waitForSessionReady(100, 88, currentToken)
    void readyPromise.catch(() => {})

    await vi.advanceTimersByTimeAsync(100)

    await expect(readyPromise).rejects.toThrow('Realtime session did not become ready in time')
  })

  it('keeps meeting B chunks queued during bootstrap and flushes after meeting B session.ready', async () => {
    let currentMeetingId = 21
    currentSessionToken = createSessionToken(21, 1, 1)

    function HarnessWithMeetingSwitch() {
      latest = useRealtimeMeetingStream({
        meetingId: currentMeetingId,
        userId: 12,
        token: 'jwt-token',
        sessionToken: currentSessionToken,
        enabled: true,
        autoReconnect: false,
      })
      return null
    }

    act(() => {
      root.render(<HarnessWithMeetingSwitch />)
    })
    await flush()

    const socketA = MockWebSocket.instances.at(-1)!
    act(() => {
      socketA.open()
      socketA.receive({ type: 'session.ready', meetingId: 21, authenticated: true, activeConnections: 1 })
    })
    await flush()

    currentMeetingId = 22
    act(() => {
      root.render(<HarnessWithMeetingSwitch />)
    })
    await flush()

    const socketB = MockWebSocket.instances.at(-1)!
    await act(async () => {
      await latest!.sendAudioChunk(new Blob(['chunk-b'], { type: 'audio/webm; codecs=opus' }), '22')
    })

    const preReadyAudioMetadata = socketB.send.mock.calls
      .map(([payload]) => (typeof payload === 'string' ? payload : null))
      .filter((payload): payload is string => payload !== null)
      .some((payload) => payload.includes('"type":"audio.chunk"'))

    expect(preReadyAudioMetadata).toBe(false)

    act(() => {
      socketB.open()
      socketB.receive({ type: 'session.ready', meetingId: 22, authenticated: true, activeConnections: 1 })
    })
    await flush()

    const postReadyMessages = socketB.send.mock.calls
      .map(([payload]) => {
        if (typeof payload !== 'string') return null
        try {
          return JSON.parse(payload) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((msg): msg is Record<string, unknown> => msg !== null)

    expect(postReadyMessages.some((message) => message.type === 'audio.chunk' && message.meeting_id === 22)).toBe(true)
  })

  it('keeps the active websocket alive when stale cleanup runs twice', async () => {
    const staleToken = createSessionToken(88, 1, 1)
    const activeToken = createSessionToken(89, 2, 2)

    function FirstHarness() {
      latest = useRealtimeMeetingStream({
        meetingId: 88,
        userId: 12,
        token: 'jwt-token',
        sessionToken: staleToken,
        enabled: true,
        autoReconnect: false,
      })
      return null
    }

    function SecondHarness() {
      latest = useRealtimeMeetingStream({
        meetingId: 89,
        userId: 12,
        token: 'jwt-token',
        sessionToken: activeToken,
        enabled: true,
        autoReconnect: false,
      })
      return null
    }

    act(() => {
      root.render(<FirstHarness />)
    })
    await flush()

    const firstSocket = MockWebSocket.instances.at(-1)!
    act(() => {
      firstSocket.open()
      firstSocket.receive({ type: 'session.ready', meetingId: 88, authenticated: true, activeConnections: 1 })
    })
    await flush()

    act(() => {
      root.render(<SecondHarness />)
    })
    await flush()

    const secondSocket = MockWebSocket.instances.at(-1)!
    act(() => {
      secondSocket.open()
      secondSocket.receive({ type: 'session.ready', meetingId: 89, authenticated: true, activeConnections: 1 })
    })
    await flush()

    act(() => {
      latest!.disconnect(staleToken)
      latest!.disconnect(staleToken)
    })

    expect(secondSocket.readyState).toBe(MockWebSocket.OPEN)
    expect(latest?.isConnected).toBe(true)
    expect(latest?.isAuthenticated).toBe(true)
  })

  it('keeps the newest websocket active when a stale socket closes', async () => {
    let secondLatest: ReturnType<typeof useRealtimeMeetingStream> | null = null
    let secondRoot: ReturnType<typeof createRoot> | null = null
    let secondContainer: HTMLDivElement | null = null
    const secondSessionToken = createSessionToken(89, 2, 2)

    function FirstHarness() {
      latest = useRealtimeMeetingStream({
        meetingId: 88,
        userId: 12,
        token: 'jwt-token',
        sessionToken: currentSessionToken,
        enabled: true,
        autoReconnect: false,
      })
      return null
    }

    function SecondHarness() {
      secondLatest = useRealtimeMeetingStream({
        meetingId: 89,
        userId: 12,
        token: 'jwt-token',
        sessionToken: secondSessionToken,
        enabled: true,
        autoReconnect: false,
      })
      return null
    }

    act(() => {
      root.render(<FirstHarness />)
    })
    await flush()

    const firstSocket = MockWebSocket.instances.at(-1)!

    act(() => {
      firstSocket.open()
      firstSocket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    secondContainer = document.createElement('div')
    document.body.appendChild(secondContainer)
    secondRoot = createRoot(secondContainer)

    act(() => {
      secondRoot!.render(<SecondHarness />)
    })

    await flush()

    const secondSocket = MockWebSocket.instances.at(-1)!

    act(() => {
      secondSocket.open()
      secondSocket.receive({
        type: 'session.ready',
        meetingId: 89,
        authenticated: true,
        activeConnections: 1,
      })
    })

    await flush()

    await act(async () => {
      await secondLatest!.waitForSessionReady()
    })

    act(() => {
      firstSocket.onclose?.({ code: 1006, reason: 'network reset' })
    })

    await flush()

    expect(secondLatest).not.toBeNull()
    const stableSecondLatest = secondLatest!
    expect(stableSecondLatest.isConnected).toBe(true)
    expect(stableSecondLatest.isAuthenticated).toBe(true)

    await act(async () => {
      await stableSecondLatest.sendAudioChunk(new Blob(['fresh'], { type: 'audio/webm; codecs=opus' }), '89')
    })

    const sentMessages = secondSocket.send.mock.calls.map(([payload]) => {
      try {
        return typeof payload === 'string' ? (JSON.parse(payload) as Record<string, unknown>) : null
      } catch {
        return null
      }
    })

    expect(sentMessages.some((message) => message?.type === 'audio.chunk' && message?.meeting_id === 89)).toBe(true)

    act(() => {
      secondRoot?.unmount()
    })

    secondContainer?.remove()
  })
})
