import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useRealtimeMeetingStream } from './useRealtimeMeetingStream'
import {
  mergeTranscriptSegments,
  normalizePersistedTranscriptSegments,
  normalizeTranscriptEvent,
} from '../utils/transcript'

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

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('useRealtimeMeetingStream', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let latest: ReturnType<typeof useRealtimeMeetingStream> | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)

    function Harness() {
      latest = useRealtimeMeetingStream({
        meetingId: 88,
        userId: 12,
        token: 'jwt-token',
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
    container.remove()
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
        segmentId: '7',
        speaker: 'Speaker 1',
        startTime: 1.25,
        endTime: 2.5,
        text: 'Xin chào',
        language: 'vi',
      })
      socket.receive({
        type: 'transcript.final',
        seq: 7,
        segmentId: '7',
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
      id: 'time-1.250-speaker 1',
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
  })

  it('marks server stop reason as stopped instead of error', async () => {
    const socket = MockWebSocket.instances[0]

    act(() => {
      socket.open()
      socket.closeWith(1000, 'Stream stopped by client')
    })

    await flush()

    expect(latest?.status.state).toBe('stopped')
    expect(latest?.closeReason).toBe('Stream stopped by client')
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
})
