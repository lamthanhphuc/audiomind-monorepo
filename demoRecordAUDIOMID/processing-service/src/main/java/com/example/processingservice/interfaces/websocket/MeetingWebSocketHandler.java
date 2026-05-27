package com.example.processingservice.interfaces.websocket;

import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.AudioStreamResetRequiredException;
import com.example.processingservice.security.JwtUtil;
import com.example.processingservice.security.MeetingChannelAuthorizer;
import com.example.processingservice.services.RealtimeEventSubscriber;
import com.fasterxml.jackson.databind.ObjectMapper;

import io.jsonwebtoken.Claims;
import lombok.extern.slf4j.Slf4j;

@Slf4j
@Component
public class MeetingWebSocketHandler extends AbstractWebSocketHandler {

    private static final Set<String> VALID_REALTIME_LANGUAGES = Set.of("vi", "en", "multi");

    private static final String AUTHENTICATED_ATTR = "authenticated";
    private static final String LAST_AUDIO_SEQ_ATTR = "lastAudioSeq";
    private static final String LAST_AUDIO_DECLARED_SIZE_ATTR = "lastAudioDeclaredSize";
    private static final String LAST_AUDIO_IS_FINAL_ATTR = "lastAudioIsFinal";
    private static final String LAST_SEGMENT_AT_ATTR = "lastSegmentAt";
    private static final String EMPTY_TRANSCRIPT_STREAK_ATTR = "emptyTranscriptStreak";
    private static final String FIRST_CHUNK_AT_ATTR = "firstChunkAt";
    private static final String AUDIO_RECEIVED_ATTR = "AUDIO_RECEIVED_ATTR";
    private static final String RESET_REQUIRED_ATTR = "RESET_REQUIRED_ATTR";
    private static final String LAST_TRANSCRIPT_TEXT_ATTR = "lastTranscriptText";
    private static final String LAST_TIMED_TRANSCRIPT_ATTR = "lastTimedTranscript";
    private static final String LANGUAGE_ATTR = "language";
    private static final String SPEAKER_MODE_ATTR = "speakerMode";
    private static final String LAST_LOGGED_SPEAKER_MODE_ATTR = "lastLoggedSpeakerMode";
    private static final String LAST_ACTIVITY_ATTR = "lastActivity";
    private static final String FINALIZED_ATTR = "FINALIZED_ATTR";
    private static final long IDLE_SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    static final int MAX_FINALIZED_TRANSCRIPT_CACHE_SIZE = 100;
    private static final long FINALIZED_TRANSCRIPT_CACHE_TTL_MS = 5 * 60 * 1000;
    private static final long REALTIME_ANALYSIS_GUARD_TTL_MS = 30 * 60 * 1000;
    private static final String REALTIME_ANALYSIS_SOURCE_STREAM_STOP = "stream_stop";
    private static final String REALTIME_ANALYSIS_SOURCE_AFTER_CLOSE = "after_close";

    // Cache for finalized transcripts (key: meetingId, value: final transcript event)
    private final ConcurrentHashMap<Long, CachedTranscript> finalizedTranscriptCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long, RealtimeAnalysisGuard> realtimeAnalysisGuard = new ConcurrentHashMap<>();

    private final MeetingChannelAuthorizer meetingChannelAuthorizer;
    private final RealtimeEventSubscriber realtimeEventSubscriber;
    private final AIServiceClient aiServiceClient;
    private final ObjectMapper objectMapper;
    private final JwtUtil jwtUtil;

    @Value("${deepgram.language:vi}")
    private String deepgramLanguage;

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
        session.getAttributes().put(LANGUAGE_ATTR, normalizeRealtimeLanguage(null));
        session.getAttributes().put(SPEAKER_MODE_ATTR, normalizeRealtimeSpeakerMode(null));
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

        log.info("event=REALTIME_SESSION_STARTED meetingId={} source=realtime", meetingId);
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
            String speakerMode = getStringValue(data.get("speakerMode"));
            Boolean isFinal = getBooleanValue(data.get("is_final"));
            String effectiveLanguage = language.isBlank()
                    ? getStringAttribute(session, LANGUAGE_ATTR)
                    : language;
            String effectiveSpeakerMode = speakerMode.isBlank()
                    ? normalizeRealtimeSpeakerMode(getStringAttribute(session, SPEAKER_MODE_ATTR))
                    : normalizeRealtimeSpeakerMode(speakerMode);

            // Store seq so we can correlate with binary message
            session.getAttributes().put(LAST_AUDIO_SEQ_ATTR, seq);
            session.getAttributes().put(LAST_AUDIO_DECLARED_SIZE_ATTR, size);
            if (!language.isBlank()) {
                session.getAttributes().put(LANGUAGE_ATTR, language);
            }
            if (!speakerMode.isBlank()) {
                session.getAttributes().put(SPEAKER_MODE_ATTR, effectiveSpeakerMode);
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
            log.info(
                    "AUDIO_CHUNK_LANGUAGE_EFFECTIVE meetingId={} seq={} incomingLanguage={} effectiveLanguage={}",
                    meetingId,
                    seq,
                    language,
                    effectiveLanguage
            );
            maybeLogEffectiveSpeakerMode(session, meetingId, seq, speakerMode, effectiveSpeakerMode);
            return;
        }

        // Handle stream stop request - finalize STT BEFORE closing session
        if ("stream.stop".equals(type)) {
            if (Boolean.TRUE.equals(session.getAttributes().get(FINALIZED_ATTR))) {
                log.info("event=REALTIME_STOP_RECEIVED meetingId={} source=stream_stop status=duplicate_ignored", meetingId);
                try {
                    session.close(CloseStatus.NORMAL.withReason("Stream stopped by client"));
                } catch (Exception e) {
                    log.warn(
                            "event=REALTIME_ANALYSIS_FAILED meetingId={} source=stream_stop errorCode={}",
                            meetingId,
                            safeErrorCode(e)
                    );
                }
                return;
            }

            log.info("event=REALTIME_STOP_RECEIVED meetingId={} source=stream_stop status=accepted", meetingId);
            finalizeSttSession(session, meetingId, true);
            try {
                session.close(CloseStatus.NORMAL.withReason("Stream stopped by client"));
            } catch (Exception e) {
                log.warn(
                        "event=REALTIME_ANALYSIS_FAILED meetingId={} source=stream_stop errorCode={}",
                        meetingId,
                        safeErrorCode(e)
                );
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

        if (Boolean.TRUE.equals(session.getAttributes().get(FINALIZED_ATTR))) {
            log.info(
                    "Skipping audio chunk for meetingId={} because STT finalization already started or completed",
                    meetingId
            );
            return;
        }
        Long lastSeq = getLongAttribute(session, LAST_AUDIO_SEQ_ATTR);
        if (Boolean.TRUE.equals(session.getAttributes().get(RESET_REQUIRED_ATTR))) {
            log.info(
                    "PROCESSING_DROP_CHUNK_AFTER_RESET_REQUIRED meetingId={} seq={}",
                    meetingId,
                    lastSeq
            );
            return;
        }

        ByteBuffer payloadBuffer = message.getPayload().asReadOnlyBuffer();
        byte[] audioBytes = new byte[payloadBuffer.remaining()];
        payloadBuffer.get(audioBytes);
        long nowMs = System.currentTimeMillis();
        if (getLongAttribute(session, FIRST_CHUNK_AT_ATTR) == null) {
            session.getAttributes().put(FIRST_CHUNK_AT_ATTR, nowMs);
        }

        int payloadSize = audioBytes.length;
        Long declaredSize = getLongAttribute(session, LAST_AUDIO_DECLARED_SIZE_ATTR);
        String language = getStringAttribute(session, LANGUAGE_ATTR);
        String speakerMode = getStringAttribute(session, SPEAKER_MODE_ATTR);
        String authorization = getStringAttribute(session, "authorization");
        Boolean isFinal = getBooleanAttribute(session, LAST_AUDIO_IS_FINAL_ATTR);
        String effectiveSpeakerMode = normalizeRealtimeSpeakerMode(speakerMode);
        log.info(
                "AUDIO HASH PROCESSING_IN seq={} size={} first16hex={}",
                lastSeq,
                payloadSize,
                first16Hex(audioBytes)
        );

        try {
                Map<String, Object> transcript = "multiple".equals(effectiveSpeakerMode)
                    ? aiServiceClient.streamAudioChunk(
                        meetingId,
                        audioBytes,
                        lastSeq != null ? lastSeq : 0L,
                        language,
                        effectiveSpeakerMode,
                        isFinal != null && isFinal,
                        null,
                        authorization
                    )
                    : aiServiceClient.streamAudioChunk(
                        meetingId,
                        audioBytes,
                        lastSeq != null ? lastSeq : 0L,
                        language,
                        isFinal != null && isFinal,
                        null,
                        authorization
                    );

            if (transcript == null) {
                log.info(
                        "Skipping audio chunk for meetingId={} seq={} because ai-service reported a terminal finalization replay",
                        meetingId,
                        lastSeq
                );
                return;
            }

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
                    session.getAttributes().put(LAST_SEGMENT_AT_ATTR, System.currentTimeMillis());
                    session.getAttributes().put(EMPTY_TRANSCRIPT_STREAK_ATTR, 0L);
                    log.info(
                            "LIVE_SEGMENT_BROADCAST meetingId={} seq={} segmentId={} type={} startTime={} endTime={} isFinal={}",
                            meetingId,
                            transcriptEvent.get("seq"),
                            transcriptEvent.get("segmentId"),
                            transcriptEvent.get("type"),
                            transcriptEvent.get("startTime"),
                            transcriptEvent.get("endTime"),
                            transcriptEvent.get("isFinal")
                    );
                    rememberTranscriptEvent(session, transcriptEvent);
                    realtimeEventSubscriber.broadcastToMeeting(meetingId, transcriptEvent);
                } else {
                    long emptyStreak = getLongAttribute(session, EMPTY_TRANSCRIPT_STREAK_ATTR) == null
                            ? 0L
                            : getLongAttribute(session, EMPTY_TRANSCRIPT_STREAK_ATTR);
                    emptyStreak += 1L;
                    session.getAttributes().put(EMPTY_TRANSCRIPT_STREAK_ATTR, emptyStreak);
                    Long lastSegmentAt = getLongAttribute(session, LAST_SEGMENT_AT_ATTR);
                    long now = System.currentTimeMillis();
                    Long firstChunkAt = getLongAttribute(session, FIRST_CHUNK_AT_ATTR);
                    boolean transcriptGraceElapsed = lastSegmentAt != null && now - lastSegmentAt >= 10_000;
                    boolean firstTranscriptGraceElapsed = lastSegmentAt == null
                            && firstChunkAt != null
                            && now - firstChunkAt >= 15_000;
                    if ((transcriptGraceElapsed || firstTranscriptGraceElapsed) && emptyStreak >= 10) {
                        log.warn(
                                "LIVE_SEGMENT_STALLED meetingId={} lastSegmentAt={} firstChunkAt={} lastChunkSeq={}",
                                meetingId,
                                lastSegmentAt,
                                firstChunkAt,
                                lastSeq
                        );
                    }
                    realtimeEventSubscriber.broadcastToMeeting(meetingId, buildListeningStatusEvent(meetingId, lastSeq));
                }
            } catch (Exception e) {
                log.warn(
                        "event=REALTIME_ANALYSIS_FAILED meetingId={} source=realtime_broadcast errorCode={}",
                        meetingId,
                        safeErrorCode(e)
                );
            }
        } catch (Exception ex) {
            log.warn(
                    "event=DEEPGRAM_STT_FAILED meetingId={} source=realtime seq={} errorCode={}",
                    meetingId,
                    lastSeq,
                    safeErrorCode(ex)
            );

            if (ex instanceof AudioStreamResetRequiredException) {
                session.getAttributes().put(RESET_REQUIRED_ATTR, Boolean.TRUE);
                log.warn(
                        "RESET_REQUIRED_FROM_AI meetingId={} seq={} errorCode={}",
                        meetingId,
                        lastSeq,
                        safeErrorCode(ex)
                );
                Map<String, Object> errorEvent = Map.of(
                        "type", "stream.error",
                        "meetingId", meetingId,
                        "message", "Nghiên cứu lại luồng ghi âm: cần khởi động lại recorder WebM",
                        "recoverable", false,
                        "resetRequired", true
                );
                try {
                    realtimeEventSubscriber.broadcastToMeeting(meetingId, errorEvent);
                } catch (Exception e) {
                    log.warn(
                            "event=REALTIME_ANALYSIS_FAILED meetingId={} source=reset_required errorCode={}",
                            meetingId,
                            safeErrorCode(e)
                    );
                }
                return;
            }

            Map<String, Object> errorEvent = Map.of(
                    "type", "stream.error",
                    "meetingId", meetingId,
                    "message", "Failed to transcribe audio chunk",
                    "recoverable", true
            );
            try {
                realtimeEventSubscriber.broadcastToMeeting(meetingId, errorEvent);
            } catch (Exception e) {
                log.warn(
                        "event=REALTIME_ANALYSIS_FAILED meetingId={} source=stream_error errorCode={}",
                        meetingId,
                        safeErrorCode(e)
                );
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
        String speakerMode = getStringAttribute(session, SPEAKER_MODE_ATTR);
        String authorization = getStringAttribute(session, "authorization");
        String analysisSource = sessionStillOpen
                ? REALTIME_ANALYSIS_SOURCE_STREAM_STOP
                : REALTIME_ANALYSIS_SOURCE_AFTER_CLOSE;

        if (Boolean.TRUE.equals(session.getAttributes().get(FINALIZED_ATTR))) {
            log.info("Skipping duplicate STT finalization for meetingId={} because finalization already started", meetingId);
            return;
        }
        if (Boolean.TRUE.equals(session.getAttributes().get(RESET_REQUIRED_ATTR))) {
            log.info("Skipping finalize seq=-1 for meetingId={} because reset_required was already raised", meetingId);
            return;
        }

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
                Map<String, Object> transcript = "multiple".equals(normalizeRealtimeSpeakerMode(speakerMode))
                    ? aiServiceClient.streamAudioChunk(
                        meetingId,
                        new byte[0],
                        -1L,
                        language,
                        normalizeRealtimeSpeakerMode(speakerMode),
                        true,
                        null,
                        authorization
                    )
                    : aiServiceClient.streamAudioChunk(
                        meetingId,
                        new byte[0],
                        -1L,
                        language,
                        true,
                        null,
                        authorization
                    );

                    if (transcript == null) {
                    log.info("Skipping duplicate finalization for meetingId={} because ai-service already finalized it", meetingId);
                    return;
                    }

            boolean partial = isPartialTranscript(transcript);
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
                if (shouldSkipLowValueFinalEvent(session, transcriptEvent)) {
                    log.info(
                            "SKIP_LOW_VALUE_TEMP_FINAL meetingId={} segmentId={} seq={} reason=duplicate_or_untimed",
                            meetingId,
                            transcriptEvent.get("segmentId"),
                            transcriptEvent.get("seq")
                    );
                    if (partial) {
                        log.info(
                                "REALTIME_ANALYSIS_SKIPPED reason=not_final source={} meetingId={}",
                                analysisSource,
                                meetingId
                        );
                    } else {
                        triggerRealtimeAnalysisAsync(meetingId, authorization, language, analysisSource);
                    }
                    return;
                }
                rememberTranscriptEvent(session, transcriptEvent);

                cacheFinalizedTranscript(meetingId, transcriptEvent);
                log.info(
                        "event=REALTIME_TRANSCRIPT_FINALIZED meetingId={} source={} transcriptLength={}",
                        meetingId,
                        analysisSource,
                        getStringValue(transcriptEvent.get("text")).length()
                );
                log.info(
                    "LIVE_SEGMENT_BROADCAST meetingId={} seq={} segmentId={} type={} startTime={} endTime={} isFinal={}",
                    meetingId,
                    transcriptEvent.get("seq"),
                    transcriptEvent.get("segmentId"),
                    transcriptEvent.get("type"),
                    transcriptEvent.get("startTime"),
                    transcriptEvent.get("endTime"),
                    transcriptEvent.get("isFinal")
                );

                if (sessionStillOpen) {
                    try {
                        realtimeEventSubscriber.broadcastToMeeting(meetingId, transcriptEvent);
                        log.info(
                                "Broadcast final transcript for meetingId={} seq=-1 transcriptLength={}",
                                meetingId,
                                getStringValue(transcriptEvent.get("text")).length()
                        );
                    } catch (Exception e) {
                        log.warn(
                                "event=REALTIME_ANALYSIS_FAILED meetingId={} source=final_broadcast errorCode={}",
                                meetingId,
                                safeErrorCode(e)
                        );
                    }
                } else {
                    log.info(
                            "Session closed for meetingId={}, cached final transcript for fallback delivery (length={})",
                            meetingId,
                            getStringValue(transcriptEvent.get("text")).length()
                    );
                }
                if (partial) {
                    Map<String, Object> partialWarningEvent = new HashMap<>();
                    partialWarningEvent.put("type", "stream.status");
                    partialWarningEvent.put("meetingId", meetingId);
                    partialWarningEvent.put("state", "partial");
                    partialWarningEvent.put("partial", true);
                    partialWarningEvent.put("resetRequired", true);
                    partialWarningEvent.put("message", "Transcript có thể chưa đầy đủ");
                    if (sessionStillOpen) {
                        realtimeEventSubscriber.broadcastToMeeting(meetingId, partialWarningEvent);
                    }
                    log.info(
                            "REALTIME_ANALYSIS_SKIPPED reason=not_final source={} meetingId={}",
                            analysisSource,
                            meetingId
                    );
                } else {
                    triggerRealtimeAnalysisAsync(meetingId, authorization, language, analysisSource);
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
                    log.warn(
                            "event=REALTIME_ANALYSIS_FAILED meetingId={} source=status_broadcast errorCode={}",
                            meetingId,
                            safeErrorCode(e)
                    );
                }
            }
            if (partial) {
                log.info(
                        "REALTIME_ANALYSIS_SKIPPED reason=not_final source={} meetingId={}",
                        analysisSource,
                        meetingId
                );
            } else {
                triggerRealtimeAnalysisAsync(meetingId, authorization, language, analysisSource);
            }
            log.info("No final transcript returned for meetingId={}", meetingId);
        } catch (Exception ex) {
            log.warn(
                    "event=REALTIME_ANALYSIS_FAILED meetingId={} source=finalize errorCode={}",
                    meetingId,
                    safeErrorCode(ex)
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
                    log.warn(
                            "event=REALTIME_ANALYSIS_FAILED meetingId={} source=finalize_broadcast errorCode={}",
                            meetingId,
                            safeErrorCode(e)
                    );
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

    private void triggerRealtimeAnalysisAsync(
            Long meetingId,
            String authorization,
            String language,
            String source
    ) {
        log.info(
                "REALTIME_ANALYSIS_TRIGGER_ATTEMPT meetingId={} source={}",
                meetingId,
                source
        );
        try {
            CompletableFuture.runAsync(() -> runRealtimeAnalysis(meetingId, authorization, language, source));
            log.info("REALTIME_ANALYSIS_ENQUEUED meetingId={} source={}", meetingId, source);
        } catch (Exception ex) {
            log.warn(
                    "REALTIME_ANALYSIS_FAILED meetingId={} source={} reason=enqueue_failed errorCode={}",
                    meetingId,
                    source,
                    safeErrorCode(ex)
            );
        }
    }

    private void runRealtimeAnalysis(Long meetingId, String authorization, String language, String source) {
        String traceId = "realtime-analysis-" + meetingId + "-" + System.currentTimeMillis();
        Map<String, Object> transcriptResponse;
        try {
            transcriptResponse = aiServiceClient.getTranscript(meetingId, traceId);
        } catch (Exception ex) {
            log.warn(
                    "REALTIME_ANALYSIS_FAILED meetingId={} source={} reason=transcript_fetch_error errorCode={}",
                    meetingId,
                    source,
                    safeErrorCode(ex)
            );
            return;
        }

        List<Map<String, Object>> transcriptRows = normalizeTranscriptRows(
                transcriptResponse == null ? null : transcriptResponse.get("transcripts")
        );
        String transcriptText = buildTranscriptText(transcriptRows);
        if (transcriptText.isBlank()) {
            log.info(
                    "REALTIME_ANALYSIS_SKIPPED reason=empty_transcript source={} meetingId={}",
                    source,
                    meetingId
            );
            return;
        }

        String transcriptHash = computeTranscriptHash(transcriptText);
        if (!markRealtimeAnalysisInProgress(meetingId, transcriptHash, source)) {
            return;
        }

        try {
            log.info("REALTIME_ANALYSIS_TRIGGERED meetingId={} source={}", meetingId, source);
            aiServiceClient.analyzeRealtimeTranscript(
                    meetingId,
                    transcriptText,
                    "it",
                    "realtime",
                    transcriptHash,
                    traceId,
                    authorization
            );
            realtimeAnalysisGuard.put(
                    meetingId,
                    new RealtimeAnalysisGuard(transcriptHash, System.currentTimeMillis(), false)
            );
            log.info("REALTIME_ANALYSIS_SAVED meetingId={} source={}", meetingId, source);
        } catch (Exception ex) {
            realtimeAnalysisGuard.remove(meetingId);
            log.warn(
                    "REALTIME_ANALYSIS_FAILED meetingId={} source={} errorCode={}",
                    meetingId,
                    source,
                    safeErrorCode(ex)
            );
        }
    }

    private boolean isPartialTranscript(Map<String, Object> transcript) {
        Object partialObj = transcript.get("partial");
        return partialObj instanceof Boolean
                ? (Boolean) partialObj
                : Boolean.parseBoolean(String.valueOf(partialObj));
    }

    private List<Map<String, Object>> normalizeTranscriptRows(Object transcripts) {
        if (!(transcripts instanceof List<?> rows) || rows.isEmpty()) {
            return List.of();
        }
        List<Map<String, Object>> normalized = new ArrayList<>();
        for (Object row : rows) {
            if (!(row instanceof Map<?, ?> mapRow)) {
                continue;
            }
            Map<String, Object> value = new HashMap<>();
            for (Map.Entry<?, ?> entry : mapRow.entrySet()) {
                value.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            normalized.add(value);
        }
        return normalized;
    }

    private String buildTranscriptText(List<Map<String, Object>> rows) {
        if (rows == null || rows.isEmpty()) {
            return "";
        }
        StringBuilder builder = new StringBuilder();
        for (Map<String, Object> row : rows) {
            String speaker = getStringValue(row.get("speaker")).trim();
            String text = getStringValue(row.get("text")).trim();
            if (text.isBlank()) {
                continue;
            }
            if (!speaker.isBlank()) {
                builder.append(speaker).append(": ");
            }
            builder.append(text).append('\n');
        }
        return builder.toString().trim();
    }

    private String computeTranscriptHash(String transcriptText) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(transcriptText.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(bytes);
        } catch (NoSuchAlgorithmException ex) {
            return Integer.toHexString(transcriptText.hashCode());
        }
    }

    private boolean markRealtimeAnalysisInProgress(Long meetingId, String transcriptHash, String source) {
        evictExpiredRealtimeAnalysisGuards();
        RealtimeAnalysisGuard currentGuard = realtimeAnalysisGuard.get(meetingId);
        if (currentGuard != null) {
            if (currentGuard.inProgress()) {
                log.info(
                        "REALTIME_ANALYSIS_SKIPPED reason=in_progress source={} meetingId={}",
                        source,
                        meetingId
                );
                return false;
            }
            if (transcriptHash.equals(currentGuard.transcriptHash())) {
                log.info(
                        "REALTIME_ANALYSIS_SKIPPED reason=already_exists source={} meetingId={}",
                        source,
                        meetingId
                );
                return false;
            }
        }
        realtimeAnalysisGuard.put(
                meetingId,
                new RealtimeAnalysisGuard(transcriptHash, System.currentTimeMillis(), true)
        );
        return true;
    }

    private void evictExpiredRealtimeAnalysisGuards() {
        long cutoff = System.currentTimeMillis() - REALTIME_ANALYSIS_GUARD_TTL_MS;
        realtimeAnalysisGuard.entrySet().removeIf(entry -> entry.getValue().updatedAtMs() < cutoff);
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

    private record RealtimeAnalysisGuard(String transcriptHash, long updatedAtMs, boolean inProgress) {
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
            transcriptText = getStringValue(transcript.get("text"));
        }
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
        segmentId = canonicalizeSegmentId(segmentId);
        String speaker = getStringValue(transcript.get("speaker"));
        if (segmentId.isBlank()) {
            segmentId = buildDeterministicSegmentId(meetingId, resolvedSeq, speaker, startTime, endTime, finalEvent);
        }
        if (segmentId.isBlank()) {
            segmentId = String.format("meeting-%d-temp-%d", meetingId, resolvedSeq);
        }

        Map<String, Object> transcriptEvent = new HashMap<>();
        transcriptEvent.put("type", finalEvent ? "transcript.final" : "transcript.partial");
        transcriptEvent.put("meetingId", meetingId);
        transcriptEvent.put("seq", resolvedSeq);
        transcriptEvent.put("segmentId", segmentId);
        transcriptEvent.put("text", transcriptText);
        transcriptEvent.put("language", getStringValue(transcript.getOrDefault("language", language)));
        transcriptEvent.put("speaker", speaker);

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
        transcriptEvent.put("isFinal", finalEvent || Boolean.TRUE.equals(getBooleanValue(finalFlag)));

        return transcriptEvent;
    }

    private String buildDeterministicSegmentId(
            Long meetingId,
            Long resolvedSeq,
            String speaker,
            Double startTime,
            Double endTime,
            boolean finalEvent) {
        String speakerPart = speaker == null || speaker.isBlank()
                ? "unknown"
                : speaker.trim().toLowerCase().replace(' ', '_');
        if (startTime != null) {
            return String.format(Locale.US, "meeting-%d-start-%.3f-%s", meetingId, startTime, speakerPart);
        }
        if (finalEvent && endTime != null) {
            return String.format(Locale.US, "meeting-%d-end-%.3f-%s", meetingId, endTime, speakerPart);
        }
        return String.format(Locale.US, "meeting-%d-temp-%d-%s", meetingId, resolvedSeq, speakerPart);
    }

    private String canonicalizeSegmentId(String segmentId) {
        String raw = getStringValue(segmentId).trim();
        if (raw.isBlank()) {
            return raw;
        }
        Pattern canonicalPattern = Pattern.compile("^meeting-(\\d+)-start-(\\d+(?:\\.\\d+)?)-([a-z0-9_]+)$", Pattern.CASE_INSENSITIVE);
        Matcher canonicalMatcher = canonicalPattern.matcher(raw);
        if (canonicalMatcher.matches()) {
            return String.format(
                    Locale.US,
                    "meeting-%s-start-%.3f-%s",
                    canonicalMatcher.group(1),
                    Double.parseDouble(canonicalMatcher.group(2)),
                    canonicalMatcher.group(3).toLowerCase()
            );
        }
        Pattern legacyPattern = Pattern.compile("^meeting-(\\d+)-(\\d+(?:\\.\\d+)?)-([a-z0-9_]+)-\\d+$", Pattern.CASE_INSENSITIVE);
        Matcher legacyMatcher = legacyPattern.matcher(raw);
        if (legacyMatcher.matches()) {
            return String.format(
                    Locale.US,
                    "meeting-%s-start-%.3f-%s",
                    legacyMatcher.group(1),
                    Double.parseDouble(legacyMatcher.group(2)),
                    legacyMatcher.group(3).toLowerCase()
            );
        }
        return raw;
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

    private void rememberTranscriptEvent(WebSocketSession session, Map<String, Object> transcriptEvent) {
        String text = normalizeText(getStringValue(transcriptEvent.get("text")));
        if (!text.isBlank()) {
            session.getAttributes().put(LAST_TRANSCRIPT_TEXT_ATTR, text);
        }
        boolean hasTiming = transcriptEvent.get("startTime") instanceof Number || transcriptEvent.get("endTime") instanceof Number;
        if (hasTiming) {
            session.getAttributes().put(LAST_TIMED_TRANSCRIPT_ATTR, Boolean.TRUE);
        }
    }

    private boolean shouldSkipLowValueFinalEvent(WebSocketSession session, Map<String, Object> transcriptEvent) {
        Object seqValue = transcriptEvent.get("seq");
        long seq = seqValue instanceof Number ? ((Number) seqValue).longValue() : 0L;
        if (seq != -1L) {
            return false;
        }
        boolean hasTiming = transcriptEvent.get("startTime") instanceof Number || transcriptEvent.get("endTime") instanceof Number;
        if (hasTiming) {
            return false;
        }
        String normalizedText = normalizeText(getStringValue(transcriptEvent.get("text")));
        if (normalizedText.isBlank()) {
            return true;
        }
        String lastText = normalizeText(getStringValue(session.getAttributes().get(LAST_TRANSCRIPT_TEXT_ATTR)));
        boolean duplicateText = !lastText.isBlank() && (lastText.contains(normalizedText) || normalizedText.contains(lastText));
        boolean alreadyHasTimedFinal = Boolean.TRUE.equals(session.getAttributes().get(LAST_TIMED_TRANSCRIPT_ATTR));
        return duplicateText || alreadyHasTimedFinal;
    }

    private String normalizeText(String value) {
        return getStringValue(value).trim().replaceAll("\\s+", " ").toLowerCase();
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
            log.debug("Unable to update last activity for sessionId={} errorCode={}", session.getId(), safeErrorCode(e));
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

        String requestedLanguage = getStringValue(data.get("language"));
        String effectiveLanguage = normalizeRealtimeLanguage(requestedLanguage);
        session.getAttributes().put(LANGUAGE_ATTR, effectiveLanguage);
        String requestedSpeakerMode = getStringValue(data.get("speakerMode"));
        String effectiveSpeakerMode = normalizeRealtimeSpeakerMode(requestedSpeakerMode);
        session.getAttributes().put(SPEAKER_MODE_ATTR, effectiveSpeakerMode);
        log.info(
            "REALTIME_SPEAKER_MODE_SELECTED meetingId={} userId={} incomingSpeakerMode={} effectiveSpeakerMode={}",
            expectedMeetingId,
            userId,
            requestedSpeakerMode,
            effectiveSpeakerMode
        );
        log.info(
            "REALTIME_LANGUAGE_SELECTED meetingId={} userId={} incomingLanguage={} effectiveLanguage={}",
            expectedMeetingId,
            userId,
            requestedLanguage,
            effectiveLanguage
        );

        Map<String, Object> readyEvent = Map.of(
                "type", "session.ready",
                "meetingId", expectedMeetingId,
                "userId", userId,
                "authenticated", true,
                "activeConnections", realtimeEventSubscriber.getActiveConnectionCount(expectedMeetingId)
        );
        safeSendMessage(session, new TextMessage(objectMapper.writeValueAsString(readyEvent)));
    }

    private String normalizeRealtimeLanguage(String candidateLanguage) {
        String defaultLanguage = normalizeFallbackLanguage(deepgramLanguage);
        String requestedLanguage = normalizeFallbackLanguage(candidateLanguage);

        if (VALID_REALTIME_LANGUAGES.contains(requestedLanguage)) {
            return requestedLanguage;
        }

        if (VALID_REALTIME_LANGUAGES.contains(defaultLanguage)) {
            return defaultLanguage;
        }

        return "vi";
    }

    private String normalizeRealtimeSpeakerMode(String candidateSpeakerMode) {
        String requestedSpeakerMode = normalizeFallbackLanguage(candidateSpeakerMode);
        if ("multiple".equals(requestedSpeakerMode)) {
            return "multiple";
        }
        return "single";
    }

    private String normalizeFallbackLanguage(String candidateLanguage) {
        if (candidateLanguage == null) {
            return "";
        }

        return candidateLanguage.trim().toLowerCase(Locale.ROOT);
    }

    private void maybeLogEffectiveSpeakerMode(
            WebSocketSession session,
            Long meetingId,
            Long seq,
            String incomingSpeakerMode,
            String effectiveSpeakerMode) {

        String lastLoggedSpeakerMode = getStringAttribute(session, LAST_LOGGED_SPEAKER_MODE_ATTR);
        if (effectiveSpeakerMode.equals(lastLoggedSpeakerMode)) {
            return;
        }

        session.getAttributes().put(LAST_LOGGED_SPEAKER_MODE_ATTR, effectiveSpeakerMode);
        log.info(
                "AUDIO_CHUNK_SPEAKER_MODE_EFFECTIVE meetingId={} seq={} incomingSpeakerMode={} effectiveSpeakerMode={}",
                meetingId,
                seq,
                incomingSpeakerMode,
                effectiveSpeakerMode
        );
    }

    private String safeErrorCode(Throwable throwable) {
        if (throwable == null) {
            return "UNKNOWN_ERROR";
        }
        String code = throwable.getClass().getSimpleName();
        return (code == null || code.isBlank()) ? "UNKNOWN_ERROR" : code;
    }
}
