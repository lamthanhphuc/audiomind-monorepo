package com.example.processingservice.interfaces.websocket;

import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.UUID;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.UserQuotaClient;
import com.example.processingservice.config.Epic2FeatureFlags;
import com.example.processingservice.config.Epic3FeatureFlags;
import com.example.processingservice.config.TraceIdFilter;
import com.example.processingservice.controller.ErrorCode;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

import com.example.processingservice.config.TraceIdFilter;
import com.example.processingservice.client.AudioStreamResetRequiredException;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeFinalizeDeadlineService;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeAudioEnqueueResult;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeAudioSessionWorker;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeAudioWorkItem;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeDualStreamSessionKeys;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeStreamAudioState;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeAudioWorkerRegistry;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeSessionLifecycleState;
import com.example.processingservice.security.JwtUtil;
import com.example.processingservice.security.MeetingChannelAuthorizer;
import com.example.processingservice.service.AnalysisFailureMapping;
import com.example.processingservice.service.JobStateStore;
import com.example.processingservice.service.RealtimeStatusCodes;
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
    private static final String LAST_ACCEPTED_SEQ_ATTR = "lastAcceptedAudioSeq";
    private static final String LAST_AUDIO_MIME_TYPE_ATTR = "lastAudioMimeType";
    private static final String LAST_AUDIO_ENCODING_ATTR = "lastAudioEncoding";
    private static final String LAST_AUDIO_DECLARED_SIZE_ATTR = "lastAudioDeclaredSize";
    private static final String LAST_AUDIO_IS_FINAL_ATTR = "lastAudioIsFinal";
    private static final String RECORDING_SESSION_ID_ATTR = "recordingSessionId";
    private static final String ATTEMPT_ID_ATTR = "attemptId";
    private static final String LAST_SEGMENT_AT_ATTR = "lastSegmentAt";
    private static final String EMPTY_TRANSCRIPT_STREAK_ATTR = "emptyTranscriptStreak";
    private static final String FIRST_CHUNK_AT_ATTR = "firstChunkAt";
    private static final String AUDIO_RECEIVED_ATTR = "AUDIO_RECEIVED_ATTR";
    private static final String VALID_AUDIO_RECEIVED_ATTR = "validAudioReceived";
    private static final String TOTAL_AUDIO_BYTES_ATTR = "totalAudioBytes";
    private static final String TINY_CHUNK_STREAK_ATTR = "tinyChunkStreak";
    private static final String TRANSCRIPT_RECOVERY_PENDING_ATTR = "transcriptRecoveryPending";
    private static final String RESET_REQUIRED_ATTR = "RESET_REQUIRED_ATTR";
    private static final String LAST_TRANSCRIPT_TEXT_ATTR = "lastTranscriptText";
    private static final String LAST_TIMED_TRANSCRIPT_ATTR = "lastTimedTranscript";
    private static final String LANGUAGE_ATTR = "language";
    private static final String DOMAIN_MODE_ATTR = "domainMode";
    private static final String SPEAKER_MODE_ATTR = "speakerMode";
    private static final String LAST_LOGGED_SPEAKER_MODE_ATTR = "lastLoggedSpeakerMode";
    private static final String LAST_ACTIVITY_ATTR = "lastActivity";
    private static final String FINALIZED_ATTR = "FINALIZED_ATTR";
    private static final String MEETING_STATUS_CHECKED_ATTR = "MEETING_STATUS_CHECKED_ATTR";
    private static final String LAST_MEETING_STATUS_CHECK_AT_ATTR = "lastMeetingStatusCheckAt";
    private static final String TERMINAL_MEETING_STATUS_ATTR = "TERMINAL_MEETING_STATUS_ATTR";
    private static final String BACKPRESSURE_REJECTED_ATTR = "BACKPRESSURE_REJECTED_ATTR";
    private static final long MEETING_STATUS_RECHECK_INTERVAL_MS = 30_000L;
    private static final long IDLE_SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    static final int MAX_FINALIZED_TRANSCRIPT_CACHE_SIZE = 100;
    private static final long FINALIZED_TRANSCRIPT_CACHE_TTL_MS = 5 * 60 * 1000;
    private static final String REALTIME_ANALYSIS_SOURCE_STREAM_STOP = "stream_stop";
    private static final String REALTIME_ANALYSIS_SOURCE_AFTER_CLOSE = "after_close";

    private static final class RecoveryControl {
        private final AtomicBoolean completed = new AtomicBoolean(false);
        private volatile ScheduledFuture<?> timeoutFuture;
    }

    // Cache for finalized transcripts (key: meetingId, value: final transcript event)
    private final ConcurrentHashMap<Long, CachedTranscript> finalizedTranscriptCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long, RecoveryControl> transcriptRecoveryControls = new ConcurrentHashMap<>();
    private final ScheduledExecutorService transcriptRecoveryExecutor = Executors.newScheduledThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "realtime-transcript-recovery");
        thread.setDaemon(true);
        return thread;
    });

    private final MeetingChannelAuthorizer meetingChannelAuthorizer;
    private final RealtimeEventSubscriber realtimeEventSubscriber;
    private final AIServiceClient aiServiceClient;
    private final MeetingServiceClient meetingServiceClient;
    private final JobStateStore jobStateStore;
    private final ObjectMapper objectMapper;
    private final JwtUtil jwtUtil;
    private final RealtimeAudioWorkerRegistry realtimeAudioWorkerRegistry;
    private final Epic2FeatureFlags epic2FeatureFlags;
    private final Epic3FeatureFlags epic3FeatureFlags;
    private final RealtimePayloadValidator realtimePayloadValidator;
    private final RealtimeFinalizeDeadlineService finalizeDeadlineService;

    @Autowired
    private UserQuotaClient userQuotaClient;

    @Value("${app.internal.quota-fail-open:true}")
    private boolean quotaFailOpen;

    @Value("${quota.stt.bytes-per-second-estimate:4000}")
    private long sttBytesPerSecondEstimate = 4000;

    @Value("${deepgram.language:vi}")
    private String deepgramLanguage;

    @Value("${realtime.async-audio-queue.enabled:true}")
    private boolean realtimeAsyncAudioQueueEnabled;

    @Value("${realtime.async-audio-queue.max-size:64}")
    private int realtimeAsyncQueueMaxSize;

    @Value("${realtime.async-audio-queue.stop-drain-timeout-ms:5000}")
    private long realtimeStopDrainTimeoutMs;

    @Value("${realtime.dual-stream-tab-mic.enabled:false}")
    private boolean dualStreamTabMicEnabled;

    @Value("${realtime.min-audio-bytes:128}")
    private int realtimeMinAudioBytes;

    @Value("${realtime.tiny-chunk-max-bytes:128}")
    private int realtimeTinyChunkMaxBytes;

    @Value("${realtime.tiny-chunk-streak-threshold:10}")
    private int realtimeTinyChunkStreakThreshold;

    @Value("${realtime.finalize-recovery-timeout-ms:5000}")
    private long realtimeFinalizeRecoveryTimeoutMs;

    @Autowired
    public MeetingWebSocketHandler(
            MeetingChannelAuthorizer meetingChannelAuthorizer,
            RealtimeEventSubscriber realtimeEventSubscriber,
            AIServiceClient aiServiceClient,
            MeetingServiceClient meetingServiceClient,
            JobStateStore jobStateStore,
            ObjectMapper objectMapper,
            JwtUtil jwtUtil,
            RealtimeAudioWorkerRegistry realtimeAudioWorkerRegistry,
            Epic2FeatureFlags epic2FeatureFlags,
            Epic3FeatureFlags epic3FeatureFlags,
            RealtimePayloadValidator realtimePayloadValidator,
            RealtimeFinalizeDeadlineService finalizeDeadlineService) {
        this.meetingChannelAuthorizer = meetingChannelAuthorizer;
        this.realtimeEventSubscriber = realtimeEventSubscriber;
        this.aiServiceClient = aiServiceClient;
        this.meetingServiceClient = meetingServiceClient;
        this.jobStateStore = jobStateStore;
        this.objectMapper = objectMapper;
        this.jwtUtil = jwtUtil;
        this.realtimeAudioWorkerRegistry = realtimeAudioWorkerRegistry;
        this.epic2FeatureFlags = epic2FeatureFlags;
        this.epic3FeatureFlags = epic3FeatureFlags;
        this.realtimePayloadValidator = realtimePayloadValidator;
        this.finalizeDeadlineService = finalizeDeadlineService;
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
        session.getAttributes().put(DOMAIN_MODE_ATTR, "it");
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

        log.info(
                "event=REALTIME_SESSION_STARTED meetingId={} traceId={} source=realtime",
                meetingId,
                resolveSessionTraceId(session)
        );
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

        if ("dual_stream.configure".equals(type)) {
            if (!dualStreamTabMicEnabled) {
                log.warn(
                        "event=REALTIME_DUAL_STREAM_CONFIGURE_IGNORED meetingId={} reason=feature_disabled",
                        meetingId
                );
                return;
            }
            if (!Boolean.TRUE.equals(getBooleanValue(data.get("dualStream")))) {
                session.getAttributes().put(RealtimeDualStreamSessionKeys.DUAL_STREAM_ENABLED_ATTR, Boolean.FALSE);
                return;
            }
            session.getAttributes().put(RealtimeDualStreamSessionKeys.DUAL_STREAM_ENABLED_ATTR, Boolean.TRUE);
            List<String> configuredStreams = parseActiveStreams(data.get("activeStreams"));
            session.getAttributes().put(
                    RealtimeDualStreamSessionKeys.ACTIVE_STREAMS_ATTR,
                    configuredStreams
            );
            log.info(
                    "REALTIME_DUAL_STREAM_CONFIGURED meetingId={} activeStreams={}",
                    meetingId,
                    configuredStreams
            );
            return;
        }

        // Handle audio chunk metadata (binary data follows in separate message)
        if ("audio.chunk".equals(type)) {
            Long seq = getLongAttribute(data, "seq");
            Long size = getLongAttribute(data, "size");
            Long tsMs = getLongAttribute(data, "ts_ms");
            Long sampleRate = getLongAttribute(data, "sample_rate");
            Long channels = getLongAttribute(data, "channels");
            Long recordingSessionId = getLongAttribute(data, "recording_session_id");
            Long attemptId = getLongAttribute(data, "attempt_id");
            String mimeType = getStringValue(data.get("mime_type"));
            String encoding = getStringValue(data.get("encoding"));
            String language = getStringValue(data.get("language"));
            String speakerMode = getStringValue(data.get("speakerMode"));
            Boolean isFinal = getBooleanValue(data.get("is_final"));
            String rawStreamId = getStringValue(data.get("stream_id"));
            String streamId = RealtimeStreamAudioState.normalizeStreamId(rawStreamId);
            boolean dualStreamSession = isDualStreamSession(session);
            String effectiveLanguage = language.isBlank()
                    ? getStringAttribute(session, LANGUAGE_ATTR)
                    : language;
            String effectiveSpeakerMode = speakerMode.isBlank()
                    ? normalizeRealtimeSpeakerMode(getStringAttribute(session, SPEAKER_MODE_ATTR))
                    : normalizeRealtimeSpeakerMode(speakerMode);
            String authorization = getStringAttribute(session, "authorization");

            if (Boolean.TRUE.equals(session.getAttributes().get(FINALIZED_ATTR))) {
                session.getAttributes().remove(LAST_AUDIO_SEQ_ATTR);
                log.info(
                        "event=REALTIME_CHUNK_DROPPED_TERMINAL meetingId={} seq={} reason=session_finalized",
                        meetingId,
                        seq
                );
                return;
            }
            if (shouldRejectTerminalMeeting(session, meetingId, seq, authorization)) {
                session.getAttributes().remove(LAST_AUDIO_SEQ_ATTR);
                return;
            }
            Long activeRecordingSessionId = getLongAttribute(session, RECORDING_SESSION_ID_ATTR);
            Long activeAttemptId = getLongAttribute(session, ATTEMPT_ID_ATTR);
            boolean staleRecordingSession =
                    activeRecordingSessionId != null
                    && (recordingSessionId == null || !activeRecordingSessionId.equals(recordingSessionId));
            boolean staleAttempt =
                    activeAttemptId != null
                    && (attemptId == null || !activeAttemptId.equals(attemptId));
            if (staleRecordingSession || staleAttempt) {
                session.getAttributes().remove(LAST_AUDIO_SEQ_ATTR);
                log.warn(
                        "event=REALTIME_CHUNK_DROPPED_STALE_SESSION meetingId={} seq={} recordingSessionId={} attemptId={} activeRecordingSessionId={} activeAttemptId={}",
                        meetingId,
                        seq,
                        recordingSessionId,
                        attemptId,
                        activeRecordingSessionId,
                        activeAttemptId
                );
                return;
            }
            if (realtimeAsyncAudioQueueEnabled && !canAcceptAsyncAudioChunk(session, meetingId, seq)) {
                return;
            }
            if (dualStreamSession && !RealtimeStreamAudioState.isDualStreamCapable(streamId)) {
                rejectInvalidDualStreamId(session, meetingId, seq, rawStreamId);
                return;
            }

            if (epic2FeatureFlags.isRealtimeValidationEnabled()) {
                Long lastAcceptedSeq;
                if (dualStreamSession) {
                    long streamAccepted = RealtimeStreamAudioState
                            .stateFor(session.getAttributes(), streamId)
                            .lastAcceptedSeq();
                    lastAcceptedSeq = streamAccepted > 0 ? streamAccepted : null;
                } else {
                    lastAcceptedSeq = getLongAttribute(session, LAST_ACCEPTED_SEQ_ATTR);
                }
                if (lastAcceptedSeq != null && lastAcceptedSeq <= 0) {
                    lastAcceptedSeq = null;
                }
                RealtimePayloadValidator.ValidationResult metadataValidation =
                        realtimePayloadValidator.validateMetadata(seq, size, mimeType, encoding, lastAcceptedSeq);
                if (!metadataValidation.valid()) {
                    rejectRealtimeValidation(session, meetingId, seq, metadataValidation.errorCode());
                    return;
                }
            }

            // Store seq so we can correlate with binary message
            session.getAttributes().put(LAST_AUDIO_SEQ_ATTR, seq);
            session.getAttributes().put(RealtimeDualStreamSessionKeys.LAST_AUDIO_STREAM_ID_ATTR, streamId);
            RealtimeStreamAudioState streamState = RealtimeStreamAudioState.stateFor(session.getAttributes(), streamId);
            streamState.setLastPendingSeq(seq != null ? seq : 0L);
            session.getAttributes().put(LAST_AUDIO_MIME_TYPE_ATTR, mimeType);
            session.getAttributes().put(LAST_AUDIO_ENCODING_ATTR, encoding);
            session.getAttributes().put(LAST_AUDIO_DECLARED_SIZE_ATTR, size);
            if (recordingSessionId != null) {
                session.getAttributes().put(RECORDING_SESSION_ID_ATTR, recordingSessionId);
            }
            if (attemptId != null) {
                session.getAttributes().put(ATTEMPT_ID_ATTR, attemptId);
            }
            if (!language.isBlank()) {
                session.getAttributes().put(LANGUAGE_ATTR, language);
            }
            if (!speakerMode.isBlank()) {
                session.getAttributes().put(SPEAKER_MODE_ATTR, effectiveSpeakerMode);
            }
            session.getAttributes().put(LAST_AUDIO_IS_FINAL_ATTR, isFinal != null && isFinal);

            log.info(
                    "Received audio.chunk metadata meetingId={} streamId={} seq={} declaredSize={} tsMs={} mimeType={} encoding={} sampleRate={} channels={} language={} isFinal={}",
                    meetingId,
                    streamId,
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
                log.info(
                        "event=REALTIME_STOP_DUPLICATE_IGNORED meetingId={} finalizedSeq={}",
                        meetingId,
                        getLongAttribute(session, LAST_AUDIO_SEQ_ATTR)
                );
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

            String authorization = getStringAttribute(session, "authorization");
            session.getAttributes().remove(MEETING_STATUS_CHECKED_ATTR);
            session.getAttributes().remove(LAST_MEETING_STATUS_CHECK_AT_ATTR);
            if (shouldRejectTerminalMeeting(
                    session,
                    meetingId,
                    getLongAttribute(session, LAST_AUDIO_SEQ_ATTR),
                    authorization)) {
                return;
            }

            log.info(
                    "event=REALTIME_STOP_FINALIZE_AFTER_DRAIN meetingId={} sessionId={} lastClientSeq={} drainedSeq={}",
                    meetingId,
                    session.getId(),
                    getLongAttribute(session, LAST_AUDIO_SEQ_ATTR),
                    getLongAttribute(session, LAST_AUDIO_SEQ_ATTR)
            );
            if (realtimeAsyncAudioQueueEnabled) {
                shutdownRealtimeWorkerForStop(session, meetingId);
            } else {
                finalizeSttSession(session, meetingId, true);
            }
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
                    "event=REALTIME_CHUNK_DROPPED_TERMINAL meetingId={} seq={} reason=session_finalized",
                    meetingId,
                    getLongAttribute(session, LAST_AUDIO_SEQ_ATTR)
            );
            return;
        }
        Long lastSeq = getLongAttribute(session, LAST_AUDIO_SEQ_ATTR);
        String streamId = RealtimeStreamAudioState.normalizeStreamId(
                getStringAttribute(session, RealtimeDualStreamSessionKeys.LAST_AUDIO_STREAM_ID_ATTR)
        );
        if (lastSeq == null) {
            log.info(
                    "event=REALTIME_CHUNK_DROPPED_STALE_SESSION meetingId={} seq={} reason=missing_or_rejected_metadata",
                    meetingId,
                    null
            );
            return;
        }
        String authorization = getStringAttribute(session, "authorization");
        if (shouldRejectTerminalMeeting(session, meetingId, lastSeq, authorization)) {
            return;
        }
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
        if (!enforceRealtimeSttQuota(session, payloadSize)) {
            String quotaMessage = ErrorCode.QUOTA_EXCEEDED.displayMessage(epic2FeatureFlags.isErrorUxEnabled());
            Map<String, Object> quotaError = new HashMap<>();
            quotaError.put("type", "error");
            quotaError.put("errorCode", "QUOTA_EXCEEDED");
            quotaError.put("message", quotaMessage);
            if (isDualStreamSession(session) && RealtimeStreamAudioState.isDualStreamCapable(streamId)) {
                quotaError.put("streamId", streamId);
                safeSendMessage(session, new TextMessage(objectMapper.writeValueAsString(quotaError)));
                log.warn(
                        "event=REALTIME_STT_QUOTA_EXCEEDED meetingId={} streamId={} seq={} dualStream=true",
                        meetingId,
                        streamId,
                        lastSeq
                );
                return;
            }
            safeSendMessage(session, new TextMessage(objectMapper.writeValueAsString(quotaError)));
            session.close(CloseStatus.POLICY_VIOLATION.withReason("Quota exceeded"));
            return;
        }
        Long declaredSize = getLongAttribute(session, LAST_AUDIO_DECLARED_SIZE_ATTR);
        String language = getStringAttribute(session, LANGUAGE_ATTR);
        String speakerMode = getStringAttribute(session, SPEAKER_MODE_ATTR);
        Boolean isFinal = getBooleanAttribute(session, LAST_AUDIO_IS_FINAL_ATTR);
        String effectiveSpeakerMode = normalizeRealtimeSpeakerMode(speakerMode);
        log.info(
                "REALTIME_AUDIO_CHUNK_RECEIVED meetingId={} streamId={} seq={} byteLength={} declaredSize={} isFinal={}",
                meetingId,
                streamId,
                lastSeq,
                payloadSize,
                declaredSize,
                isFinal
        );

        if (epic2FeatureFlags.isRealtimeValidationEnabled()) {
            RealtimePayloadValidator.ValidationResult binaryValidation =
                    realtimePayloadValidator.validateBinary(audioBytes, declaredSize);
            if (!binaryValidation.valid()) {
                rejectRealtimeValidation(session, meetingId, lastSeq, binaryValidation.errorCode());
                return;
            }
            log.info("event=REALTIME_VALIDATION_ACCEPTED meetingId={} streamId={} seq={}", meetingId, streamId, lastSeq);
            session.getAttributes().put(LAST_ACCEPTED_SEQ_ATTR, lastSeq);
            if (isDualStreamSession(session)) {
                RealtimeStreamAudioState.stateFor(session.getAttributes(), streamId).setLastAcceptedSeq(lastSeq);
            }
        }

        if (payloadSize > 0) {
            recordAcceptedAudioChunk(session, meetingId, streamId, payloadSize);
        }

        log.info(
                "event=REALTIME_CHUNK_FORWARD_TO_AI meetingId={} streamId={} seq={} byteLength={}",
                meetingId,
                streamId,
                lastSeq,
                payloadSize
        );

        if (realtimeAsyncAudioQueueEnabled) {
            enqueueAsyncAudioChunk(
                    session,
                    meetingId,
                    streamId,
                    audioBytes,
                    lastSeq,
                    language,
                    effectiveSpeakerMode,
                    isFinal != null && isFinal,
                    authorization
            );
            return;
        }

        forwardAudioChunkToAiAndBroadcast(
                session,
                meetingId,
                streamId,
                audioBytes,
                lastSeq,
                language,
                effectiveSpeakerMode,
                isFinal != null && isFinal,
                authorization
        );
    }

    private boolean enforceRealtimeSttQuota(WebSocketSession session, int payloadSizeBytes) {
        try {
            Long userId = getLongAttribute(session, "userId");
            if (userId == null || payloadSizeBytes <= 0) {
                return true;
            }
            if (userQuotaClient == null) {
                if (quotaFailOpen) {
                    return true;
                }
                log.error("event=REALTIME_STT_QUOTA_DENIED reason=quota_client_unavailable userId={}", userId);
                return false;
            }
            long bps = sttBytesPerSecondEstimate <= 0 ? 4000 : sttBytesPerSecondEstimate;
            long seconds = payloadSizeBytes / bps;
            if (seconds <= 0) {
                seconds = 1;
            }
            UserQuotaClient.QuotaConsumeResult result = userQuotaClient.consume(userId, seconds, 0);
            if (!result.allowed()) {
                log.warn(
                        "event=REALTIME_STT_QUOTA_EXCEEDED userId={} meetingId={} seconds={}",
                        userId,
                        getLongAttribute(session, "meetingId"),
                        seconds
                );
            }
            return result.allowed();
        } catch (Exception ex) {
            if (quotaFailOpen) {
                log.warn(
                        "event=REALTIME_STT_QUOTA_FAIL_OPEN errorCode={}",
                        ex.getClass().getSimpleName()
                );
                return true;
            }
            log.error(
                    "event=REALTIME_STT_QUOTA_DENIED reason=quota_error errorCode={}",
                    ex.getClass().getSimpleName()
            );
            return false;
        }
    }

    private boolean enforceRealtimeGeminiQuota(Long userId, String transcriptText) {
        if (userId == null || transcriptText == null || transcriptText.isBlank()) {
            return true;
        }
        if (userQuotaClient == null) {
            if (quotaFailOpen) {
                return true;
            }
            log.error("event=REALTIME_GEMINI_QUOTA_DENIED reason=quota_client_unavailable userId={}", userId);
            return false;
        }
        try {
            UserQuotaClient.QuotaConsumeResult result = userQuotaClient.consume(userId, 0, transcriptText.length());
            if (!result.allowed()) {
                log.warn("event=REALTIME_GEMINI_QUOTA_EXCEEDED userId={} chars={}", userId, transcriptText.length());
            }
            return result.allowed();
        } catch (Exception ex) {
            if (quotaFailOpen) {
                log.warn(
                        "event=REALTIME_GEMINI_QUOTA_FAIL_OPEN userId={} errorCode={}",
                        userId,
                        ex.getClass().getSimpleName()
                );
                return true;
            }
            log.error(
                    "event=REALTIME_GEMINI_QUOTA_DENIED userId={} errorCode={}",
                    userId,
                    ex.getClass().getSimpleName()
            );
            return false;
        }
    }

    private void enqueueAsyncAudioChunk(
            WebSocketSession session,
            Long meetingId,
            String streamId,
            byte[] audioBytes,
            Long lastSeq,
            String language,
            String effectiveSpeakerMode,
            boolean isFinal,
            String authorization) throws Exception {
        if (!canAcceptAsyncAudioChunk(session, meetingId, lastSeq)) {
            return;
        }

        RealtimeAudioSessionWorker worker = resolveRealtimeWorker(session, meetingId);
        RealtimeAudioWorkItem workItem = new RealtimeAudioWorkItem(
                meetingId,
                streamId,
                lastSeq != null ? lastSeq : 0L,
                audioBytes,
                language,
                effectiveSpeakerMode,
                isFinal,
                authorization
        );
        RealtimeAudioEnqueueResult enqueueResult = worker.enqueue(workItem);
        if (enqueueResult == RealtimeAudioEnqueueResult.ACCEPTED) {
            return;
        }
        if (enqueueResult == RealtimeAudioEnqueueResult.QUEUE_FULL) {
            handleQueueFullBackpressure(session, meetingId, lastSeq, worker);
            return;
        }
        log.info(
                "event=REALTIME_CHUNK_DROPPED_TERMINAL meetingId={} seq={} reason=worker_state_{}",
                meetingId,
                lastSeq,
                worker.state()
        );
    }

    private boolean canAcceptAsyncAudioChunk(WebSocketSession session, Long meetingId, Long seq) {
        RealtimeAudioSessionWorker worker = realtimeAudioWorkerRegistry.get(session.getId());
        if (worker == null) {
            return true;
        }
        if (worker.state() == RealtimeSessionLifecycleState.ACTIVE) {
            return true;
        }
        session.getAttributes().remove(LAST_AUDIO_SEQ_ATTR);
        log.info(
                "event=REALTIME_CHUNK_DROPPED_TERMINAL meetingId={} seq={} reason=worker_state_{}",
                meetingId,
                seq,
                worker.state()
        );
        return false;
    }

    private RealtimeAudioSessionWorker resolveRealtimeWorker(WebSocketSession session, Long meetingId) {
        return realtimeAudioWorkerRegistry.getOrCreate(
                session.getId(),
                sessionId -> new RealtimeAudioSessionWorker(
                        sessionId,
                        meetingId,
                        session,
                        this::processEnqueuedAudioChunk,
                        realtimeAsyncQueueMaxSize,
                        realtimeStopDrainTimeoutMs
                )
        );
    }

    private void processEnqueuedAudioChunk(WebSocketSession session, RealtimeAudioWorkItem item) throws Exception {
        forwardAudioChunkToAiAndBroadcast(
                session,
                item.meetingId(),
                item.streamId(),
                item.audioBytes(),
                item.seq(),
                item.language(),
                item.speakerMode(),
                item.isFinal(),
                item.authorization()
        );
    }

    private void forwardAudioChunkToAiAndBroadcast(
            WebSocketSession session,
            Long meetingId,
            String streamId,
            byte[] audioBytes,
            Long lastSeq,
            String language,
            String effectiveSpeakerMode,
            boolean isFinal,
            String authorization) throws Exception {
        try {
                Map<String, Object> transcript = invokeStreamAudioChunk(
                        session,
                        meetingId,
                        streamId,
                        audioBytes,
                        lastSeq,
                        language,
                        effectiveSpeakerMode,
                        isFinal,
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
            Map<String, Object> transcriptEvent = buildTranscriptEvent(
                    meetingId,
                    streamId,
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
                    realtimeEventSubscriber.dispatchMeetingEvent(meetingId, transcriptEvent);
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
                    realtimeEventSubscriber.dispatchMeetingEvent(meetingId, buildListeningStatusEvent(meetingId, lastSeq));
                }
            } catch (Exception e) {
                log.warn(
                        "event=REALTIME_ANALYSIS_FAILED meetingId={} source=realtime_broadcast errorCode={}",
                        meetingId,
                        safeErrorCode(e)
                );
            }
        } catch (Exception ex) {
            handleAudioChunkForwardFailure(session, meetingId, lastSeq, ex);
        }
    }

    private void handleAudioChunkForwardFailure(WebSocketSession session, Long meetingId, Long lastSeq, Exception ex) {
        if (Boolean.TRUE.equals(session.getAttributes().get(BACKPRESSURE_REJECTED_ATTR))) {
            log.info(
                    "event=REALTIME_CHUNK_FORWARD_SUPPRESSED meetingId={} seq={} reason=backpressure",
                    meetingId,
                    lastSeq
            );
            return;
        }
        if (realtimeAsyncAudioQueueEnabled) {
            RealtimeAudioSessionWorker worker = realtimeAudioWorkerRegistry.get(session.getId());
            if (worker != null && worker.state() == RealtimeSessionLifecycleState.REJECTED) {
                log.info(
                        "event=REALTIME_CHUNK_FORWARD_SUPPRESSED meetingId={} seq={} reason=session_rejected",
                        meetingId,
                        lastSeq
                );
                return;
            }
        }

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
                realtimeEventSubscriber.dispatchMeetingEvent(meetingId, errorEvent);
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
            realtimeEventSubscriber.dispatchMeetingEvent(meetingId, errorEvent);
        } catch (Exception e) {
            log.warn(
                    "event=REALTIME_ANALYSIS_FAILED meetingId={} source=stream_error errorCode={}",
                    meetingId,
                    safeErrorCode(e)
            );
        }
    }

    private void handleQueueFullBackpressure(
            WebSocketSession session,
            Long meetingId,
            Long seq,
            RealtimeAudioSessionWorker worker) {
        log.warn(
                "event=REALTIME_CHUNK_DROPPED_QUEUE_FULL meetingId={} seq={} queueDepth={} maxQueueDepth={} reason=queue_full",
                meetingId,
                seq,
                worker.queueDepth(),
                realtimeAsyncQueueMaxSize
        );
        session.getAttributes().put(BACKPRESSURE_REJECTED_ATTR, Boolean.TRUE);
        Map<String, Object> errorEvent = Map.of(
                "type", "stream.error",
                "meetingId", meetingId,
                "message", "Realtime audio queue full; restart recording.",
                "recoverable", false,
                "resetRequired", true
        );
        try {
            realtimeEventSubscriber.dispatchMeetingEvent(meetingId, errorEvent);
        } catch (Exception e) {
            log.warn(
                    "event=REALTIME_ANALYSIS_FAILED meetingId={} source=queue_full errorCode={}",
                    meetingId,
                    safeErrorCode(e)
            );
        }
        worker.rejectQueueFull();
        realtimeAudioWorkerRegistry.remove(session.getId(), worker);
        try {
            session.close(new CloseStatus(1013, "backpressure"));
        } catch (Exception e) {
            log.debug(
                    "Unable to close backpressure session meetingId={} errorCode={}",
                    meetingId,
                    safeErrorCode(e)
            );
        }
    }

    private void shutdownRealtimeWorkerForStop(WebSocketSession session, Long meetingId) {
        RealtimeAudioSessionWorker worker = realtimeAudioWorkerRegistry.get(session.getId());
        if (worker != null) {
            try {
                worker.shutdownAndFinalize(() -> {
                    finalizeSttSession(session, meetingId, true);
                    return true;
                });
            } finally {
                realtimeAudioWorkerRegistry.remove(session.getId(), worker);
            }
            return;
        }
        if (!Boolean.TRUE.equals(session.getAttributes().get(FINALIZED_ATTR))) {
            finalizeSttSession(session, meetingId, true);
        }
    }

    private void shutdownRealtimeWorkerForClose(WebSocketSession session, Long meetingId) {
        RealtimeAudioSessionWorker worker = realtimeAudioWorkerRegistry.get(session.getId());
        if (worker != null) {
            try {
                worker.shutdownAndFinalize(() -> {
                    finalizeSttSession(session, meetingId, false);
                    return true;
                });
            } finally {
                realtimeAudioWorkerRegistry.remove(session.getId(), worker);
            }
            return;
        }
        if (!Boolean.TRUE.equals(session.getAttributes().get(FINALIZED_ATTR))) {
            finalizeSttSession(session, meetingId, false);
        }
    }

    private void cleanupRealtimeWorker(WebSocketSession session, String reason) {
        RealtimeAudioSessionWorker worker = realtimeAudioWorkerRegistry.get(session.getId());
        if (worker == null) {
            return;
        }
        try {
            worker.cleanupOnly(reason);
        } finally {
            realtimeAudioWorkerRegistry.remove(session.getId(), worker);
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
                    if (realtimeAsyncAudioQueueEnabled) {
                        shutdownRealtimeWorkerForClose(session, meetingId);
                    } else {
                        finalizeSttSession(session, meetingId, false);
                    }
                } else {
                    log.info("Skipping STT finalization for meetingId={} because no audio was received", meetingId);
                    cleanupRealtimeWorker(session, "no_audio");
                }
            } else if (!isAuthenticated(session)) {
                log.info("Skipping STT finalization for unauthenticated session meetingId={}", meetingId);
                cleanupRealtimeWorker(session, "unauthenticated");
            } else {
                cleanupRealtimeWorker(session, "already_finalized");
            }

            realtimeEventSubscriber.unregisterSession(meetingId, session);
            log.info("WebSocket session closed for meetingId={}", meetingId);
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) throws Exception {
        Long meetingId = getLongAttribute(session, "meetingId");
        if (meetingId != null) {
            cleanupRealtimeWorker(session, "transport_error");
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

    private boolean shouldRejectTerminalMeeting(
            WebSocketSession session,
            Long meetingId,
            Long seq,
            String authorization) {
        Object cachedTerminalStatus = session.getAttributes().get(TERMINAL_MEETING_STATUS_ATTR);
        if (cachedTerminalStatus != null) {
            rejectTerminalMeeting(session, meetingId, seq, String.valueOf(cachedTerminalStatus));
            return true;
        }

        if (Boolean.TRUE.equals(session.getAttributes().get(MEETING_STATUS_CHECKED_ATTR))) {
            Long lastCheckAt = getLongAttribute(session, LAST_MEETING_STATUS_CHECK_AT_ATTR);
            if (lastCheckAt != null
                    && (System.currentTimeMillis() - lastCheckAt) < MEETING_STATUS_RECHECK_INTERVAL_MS) {
                return false;
            }
            session.getAttributes().remove(MEETING_STATUS_CHECKED_ATTR);
        }

        try {
            Map<String, Object> meeting = meetingServiceClient.getMeetingById(meetingId, null, authorization);
            String status = normalizeMeetingStatus(getStringValue(meeting.get("status")));
            if (isTerminalMeetingStatus(status)) {
                session.getAttributes().put(TERMINAL_MEETING_STATUS_ATTR, status);
                rejectTerminalMeeting(session, meetingId, seq, status);
                return true;
            }
            session.getAttributes().put(MEETING_STATUS_CHECKED_ATTR, Boolean.TRUE);
            session.getAttributes().put(LAST_MEETING_STATUS_CHECK_AT_ATTR, System.currentTimeMillis());
        } catch (Exception ex) {
            log.warn(
                    "event=REALTIME_MEETING_STATUS_CHECK_FAILED meetingId={} seq={} errorCode={}",
                    meetingId,
                    seq,
                    safeErrorCode(ex)
            );
        }

        return false;
    }

    private void rejectRealtimeValidation(
            WebSocketSession session,
            Long meetingId,
            Long seq,
            RealtimePayloadValidator.ValidationError errorCode) {
        session.getAttributes().remove(LAST_AUDIO_SEQ_ATTR);
        session.getAttributes().remove(LAST_AUDIO_DECLARED_SIZE_ATTR);
        session.getAttributes().remove(LAST_AUDIO_MIME_TYPE_ATTR);
        session.getAttributes().remove(LAST_AUDIO_ENCODING_ATTR);
        String code = errorCode == null ? "REALTIME_INVALID_PAYLOAD" : errorCode.name();
        log.warn(
                "event=REALTIME_VALIDATION_FAILED meetingId={} seq={} errorCode={}",
                meetingId,
                seq,
                code
        );
        Map<String, Object> errorEvent = Map.of(
                "type", "stream.error",
                "meetingId", meetingId,
                "message", "Realtime chunk validation failed",
                "errorCode", code,
                "recoverable", true
        );
        try {
            realtimeEventSubscriber.dispatchMeetingEvent(meetingId, errorEvent);
        } catch (Exception broadcastError) {
            log.warn(
                    "event=REALTIME_ANALYSIS_FAILED meetingId={} source=validation_reject errorCode={}",
                    meetingId,
                    safeErrorCode(broadcastError)
            );
        }
    }

    private void rejectInvalidDualStreamId(WebSocketSession session, Long meetingId, Long seq, String rawStreamId) {
        session.getAttributes().remove(LAST_AUDIO_SEQ_ATTR);
        session.getAttributes().remove(LAST_AUDIO_DECLARED_SIZE_ATTR);
        session.getAttributes().remove(LAST_AUDIO_MIME_TYPE_ATTR);
        session.getAttributes().remove(LAST_AUDIO_ENCODING_ATTR);
        session.getAttributes().remove(RealtimeDualStreamSessionKeys.LAST_AUDIO_STREAM_ID_ATTR);
        log.warn(
                "event=REALTIME_INVALID_STREAM_ID meetingId={} seq={} streamId={}",
                meetingId,
                seq,
                rawStreamId == null ? "" : rawStreamId
        );
        Map<String, Object> errorEvent = Map.of(
                "type", "stream.error",
                "meetingId", meetingId,
                "message", "Invalid stream_id for Tab+Mic realtime audio",
                "errorCode", "REALTIME_INVALID_STREAM_ID",
                "recoverable", true
        );
        try {
            realtimeEventSubscriber.dispatchMeetingEvent(meetingId, errorEvent);
        } catch (Exception broadcastError) {
            log.warn(
                    "event=REALTIME_ANALYSIS_FAILED meetingId={} source=invalid_stream_id errorCode={}",
                    meetingId,
                    safeErrorCode(broadcastError)
            );
        }
    }

    private void rejectTerminalMeeting(WebSocketSession session, Long meetingId, Long seq, String status) {
        log.warn(
                "event=REALTIME_STREAM_REJECTED_STALE_MEETING meetingId={} seq={} meetingStatus={}",
                meetingId,
                seq,
                status
        );
        log.warn(
                "event=REALTIME_CHUNK_DROPPED_TERMINAL meetingId={} seq={} reason=meeting_status_{}",
                meetingId,
                seq,
                status
        );
        Map<String, Object> errorEvent = Map.of(
                "type", "stream.error",
                "meetingId", meetingId,
                "message", "Meeting is already finalized; start a new realtime recording.",
                "recoverable", false,
                "resetRequired", true
        );
        try {
            realtimeEventSubscriber.dispatchMeetingEvent(meetingId, errorEvent);
        } catch (Exception e) {
            log.warn(
                    "event=REALTIME_ANALYSIS_FAILED meetingId={} source=stale_meeting_reject errorCode={}",
                    meetingId,
                    safeErrorCode(e)
            );
        }
        try {
            session.close(CloseStatus.POLICY_VIOLATION.withReason("Meeting already finalized"));
        } catch (Exception e) {
            log.debug("Unable to close stale realtime session meetingId={} errorCode={}", meetingId, safeErrorCode(e));
        }
    }

    private boolean isTerminalMeetingStatus(String status) {
        return "completed".equals(status)
                || "failed".equals(status)
                || "finalized".equals(status)
                || "success".equals(status)
                || "succeeded".equals(status);
    }

    private String normalizeMeetingStatus(String status) {
        if (status == null) {
            return "";
        }
        return status.trim().toLowerCase(Locale.ROOT);
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

        try {
            session.getAttributes().put(FINALIZED_ATTR, Boolean.TRUE);
        } catch (Exception ignore) {
            log.debug("Unable to set FINALIZED_ATTR for sessionId={}", session.getId());
        }

        broadcastStreamStatus(
                session,
                meetingId,
                RealtimeStatusCodes.FINALIZING,
                sessionStillOpen,
                "Finalizing realtime transcript",
                false
        );

        boolean audioReceived = isDualStreamSession(session)
                ? RealtimeStreamAudioState.anyStreamReceivedAudio(session.getAttributes())
                : Boolean.TRUE.equals(session.getAttributes().get(AUDIO_RECEIVED_ATTR));
        if (!audioReceived) {
            log.info("No audio received for meetingId={}, scheduling persisted transcript recovery before failed audio capture", meetingId);
            scheduleTranscriptRecoveryBeforeTerminalOutcome(
                    session,
                    meetingId,
                    sessionStillOpen,
                    analysisSource,
                    authorization,
                    RealtimeStatusCodes.FAILED_AUDIO_CAPTURE,
                    "No audio chunks were received from the client.",
                    "no_audio_received"
            );
            return;
        }

        if (isInvalidAudioCapture(session, meetingId)) {
            scheduleTranscriptRecoveryBeforeTerminalOutcome(
                    session,
                    meetingId,
                    sessionStillOpen,
                    analysisSource,
                    authorization,
                    RealtimeStatusCodes.FAILED_AUDIO_CAPTURE,
                    "Recorded audio was too short or invalid. Check microphone permissions and volume.",
                    "invalid_audio_capture"
            );
            return;
        }

        log.info(
                "Finalizing STT session for meetingId={} with synthetic final chunk dualStream={}",
                meetingId,
                isDualStreamSession(session)
        );

        if (isDualStreamSession(session) && dualStreamTabMicEnabled) {
            finalizeDualSttStreams(
                    session,
                    meetingId,
                    sessionStillOpen,
                    analysisSource,
                    authorization,
                    language,
                    speakerMode
            );
            return;
        }

        try {
                Map<String, Object> transcript = invokeStreamAudioChunk(
                        session,
                        meetingId,
                        RealtimeStreamAudioState.LEGACY_STREAM_ID,
                        new byte[0],
                        -1L,
                        language,
                        speakerMode,
                        true,
                        authorization
                );

                    if (transcript == null) {
                    log.info(
                            "REALTIME_FINALIZE_SKIPPED_DUPLICATE meetingId={} reason=already_finalized",
                            meetingId
                    );
                    recoverTranscriptAfterTerminalFinalize(
                            session,
                            meetingId,
                            sessionStillOpen,
                            analysisSource,
                            authorization
                    );
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
                        triggerRealtimeAnalysisAsync(
                                meetingId,
                                getLongAttribute(session, "userId"),
                                authorization,
                                language,
                                analysisSource,
                                resolveSessionTraceId(session),
                                normalizeDomainMode(getStringAttribute(session, DOMAIN_MODE_ATTR))
                        );
                        triggerCanonicalizeIfEnabled(meetingId, resolveSessionTraceId(session), "realtime");
                        syncRealtimeMeetingTerminalStatus(meetingId, authorization, RealtimeStatusCodes.COMPLETED);
                    }
                    return;
                }
                rememberTranscriptEvent(session, transcriptEvent);

                cacheFinalizedTranscript(meetingId, transcriptEvent);
                finalizeDeadlineService.clear(meetingId);
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
                        realtimeEventSubscriber.dispatchMeetingEvent(meetingId, transcriptEvent);
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
                        realtimeEventSubscriber.dispatchMeetingEvent(meetingId, partialWarningEvent);
                    }
                    log.info(
                            "REALTIME_ANALYSIS_SKIPPED reason=not_final source={} meetingId={}",
                            analysisSource,
                            meetingId
                    );
                } else {
                    int transcriptRows = normalizeTranscriptRows(transcript.get("transcripts")).size();
                    log.info(
                            "event=REALTIME_FINALIZE_COMPLETE meetingId={} sessionId={} finalizeSeq={} transcriptRows={} finalAudioBytes=0",
                            meetingId,
                            session.getId(),
                            finalSeq != null ? finalSeq : -1L,
                            transcriptRows
                    );
                    triggerRealtimeAnalysisAsync(
                            meetingId,
                            getLongAttribute(session, "userId"),
                            authorization,
                            language,
                            analysisSource,
                            resolveSessionTraceId(session),
                            normalizeDomainMode(getStringAttribute(session, DOMAIN_MODE_ATTR))
                    );
                    triggerCanonicalizeIfEnabled(meetingId, resolveSessionTraceId(session), "realtime");
                    syncRealtimeMeetingTerminalStatus(meetingId, authorization, RealtimeStatusCodes.COMPLETED);
                }
                return;
            }

            completeTerminalRealtimeOutcome(
                    session,
                    meetingId,
                    sessionStillOpen,
                    analysisSource,
                    authorization,
                    RealtimeStatusCodes.NO_TRANSCRIPT,
                    "STT session closed with no recognized speech"
            );
            log.info("No final transcript returned for meetingId={}", meetingId);
        } catch (Exception ex) {
            handleFinalizeException(session, meetingId, sessionStillOpen, analysisSource, authorization, ex);
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
            Long userId,
            String authorization,
            String language,
            String source,
            String traceId,
            String domainMode
    ) {
        log.info(
                "REALTIME_ANALYSIS_TRIGGER_ATTEMPT meetingId={} source={} traceId={}",
                meetingId,
                source,
                traceId
        );
        try {
            CompletableFuture.runAsync(() -> runRealtimeAnalysis(
                    meetingId,
                    userId,
                    authorization,
                    language,
                    source,
                    traceId,
                    domainMode
            ));
            log.info("REALTIME_ANALYSIS_ENQUEUED meetingId={} source={} traceId={}", meetingId, source, traceId);
        } catch (Exception ex) {
            log.warn(
                    "REALTIME_ANALYSIS_FAILED meetingId={} source={} reason=enqueue_failed errorCode={}",
                    meetingId,
                    source,
                    safeErrorCode(ex)
            );
        }
    }

    private void triggerCanonicalizeIfEnabled(Long meetingId, String traceId, String source) {
        if (epic3FeatureFlags == null || !epic3FeatureFlags.isTranscriptQualityEnabled()) {
            return;
        }
        try {
            CompletableFuture.runAsync(() -> aiServiceClient.requestCanonicalize(meetingId, null, traceId));
            log.info(
                    "event=TRANSCRIPT_QUALITY_CANONICALIZE_ENQUEUED meetingId={} runId={} source={}",
                    meetingId,
                    null,
                    source
            );
        } catch (Exception ex) {
            log.warn(
                    "event=TRANSCRIPT_QUALITY_CANONICALIZE_FAILED meetingId={} errorCode={}",
                    meetingId,
                    safeErrorCode(ex)
            );
        }
    }

    private void runRealtimeAnalysis(
            Long meetingId,
            Long userId,
            String authorization,
            String language,
            String source,
            String traceId,
            String domainMode
    ) {
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
        JobStateStore.AnalysisTriggerDecision decision = jobStateStore.tryStartAnalysis(
                meetingId,
                transcriptHash,
                source,
                "processing_ws_realtime_stop"
        );
        if (!decision.shouldTrigger()) {
            log.info(
                    "event=REALTIME_ANALYSIS_SKIPPED reason={} source={} meetingId={} retryAfterSeconds={}",
                    decision.reason(),
                    source,
                    meetingId,
                    decision.retryAfterSeconds()
            );
            return;
        }

        try {
            if (!enforceRealtimeGeminiQuota(userId, transcriptText)) {
                String quotaMessage = ErrorCode.QUOTA_EXCEEDED.displayMessage(epic2FeatureFlags.isErrorUxEnabled());
                jobStateStore.markAnalysisFailed(
                        meetingId,
                        transcriptHash,
                        source,
                        "processing_ws_realtime_stop",
                        decision.lockToken(),
                        "QUOTA_EXCEEDED",
                        quotaMessage
                );
                log.warn(
                        "event=REALTIME_ANALYSIS_FAILED meetingId={} source={} reason=quota_exceeded",
                        meetingId,
                        source
                );
                return;
            }
            log.info("event=REALTIME_ANALYSIS_REQUEST_SENT meetingId={} source={}", meetingId, source);
            Map<String, Object> analysisResponse = aiServiceClient.analyzeRealtimeTranscript(
                    meetingId,
                    transcriptText,
                    domainMode,
                    "realtime",
                    transcriptHash,
                    traceId,
                    authorization
            );

            String analysisStatus = normalizeStatus(
                    analysisResponse == null ? null : analysisResponse.get("status")
            );
            String analysisReason = normalizeRealtimeSkipReason(analysisResponse);
            int retryAfterSeconds = parseRetryAfter(analysisResponse);
            if ("FAILED".equals(analysisStatus)) {
                String errorCode = mapRealtimeFailureCode(analysisResponse);
                int retryAfterSecondsForFailure = AnalysisFailureMapping.resolveRetryAfterSeconds(
                        errorCode,
                        retryAfterSeconds
                );
                jobStateStore.markAnalysisFailed(
                        meetingId,
                        transcriptHash,
                        source,
                        "processing_ws_realtime_stop",
                        decision.lockToken(),
                        errorCode,
                        safeText(analysisResponse.get("reason")),
                        retryAfterSecondsForFailure
                );
                logRealtimeAnalysisFailure(meetingId, source, errorCode, retryAfterSecondsForFailure, 1);
                return;
            }

            if ("COMPLETED".equals(analysisStatus)) {
                jobStateStore.markAnalysisCompleted(
                        meetingId,
                        transcriptHash,
                        source,
                        "processing_ws_realtime_stop",
                        decision.lockToken()
                );
                log.info("event=REALTIME_ANALYSIS_SAVED meetingId={} source={}", meetingId, source);
                return;
            }

            if ("SKIPPED".equals(analysisStatus)) {
                if ("already_exists".equals(analysisReason) && hasPersistedAnalysisResult(meetingId, traceId)) {
                    jobStateStore.markAnalysisCompleted(
                            meetingId,
                            transcriptHash,
                            source,
                            "processing_ws_realtime_stop",
                            decision.lockToken()
                    );
                    log.info(
                            "event=REALTIME_ANALYSIS_SAVED meetingId={} source={} reason=already_exists_verified",
                            meetingId,
                            source
                    );
                    return;
                }

                jobStateStore.markAnalysisSkipped(
                        meetingId,
                        transcriptHash,
                        source,
                        "processing_ws_realtime_stop",
                        decision.lockToken(),
                        analysisReason.isBlank() ? "skipped" : analysisReason,
                        retryAfterSeconds
                );
                log.info(
                        "event=REALTIME_ANALYSIS_SKIPPED reason={} source={} meetingId={} retryAfterSeconds={}",
                        analysisReason.isBlank() ? "skipped" : analysisReason,
                        source,
                        meetingId,
                        retryAfterSeconds
                );
                return;
            }

            jobStateStore.markAnalysisSkipped(
                    meetingId,
                    transcriptHash,
                    source,
                    "processing_ws_realtime_stop",
                    decision.lockToken(),
                    "unexpected_status",
                    retryAfterSeconds
            );
            log.warn(
                    "event=REALTIME_ANALYSIS_SKIPPED reason=unexpected_status source={} meetingId={} status={} retryAfterSeconds={}",
                    source,
                    meetingId,
                    analysisStatus,
                    retryAfterSeconds
            );
        } catch (org.springframework.web.client.HttpStatusCodeException ex) {
            String errorCode = AnalysisFailureMapping.mapFailureCode(ex);
            int retryAfterSeconds = AnalysisFailureMapping.resolveRetryAfterSeconds(errorCode, 0);
            jobStateStore.markAnalysisFailed(
                    meetingId,
                    transcriptHash,
                    source,
                    "processing_ws_realtime_stop",
                    decision.lockToken(),
                    errorCode,
                    safeText(ex.getStatusText()),
                    retryAfterSeconds
            );
            logRealtimeAnalysisFailure(meetingId, source, errorCode, retryAfterSeconds, 1);
        } catch (Exception ex) {
            String errorCode = AnalysisFailureMapping.mapFailureCode(ex);
            int retryAfterSeconds = AnalysisFailureMapping.resolveRetryAfterSeconds(errorCode, 0);
            jobStateStore.markAnalysisFailed(
                    meetingId,
                    transcriptHash,
                    source,
                    "processing_ws_realtime_stop",
                    decision.lockToken(),
                    errorCode,
                    ex.getClass().getSimpleName(),
                    retryAfterSeconds
            );
            logRealtimeAnalysisFailure(meetingId, source, errorCode, retryAfterSeconds, 1);
        }
    }

    private void logRealtimeAnalysisFailure(
            Long meetingId,
            String source,
            String errorCode,
            int retryAfterSeconds,
            int attempt
    ) {
        if (AnalysisFailureMapping.ERROR_CODE_CIRCUIT_OPEN.equals(errorCode)) {
            log.warn(
                    "event=ANALYSIS_CIRCUIT_OPEN meetingId={} circuitName=ai-service retryAfterSeconds={} attempt={}",
                    meetingId,
                    retryAfterSeconds,
                    attempt
            );
        }
        if (AnalysisFailureMapping.isRetryableErrorCode(errorCode)) {
            log.warn(
                    "event=REALTIME_ANALYSIS_FAILED_RETRYABLE meetingId={} source={} errorCode={} retryAfterSeconds={} retryable=true attempt={}",
                    meetingId,
                    source,
                    errorCode,
                    retryAfterSeconds,
                    attempt
            );
            return;
        }
        log.warn(
                "event=REALTIME_ANALYSIS_FAILED meetingId={} source={} errorCode={} retryable=false attempt={}",
                meetingId,
                source,
                errorCode,
                attempt
        );
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

    private String normalizeStatus(Object value) {
        if (value == null) {
            return "";
        }
        return String.valueOf(value).trim().toUpperCase(Locale.ROOT);
    }

    private int parseRetryAfter(Map<String, Object> response) {
        if (response == null) {
            return 0;
        }
        Object value = response.get("retryAfterSeconds");
        if (value == null) {
            return 0;
        }
        try {
            return Math.max(0, Integer.parseInt(String.valueOf(value)));
        } catch (NumberFormatException ex) {
            return 0;
        }
    }

    private String normalizeRealtimeSkipReason(Map<String, Object> response) {
        if (response == null) {
            return "";
        }
        return safeText(response.get("reason")).trim().toLowerCase(Locale.ROOT);
    }

    private boolean hasPersistedAnalysisResult(Long meetingId, String traceId) {
        try {
            Map<String, Object> response = aiServiceClient.getAnalysis(meetingId, traceId);
            return hasStructuredAnalysis(response);
        } catch (org.springframework.web.client.HttpStatusCodeException ex) {
            return false;
        } catch (Exception ex) {
            return false;
        }
    }

    private boolean hasStructuredAnalysis(Map<String, Object> payload) {
        if (payload == null || payload.isEmpty()) {
            return false;
        }
        String summary = safeText(payload.get("summary"));
        if (!summary.isBlank()) {
            return true;
        }
        if (payload.get("analysis") instanceof Map<?, ?> analysisMap) {
            Object nestedSummary = analysisMap.get("summary");
            if (nestedSummary != null && !String.valueOf(nestedSummary).trim().isBlank()) {
                return true;
            }
        }
        return (payload.get("keywords") instanceof List<?> keywords && !keywords.isEmpty())
                || (payload.get("technicalTerms") instanceof List<?> technicalTerms && !technicalTerms.isEmpty())
                || (payload.get("painPoints") instanceof List<?> painPoints && !painPoints.isEmpty())
                || (payload.get("actionItems") instanceof List<?> actionItems && !actionItems.isEmpty())
                || (payload.get("technical_terms") instanceof List<?> technicalTermsSnake && !technicalTermsSnake.isEmpty())
                || (payload.get("action_items") instanceof List<?> actionItemsSnake && !actionItemsSnake.isEmpty());
    }

    private String mapRealtimeFailureCode(Map<String, Object> response) {
        if (response == null) {
            return AnalysisFailureMapping.ERROR_CODE_GEMINI_ANALYSIS_FAILED;
        }
        String explicitErrorCode = safeText(response.get("errorCode"));
        if (!explicitErrorCode.isBlank()) {
            return explicitErrorCode.toUpperCase(Locale.ROOT);
        }
        String reason = safeText(response.get("reason")).toLowerCase(Locale.ROOT);
        if (reason.contains("empty_transcript")) {
            return AnalysisFailureMapping.ERROR_CODE_EMPTY_TRANSCRIPT;
        }
        if (reason.contains("circuit_open") || reason.contains("callnotpermitted")) {
            return AnalysisFailureMapping.ERROR_CODE_CIRCUIT_OPEN;
        }
        if (reason.contains("unavailable")) {
            return AnalysisFailureMapping.ERROR_CODE_GEMINI_UNAVAILABLE;
        }
        return AnalysisFailureMapping.ERROR_CODE_GEMINI_ANALYSIS_FAILED;
    }

    private Map<String, Object> buildTerminalRealtimeStatusEvent(
            Long meetingId,
            String statusCode,
            String message
    ) {
        Map<String, Object> statusEvent = new HashMap<>();
        statusEvent.put("type", "stream.status");
        statusEvent.put("state", statusCode);
        statusEvent.put("status", statusCode);
        statusEvent.put("errorCode", statusCode);
        if (RealtimeStatusCodes.isNoTranscriptTerminal(statusCode)) {
            statusEvent.put("legacyErrorCode", RealtimeStatusCodes.legacyNoTranscriptAlias());
            statusEvent.put("analysisStatus", "NO_ANALYSIS");
            statusEvent.put("transcriptRows", 0);
        }
        statusEvent.put("finalized", true);
        statusEvent.put("meetingId", meetingId);
        statusEvent.put("message", message);
        statusEvent.put("activeConnections", realtimeEventSubscriber.getActiveConnectionCount(meetingId));
        return statusEvent;
    }

    private void persistTerminalRealtimeOutcome(Long meetingId, String source, String statusCode) {
        Map<String, Object> result = new HashMap<>();
        result.put("transcripts", List.of());
        result.put("analysisStatus", "NO_ANALYSIS");
        result.put("transcriptRows", 0);
        result.put("finalized", true);
        result.put("terminalStatus", statusCode);
        String persistedStatus = RealtimeStatusCodes.isNoTranscriptTerminal(statusCode)
                ? RealtimeStatusCodes.legacyNoTranscriptAlias()
                : statusCode;
        try {
            jobStateStore.upsertJobState(
                    meetingId,
                    persistedStatus,
                    "realtime-meeting:" + meetingId,
                    result,
                    null,
                    "realtime-terminal-" + meetingId + "-" + statusCode.toLowerCase(Locale.ROOT)
            );
        } catch (Exception ex) {
            log.warn(
                    "event=REALTIME_TERMINAL_PERSIST_FAILED meetingId={} source={} status={} errorCode={}",
                    meetingId,
                    source,
                    statusCode,
                    safeErrorCode(ex)
            );
        }
    }

    private void completeTerminalRealtimeOutcome(
            WebSocketSession session,
            Long meetingId,
            boolean sessionStillOpen,
            String analysisSource,
            String authorization,
            String statusCode,
            String message
    ) {
        persistTerminalRealtimeOutcome(meetingId, analysisSource, statusCode);
        Map<String, Object> statusEvent = buildTerminalRealtimeStatusEvent(meetingId, statusCode, message);
        broadcastStreamStatusEvent(session, meetingId, sessionStillOpen, statusEvent);
        syncRealtimeMeetingTerminalStatus(meetingId, authorization, statusCode);
        if (RealtimeStatusCodes.isNoTranscriptTerminal(statusCode)) {
            log.info(
                    "REALTIME_ANALYSIS_SKIPPED reason=no_transcript source={} meetingId={} transcriptRows=0 transcriptLength=0 finalized=true",
                    analysisSource,
                    meetingId
            );
        } else if (RealtimeStatusCodes.FAILED_AUDIO_CAPTURE.equals(statusCode)) {
            log.info(
                    "REALTIME_ANALYSIS_SKIPPED reason=failed_audio_capture source={} meetingId={} transcriptRows=0 finalized=true",
                    analysisSource,
                    meetingId
            );
        }
    }

    private void broadcastStreamStatus(
            WebSocketSession session,
            Long meetingId,
            String statusCode,
            boolean sessionStillOpen,
            String message,
            boolean terminal
    ) {
        Map<String, Object> statusEvent = terminal
                ? buildTerminalRealtimeStatusEvent(meetingId, statusCode, message)
                : buildLifecycleStatusEvent(meetingId, statusCode, message);
        broadcastStreamStatusEvent(session, meetingId, sessionStillOpen, statusEvent);
    }

    private Map<String, Object> buildLifecycleStatusEvent(
            Long meetingId,
            String statusCode,
            String message
    ) {
        Map<String, Object> statusEvent = new HashMap<>();
        statusEvent.put("type", "stream.status");
        statusEvent.put("state", statusCode);
        statusEvent.put("status", statusCode);
        statusEvent.put("meetingId", meetingId);
        statusEvent.put("message", message);
        statusEvent.put("activeConnections", realtimeEventSubscriber.getActiveConnectionCount(meetingId));
        return statusEvent;
    }

    private void broadcastStreamStatusEvent(
            WebSocketSession session,
            Long meetingId,
            boolean sessionStillOpen,
            Map<String, Object> statusEvent
    ) {
        if (!sessionStillOpen) {
            log.debug("Session already closed for meetingId={}, cannot broadcast stream status", meetingId);
            return;
        }
        try {
            realtimeEventSubscriber.dispatchMeetingEvent(meetingId, statusEvent);
        } catch (Exception e) {
            log.warn(
                    "event=REALTIME_STATUS_BROADCAST_FAILED meetingId={} status={} errorCode={}",
                    meetingId,
                    statusEvent.get("status"),
                    safeErrorCode(e)
            );
        }
    }

    private void syncRealtimeMeetingTerminalStatus(Long meetingId, String authorization, String terminalStatus) {
        if (meetingId == null || authorization == null || authorization.isBlank()) {
            return;
        }
        String meetingStatus = RealtimeStatusCodes.resolveMeetingStatusForTerminalOutcome(terminalStatus);
        try {
            meetingServiceClient.updateMeetingStatus(
                    meetingId,
                    meetingStatus,
                    "realtime-finalize-" + meetingId,
                    authorization
            );
            log.info(
                    "event=REALTIME_MEETING_STATUS_SYNCED meetingId={} meetingStatus={} terminalStatus={}",
                    meetingId,
                    meetingStatus,
                    terminalStatus
            );
        } catch (Exception ex) {
            log.warn(
                    "event=REALTIME_MEETING_STATUS_SYNC_FAILED meetingId={} meetingStatus={} terminalStatus={} errorCode={}",
                    meetingId,
                    meetingStatus,
                    terminalStatus,
                    safeErrorCode(ex)
            );
        }
    }

    private void recordAcceptedAudioChunk(
            WebSocketSession session,
            Long meetingId,
            String streamId,
            int payloadSize
    ) {
        try {
            Boolean previouslyReceived = (Boolean) session.getAttributes().get(AUDIO_RECEIVED_ATTR);
            session.getAttributes().put(AUDIO_RECEIVED_ATTR, Boolean.TRUE);
            if (isDualStreamSession(session)) {
                RealtimeStreamAudioState streamState =
                        RealtimeStreamAudioState.stateFor(session.getAttributes(), streamId);
                streamState.setAudioReceived(true);
                recordStreamAudioChunkMetrics(session, meetingId, streamId, streamState, payloadSize);
            } else {
                recordAudioChunkMetrics(session, payloadSize);
            }
            if (!Boolean.TRUE.equals(previouslyReceived)) {
                finalizeDeadlineService.markAudioReceived(
                        meetingId,
                        buildFinalizeContext(session, meetingId, session.isOpen(), REALTIME_ANALYSIS_SOURCE_STREAM_STOP),
                        ctx -> finalizeSttSession(session, meetingId, session.isOpen()));
            }
        } catch (Exception ignore) {
            log.debug("Unable to set AUDIO_RECEIVED_ATTR for sessionId={}", session.getId());
        }
    }

    private void recordAudioChunkMetrics(WebSocketSession session, int payloadSize) {
        long totalBytes = getTotalAudioBytes(session) + payloadSize;
        session.getAttributes().put(TOTAL_AUDIO_BYTES_ATTR, totalBytes);
        int tinyChunkStreak = payloadSize > 0 && payloadSize < realtimeTinyChunkMaxBytes
                ? getTinyChunkStreak(session) + 1
                : 0;
        session.getAttributes().put(TINY_CHUNK_STREAK_ATTR, tinyChunkStreak);
        if (payloadSize >= realtimeTinyChunkMaxBytes) {
            session.getAttributes().put(VALID_AUDIO_RECEIVED_ATTR, Boolean.TRUE);
        }
        if (tinyChunkStreak >= realtimeTinyChunkStreakThreshold) {
            log.warn(
                    "event=REALTIME_TINY_CHUNK_SUSPECTED meetingId={} streak={} threshold={} maxBytes={} totalAudioBytes={}",
                    getLongAttribute(session, "meetingId"),
                    tinyChunkStreak,
                    realtimeTinyChunkStreakThreshold,
                    realtimeTinyChunkMaxBytes,
                    totalBytes
            );
        }
    }

    private void recordStreamAudioChunkMetrics(
            WebSocketSession session,
            Long meetingId,
            String streamId,
            RealtimeStreamAudioState streamState,
            int payloadSize) {
        streamState.addTotalAudioBytes(payloadSize);
        int tinyChunkStreak = payloadSize > 0 && payloadSize < realtimeTinyChunkMaxBytes
                ? streamState.tinyChunkStreak() + 1
                : 0;
        streamState.setTinyChunkStreak(tinyChunkStreak);
        if (payloadSize >= realtimeTinyChunkMaxBytes) {
            streamState.setValidAudioReceived(true);
            streamState.setInvalidCapture(false);
        }
        if (tinyChunkStreak >= realtimeTinyChunkStreakThreshold) {
            streamState.setInvalidCapture(true);
            log.warn(
                    "event=REALTIME_TINY_CHUNK_SUSPECTED meetingId={} streamId={} streak={} threshold={} maxBytes={} totalAudioBytes={}",
                    meetingId,
                    streamId,
                    tinyChunkStreak,
                    realtimeTinyChunkStreakThreshold,
                    realtimeTinyChunkMaxBytes,
                    streamState.totalAudioBytes()
            );
        }
    }

    private long getTotalAudioBytes(WebSocketSession session) {
        Long totalBytes = getLongAttribute(session, TOTAL_AUDIO_BYTES_ATTR);
        return totalBytes == null ? 0L : totalBytes;
    }

    private int getTinyChunkStreak(WebSocketSession session) {
        Long streak = getLongAttribute(session, TINY_CHUNK_STREAK_ATTR);
        return streak == null ? 0 : Math.toIntExact(streak);
    }

    private boolean isInvalidAudioCapture(WebSocketSession session, Long meetingId) {
        if (isDualStreamSession(session)) {
            List<String> activeStreams = RealtimeStreamAudioState.getActiveStreams(session.getAttributes());
            if (activeStreams.isEmpty()) {
                activeStreams = List.of("tab", "mic");
            }
            Map<String, RealtimeStreamAudioState> states =
                    RealtimeStreamAudioState.getOrCreateStateMap(session.getAttributes());
            boolean anyAudioReceived = false;
            boolean allActiveInvalid = true;
            for (String streamId : activeStreams) {
                RealtimeStreamAudioState streamState = states.get(streamId);
                if (streamState == null || !streamState.audioReceived()) {
                    allActiveInvalid = false;
                    continue;
                }
                anyAudioReceived = true;
                if (streamState.validAudioReceived()
                        || (!streamState.invalidCapture()
                        && streamState.tinyChunkStreak() < realtimeTinyChunkStreakThreshold)) {
                    allActiveInvalid = false;
                }
            }
            if (!anyAudioReceived) {
                return false;
            }
            if (allActiveInvalid) {
                log.warn(
                        "event=REALTIME_AUDIO_TOO_SMALL meetingId={} dualStream=true activeStreams={}",
                        meetingId,
                        activeStreams
                );
                return true;
            }
            return false;
        }

        if (getTinyChunkStreak(session) >= realtimeTinyChunkStreakThreshold
                && !Boolean.TRUE.equals(session.getAttributes().get(VALID_AUDIO_RECEIVED_ATTR))) {
            log.warn(
                    "event=REALTIME_AUDIO_TOO_SMALL meetingId={} tinyChunkStreak={} threshold={} maxBytes={} totalAudioBytes={}",
                    meetingId,
                    getTinyChunkStreak(session),
                    realtimeTinyChunkStreakThreshold,
                    realtimeTinyChunkMaxBytes,
                    getTotalAudioBytes(session)
            );
            return true;
        }
        return false;
    }

    private void scheduleTranscriptRecoveryBeforeTerminalOutcome(
            WebSocketSession session,
            Long meetingId,
            boolean sessionStillOpen,
            String analysisSource,
            String authorization,
            String fallbackStatusCode,
            String fallbackMessage,
            String reason
    ) {
        if (meetingId == null) {
            completeTerminalRealtimeOutcome(
                    session,
                    meetingId,
                    sessionStillOpen,
                    analysisSource,
                    authorization,
                    fallbackStatusCode,
                    fallbackMessage
            );
            return;
        }

        RecoveryControl control = new RecoveryControl();
        RecoveryControl existing = transcriptRecoveryControls.putIfAbsent(meetingId, control);
        if (existing != null) {
            log.info(
                    "event=REALTIME_FINALIZE_RECOVER_ALREADY_PENDING meetingId={} source={} reason={}",
                    meetingId,
                    analysisSource,
                    reason
            );
            return;
        }
        session.getAttributes().put(TRANSCRIPT_RECOVERY_PENDING_ATTR, Boolean.TRUE);

        long timeoutMs = Math.max(100L, realtimeFinalizeRecoveryTimeoutMs);
        control.timeoutFuture = transcriptRecoveryExecutor.schedule(
                () -> completeTimedOutTranscriptRecovery(
                        control,
                        session,
                        meetingId,
                        sessionStillOpen,
                        analysisSource,
                        authorization,
                        fallbackStatusCode,
                        fallbackMessage,
                        reason,
                        timeoutMs
                ),
                timeoutMs,
                TimeUnit.MILLISECONDS
        );

        transcriptRecoveryExecutor.execute(() -> {
            List<Map<String, Object>> rows = List.of();
            String transcriptText = "";
            boolean fetchSucceeded = false;
            try {
                rows = fetchPersistedTranscriptRows(meetingId);
                transcriptText = buildTranscriptText(rows);
                fetchSucceeded = true;
            } catch (Exception ex) {
                log.warn(
                        "event=REALTIME_FINALIZE_RECOVER_FAILED meetingId={} source={} reason={} errorCode={}",
                        meetingId,
                        analysisSource,
                        reason,
                        safeErrorCode(ex)
                );
            }

            if (!control.completed.compareAndSet(false, true)) {
                log.info(
                        "event=REALTIME_FINALIZE_RECOVER_LATE_RESULT_IGNORED meetingId={} source={} reason={}",
                        meetingId,
                        analysisSource,
                        reason
                );
                return;
            }

            ScheduledFuture<?> timeoutFuture = control.timeoutFuture;
            if (timeoutFuture != null) {
                timeoutFuture.cancel(false);
            }
            transcriptRecoveryControls.remove(meetingId, control);
            session.getAttributes().remove(TRANSCRIPT_RECOVERY_PENDING_ATTR);

            log.info(
                    "event=REALTIME_FINALIZE_RECOVER_COMPLETE meetingId={} source={} reason={} fetchSucceeded={} transcriptRows={} transcriptLength={}",
                    meetingId,
                    analysisSource,
                    reason,
                    fetchSucceeded,
                    rows.size(),
                    transcriptText.length()
            );

            if (!transcriptText.isBlank()) {
                triggerRecoveredTranscriptAnalysis(
                        session,
                        meetingId,
                        analysisSource,
                        authorization,
                        reason,
                        rows.size(),
                        transcriptText.length()
                );
                return;
            }

            completeTerminalRealtimeOutcome(
                    session,
                    meetingId,
                    sessionStillOpen,
                    analysisSource,
                    authorization,
                    fallbackStatusCode,
                    fallbackMessage
            );
        });
    }

    private List<Map<String, Object>> fetchPersistedTranscriptRows(Long meetingId) {
        Map<String, Object> transcriptResponse = aiServiceClient.getTranscript(
                meetingId,
                "realtime-finalize-recover-" + meetingId
        );
        return normalizeTranscriptRows(
                transcriptResponse == null ? null : transcriptResponse.get("transcripts")
        );
    }

    private void completeTimedOutTranscriptRecovery(
            RecoveryControl control,
            WebSocketSession session,
            Long meetingId,
            boolean sessionStillOpen,
            String analysisSource,
            String authorization,
            String fallbackStatusCode,
            String fallbackMessage,
            String reason,
            long timeoutMs
    ) {
        if (!control.completed.compareAndSet(false, true)) {
            return;
        }
        transcriptRecoveryControls.remove(meetingId, control);
        session.getAttributes().remove(TRANSCRIPT_RECOVERY_PENDING_ATTR);
        log.warn(
                "event=REALTIME_FINALIZE_RECOVER_TIMEOUT meetingId={} source={} reason={} timeoutMs={}",
                meetingId,
                analysisSource,
                reason,
                timeoutMs
        );
        completeTerminalRealtimeOutcome(
                session,
                meetingId,
                sessionStillOpen,
                analysisSource,
                authorization,
                fallbackStatusCode,
                fallbackMessage
        );
    }

    private void triggerRecoveredTranscriptAnalysis(
            WebSocketSession session,
            Long meetingId,
            String analysisSource,
            String authorization,
            String reason,
            int transcriptRows,
            int transcriptLength
    ) {
        log.info(
                "event=REALTIME_FINALIZE_RECOVERED_TRANSCRIPT meetingId={} source={} reason={} transcriptRows={} transcriptLength={}",
                meetingId,
                analysisSource,
                reason,
                transcriptRows,
                transcriptLength
        );
        triggerRealtimeAnalysisAsync(
                meetingId,
                getLongAttribute(session, "userId"),
                authorization,
                getStringAttribute(session, LANGUAGE_ATTR),
                analysisSource,
                resolveSessionTraceId(session),
                normalizeDomainMode(getStringAttribute(session, DOMAIN_MODE_ATTR))
        );
        syncRealtimeMeetingTerminalStatus(meetingId, authorization, RealtimeStatusCodes.COMPLETED);
    }

    private void recoverTranscriptAfterTerminalFinalize(
            WebSocketSession session,
            Long meetingId,
            boolean sessionStillOpen,
            String analysisSource,
            String authorization
    ) {
        scheduleTranscriptRecoveryBeforeTerminalOutcome(
                session,
                meetingId,
                sessionStillOpen,
                analysisSource,
                authorization,
                RealtimeStatusCodes.NO_TRANSCRIPT,
                "STT session already finalized with no persisted transcript",
                "terminal_finalize"
        );
    }

    private RealtimeFinalizeDeadlineService.FinalizeAttemptContext buildFinalizeContext(
            WebSocketSession session,
            Long meetingId,
            boolean sessionStillOpen,
            String analysisSource
    ) {
        return new RealtimeFinalizeDeadlineService.FinalizeAttemptContext(
                meetingId,
                getStringAttribute(session, LANGUAGE_ATTR),
                getStringAttribute(session, SPEAKER_MODE_ATTR),
                getStringAttribute(session, "authorization"),
                getLongAttribute(session, "userId"),
                resolveSessionTraceId(session),
                analysisSource,
                sessionStillOpen
        );
    }

    private void handleFinalizeException(
            WebSocketSession session,
            Long meetingId,
            boolean sessionStillOpen,
            String analysisSource,
            String authorization,
            Exception ex
    ) {
        if (isIdempotentFinalizeConflict(ex)) {
            log.info(
                    "REALTIME_FINALIZE_SKIPPED_DUPLICATE meetingId={} reason=terminal_conflict errorCode={}",
                    meetingId,
                    safeErrorCode(ex)
            );
            recoverTranscriptAfterTerminalFinalize(
                    session,
                    meetingId,
                    sessionStillOpen,
                    analysisSource,
                    authorization
            );
            return;
        }

        log.warn(
                "event=REALTIME_FINALIZE_FAILED meetingId={} source={} errorCode={}",
                meetingId,
                analysisSource,
                safeErrorCode(ex)
        );

        finalizeDeadlineService.scheduleRetry(
                meetingId,
                buildFinalizeContext(session, meetingId, sessionStillOpen, analysisSource),
                ctx -> finalizeSttSession(session, meetingId, sessionStillOpen));

        try {
            Map<String, Object> transcriptResponse = aiServiceClient.getTranscript(
                    meetingId,
                    "realtime-finalize-fallback-" + meetingId
            );
            List<Map<String, Object>> rows = normalizeTranscriptRows(
                    transcriptResponse == null ? null : transcriptResponse.get("transcripts")
            );
            String transcriptText = buildTranscriptText(rows);
            if (!transcriptText.isBlank()) {
                String language = getStringAttribute(session, LANGUAGE_ATTR);
                triggerRealtimeAnalysisAsync(
                        meetingId,
                        getLongAttribute(session, "userId"),
                        authorization,
                        language,
                        analysisSource,
                        resolveSessionTraceId(session),
                        normalizeDomainMode(getStringAttribute(session, DOMAIN_MODE_ATTR))
                );
                syncRealtimeMeetingTerminalStatus(meetingId, authorization, RealtimeStatusCodes.COMPLETED);
                return;
            }
        } catch (Exception fallbackEx) {
            log.warn(
                    "event=REALTIME_FINALIZE_FALLBACK_FAILED meetingId={} source={} errorCode={}",
                    meetingId,
                    analysisSource,
                    safeErrorCode(fallbackEx)
            );
        }

        String terminalStatus = isInvalidAudioCapture(session, meetingId)
                ? RealtimeStatusCodes.FAILED_AUDIO_CAPTURE
                : RealtimeStatusCodes.NO_TRANSCRIPT;
        completeTerminalRealtimeOutcome(
                session,
                meetingId,
                sessionStillOpen,
                analysisSource,
                authorization,
                terminalStatus,
                "Finalize failed; using controlled terminal status instead of stream error"
        );
    }

    private boolean isIdempotentFinalizeConflict(Exception ex) {
        if (ex instanceof HttpClientErrorException httpEx) {
            return aiServiceClient.isTerminalStreamConflict(httpEx);
        }
        Throwable current = ex;
        while (current != null) {
            if (current instanceof HttpClientErrorException httpEx) {
                return aiServiceClient.isTerminalStreamConflict(httpEx);
            }
            current = current.getCause();
        }
        return false;
    }

    private Map<String, Object> buildNoTranscriptAfterFinalizeStatusEvent(Long meetingId) {
        return buildTerminalRealtimeStatusEvent(
                meetingId,
                RealtimeStatusCodes.NO_TRANSCRIPT,
                "STT session closed with no recognized speech"
        );
    }

    private void persistNoTranscriptAfterFinalize(Long meetingId, String source) {
        persistTerminalRealtimeOutcome(meetingId, source, RealtimeStatusCodes.NO_TRANSCRIPT);
    }

    private String safeText(Object value) {
        if (value == null) {
            return "";
        }
        String text = String.valueOf(value).trim();
        if (text.length() <= 180) {
            return text;
        }
        return text.substring(0, 180);
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
        return buildTranscriptEvent(meetingId, RealtimeStreamAudioState.LEGACY_STREAM_ID, transcript, seq, language, finalEvent);
    }

    private Map<String, Object> buildTranscriptEvent(
            Long meetingId,
            String streamId,
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
        if (RealtimeStreamAudioState.isDualStreamCapable(streamId)) {
            transcriptEvent.put("streamId", streamId);
        }

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

        if (shouldRejectTerminalMeeting(session, expectedMeetingId, null, authorization)) {
            return;
        }

        session.getAttributes().put("userId", userId);
        session.getAttributes().put("username", username);
        session.getAttributes().put("authorization", authorization);
        session.getAttributes().put(AUTHENTICATED_ATTR, true);
        ensureSessionTraceId(session, data);

        String requestedLanguage = getStringValue(data.get("language"));
        String effectiveLanguage = normalizeRealtimeLanguage(requestedLanguage);
        session.getAttributes().put(LANGUAGE_ATTR, effectiveLanguage);
        String requestedSpeakerMode = getStringValue(data.get("speakerMode"));
        String effectiveSpeakerMode = normalizeRealtimeSpeakerMode(requestedSpeakerMode);
        session.getAttributes().put(SPEAKER_MODE_ATTR, effectiveSpeakerMode);
        String requestedDomainMode = getStringValue(data.get("domainMode"));
        if (requestedDomainMode.isBlank()) {
            requestedDomainMode = getStringValue(data.get("domain_mode"));
        }
        String effectiveDomainMode = normalizeDomainMode(requestedDomainMode);
        session.getAttributes().put(DOMAIN_MODE_ATTR, effectiveDomainMode);

        boolean dualStreamRequested = dualStreamTabMicEnabled
                && Boolean.TRUE.equals(getBooleanValue(data.get("dualStream")));
        session.getAttributes().put(RealtimeDualStreamSessionKeys.DUAL_STREAM_ENABLED_ATTR, dualStreamRequested);
        if (dualStreamRequested) {
            session.getAttributes().put(
                    RealtimeDualStreamSessionKeys.ACTIVE_STREAMS_ATTR,
                    parseActiveStreams(data.get("activeStreams"))
            );
            log.info(
                    "REALTIME_DUAL_STREAM_ENABLED meetingId={} userId={} activeStreams={}",
                    expectedMeetingId,
                    userId,
                    RealtimeStreamAudioState.getActiveStreams(session.getAttributes())
            );
        }

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

        Map<String, Object> readyEvent = new HashMap<>();
        readyEvent.put("type", "session.ready");
        readyEvent.put("meetingId", expectedMeetingId);
        readyEvent.put("userId", userId);
        readyEvent.put("authenticated", true);
        readyEvent.put("dualStreamBackendEnabled", dualStreamTabMicEnabled);
        readyEvent.put("activeConnections", realtimeEventSubscriber.getActiveConnectionCount(expectedMeetingId));
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

    private String normalizeDomainMode(String candidateDomainMode) {
        String normalized = normalizeFallbackLanguage(candidateDomainMode);
        if ("general".equals(normalized) || "it".equals(normalized) || "business".equals(normalized) || "education".equals(normalized)) {
            return normalized;
        }
        return "it";
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

    private String resolveSessionTraceId(WebSocketSession session) {
        Object existing = session.getAttributes().get(TraceIdFilter.TRACE_ID_ATTR);
        if (existing instanceof String traceId && !traceId.isBlank()) {
            return traceId;
        }
        String generated = UUID.randomUUID().toString();
        session.getAttributes().put(TraceIdFilter.TRACE_ID_ATTR, generated);
        return generated;
    }

    private void ensureSessionTraceId(WebSocketSession session, Map<String, Object> data) {
        String fromPayload = getStringValue(data.get("traceId"));
        if (fromPayload.isBlank()) {
            fromPayload = getStringValue(data.get("trace_id"));
        }
        if (!fromPayload.isBlank()) {
            session.getAttributes().put(TraceIdFilter.TRACE_ID_ATTR, fromPayload);
            return;
        }
        resolveSessionTraceId(session);
    }

    private boolean isDualStreamSession(WebSocketSession session) {
        return dualStreamTabMicEnabled
                && RealtimeStreamAudioState.isDualStreamSession(session.getAttributes());
    }

    private String dualStreamCapableStreamId(WebSocketSession session, String streamId) {
        if (!isDualStreamSession(session)) {
            return null;
        }
        return RealtimeStreamAudioState.isDualStreamCapable(streamId) ? streamId : null;
    }

    private Map<String, Object> invokeStreamAudioChunk(
            WebSocketSession session,
            Long meetingId,
            String streamId,
            byte[] audioBytes,
            Long lastSeq,
            String language,
            String speakerMode,
            boolean isFinal,
            String authorization) {
        long seq = lastSeq != null ? lastSeq : 0L;
        String capableStreamId = dualStreamCapableStreamId(session, streamId);
        String normalizedSpeakerMode = normalizeRealtimeSpeakerMode(speakerMode);
        if ("multiple".equals(normalizedSpeakerMode)) {
            if (capableStreamId != null) {
                return aiServiceClient.streamAudioChunk(
                        meetingId,
                        capableStreamId,
                        audioBytes,
                        seq,
                        language,
                        normalizedSpeakerMode,
                        isFinal,
                        null,
                        authorization
                );
            }
            return aiServiceClient.streamAudioChunk(
                    meetingId,
                    audioBytes,
                    seq,
                    language,
                    normalizedSpeakerMode,
                    isFinal,
                    null,
                    authorization
            );
        }
        if (capableStreamId != null) {
            return aiServiceClient.streamAudioChunk(
                    meetingId,
                    capableStreamId,
                    audioBytes,
                    seq,
                    language,
                    isFinal,
                    null,
                    authorization
            );
        }
        return aiServiceClient.streamAudioChunk(
                meetingId,
                audioBytes,
                seq,
                language,
                isFinal,
                null,
                authorization
        );
    }

    @SuppressWarnings("unchecked")
    private List<String> parseActiveStreams(Object raw) {
        if (!(raw instanceof List<?> list) || list.isEmpty()) {
            return List.of("tab", "mic");
        }
        return list.stream()
                .map(String::valueOf)
                .map(RealtimeStreamAudioState::normalizeStreamId)
                .filter(RealtimeStreamAudioState::isDualStreamCapable)
                .distinct()
                .toList();
    }

    private void finalizeDualSttStreams(
            WebSocketSession session,
            Long meetingId,
            boolean sessionStillOpen,
            String analysisSource,
            String authorization,
            String language,
            String speakerMode) {
        List<String> activeStreams = RealtimeStreamAudioState.getActiveStreams(session.getAttributes());
        if (activeStreams.isEmpty()) {
            activeStreams = List.of("tab", "mic");
        }
        String normalizedSpeakerMode = normalizeRealtimeSpeakerMode(speakerMode);
        boolean multiple = "multiple".equals(normalizedSpeakerMode);

        for (String streamId : activeStreams) {
            RealtimeStreamAudioState streamState = RealtimeStreamAudioState.stateFor(session.getAttributes(), streamId);
            if (streamState.streamFinalized()) {
                continue;
            }
            try {
                Map<String, Object> transcript = multiple
                        ? aiServiceClient.streamAudioChunk(
                                meetingId,
                                streamId,
                                new byte[0],
                                -1L,
                                language,
                                normalizedSpeakerMode,
                                true,
                                null,
                                authorization
                        )
                        : aiServiceClient.streamAudioChunk(
                                meetingId,
                                streamId,
                                new byte[0],
                                -1L,
                                language,
                                true,
                                null,
                                authorization
                        );
                streamState.setStreamFinalized(true);
                log.info(
                        "REALTIME_DUAL_STREAM_FINALIZED meetingId={} streamId={} hasTranscript={}",
                        meetingId,
                        streamId,
                        transcript != null
                );
            } catch (Exception ex) {
                log.warn(
                        "REALTIME_DUAL_STREAM_FINALIZE_FAILED meetingId={} streamId={} errorCode={}",
                        meetingId,
                        streamId,
                        safeErrorCode(ex)
                );
            }
        }

        recoverTranscriptAfterTerminalFinalize(
                session,
                meetingId,
                sessionStillOpen,
                analysisSource,
                authorization
        );
    }
}
