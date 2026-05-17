package com.example.processingservice.interfaces.websocket;

import com.example.processingservice.security.JwtUtil;
import com.example.processingservice.security.MeetingChannelAuthorizer;
import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.services.RealtimeEventSubscriber;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.jsonwebtoken.Claims;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

@Slf4j
@Component
public class MeetingWebSocketHandler extends AbstractWebSocketHandler {

    private static final String AUTHENTICATED_ATTR = "authenticated";
    private static final String LAST_AUDIO_SEQ_ATTR = "lastAudioSeq";
    private static final String LAST_AUDIO_DECLARED_SIZE_ATTR = "lastAudioDeclaredSize";
    private static final String LAST_AUDIO_IS_FINAL_ATTR = "lastAudioIsFinal";
    private static final String AUDIO_RECEIVED_ATTR = "AUDIO_RECEIVED_ATTR";
    private static final String LANGUAGE_ATTR = "language";
    private static final String LAST_ACTIVITY_ATTR = "lastActivity";
    private static final String FINALIZED_ATTR = "FINALIZED_ATTR";
    private static final long IDLE_SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    static final int MAX_FINALIZED_TRANSCRIPT_CACHE_SIZE = 100;
    private static final long FINALIZED_TRANSCRIPT_CACHE_TTL_MS = 5 * 60 * 1000;

    // Cache for finalized transcripts (key: meetingId, value: final transcript event)
    private final ConcurrentHashMap<Long, CachedTranscript> finalizedTranscriptCache = new ConcurrentHashMap<>();

    private final MeetingChannelAuthorizer meetingChannelAuthorizer;
    private final RealtimeEventSubscriber realtimeEventSubscriber;
    private final AIServiceClient aiServiceClient;
    private final ObjectMapper objectMapper;
    private final JwtUtil jwtUtil;

    public MeetingWebSocketHandler(
            MeetingChannelAuthorizer meetingChannelAuthorizer,
            RealtimeEventSubscriber realtimeEventSubscriber,
            AIServiceClient aiServiceClient,
            ObjectMapper objectMapper,
            JwtUtil jwtUtil) {
        this.meetingChannelAuthorizer = meetingChannelAuthorizer;
        this.realtimeEventSubscriber = realtimeEventSubscriber;
        this.aiServiceClient = aiServiceClient;
        this.objectMapper = objectMapper;
        this.jwtUtil = jwtUtil;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        Long meetingId = getLongAttribute(session, "meetingId");

        if (meetingId == null) {
            session.close(CloseStatus.NOT_ACCEPTABLE.withReason("Missing meetingId"));
            return;
        }

        // Register session with realtime subscriber
        realtimeEventSubscriber.registerSession(meetingId, session);
        session.getAttributes().put(AUTHENTICATED_ATTR, false);
        session.getAttributes().put(LANGUAGE_ATTR, "vi");
        session.getAttributes().put(LAST_ACTIVITY_ATTR, System.currentTimeMillis());

        // Send initial ready event; auth.init will finalize user authentication.
        Map<String, Object> readyEvent = new HashMap<>();
        readyEvent.put("type", "session.ready");
        readyEvent.put("meetingId", meetingId);
        readyEvent.put("authenticated", false);
        readyEvent.put("activeConnections", realtimeEventSubscriber.getActiveConnectionCount(meetingId));

        Long userId = getLongAttribute(session, "userId");
        if (userId != null) {
            readyEvent.put("userId", userId);
        }
        safeSendMessage(session, new TextMessage(objectMapper.writeValueAsString(readyEvent)));

        log.info("WebSocket session established for meetingId={} (awaiting auth.init)", meetingId);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        String payload = message.getPayload();
        if (payload == null || payload.isBlank()) {
            return;
        }

        Long meetingId = getLongAttribute(session, "meetingId");
        if (meetingId == null) {
            session.close(new CloseStatus(1008, "Invalid session state"));
            return;
        }

        // Update last activity timestamp
        updateLastActivity(session);

        Map<String, Object> data;
        try {
            data = objectMapper.readValue(payload, Map.class);
        } catch (Exception ex) {
            session.close(CloseStatus.BAD_DATA.withReason("Invalid JSON payload"));
            return;
        }

        String type = getStringValue(data.get("type"));

        if ("auth.init".equals(type)) {
            handleAuthInit(session, data, meetingId);
            return;
        }

        // Require authentication for subsequent messages
        if (!isAuthenticated(session)) {
            session.close(CloseStatus.POLICY_VIOLATION.withReason("Authentication required"));
            return;
        }

        // Handle audio chunk metadata (binary data follows in separate message)
        if ("audio.chunk".equals(type)) {
            Long seq = getLongAttribute(data, "seq");
            Long size = getLongAttribute(data, "size");
            Long tsMs = getLongAttribute(data, "ts_ms");
            Long sampleRate = getLongAttribute(data, "sample_rate");
            Long channels = getLongAttribute(data, "channels");
            String mimeType = getStringValue(data.get("mime_type"));
            String encoding = getStringValue(data.get("encoding"));
            String language = getStringValue(data.get("language"));
            Boolean isFinal = getBooleanValue(data.get("is_final"));
            
            // Store seq so we can correlate with binary message
            session.getAttributes().put(LAST_AUDIO_SEQ_ATTR, seq);
            session.getAttributes().put(LAST_AUDIO_DECLARED_SIZE_ATTR, size);
            if (!language.isBlank()) {
                session.getAttributes().put(LANGUAGE_ATTR, language);
            }
            session.getAttributes().put(LAST_AUDIO_IS_FINAL_ATTR, isFinal != null && isFinal);
            
            log.info(
                    "Received audio.chunk metadata meetingId={} seq={} declaredSize={} tsMs={} mimeType={} encoding={} sampleRate={} channels={} language={} isFinal={}",
                    meetingId,
                    seq,
                    size,
                    tsMs,
                    mimeType,
                    encoding,
                    sampleRate,
                    channels,
                    language,
                    isFinal
            );
            return;
        }

        // Handle stream stop request - finalize STT BEFORE closing session
        if ("stream.stop".equals(type)) {
            log.info("Received stream.stop for meetingId={}, finalizing STT session now", meetingId);
            finalizeSttSession(session, meetingId, true);
            try {
                session.close(CloseStatus.NORMAL.withReason("Stream stopped by client"));
            } catch (Exception e) {
                log.warn("Error closing session after stream.stop for meetingId={}: {}", meetingId, e.getMessage());
            }
            return;
        }

        Map<String, Object> statusEvent = Map.of(
                "type", "stream.status",
                "state", "received",
                "meetingId", meetingId,
                "activeConnections", realtimeEventSubscriber.getActiveConnectionCount(meetingId)
        );

        safeSendMessage(session, new TextMessage(objectMapper.writeValueAsString(statusEvent)));
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) throws Exception {
        Long meetingId = getLongAttribute(session, "meetingId");
        if (meetingId == null) {
            session.close(new CloseStatus(1008, "Invalid session state"));
            return;
        }

        // Update last activity timestamp
        updateLastActivity(session);

        // Require authentication for binary audio
        if (!isAuthenticated(session)) {
            session.close(CloseStatus.POLICY_VIOLATION.withReason("Authentication required"));
            return;
        }

        ByteBuffer payloadBuffer = message.getPayload().asReadOnlyBuffer();
        byte[] audioBytes = new byte[payloadBuffer.remaining()];
        payloadBuffer.get(audioBytes);

        int payloadSize = audioBytes.length;
        Long lastSeq = getLongAttribute(session, LAST_AUDIO_SEQ_ATTR);
        Long declaredSize = getLongAttribute(session, LAST_AUDIO_DECLARED_SIZE_ATTR);
        String language = getStringAttribute(session, LANGUAGE_ATTR);
        String authorization = getStringAttribute(session, "authorization");
        Boolean isFinal = getBooleanAttribute(session, LAST_AUDIO_IS_FINAL_ATTR);
        log.info(
                "AUDIO HASH PROCESSING_IN seq={} size={} first16hex={}",
                lastSeq,
                payloadSize,
                first16Hex(audioBytes)
        );

        try {
            Map<String, Object> transcript = aiServiceClient.streamAudioChunk(
                    meetingId,
                    audioBytes,
                    lastSeq != null ? lastSeq : 0L,
                    language,
                    isFinal != null && isFinal,
                    null,
                    authorization
            );

            // Mark that we've successfully sent audio to the AI service for this session
            try {
                session.getAttributes().put(AUDIO_RECEIVED_ATTR, Boolean.TRUE);
            } catch (Exception ignore) {
                log.debug("Unable to set AUDIO_RECEIVED_ATTR for sessionId={}", session.getId());
            }

            Map<String, Object> transcriptEvent = buildTranscriptEvent(
                    meetingId,
                    transcript,
                    lastSeq != null ? lastSeq : 0L,
                    language,
                    Boolean.TRUE.equals(getBooleanValue(transcript.get("is_final")))
            );

            try {
                if (transcriptEvent != null) {
                    realtimeEventSubscriber.broadcastToMeeting(meetingId, transcriptEvent);
                } else {
                    realtimeEventSubscriber.broadcastToMeeting(meetingId, buildListeningStatusEvent(meetingId, lastSeq));
                }
            } catch (Exception e) {
                log.error("Failed to broadcast transcriptEvent for meetingId={}: {}", meetingId, e.getMessage(), e);
            }
        } catch (Exception ex) {
            log.warn(
                    "Failed to stream audio chunk to ai-service for meetingId={} seq={}: {}",
                    meetingId,
                    lastSeq,
                    ex.getMessage()
            );

            Map<String, Object> errorEvent = Map.of(
                    "type", "stream.error",
                    "meetingId", meetingId,
                    "message", "Failed to transcribe audio chunk",
                    "recoverable", true
            );
            try {
                realtimeEventSubscriber.broadcastToMeeting(meetingId, errorEvent);
            } catch (Exception e) {
                log.error("Failed to broadcast errorEvent for meetingId={}: {}", meetingId, e.getMessage(), e);
            }
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        Long meetingId = getLongAttribute(session, "meetingId");
        if (meetingId != null) {
            // Check if finalization was already done (e.g., via stream.stop)
            Boolean alreadyFinalized = (Boolean) session.getAttributes().get(FINALIZED_ATTR);
            Boolean audioReceived = (Boolean) session.getAttributes().get(AUDIO_RECEIVED_ATTR);
            if (!Boolean.TRUE.equals(alreadyFinalized) && isAuthenticated(session)) {
                if (Boolean.TRUE.equals(audioReceived)) {
                    // finalizeSttSession() cannot broadcast here (session is closed),
                    // but we still try to finalize and cache the transcript for fallback
                    finalizeSttSession(session, meetingId, false);
                } else {
                    log.info("Skipping STT finalization for meetingId={} because no audio was received", meetingId);
                }
            } else if (!isAuthenticated(session)) {
                log.info("Skipping STT finalization for unauthenticated session meetingId={}", meetingId);
            }

            realtimeEventSubscriber.unregisterSession(meetingId, session);
            log.info("WebSocket session closed for meetingId={}", meetingId);
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) throws Exception {
        Long meetingId = getLongAttribute(session, "meetingId");
        if (meetingId != null) {
            realtimeEventSubscriber.unregisterSession(meetingId, session);
            log.warn("WebSocket transport error for meetingId={}", meetingId, exception);
        }
    }

    private void safeSendMessage(WebSocketSession session, TextMessage message) {
        if (session == null) {
            log.warn("Attempted to send message to null session");
            return;
        }
        try {
            if (session.isOpen()) {
                session.sendMessage(message);
            } else {
                log.debug("Session is not open, skipping sendMessage for sessionId={}", session.getId());
            }
        } catch (Exception e) {
            try {
                log.error("Failed to send WebSocket message to sessionId={}: {}", session.getId(), e.getMessage(), e);
            } catch (Exception ignore) {
                // best-effort logging
            }
        }
    }

    private String first16Hex(byte[] audioBytes) {
        byte[] payload = audioBytes == null ? new byte[0] : audioBytes;
        return HexFormat.of().formatHex(Arrays.copyOfRange(payload, 0, Math.min(16, payload.length)));
    }

    private Long getLongAttribute(WebSocketSession session, String key) {
        Object value = session.getAttributes().get(key);
        if (value instanceof Number number) {
            return number.longValue();
        }
        if (value != null) {
            try {
                return Long.parseLong(String.valueOf(value));
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private void finalizeSttSession(WebSocketSession session, Long meetingId, boolean sessionStillOpen) {
        String language = getStringAttribute(session, LANGUAGE_ATTR);
        String authorization = getStringAttribute(session, "authorization");

        // Mark this session as finalized to avoid double-finalization
        try {
            session.getAttributes().put(FINALIZED_ATTR, Boolean.TRUE);
        } catch (Exception ignore) {
            log.debug("Unable to set FINALIZED_ATTR for sessionId={}", session.getId());
        }

        // Only finalize when the session actually received audio payloads.
        Boolean audioReceived = (Boolean) session.getAttributes().get(AUDIO_RECEIVED_ATTR);
        if (!Boolean.TRUE.equals(audioReceived)) {
            log.info("No audio received for meetingId={}, skipping finalize", meetingId);
            Map<String, Object> statusEvent = Map.of(
                    "type", "stream.status",
                    "status", "completed_no_audio",
                    "meetingId", meetingId,
                    "activeConnections", realtimeEventSubscriber.getActiveConnectionCount(meetingId)
            );
            if (sessionStillOpen) {
                try {
                    realtimeEventSubscriber.broadcastToMeeting(meetingId, statusEvent);
                } catch (Exception e) {
                    log.error("Failed to broadcast completed_no_audio for meetingId={}: {}", meetingId, e.getMessage(), e);
                }
            } else {
                log.debug("Session already closed for meetingId={}, cannot broadcast completed_no_audio event", meetingId);
            }
            return;
        }

        log.info(
                "Finalizing STT session for meetingId={} with synthetic final chunk",
                meetingId
        );

        try {
            Map<String, Object> transcript = aiServiceClient.streamAudioChunk(
                    meetingId,
                    new byte[0],
                    -1L,
                    language,
                    true,
                    null,
                    authorization
            );

            Long finalSeq = getLongAttribute(session, LAST_AUDIO_SEQ_ATTR);
            Map<String, Object> transcriptEvent = buildTranscriptEvent(
                    meetingId,
                    transcript,
                    finalSeq != null ? finalSeq : -1L,
                    language,
                    true
            );

            if (transcriptEvent != null) {
                // Preserve the final payload type while keeping the segment id stable for FE merging.
                transcriptEvent.put("seq", -1L);
                transcriptEvent.put("isFinal", true);

                cacheFinalizedTranscript(meetingId, transcriptEvent);

                if (sessionStillOpen) {
                    try {
                        realtimeEventSubscriber.broadcastToMeeting(meetingId, transcriptEvent);
                        log.info(
                                "Broadcast final transcript for meetingId={} seq=-1 transcriptLength={}",
                                meetingId,
                                getStringValue(transcriptEvent.get("text")).length()
                        );
                    } catch (Exception e) {
                        log.error("Failed to broadcast final transcript for meetingId={}: {}", meetingId, e.getMessage(), e);
                    }
                } else {
                    log.info(
                            "Session closed for meetingId={}, cached final transcript for fallback delivery (length={})",
                            meetingId,
                            getStringValue(transcriptEvent.get("text")).length()
                    );
                }
                return;
            }

            Map<String, Object> statusEvent = Map.of(
                    "type", "stream.status",
                    "state", "completed_with_no_speech_detected",
                    "status", "completed_with_no_speech_detected",
                    "meetingId", meetingId,
                    "message", "STT session closed with no recognized speech",
                    "activeConnections", realtimeEventSubscriber.getActiveConnectionCount(meetingId)
            );
            if (sessionStillOpen) {
                try {
                    realtimeEventSubscriber.broadcastToMeeting(meetingId, statusEvent);
                } catch (Exception e) {
                    log.error("Failed to broadcast statusEvent for meetingId={}: {}", meetingId, e.getMessage(), e);
                }
            }
            log.info("No final transcript returned for meetingId={}", meetingId);
        } catch (Exception ex) {
            log.warn(
                    "Failed to finalize STT session for meetingId={}: {}",
                    meetingId,
                    ex.getMessage()
            );

            Map<String, Object> errorEvent = Map.of(
                    "type", "stream.error",
                    "meetingId", meetingId,
                    "message", "Failed to finalize STT session",
                    "recoverable", false
            );
            if (sessionStillOpen) {
                try {
                    realtimeEventSubscriber.broadcastToMeeting(meetingId, errorEvent);
                } catch (Exception e) {
                    log.error("Failed to broadcast finalize errorEvent for meetingId={}: {}", meetingId, e.getMessage(), e);
                }
            }
        }
    }

    /**
     * Public method to retrieve a cached finalized transcript (for fallback delivery or polling).
     */
    public Map<String, Object> getFinalizedTranscript(Long meetingId) {
        evictExpiredFinalizedTranscripts();
        CachedTranscript cached = finalizedTranscriptCache.get(meetingId);
        return cached == null ? null : cached.event();
    }

    /**
     * Public method to clear a cached finalized transcript after delivery.
     */
    public void clearFinalizedTranscript(Long meetingId) {
        finalizedTranscriptCache.remove(meetingId);
    }

    int finalizedTranscriptCacheSizeForTesting() {
        evictExpiredFinalizedTranscripts();
        return finalizedTranscriptCache.size();
    }

    private void cacheFinalizedTranscript(Long meetingId, Map<String, Object> transcriptEvent) {
        evictExpiredFinalizedTranscripts();
        finalizedTranscriptCache.put(meetingId, new CachedTranscript(Map.copyOf(transcriptEvent), System.currentTimeMillis()));
        evictOverflowFinalizedTranscripts();
    }

    private void evictExpiredFinalizedTranscripts() {
        long cutoff = System.currentTimeMillis() - FINALIZED_TRANSCRIPT_CACHE_TTL_MS;
        finalizedTranscriptCache.entrySet().removeIf(entry -> entry.getValue().createdAtMs() < cutoff);
    }

    private void evictOverflowFinalizedTranscripts() {
        while (finalizedTranscriptCache.size() > MAX_FINALIZED_TRANSCRIPT_CACHE_SIZE) {
            Long oldestMeetingId = finalizedTranscriptCache.entrySet().stream()
                    .min(Comparator.comparingLong(entry -> entry.getValue().createdAtMs()))
                    .map(Map.Entry::getKey)
                    .orElse(null);
            if (oldestMeetingId == null) {
                return;
            }
            finalizedTranscriptCache.remove(oldestMeetingId);
        }
    }

    private record CachedTranscript(Map<String, Object> event, long createdAtMs) {
    }

    private Long getLongAttribute(Map<String, Object> data, String key) {
        Object value = data.get(key);
        if (value instanceof Number number) {
            return number.longValue();
        }
        if (value != null) {
            try {
                return Long.parseLong(String.valueOf(value));
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private String getStringAttribute(WebSocketSession session, String key) {
        Object value = session.getAttributes().get(key);
        return value == null ? null : String.valueOf(value);
    }

    private Boolean getBooleanAttribute(WebSocketSession session, String key) {
        Object value = session.getAttributes().get(key);
        if (value instanceof Boolean bool) {
            return bool;
        }
        if (value == null) {
            return null;
        }
        return Boolean.parseBoolean(String.valueOf(value));
    }

    private boolean isAuthenticated(WebSocketSession session) {
        Object value = session.getAttributes().get(AUTHENTICATED_ATTR);
        return value instanceof Boolean bool && bool;
    }

    private String getStringValue(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private Double getDoubleValue(Object value) {
        if (value instanceof Number number) {
            return number.doubleValue();
        }
        if (value == null) {
            return null;
        }
        String normalized = String.valueOf(value).trim();
        if (normalized.isEmpty()) {
            return null;
        }
        try {
            return Double.parseDouble(normalized);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private Map<String, Object> buildTranscriptEvent(
            Long meetingId,
            Map<String, Object> transcript,
            Long seq,
            String language,
            boolean finalEvent) {
        String transcriptText = getStringValue(transcript.get("transcript"));
        if (transcriptText.isBlank()) {
            return null;
        }

        Long resolvedSeq = seq == null ? 0L : seq;
        Double startTime = getDoubleValue(transcript.get("start_time"));
        if (startTime == null) {
            startTime = getDoubleValue(transcript.get("startTime"));
        }
        Double endTime = getDoubleValue(transcript.get("end_time"));
        if (endTime == null) {
            endTime = getDoubleValue(transcript.get("endTime"));
        }

        String segmentId = getStringValue(transcript.get("segment_id"));
        if (segmentId.isBlank()) {
            segmentId = getStringValue(transcript.get("segmentId"));
        }
        if (segmentId.isBlank() && startTime != null) {
            segmentId = String.format("meeting-%d-start-%.3f", meetingId, startTime);
        }
        if (segmentId.isBlank()) {
            segmentId = String.valueOf(resolvedSeq);
        }

        Map<String, Object> transcriptEvent = new HashMap<>();
        transcriptEvent.put("type", finalEvent ? "transcript.final" : "transcript.partial");
        transcriptEvent.put("meetingId", meetingId);
        transcriptEvent.put("seq", resolvedSeq);
        transcriptEvent.put("segmentId", segmentId);
        transcriptEvent.put("text", transcriptText);
        transcriptEvent.put("language", getStringValue(transcript.getOrDefault("language", language)));

        if (startTime != null) {
            transcriptEvent.put("startTime", startTime);
        }
        if (endTime != null) {
            transcriptEvent.put("endTime", endTime);
        }

        Object confidence = transcript.get("confidence");
        if (confidence instanceof Number number) {
            transcriptEvent.put("confidence", number.doubleValue());
        }

        Object finalFlag = transcript.get("is_final");
        if (finalEvent || Boolean.TRUE.equals(getBooleanValue(finalFlag))) {
            transcriptEvent.put("isFinal", true);
        }

        return transcriptEvent;
    }

    private Map<String, Object> buildListeningStatusEvent(Long meetingId, Long seq) {
        Map<String, Object> statusEvent = new HashMap<>();
        statusEvent.put("type", "stream.status");
        statusEvent.put("state", "connected");
        statusEvent.put("message", "Đang lắng nghe...");
        statusEvent.put("meetingId", meetingId);
        if (seq != null) {
            statusEvent.put("seq", seq);
        }
        statusEvent.put("activeConnections", realtimeEventSubscriber.getActiveConnectionCount(meetingId));
        return statusEvent;
    }

    private Boolean getBooleanValue(Object value) {
        if (value instanceof Boolean bool) {
            return bool;
        }
        if (value == null) {
            return null;
        }
        String normalized = String.valueOf(value).trim();
        if (normalized.isEmpty()) {
            return null;
        }
        return Boolean.parseBoolean(normalized);
    }

    private void updateLastActivity(WebSocketSession session) {
        try {
            long now = System.currentTimeMillis();

            Object prev = session.getAttributes().get(LAST_ACTIVITY_ATTR);
            long previousActivity = prev instanceof Number ? ((Number) prev).longValue() : now;

            long idleDuration = now - previousActivity;

            // update last activity timestamp
            session.getAttributes().put(LAST_ACTIVITY_ATTR, now);

            // Check for idle sessions (longer than timeout)
            if (idleDuration > IDLE_SESSION_TIMEOUT_MS) {
                log.warn("Closing idle session {} (idleDuration={}ms)", session.getId(), idleDuration);
                session.close(new CloseStatus(1000, "Idle timeout"));
            }
        } catch (Exception e) {
            log.debug("Error updating last activity for session {}: {}", session.getId(), e.getMessage());
        }
    }

    private void handleAuthInit(WebSocketSession session, Map<String, Object> data, Long expectedMeetingId) throws Exception {
        String tokenValue = getStringValue(data.get("token"));
        if (tokenValue.isBlank()) {
            session.close(CloseStatus.POLICY_VIOLATION.withReason("Missing token"));
            return;
        }

        String rawToken = tokenValue.startsWith("Bearer ") ? tokenValue.substring(7) : tokenValue;

        Claims claims;
        try {
            claims = jwtUtil.parseClaims(rawToken);
        } catch (Exception ex) {
            session.close(CloseStatus.POLICY_VIOLATION.withReason("Invalid token"));
            return;
        }

        Long userId;
        try {
            userId = Long.parseLong(claims.getSubject());
        } catch (Exception ex) {
            session.close(CloseStatus.POLICY_VIOLATION.withReason("Invalid token subject"));
            return;
        }

        String username = claims.get("username", String.class);
        String authorization = "Bearer " + rawToken;

        Object payloadMeetingId = data.get("meetingId");
        if (payloadMeetingId != null) {
            try {
                Long candidateMeetingId = Long.parseLong(String.valueOf(payloadMeetingId));
                if (!expectedMeetingId.equals(candidateMeetingId)) {
                    session.close(CloseStatus.POLICY_VIOLATION.withReason("Meeting mismatch"));
                    return;
                }
            } catch (NumberFormatException ex) {
                session.close(CloseStatus.POLICY_VIOLATION.withReason("Invalid meetingId"));
                return;
            }
        }

        if (!meetingChannelAuthorizer.canJoin(userId, expectedMeetingId, authorization)) {
            session.close(CloseStatus.POLICY_VIOLATION.withReason("Forbidden"));
            return;
        }

        session.getAttributes().put("userId", userId);
        session.getAttributes().put("username", username);
        session.getAttributes().put("authorization", authorization);
        session.getAttributes().put(AUTHENTICATED_ATTR, true);

        Map<String, Object> readyEvent = Map.of(
                "type", "session.ready",
                "meetingId", expectedMeetingId,
                "userId", userId,
                "authenticated", true,
                "activeConnections", realtimeEventSubscriber.getActiveConnectionCount(expectedMeetingId)
        );
        safeSendMessage(session, new TextMessage(objectMapper.writeValueAsString(readyEvent)));
    }
}
