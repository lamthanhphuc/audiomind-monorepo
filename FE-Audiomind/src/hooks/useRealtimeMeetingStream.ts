import { useEffect, useRef, useState, useCallback } from 'react';

export interface TranscriptSegment {
  id: string;
  speaker: string;
  text: string;
  timestamp: number;
  confidence?: number;
}

export interface KeywordHit {
  id: string;
  keyword: string;
  confidence: number;
  position: number;
  definition?: string;
}

export interface RealtimeStatusEvent {
  state: 'connected' | 'disconnected' | 'reconnecting' | 'error';
  activeConnections?: number;
  lagMs?: number;
  message?: string;
}

interface UseRealtimeMeetingStreamOptions {
  meetingId: number;
  userId: number;
  token: string;
  onTranscript?: (segment: TranscriptSegment) => void;
  onKeyword?: (hit: KeywordHit) => void;
  onStatusChange?: (status: RealtimeStatusEvent) => void;
  autoReconnect?: boolean;
  reconnectAttempts?: number;
  reconnectDelay?: number;
}

const DEFAULT_WS_URL = process.env.REACT_APP_WS_URL || 'ws://localhost:8080/ws/meetings';

export const useRealtimeMeetingStream = (options: UseRealtimeMeetingStreamOptions) => {
  const {
    meetingId,
    userId,
    token,
    onTranscript,
    onKeyword,
    onStatusChange,
    autoReconnect = true,
    reconnectAttempts = 5,
    reconnectDelay = 1000,
  } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptSegment[]>([]);
  const [keywords, setKeywords] = useState<KeywordHit[]>([]);
  const [status, setStatus] = useState<RealtimeStatusEvent>({ state: 'disconnected' });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectCountRef = useRef(0);
  const messageQueueRef = useRef<any[]>([]);

  const updateStatus = useCallback((newStatus: RealtimeStatusEvent) => {
    setStatus(newStatus);
    onStatusChange?.(newStatus);
  }, [onStatusChange]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      const wsUrl = new URL(DEFAULT_WS_URL);
      wsUrl.pathname = `/ws/meetings/${meetingId}`;
      wsUrl.searchParams.set('userId', userId.toString());
      wsUrl.searchParams.set('token', token);

      const ws = new WebSocket(wsUrl.toString());

      ws.onopen = () => {
        console.log(`[Realtime] Connected to meeting ${meetingId}`);
        setIsConnected(true);
        reconnectCountRef.current = 0;
        updateStatus({ state: 'connected', activeConnections: 1 });

        // Send auth init message
        ws.send(JSON.stringify({
          type: 'auth.init',
          token,
          userId,
          meetingId,
        }));

        // Flush queued messages
        while (messageQueueRef.current.length > 0) {
          const queuedMsg = messageQueueRef.current.shift();
          ws.send(JSON.stringify(queuedMsg));
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          switch (data.type) {
            case 'session.ready':
              console.log('[Realtime] Session ready', data);
              break;

            case 'transcript.partial':
              {
                const segment: TranscriptSegment = {
                  id: data.segment_id || data.id || `seg-${Date.now()}`,
                  speaker: data.speaker || 'Unknown',
                  text: data.text || '',
                  timestamp: data.start_time || 0,
                  confidence: data.confidence,
                };
                setTranscripts((prev) => {
                  const updated = [...prev];
                  const existingIndex = updated.findIndex((s) => s.id === segment.id);
                  if (existingIndex >= 0) {
                    updated[existingIndex] = segment;
                  } else {
                    updated.push(segment);
                  }
                  return updated;
                });
                onTranscript?.(segment);
              }
              break;

            case 'keyword.hit':
              {
                const hit: KeywordHit = {
                  id: data.keyword_id || data.id || `kw-${Date.now()}`,
                  keyword: data.term || data.keyword || '',
                  confidence: data.confidence || 0.8,
                  position: data.ranges?.[0] || 0,
                  definition: data.definition,
                };
                setKeywords((prev) => [...prev, hit]);
                onKeyword?.(hit);
              }
              break;

            case 'stream.status':
              updateStatus({
                state: 'connected',
                activeConnections: data.activeConnections,
                lagMs: data.lagMs,
              });
              break;

            case 'stream.error':
              console.error('[Realtime] Stream error:', data.message);
              if (data.recoverable === false) {
                ws.close();
              }
              break;

            default:
              console.debug('[Realtime] Unknown message type:', data.type);
          }
        } catch (error) {
          console.error('[Realtime] Failed to parse message:', error, event);
        }
      };

      ws.onerror = (event) => {
        console.error('[Realtime] WebSocket error:', event);
        updateStatus({ state: 'error', message: 'WebSocket error' });
      };

      ws.onclose = () => {
        console.log('[Realtime] Disconnected from meeting');
        setIsConnected(false);
        wsRef.current = null;

        if (autoReconnect && reconnectCountRef.current < reconnectAttempts) {
          reconnectCountRef.current++;
          const delay = reconnectDelay * Math.pow(1.5, reconnectCountRef.current - 1);
          updateStatus({ state: 'reconnecting', message: `Reconnecting in ${Math.round(delay / 1000)}s...` });
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        } else {
          updateStatus({ state: 'disconnected', message: 'Disconnected' });
        }
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('[Realtime] Failed to establish connection:', error);
      updateStatus({ state: 'error', message: 'Failed to connect' });
    }
  }, [meetingId, userId, token, autoReconnect, reconnectAttempts, reconnectDelay, updateStatus]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  }, []);

  const send = useCallback(
    (message: any) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(message));
      } else {
        messageQueueRef.current.push(message);
      }
    },
    []
  );

  const pause = useCallback(() => {
    send({ type: 'stream.pause' });
  }, [send]);

  const resume = useCallback(() => {
    send({ type: 'stream.resume' });
  }, [send]);

  const clearTranscripts = useCallback(() => {
    setTranscripts([]);
  }, []);

  const clearKeywords = useCallback(() => {
    setKeywords([]);
  }, []);

  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [meetingId, userId, token]); // Intentionally excluding connect/disconnect to avoid loops

  return {
    isConnected,
    status,
    transcripts,
    keywords,
    connect,
    disconnect,
    send,
    pause,
    resume,
    clearTranscripts,
    clearKeywords,
  };
};
