package com.example.processingservice.interfaces.websocket.realtime;

import org.springframework.web.socket.WebSocketSession;

@FunctionalInterface
public interface RealtimeAudioChunkProcessor {
    void processChunk(WebSocketSession session, RealtimeAudioWorkItem item) throws Exception;
}
