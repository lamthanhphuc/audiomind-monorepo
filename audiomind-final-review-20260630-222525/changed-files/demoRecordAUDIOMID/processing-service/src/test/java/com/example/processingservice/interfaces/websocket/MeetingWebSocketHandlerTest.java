package com.example.processingservice.interfaces.websocket;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.after;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.lenient;

import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.slf4j.LoggerFactory;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.AudioStreamResetRequiredException;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.client.UserQuotaClient;
import com.example.processingservice.config.Epic2FeatureFlags;
import com.example.processingservice.config.Epic3FeatureFlags;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeAudioEnqueueResult;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeAudioWorkerRegistry;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeFinalizeDeadlineService;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeDualStreamSessionKeys;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeSessionLifecycleState;
import com.example.processingservice.interfaces.websocket.realtime.RealtimeStreamAudioState;
import com.example.processingservice.security.JwtUtil;
import com.example.processingservice.security.MeetingChannelAuthorizer;
import com.example.processingservice.service.JobStateStore;
import com.example.processingservice.services.RealtimeEventSubscriber;
import com.fasterxml.jackson.databind.ObjectMapper;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import io.jsonwebtoken.Claims;

@ExtendWith(MockitoExtension.class)
class MeetingWebSocketHandlerTest {

    @Mock
    private MeetingChannelAuthorizer meetingChannelAuthorizer;

    @Mock
    private RealtimeEventSubscriber realtimeEventSubscriber;

    @Mock
    private AIServiceClient aiServiceClient;

    @Mock
    private MeetingServiceClient meetingServiceClient;

    @Mock
    private JobStateStore jobStateStore;

    @Mock
    private ObjectMapper objectMapper;

    @Mock
    private JwtUtil jwtUtil;

    @Mock
    private Epic2FeatureFlags epic2FeatureFlags;

    @Mock
    private Epic3FeatureFlags epic3FeatureFlags;

    @Mock
    private WebSocketSession session;

    private MeetingWebSocketHandler handler;
    private RealtimePayloadValidator realtimePayloadValidator;
    private Map<String, Object> attributes;
    private RealtimeAudioWorkerRegistry realtimeAudioWorkerRegistry;

    private Map<String, Object> lastCapturedBroadcast(ArgumentCaptor<Map<String, Object>> eventCaptor) {
        List<Map<String, Object>> events = eventCaptor.getAllValues();
        return events.isEmpty() ? null : events.get(events.size() - 1);
    }

    private Map<String, Object> findCapturedBroadcastByType(
            ArgumentCaptor<Map<String, Object>> eventCaptor,
            String type
    ) {
        return eventCaptor.getAllValues().stream()
                .filter(event -> type.equals(event.get("type")))
                .reduce((first, second) -> second)
                .orElse(null);
    }

    private void sendAudioMetadata(Long seq, int size) throws Exception {
        sendAudioMetadata(seq, size, null);
    }

    private void sendAudioMetadata(Long seq, int size, String streamId) throws Exception {
        Map<String, Object> metadata = new HashMap<>();
        metadata.put("type", "audio.chunk");
        metadata.put("seq", seq);
        metadata.put("size", (long) size);
        metadata.put("mime_type", "audio/webm; codecs=opus");
        metadata.put("encoding", "webm-opus");
        if (streamId != null) {
            metadata.put("stream_id", streamId);
        }
        doReturn(metadata).when(objectMapper).readValue(anyString(), any(Class.class));
        handler.handleTextMessage(session, new TextMessage("{}"));
    }

    private void sendBinary(byte[] payload) throws Exception {
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(payload)));
    }

    private byte[] bytes(int size) {
        byte[] payload = new byte[size];
        for (int i = 0; i < size; i++) {
            payload[i] = (byte) (i % 127);
        }
        return payload;
    }

    @BeforeEach
    void setUp() {
        realtimeAudioWorkerRegistry = new RealtimeAudioWorkerRegistry();
        realtimePayloadValidator = new RealtimePayloadValidator();
        lenient().when(epic2FeatureFlags.isRealtimeValidationEnabled()).thenReturn(false);
        lenient().when(epic3FeatureFlags.isTranscriptQualityEnabled()).thenReturn(false);
        handler = new MeetingWebSocketHandler(
                meetingChannelAuthorizer,
                realtimeEventSubscriber,
                aiServiceClient,
                meetingServiceClient,
                jobStateStore,
                objectMapper,
                jwtUtil,
                realtimeAudioWorkerRegistry,
                epic2FeatureFlags,
                epic3FeatureFlags,
                realtimePayloadValidator,
                new RealtimeFinalizeDeadlineService());

        attributes = new HashMap<>();
        lenient().when(session.getAttributes()).thenReturn(attributes);
        lenient().when(session.getId()).thenReturn("ws-session-1");
        ReflectionTestUtils.setField(handler, "realtimeAsyncAudioQueueEnabled", false);
        ReflectionTestUtils.setField(handler, "realtimeAsyncQueueMaxSize", 64);
        ReflectionTestUtils.setField(handler, "realtimeStopDrainTimeoutMs", 5000L);
        ReflectionTestUtils.setField(handler, "realtimeMinAudioBytes", 128);
        ReflectionTestUtils.setField(handler, "realtimeTinyChunkMaxBytes", 128);
        ReflectionTestUtils.setField(handler, "realtimeTinyChunkStreakThreshold", 10);
        lenient().when(jobStateStore.tryStartAnalysis(anyLong(), anyString(), anyString(), anyString()))
                .thenReturn(new JobStateStore.AnalysisTriggerDecision(
                        true,
                        "RUNNING",
                        "started",
                        "lock-token",
                        0,
                        null
                ));
    }

    @Test
    void handleTextMessage_shouldSnapshotSelectedRealtimeLanguageFromAuthInit() throws Exception {
        ReflectionTestUtils.setField(handler, "deepgramLanguage", "multi");

        attributes.put("meetingId", 41L);
        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "auth.init",
                "token", "Bearer raw-token",
                "meetingId", 41L,
                "language", "en"
        ));

        Claims claims = org.mockito.Mockito.mock(Claims.class);
        when(claims.getSubject()).thenReturn("99");
        when(claims.get("username", String.class)).thenReturn("alice");
        when(jwtUtil.parseClaims("raw-token")).thenReturn(claims);
        when(meetingChannelAuthorizer.canJoin(99L, 41L, "Bearer raw-token")).thenReturn(true);
        when(realtimeEventSubscriber.getActiveConnectionCount(41L)).thenReturn(1);
        when(objectMapper.writeValueAsString(any())).thenReturn("{}");
        when(session.isOpen()).thenReturn(true);
        doNothing().when(session).sendMessage(any(TextMessage.class));

        handler.handleTextMessage(session, new TextMessage("{}"));

        assertEquals("en", attributes.get("language"));
        verify(realtimeEventSubscriber).getActiveConnectionCount(41L);
    }

    @Test
    void handleTextMessage_dualStream_shouldAcceptTabAndMicStreamIds() throws Exception {
        ReflectionTestUtils.setField(handler, "dualStreamTabMicEnabled", true);
        attributes.put("meetingId", 501L);
        attributes.put("authenticated", true);
        attributes.put(RealtimeDualStreamSessionKeys.DUAL_STREAM_ENABLED_ATTR, Boolean.TRUE);
        attributes.put(RealtimeDualStreamSessionKeys.ACTIVE_STREAMS_ATTR, List.of("tab", "mic"));

        sendAudioMetadata(1L, 512, "tab");
        assertEquals("tab", attributes.get(RealtimeDualStreamSessionKeys.LAST_AUDIO_STREAM_ID_ATTR));
        assertEquals(1L, attributes.get("lastAudioSeq"));

        sendAudioMetadata(2L, 512, "mic");
        assertEquals("mic", attributes.get(RealtimeDualStreamSessionKeys.LAST_AUDIO_STREAM_ID_ATTR));
        assertEquals(2L, attributes.get("lastAudioSeq"));
    }

    @Test
    void handleTextMessage_dualStream_shouldRejectBlankOrUnknownStreamIdWithoutTerminalFailure() throws Exception {
        ReflectionTestUtils.setField(handler, "dualStreamTabMicEnabled", true);
        attributes.put("meetingId", 502L);
        attributes.put("authenticated", true);
        attributes.put(RealtimeDualStreamSessionKeys.DUAL_STREAM_ENABLED_ATTR, Boolean.TRUE);
        attributes.put(RealtimeDualStreamSessionKeys.ACTIVE_STREAMS_ATTR, List.of("tab", "mic"));

        sendAudioMetadata(1L, 512, "");

        assertNull(attributes.get("lastAudioSeq"));
        assertNull(attributes.get(RealtimeDualStreamSessionKeys.LAST_AUDIO_STREAM_ID_ATTR));
        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber).dispatchMeetingEvent(eq(502L), eventCaptor.capture());
        assertEquals("stream.error", eventCaptor.getValue().get("type"));
        assertEquals("REALTIME_INVALID_STREAM_ID", eventCaptor.getValue().get("errorCode"));
        assertEquals(Boolean.TRUE, eventCaptor.getValue().get("recoverable"));
        verify(jobStateStore, never()).upsertJobState(
                eq(502L),
                eq("FAILED_AUDIO_CAPTURE"),
                anyString(),
                any(),
                any(),
                anyString()
        );
    }

    @Test
    void handleTextMessage_tabOnly_shouldKeepLegacyOmittedStreamIdCompatibility() throws Exception {
        attributes.put("meetingId", 503L);
        attributes.put("authenticated", true);

        sendAudioMetadata(1L, 512);

        assertEquals("", attributes.get(RealtimeDualStreamSessionKeys.LAST_AUDIO_STREAM_ID_ATTR));
        assertEquals(1L, attributes.get("lastAudioSeq"));
        verify(realtimeEventSubscriber, never()).dispatchMeetingEvent(eq(503L), any());
    }

    @Test
    void handleTextMessage_shouldNormalizeInvalidSpeakerModeToSingleFromAuthInit() throws Exception {
        attributes.put("meetingId", 42L);
        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "auth.init",
                "token", "Bearer raw-token",
                "meetingId", 42L,
                "speakerMode", "invalid"
        ));

        Claims claims = org.mockito.Mockito.mock(Claims.class);
        when(claims.getSubject()).thenReturn("99");
        when(claims.get("username", String.class)).thenReturn("alice");
        when(jwtUtil.parseClaims("raw-token")).thenReturn(claims);
        when(meetingChannelAuthorizer.canJoin(99L, 42L, "Bearer raw-token")).thenReturn(true);
        when(realtimeEventSubscriber.getActiveConnectionCount(42L)).thenReturn(1);
        when(objectMapper.writeValueAsString(any())).thenReturn("{}");
        when(session.isOpen()).thenReturn(true);
        doNothing().when(session).sendMessage(any(TextMessage.class));

        handler.handleTextMessage(session, new TextMessage("{}"));

        assertEquals("single", attributes.get("speakerMode"));
        verify(realtimeEventSubscriber).getActiveConnectionCount(42L);
    }

    @Test
    void handleTextMessage_authInitShouldRejectTerminalMeetingBeforeReady() throws Exception {
        attributes.put("meetingId", 420L);
        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "auth.init",
                "token", "Bearer raw-token",
                "meetingId", 420L
        ));

        Claims claims = org.mockito.Mockito.mock(Claims.class);
        when(claims.getSubject()).thenReturn("99");
        when(claims.get("username", String.class)).thenReturn("alice");
        when(jwtUtil.parseClaims("raw-token")).thenReturn(claims);
        when(meetingChannelAuthorizer.canJoin(99L, 420L, "Bearer raw-token")).thenReturn(true);
        when(meetingServiceClient.getMeetingById(420L, null, "Bearer raw-token"))
                .thenReturn(Map.of("id", 420L, "status", "completed"));

        handler.handleTextMessage(session, new TextMessage("{}"));

        assertEquals("completed", attributes.get("TERMINAL_MEETING_STATUS_ATTR"));
        verify(meetingServiceClient).getMeetingById(420L, null, "Bearer raw-token");
        verify(realtimeEventSubscriber).dispatchMeetingEvent(eq(420L), any(Map.class));
        verify(session).close(CloseStatus.POLICY_VIOLATION.withReason("Meeting already finalized"));
        verify(session, never()).sendMessage(any(TextMessage.class));
        verifyNoInteractions(aiServiceClient);
    }

    @Test
    void handleTextMessage_shouldLogEffectiveSpeakerModeOnlyOncePerSessionUntilItChanges() throws Exception {
        attributes.put("meetingId", 43L);
        attributes.put("authenticated", true);
        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(
                Map.of(
                        "type", "audio.chunk",
                        "speakerMode", "multiple",
                        "language", "vi",
                        "seq", 1L,
                        "size", 4L
                ),
                Map.of(
                        "type", "audio.chunk",
                        "speakerMode", "multiple",
                        "language", "vi",
                        "seq", 2L,
                        "size", 4L
                )
        );

        Logger logger = (Logger) LoggerFactory.getLogger(MeetingWebSocketHandler.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);

        try {
            handler.handleTextMessage(session, new TextMessage("{}"));
            handler.handleTextMessage(session, new TextMessage("{}"));
        } finally {
            logger.detachAppender(appender);
        }

        long speakerModeLogCount = appender.list.stream()
                .filter(event -> event.getFormattedMessage().contains("AUDIO_CHUNK_SPEAKER_MODE_EFFECTIVE"))
                .count();
        assertEquals(1L, speakerModeLogCount);
    }

    @Test
    void afterConnectionClosed_shouldFinalizeWhenAudioWasReceivedEvenWithoutAudioSentFlag() throws Exception {
        attributes.put("meetingId", 31L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 31L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);

        when(aiServiceClient.streamAudioChunk(
                eq(31L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "xin chao",
                "is_final", true,
                "language", "vi",
                "confidence", 0.93
        ));

        handler.afterConnectionClosed(session, CloseStatus.NORMAL);

        Map<String, Object> cached = handler.getFinalizedTranscript(31L);
        assertNotNull(cached);
        assertEquals("transcript.final", cached.get("type"));
        assertEquals("meeting-31-temp-31-unknown", cached.get("segmentId"));
        assertEquals(-1L, cached.get("seq"));
        assertEquals("xin chao", cached.get("text"));
        assertEquals(Boolean.TRUE, cached.get("isFinal"));
        assertEquals("vi", cached.get("language"));
        assertEquals("", cached.get("speaker"));
        assertEquals(0.93, cached.get("confidence"));

        verify(aiServiceClient).streamAudioChunk(
                eq(31L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        );
        verify(realtimeEventSubscriber).unregisterSession(31L, session);
    }

    @Test
    void afterConnectionClosed_shouldSkipFinalizeWhenNoAudioWasReceived() throws Exception {
        attributes.put("meetingId", 32L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");

        handler.afterConnectionClosed(session, CloseStatus.NORMAL);

        assertNull(handler.getFinalizedTranscript(32L));
        verifyNoInteractions(aiServiceClient);
        verify(realtimeEventSubscriber).unregisterSession(32L, session);
    }

    @Test
    void finalizedTranscriptCache_shouldEvictOverflowEntries() throws Exception {
        when(aiServiceClient.streamAudioChunk(
                anyLong(),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "done",
                "is_final", true,
                "language", "vi"
        ));

        for (long meetingId = 1L; meetingId <= MeetingWebSocketHandler.MAX_FINALIZED_TRANSCRIPT_CACHE_SIZE + 5L; meetingId++) {
            attributes.clear();
            attributes.put("meetingId", meetingId);
            attributes.put("authenticated", true);
            attributes.put("language", "vi");
            attributes.put("authorization", "Bearer test-token");
            attributes.put("lastAudioSeq", meetingId);
            attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);

            handler.afterConnectionClosed(session, CloseStatus.NORMAL);
        }

        assertTrue(handler.finalizedTranscriptCacheSizeForTesting() <= MeetingWebSocketHandler.MAX_FINALIZED_TRANSCRIPT_CACHE_SIZE);
        assertNull(handler.getFinalizedTranscript(1L));
        assertNotNull(handler.getFinalizedTranscript(MeetingWebSocketHandler.MAX_FINALIZED_TRANSCRIPT_CACHE_SIZE + 5L));
    }

    @Test
    void handleBinaryMessage_shouldBroadcastStatusOnlyForEmptyTranscript() throws Exception {
        attributes.put("meetingId", 33L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 7L);

        when(aiServiceClient.streamAudioChunk(
            eq(33L),
            argThat(bytes -> bytes != null && bytes.length == 3),
            eq(7L),
            eq("vi"),
            eq(false),
            isNull(),
            eq("Bearer test-token")
        )).thenReturn(Map.of(
            "transcript", "",
            "is_final", false,
            "language", "vi"
        ));

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3})));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).streamAudioChunk(
            eq(33L),
            argThat(bytes -> bytes != null && bytes.length == 3),
            eq(7L),
            eq("vi"),
            eq(false),
            isNull(),
            eq("Bearer test-token")
        );
        verify(aiServiceClient, never()).getTranscript(anyLong(), anyString());
        verify(realtimeEventSubscriber).dispatchMeetingEvent(eq(33L), eventCaptor.capture());

        Map<String, Object> event = eventCaptor.getValue();
        assertEquals("stream.status", event.get("type"));
        assertEquals("connected", event.get("state"));
        assertEquals("Đang lắng nghe...", event.get("message"));
        assertEquals(7L, event.get("seq"));
    }

    @Test
    void handleBinaryMessage_shouldForwardMultipleSpeakerModeToAiService() throws Exception {
        attributes.put("meetingId", 35L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("speakerMode", "multiple");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 9L);

        when(aiServiceClient.streamAudioChunk(
            eq(35L),
            argThat(bytes -> bytes != null && bytes.length == 4),
            eq(9L),
            eq("vi"),
            eq("multiple"),
            eq(false),
            isNull(),
            eq("Bearer test-token")
        )).thenReturn(Map.of(
            "transcript", "xin chao",
            "is_final", false,
            "language", "vi"
        ));

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3, 4})));

        verify(aiServiceClient).streamAudioChunk(
            eq(35L),
            argThat(bytes -> bytes != null && bytes.length == 4),
            eq(9L),
            eq("vi"),
            eq("multiple"),
            eq(false),
            isNull(),
            eq("Bearer test-token")
        );
    }

    @Test
    void handleBinaryMessage_shouldBroadcastStableTranscriptSegmentForNonEmptyText() throws Exception {
        attributes.put("meetingId", 34L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 8L);

        when(aiServiceClient.streamAudioChunk(
            eq(34L),
            argThat(bytes -> bytes != null && bytes.length == 4),
            eq(8L),
            eq("vi"),
            eq(false),
            isNull(),
            eq("Bearer test-token")
        )).thenReturn(Map.of(
            "transcript", "seq-8",
            "is_final", false,
            "language", "vi"
        ));

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {4, 5, 6, 7})));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).streamAudioChunk(
            eq(34L),
            argThat(bytes -> bytes != null && bytes.length == 4),
            eq(8L),
            eq("vi"),
            eq(false),
            isNull(),
            eq("Bearer test-token")
        );
        verify(aiServiceClient, never()).getTranscript(anyLong(), anyString());
        verify(realtimeEventSubscriber).dispatchMeetingEvent(eq(34L), eventCaptor.capture());

        Map<String, Object> event = eventCaptor.getValue();
        assertEquals("transcript.partial", event.get("type"));
        assertEquals(34L, event.get("meetingId"));
        assertEquals(8L, event.get("seq"));
        assertEquals("meeting-34-temp-8-unknown", event.get("segmentId"));
        assertEquals("seq-8", event.get("text"));
        assertEquals(Boolean.FALSE, event.get("isFinal"));
        assertEquals("", event.get("speaker"));
    }

    @Test
    void handleBinaryMessage_shouldMarkAudioReceivedBeforeAiServiceReturns() throws Exception {
        attributes.put("meetingId", 342L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 12L);

        when(aiServiceClient.streamAudioChunk(
                eq(342L),
                argThat(bytes -> bytes != null && bytes.length == 4),
                eq(12L),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        )).thenThrow(new RuntimeException("ai still processing"));

        when(aiServiceClient.streamAudioChunk(
                eq(342L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "final transcript",
                "is_final", true,
                "language", "vi"
        ));

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3, 4})));
        handler.afterConnectionClosed(session, CloseStatus.NORMAL);

        assertEquals(Boolean.TRUE, attributes.get("AUDIO_RECEIVED_ATTR"));
        Map<String, Object> cached = handler.getFinalizedTranscript(342L);
        assertNotNull(cached);
        assertEquals("transcript.final", cached.get("type"));
        assertEquals("final transcript", cached.get("text"));
        assertEquals(Boolean.TRUE, cached.get("isFinal"));
        verify(realtimeEventSubscriber).unregisterSession(342L, session);
    }

    @Test
    void handleBinaryMessage_shouldPropagateStableSegmentIdentityAndTimingWhenAvailable() throws Exception {
        attributes.put("meetingId", 340L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 9L);

        when(aiServiceClient.streamAudioChunk(
            eq(340L),
            argThat(bytes -> bytes != null && bytes.length == 4),
            eq(9L),
            eq("vi"),
            eq(false),
            isNull(),
            eq("Bearer test-token")
        )).thenReturn(Map.of(
            "transcript", "Đáng sợ, mọi con quái bạn đối mặt",
            "is_final", true,
            "language", "vi",
            "speaker", "SPEAKER_1",
            "confidence", 0.94,
            "segment_id", "meeting-340-start-1.250",
            "start_time", 1.25,
            "end_time", 3.10
        ));

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {8, 9, 10, 11})));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber).dispatchMeetingEvent(eq(340L), eventCaptor.capture());

        Map<String, Object> event = eventCaptor.getValue();
        assertEquals("transcript.final", event.get("type"));
        assertEquals("meeting-340-start-1.250", event.get("segmentId"));
        assertEquals("SPEAKER_1", event.get("speaker"));
        assertEquals(1.25, event.get("startTime"));
        assertEquals(3.10, event.get("endTime"));
        assertEquals(Boolean.TRUE, event.get("isFinal"));
        assertEquals(0.94, event.get("confidence"));
    }

    @Test
    void handleBinaryMessage_shouldIgnoreChunksAfterFinalizationStarts() throws Exception {
        attributes.put("meetingId", 341L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 10L);
        attributes.put("FINALIZED_ATTR", Boolean.TRUE);

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3, 4})));

        verifyNoInteractions(aiServiceClient);
        verifyNoInteractions(realtimeEventSubscriber);
    }

    @Test
    void handleBinaryMessage_shouldRejectTerminalMeetingBeforeCallingAiService() throws Exception {
        attributes.put("meetingId", 346L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 15L);

        when(meetingServiceClient.getMeetingById(346L, null, "Bearer test-token"))
                .thenReturn(Map.of("id", 346L, "status", "completed"));

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3, 4})));

        verify(meetingServiceClient).getMeetingById(346L, null, "Bearer test-token");
        verifyNoInteractions(aiServiceClient);
        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber).dispatchMeetingEvent(eq(346L), eventCaptor.capture());
        Map<String, Object> event = eventCaptor.getValue();
        assertEquals("stream.error", event.get("type"));
        assertEquals(346L, event.get("meetingId"));
        assertEquals(Boolean.FALSE, event.get("recoverable"));
        assertEquals(Boolean.TRUE, event.get("resetRequired"));
    }

    @Test
    void handleTextMessage_shouldDropStaleSessionMetadataAndNextBinaryBeforeAiService() throws Exception {
        attributes.put("meetingId", 347L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("recordingSessionId", 1L);
        attributes.put("attemptId", 1L);
        attributes.put("MEETING_STATUS_CHECKED_ATTR", Boolean.TRUE);
        attributes.put("lastAudioSeq", 14L);

        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 15L,
                "size", 4L,
                "recording_session_id", 2L,
                "attempt_id", 1L
        ));

        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3, 4})));

        assertNull(attributes.get("lastAudioSeq"));
        verifyNoInteractions(aiServiceClient);
        verifyNoInteractions(realtimeEventSubscriber);
    }

    @Test
    void handleTextMessage_shouldDropMetadataMissingRecordingSessionIdAfterActiveSessionKnown() throws Exception {
        attributes.put("meetingId", 348L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("recordingSessionId", 1L);
        attributes.put("attemptId", 1L);
        attributes.put("MEETING_STATUS_CHECKED_ATTR", Boolean.TRUE);
        attributes.put("lastAudioSeq", 14L);

        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 15L,
                "size", 4L,
                "attempt_id", 1L
        ));

        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3, 4})));

        assertNull(attributes.get("lastAudioSeq"));
        verifyNoInteractions(aiServiceClient);
        verifyNoInteractions(realtimeEventSubscriber);
    }

    @Test
    void handleTextMessage_shouldDropMetadataMissingAttemptIdAfterActiveAttemptKnown() throws Exception {
        attributes.put("meetingId", 349L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("recordingSessionId", 1L);
        attributes.put("attemptId", 1L);
        attributes.put("MEETING_STATUS_CHECKED_ATTR", Boolean.TRUE);
        attributes.put("lastAudioSeq", 14L);

        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 16L,
                "size", 4L,
                "recording_session_id", 1L
        ));

        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3, 4})));

        assertNull(attributes.get("lastAudioSeq"));
        verifyNoInteractions(aiServiceClient);
        verifyNoInteractions(realtimeEventSubscriber);
    }

    @Test
    void handleTextMessage_shouldForwardBinaryWhenActiveSessionMetadataMatches() throws Exception {
        attributes.put("meetingId", 350L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("recordingSessionId", 1L);
        attributes.put("attemptId", 1L);
        attributes.put("MEETING_STATUS_CHECKED_ATTR", Boolean.TRUE);

        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 17L,
                "size", 4L,
                "recording_session_id", 1L,
                "attempt_id", 1L
        ));
        when(aiServiceClient.streamAudioChunk(
                eq(350L),
                argThat(bytes -> bytes != null && bytes.length == 4),
                eq(17L),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "valid session chunk",
                "is_final", false,
                "language", "vi"
        ));

        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3, 4})));

        assertEquals(17L, attributes.get("lastAudioSeq"));
        verify(aiServiceClient).streamAudioChunk(
                eq(350L),
                argThat(bytes -> bytes != null && bytes.length == 4),
                eq(17L),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        );
    }

    @Test
    void handleBinaryMessage_shouldTreatFinalizationReplayAsTerminalNoOp() throws Exception {
        attributes.put("meetingId", 342L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 11L);

        when(aiServiceClient.streamAudioChunk(
            eq(342L),
            argThat(bytes -> bytes != null && bytes.length == 4),
            eq(11L),
            eq("vi"),
            eq(false),
            isNull(),
            eq("Bearer test-token")
        )).thenReturn(null);

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {5, 6, 7, 8})));

        verify(aiServiceClient).streamAudioChunk(
            eq(342L),
            argThat(bytes -> bytes != null && bytes.length == 4),
            eq(11L),
            eq("vi"),
            eq(false),
            isNull(),
            eq("Bearer test-token")
        );
        verifyNoInteractions(realtimeEventSubscriber);
    }

    @Test
    void handleBinaryMessage_shouldBroadcastResetRequiredWhenAiServiceRequestsRecorderReset() throws Exception {
        attributes.put("meetingId", 343L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 12L);

        when(aiServiceClient.streamAudioChunk(
            eq(343L),
            argThat(bytes -> bytes != null && bytes.length == 4),
            eq(12L),
            eq("vi"),
            eq(false),
            isNull(),
            eq("Bearer test-token")
        )).thenThrow(new AudioStreamResetRequiredException(343L, 12L, new RuntimeException("reset")));

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {9, 10, 11, 12})));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber).dispatchMeetingEvent(eq(343L), eventCaptor.capture());

        Map<String, Object> event = eventCaptor.getValue();
        assertEquals("stream.error", event.get("type"));
        assertEquals(Boolean.FALSE, event.get("recoverable"));
        assertEquals(Boolean.TRUE, event.get("resetRequired"));
    }

    @Test
    void handleBinaryMessage_shouldDropFollowingChunksAfterResetRequired() throws Exception {
        attributes.put("meetingId", 344L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 13L);

        when(aiServiceClient.streamAudioChunk(
                eq(344L),
                argThat(bytes -> bytes != null && bytes.length == 4),
                eq(13L),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        )).thenThrow(new AudioStreamResetRequiredException(344L, 13L, new RuntimeException("reset")));

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3, 4})));

        attributes.put("lastAudioSeq", 14L);
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {5, 6, 7, 8})));

        verify(aiServiceClient).streamAudioChunk(
                eq(344L),
                argThat(bytes -> bytes != null && bytes.length == 4),
                eq(13L),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        );
        verifyNoMoreInteractions(aiServiceClient);
    }

    @Test
    void handleTextMessage_streamStop_shouldSkipFinalizeAfterResetRequired() throws Exception {
        attributes.put("meetingId", 345L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);
        attributes.put("RESET_REQUIRED_ATTR", Boolean.TRUE);

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        verify(aiServiceClient, never()).streamAudioChunk(
                eq(345L),
                any(byte[].class),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        );
    }

    @Test
    void handleTextMessage_streamStop_shouldFinalizeImmediately() throws Exception {
        attributes.put("meetingId", 35L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 35L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);

        doReturn(Map.of(
            "type", "stream.stop"
        )).when(objectMapper).readValue(anyString(), any(Class.class));

        when(aiServiceClient.streamAudioChunk(
            eq(35L),
            argThat(bytes -> bytes != null && bytes.length == 0),
            eq(-1L),
            eq("vi"),
            eq(true),
            isNull(),
            eq("Bearer test-token")
        )).thenReturn(Map.of(
            "transcript", "done",
            "is_final", true,
            "language", "vi"
        ));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        verify(aiServiceClient).streamAudioChunk(
            eq(35L),
            argThat(bytes -> bytes != null && bytes.length == 0),
            eq(-1L),
            eq("vi"),
            eq(true),
            isNull(),
            eq("Bearer test-token")
        );
            ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
            verify(realtimeEventSubscriber, atLeastOnce()).dispatchMeetingEvent(eq(35L), eventCaptor.capture());

            Map<String, Object> event = lastCapturedBroadcast(eventCaptor);
            assertEquals("transcript.final", event.get("type"));
            // Phase 4 uses stable string segmentId; stop finalize without timing may use temporary fallback ID.
            assertEquals(35L, event.get("meetingId"));
            assertTrue(event.get("segmentId") instanceof String);
            String segmentId = (String) event.get("segmentId");
            assertTrue(!segmentId.isBlank());
            assertTrue(!"35".equals(segmentId));
            assertTrue(segmentId.startsWith("meeting-35-temp-"));
            assertEquals(-1L, event.get("seq"));
            assertEquals("done", event.get("text"));
             assertEquals(Boolean.TRUE, event.get("isFinal"));
             }

    @Test
    void handleTextMessage_streamStop_shouldTriggerRealtimeAnalysisAsyncAfterFinalize() throws Exception {
        attributes.put("meetingId", 351L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 21L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        when(aiServiceClient.streamAudioChunk(
                eq(351L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "done",
                "is_final", true,
                "language", "vi"
        ));
        when(aiServiceClient.getTranscript(eq(351L), anyString())).thenReturn(Map.of(
                "meeting_id", 351L,
                "transcripts", java.util.List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "final transcript", "start_time", 1.0, "end_time", 2.0)
                )
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(351L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("status", "completed"));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        verify(aiServiceClient, timeout(1000)).getTranscript(eq(351L), anyString());
        verify(aiServiceClient, timeout(1000)).analyzeRealtimeTranscript(
                eq(351L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        );
        verify(jobStateStore, timeout(1000)).markAnalysisCompleted(
                eq(351L),
                anyString(),
                eq("stream_stop"),
                eq("processing_ws_realtime_stop"),
                eq("lock-token")
        );
    }

    @Test
    void handleTextMessage_streamStopShouldRejectTerminalMeetingAfterCachedNonTerminal() throws Exception {
        attributes.put("meetingId", 421L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("MEETING_STATUS_CHECKED_ATTR", Boolean.TRUE);
        attributes.put("lastMeetingStatusCheckAt", System.currentTimeMillis());
        attributes.put("lastAudioSeq", 9L);

        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "stream.stop",
                "meetingId", 421L
        ));
        when(meetingServiceClient.getMeetingById(421L, null, "Bearer test-token"))
                .thenReturn(Map.of("id", 421L, "status", "completed"));

        handler.handleTextMessage(session, new TextMessage("{}"));

        assertEquals("completed", attributes.get("TERMINAL_MEETING_STATUS_ATTR"));
        verify(meetingServiceClient).getMeetingById(421L, null, "Bearer test-token");
        verify(realtimeEventSubscriber).dispatchMeetingEvent(eq(421L), any(Map.class));
        verify(session).close(CloseStatus.POLICY_VIOLATION.withReason("Meeting already finalized"));
        verifyNoInteractions(aiServiceClient);
    }

    @Test
    void handleTextMessage_duplicateStreamStop_shouldNotTriggerRealtimeAnalysisTwice() throws Exception {
        attributes.put("meetingId", 352L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 22L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        when(aiServiceClient.streamAudioChunk(
                eq(352L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "done",
                "is_final", true,
                "language", "vi"
        ));
        when(aiServiceClient.getTranscript(eq(352L), anyString())).thenReturn(Map.of(
                "meeting_id", 352L,
                "transcripts", java.util.List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "final transcript", "start_time", 1.0, "end_time", 2.0)
                )
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(352L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("status", "completed"));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));
        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        verify(aiServiceClient, timeout(1000).times(1)).analyzeRealtimeTranscript(
                eq(352L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        );
        verify(aiServiceClient, times(1)).streamAudioChunk(
                eq(352L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        );
    }

    @Test
    void handleTextMessage_streamStop_shouldEmitStructuredFinalizeLogs() throws Exception {
        attributes.put("meetingId", 360L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 17L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        when(aiServiceClient.streamAudioChunk(
                eq(360L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "final transcript",
                "is_final", true,
                "language", "vi",
                "transcripts", java.util.List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "final transcript", "start_time", 1.0, "end_time", 2.0)
                )
        ));

        Logger logger = (Logger) LoggerFactory.getLogger(MeetingWebSocketHandler.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);

        try {
            handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));
        } finally {
            logger.detachAppender(appender);
        }

        assertTrue(appender.list.stream().anyMatch(logEvent ->
                logEvent.getFormattedMessage().contains("event=REALTIME_STOP_FINALIZE_AFTER_DRAIN")
                        && logEvent.getFormattedMessage().contains("meetingId=360")
                        && logEvent.getFormattedMessage().contains("lastClientSeq=17")
                        && logEvent.getFormattedMessage().contains("drainedSeq=17")
        ));
        assertTrue(appender.list.stream().anyMatch(logEvent ->
                logEvent.getFormattedMessage().contains("event=REALTIME_FINALIZE_COMPLETE")
                        && logEvent.getFormattedMessage().contains("meetingId=360")
                        && logEvent.getFormattedMessage().contains("finalizeSeq=17")
                        && logEvent.getFormattedMessage().contains("transcriptRows=1")
                        && logEvent.getFormattedMessage().contains("finalAudioBytes=0")
        ));
    }

    @Test
    void handleTextMessage_duplicateStreamStop_shouldLogDuplicateIgnored() throws Exception {
        attributes.put("meetingId", 361L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 22L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);
        attributes.put("FINALIZED_ATTR", Boolean.TRUE);

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));

        Logger logger = (Logger) LoggerFactory.getLogger(MeetingWebSocketHandler.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);

        try {
            handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));
        } finally {
            logger.detachAppender(appender);
        }

        assertTrue(appender.list.stream().anyMatch(logEvent ->
                logEvent.getFormattedMessage().contains("event=REALTIME_STOP_DUPLICATE_IGNORED")
                        && logEvent.getFormattedMessage().contains("meetingId=361")
                        && logEvent.getFormattedMessage().contains("finalizedSeq=22")
        ));
        verifyNoInteractions(aiServiceClient);
    }

    @Test
    void handleTextMessage_streamStop_shouldNotMarkCompletedWhenRealtimeAnalysisSkippedInProgress() throws Exception {
        attributes.put("meetingId", 354L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 23L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        when(aiServiceClient.streamAudioChunk(
                eq(354L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "done",
                "is_final", true,
                "language", "vi"
        ));
        when(aiServiceClient.getTranscript(eq(354L), anyString())).thenReturn(Map.of(
                "meeting_id", 354L,
                "transcripts", java.util.List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "final transcript")
                )
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(354L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "status", "skipped",
                "reason", "in_progress",
                "retryAfterSeconds", 25
        ));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        verify(jobStateStore, timeout(1000)).markAnalysisSkipped(
                eq(354L),
                anyString(),
                eq("stream_stop"),
                eq("processing_ws_realtime_stop"),
                eq("lock-token"),
                eq("in_progress"),
                eq(25)
        );
        verify(jobStateStore, never()).markAnalysisCompleted(
                eq(354L),
                anyString(),
                eq("stream_stop"),
                eq("processing_ws_realtime_stop"),
                eq("lock-token")
        );
    }

    @Test
    void handleTextMessage_streamStop_shouldBroadcastNoSpeechStatusForEmptyFinalTranscript() throws Exception {
        attributes.put("meetingId", 36L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 36L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);

        doReturn(Map.of(
            "type", "stream.stop"
        )).when(objectMapper).readValue(anyString(), any(Class.class));

        when(aiServiceClient.streamAudioChunk(
            eq(36L),
            argThat(bytes -> bytes != null && bytes.length == 0),
            eq(-1L),
            eq("vi"),
            eq(true),
            isNull(),
            eq("Bearer test-token")
        )).thenReturn(Map.of(
            "transcript", "",
            "is_final", true,
            "language", "vi"
        ));

        Logger logger = (Logger) LoggerFactory.getLogger(MeetingWebSocketHandler.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);

        try {
            handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));
        } finally {
            logger.detachAppender(appender);
        }

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber, atLeastOnce()).dispatchMeetingEvent(eq(36L), eventCaptor.capture());

        Map<String, Object> event = lastCapturedBroadcast(eventCaptor);
        assertEquals("stream.status", event.get("type"));
        assertEquals("NO_TRANSCRIPT", event.get("state"));
        assertEquals("NO_TRANSCRIPT", event.get("status"));
        assertEquals("NO_TRANSCRIPT", event.get("errorCode"));
        assertEquals("NO_TRANSCRIPT_AFTER_FINALIZE", event.get("legacyErrorCode"));
        assertEquals("NO_ANALYSIS", event.get("analysisStatus"));
        assertEquals(0, event.get("transcriptRows"));
        assertEquals(Boolean.TRUE, event.get("finalized"));
        assertEquals(36L, event.get("meetingId"));
        verify(jobStateStore).upsertJobState(
                eq(36L),
                eq("NO_TRANSCRIPT_AFTER_FINALIZE"),
                eq("realtime-meeting:36"),
                argThat(result ->
                        result != null
                                && result.get("transcripts") instanceof java.util.List<?> transcripts
                                && transcripts.isEmpty()
                                && Integer.valueOf(0).equals(result.get("transcriptRows"))
                                && Boolean.TRUE.equals(result.get("finalized"))
                                && "NO_ANALYSIS".equals(result.get("analysisStatus"))
                ),
                isNull(),
                anyString()
        );
        assertTrue(appender.list.stream().anyMatch(logEvent ->
                logEvent.getFormattedMessage().contains("REALTIME_ANALYSIS_SKIPPED reason=no_transcript")
        ));
        verify(aiServiceClient, never()).getTranscript(eq(36L), anyString());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void handleTextMessage_streamStop_shouldSkipUntimedDuplicateTempFinalWhenTimedSegmentAlreadyExists() throws Exception {
        attributes.put("meetingId", 112L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 35L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);

        when(aiServiceClient.streamAudioChunk(
                eq(112L),
                any(byte[].class),
                eq(35L),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "xin chao moi nguoi",
                "is_final", true,
                "language", "vi",
                "start_time", 30.95,
                "end_time", 35.46
        ));

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3})));

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        when(aiServiceClient.streamAudioChunk(
                eq(112L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "xin chao moi nguoi",
                "is_final", true,
                "language", "vi"
        ));
        when(aiServiceClient.getTranscript(eq(112L), anyString())).thenReturn(Map.of(
                "meeting_id", 112L,
                "transcripts", java.util.List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "xin chao moi nguoi")
                )
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(112L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("status", "completed"));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber, atLeastOnce()).dispatchMeetingEvent(eq(112L), eventCaptor.capture());
        Map<String, Object> event = findCapturedBroadcastByType(eventCaptor, "transcript.final");
        assertNotNull(event);
        assertEquals("meeting-112-start-30.950-unknown", event.get("segmentId"));
        assertEquals(35L, event.get("seq"));
        verify(aiServiceClient, timeout(1000)).analyzeRealtimeTranscript(
                eq(112L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        );
    }

    @Test
    void handleTextMessage_streamStop_shouldPreserveFinalSegmentWhenFinalizeIncludesTiming() throws Exception {
        attributes.put("meetingId", 113L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 40L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        when(aiServiceClient.streamAudioChunk(
                eq(113L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "final with timing",
                "is_final", true,
                "language", "vi",
                "start_time", 30.95,
                "end_time", 35.46,
                "speaker", "SPEAKER_1"
        ));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber, atLeastOnce()).dispatchMeetingEvent(eq(113L), eventCaptor.capture());
        Map<String, Object> event = lastCapturedBroadcast(eventCaptor);
        assertEquals("transcript.final", event.get("type"));
        assertEquals(-1L, event.get("seq"));
        assertEquals("meeting-113-start-30.950-speaker_1", event.get("segmentId"));
        assertEquals(30.95, event.get("startTime"));
        assertEquals(35.46, event.get("endTime"));
    }

    @Test
    void afterConnectionClosed_shouldTriggerRealtimeAnalysisWhenFinalizedWithoutStreamStop() throws Exception {
        attributes.put("meetingId", 353L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 30L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);

        when(aiServiceClient.streamAudioChunk(
                eq(353L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "done after close",
                "is_final", true,
                "language", "vi"
        ));
        when(aiServiceClient.getTranscript(eq(353L), anyString())).thenReturn(Map.of(
                "meeting_id", 353L,
                "transcripts", java.util.List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "done after close")
                )
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(353L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("status", "completed"));

        handler.afterConnectionClosed(session, CloseStatus.NORMAL);

        verify(aiServiceClient, timeout(1000)).analyzeRealtimeTranscript(
                eq(353L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        );
        verify(realtimeEventSubscriber).unregisterSession(353L, session);
    }

    @Test
    void handleBinaryMessage_asyncEnabled_returnsBeforeSlowAiCompletes() throws Exception {
        ReflectionTestUtils.setField(handler, "realtimeAsyncAudioQueueEnabled", true);
        attributes.put("meetingId", 901L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("recordingSessionId", 1L);
        attributes.put("attemptId", 1L);
        attributes.put("MEETING_STATUS_CHECKED_ATTR", Boolean.TRUE);

        CountDownLatch aiStarted = new CountDownLatch(1);
        CountDownLatch allowAiComplete = new CountDownLatch(1);
        when(aiServiceClient.streamAudioChunk(
                eq(901L),
                any(byte[].class),
                eq(1L),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        )).thenAnswer(invocation -> {
            aiStarted.countDown();
            allowAiComplete.await(5, TimeUnit.SECONDS);
            return Map.of("transcript", "async chunk", "is_final", false, "language", "vi");
        });
        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 1L,
                "size", 4L,
                "recording_session_id", 1L,
                "attempt_id", 1L
        ));

        long startedAt = System.currentTimeMillis();
        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3, 4})));
        long elapsedMs = System.currentTimeMillis() - startedAt;

        assertTrue(elapsedMs < 750L, "WS thread should return before slow AI completes");
        assertTrue(aiStarted.await(3, TimeUnit.SECONDS));
        allowAiComplete.countDown();
        verify(aiServiceClient, timeout(3000)).streamAudioChunk(
                eq(901L),
                any(byte[].class),
                eq(1L),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        );
    }

    @Test
    void handleBinaryMessage_asyncEnabled_preservesSeqOrder() throws Exception {
        ReflectionTestUtils.setField(handler, "realtimeAsyncAudioQueueEnabled", true);
        attributes.put("meetingId", 902L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("recordingSessionId", 1L);
        attributes.put("attemptId", 1L);
        attributes.put("MEETING_STATUS_CHECKED_ATTR", Boolean.TRUE);

        List<Long> seqOrder = Collections.synchronizedList(new ArrayList<>());
        when(aiServiceClient.streamAudioChunk(
                eq(902L),
                any(byte[].class),
                anyLong(),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        )).thenAnswer(invocation -> {
            seqOrder.add(invocation.getArgument(2));
            return Map.of(
                    "transcript", "chunk-" + invocation.getArgument(2),
                    "is_final", false,
                    "language", "vi"
            );
        });

        for (long seq = 1L; seq <= 3L; seq++) {
            when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                    "type", "audio.chunk",
                    "seq", seq,
                    "size", 2L,
                    "recording_session_id", 1L,
                    "attempt_id", 1L
            ));
            handler.handleTextMessage(session, new TextMessage("{}"));
            handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2})));
        }

        verify(aiServiceClient, timeout(5000).times(3)).streamAudioChunk(
                eq(902L),
                any(byte[].class),
                anyLong(),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        );
        assertEquals(List.of(1L, 2L, 3L), seqOrder);
    }

    @Test
    void handleTextMessage_streamStop_asyncEnabled_drainsQueueBeforeFinalize() throws Exception {
        ReflectionTestUtils.setField(handler, "realtimeAsyncAudioQueueEnabled", true);
        attributes.put("meetingId", 903L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("recordingSessionId", 1L);
        attributes.put("attemptId", 1L);
        attributes.put("MEETING_STATUS_CHECKED_ATTR", Boolean.TRUE);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);
        attributes.put("lastAudioSeq", 2L);

        CountDownLatch firstChunkStarted = new CountDownLatch(1);
        CountDownLatch allowFirstChunk = new CountDownLatch(1);
        when(aiServiceClient.streamAudioChunk(
                eq(903L),
                argThat(bytes -> bytes != null && bytes.length == 2),
                anyLong(),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        )).thenAnswer(invocation -> {
            firstChunkStarted.countDown();
            allowFirstChunk.await(5, TimeUnit.SECONDS);
            return Map.of("transcript", "queued", "is_final", false, "language", "vi");
        });
        when(aiServiceClient.streamAudioChunk(
                eq(903L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("transcript", "done", "is_final", true, "language", "vi"));
        when(objectMapper.readValue(any(String.class), eq(Map.class)))
                .thenReturn(Map.of(
                        "type", "audio.chunk",
                        "seq", 1L,
                        "size", 2L,
                        "recording_session_id", 1L,
                        "attempt_id", 1L
                ))
                .thenReturn(Map.of(
                        "type", "audio.chunk",
                        "seq", 2L,
                        "size", 2L,
                        "recording_session_id", 1L,
                        "attempt_id", 1L
                ))
                .thenReturn(Map.of("type", "stream.stop"));

        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2})));
        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {3, 4})));

        CountDownLatch stopStarted = new CountDownLatch(1);
        Thread stopThread = new Thread(() -> {
            try {
                stopStarted.countDown();
                handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));
            } catch (Exception ex) {
                throw new RuntimeException(ex);
            }
        });
        stopThread.start();
        assertTrue(stopStarted.await(3, TimeUnit.SECONDS));
        allowFirstChunk.countDown();

        verify(aiServiceClient, timeout(5000).times(2)).streamAudioChunk(
                eq(903L),
                argThat(bytes -> bytes != null && bytes.length == 2),
                anyLong(),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        );
        verify(aiServiceClient, timeout(5000)).streamAudioChunk(
                eq(903L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        );
        stopThread.join(5000);
        assertFalse(realtimeAudioWorkerRegistry.contains("ws-session-1"));
    }

    @Test
    void streamStopAndAfterConnectionClosed_asyncEnabled_finalizeAtMostOnce() throws Exception {
        ReflectionTestUtils.setField(handler, "realtimeAsyncAudioQueueEnabled", true);
        attributes.put("meetingId", 904L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);
        attributes.put("lastAudioSeq", 5L);

        AtomicInteger finalizeCalls = new AtomicInteger(0);
        when(aiServiceClient.streamAudioChunk(
                eq(904L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenAnswer(invocation -> {
            finalizeCalls.incrementAndGet();
            return Map.of("transcript", "done", "is_final", true, "language", "vi");
        });
        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));
        handler.afterConnectionClosed(session, CloseStatus.NORMAL);

        verify(aiServiceClient, timeout(3000).times(1)).streamAudioChunk(
                eq(904L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        );
        assertEquals(1, finalizeCalls.get());
        assertFalse(realtimeAudioWorkerRegistry.contains("ws-session-1"));
    }

    @Test
    void streamStopAndAfterConnectionClosed_asyncEnabled_concurrentFinalizeAtMostOnce() throws Exception {
        ReflectionTestUtils.setField(handler, "realtimeAsyncAudioQueueEnabled", true);
        attributes.put("meetingId", 908L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("recordingSessionId", 1L);
        attributes.put("attemptId", 1L);
        attributes.put("MEETING_STATUS_CHECKED_ATTR", Boolean.TRUE);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);
        attributes.put("lastAudioSeq", 1L);

        when(aiServiceClient.streamAudioChunk(
                eq(908L),
                argThat(bytes -> bytes != null && bytes.length == 2),
                eq(1L),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("transcript", "chunk", "is_final", false, "language", "vi"));

        CountDownLatch finalizeStarted = new CountDownLatch(1);
        CountDownLatch allowFinalizeComplete = new CountDownLatch(1);
        AtomicInteger finalizeCalls = new AtomicInteger(0);
        when(aiServiceClient.streamAudioChunk(
                eq(908L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenAnswer(invocation -> {
            finalizeCalls.incrementAndGet();
            finalizeStarted.countDown();
            allowFinalizeComplete.await(5, TimeUnit.SECONDS);
            return Map.of("transcript", "done", "is_final", true, "language", "vi");
        });
        when(objectMapper.readValue(any(String.class), eq(Map.class)))
                .thenReturn(Map.of(
                        "type", "audio.chunk",
                        "seq", 1L,
                        "size", 2L,
                        "recording_session_id", 1L,
                        "attempt_id", 1L
                ))
                .thenReturn(Map.of("type", "stream.stop"));

        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2})));
        assertTrue(realtimeAudioWorkerRegistry.contains("ws-session-1"));

        CountDownLatch bothReady = new CountDownLatch(2);
        CountDownLatch releaseBoth = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            executor.submit(() -> {
                try {
                    bothReady.countDown();
                    releaseBoth.await(5, TimeUnit.SECONDS);
                    handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));
                } catch (Exception ex) {
                    throw new RuntimeException(ex);
                }
            });
            executor.submit(() -> {
                try {
                    bothReady.countDown();
                    releaseBoth.await(5, TimeUnit.SECONDS);
                    handler.afterConnectionClosed(session, CloseStatus.NORMAL);
                } catch (Exception ex) {
                    throw new RuntimeException(ex);
                }
            });

            assertTrue(bothReady.await(3, TimeUnit.SECONDS));
            releaseBoth.countDown();
            assertTrue(finalizeStarted.await(5, TimeUnit.SECONDS));
            allowFinalizeComplete.countDown();
            executor.shutdown();
            assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS));
        } finally {
            executor.shutdownNow();
        }

        verify(aiServiceClient, timeout(5000).times(1)).streamAudioChunk(
                eq(908L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        );
        assertEquals(1, finalizeCalls.get());
        assertFalse(realtimeAudioWorkerRegistry.contains("ws-session-1"));
    }

    @Test
    void handleBinaryMessage_asyncEnabled_queueFull_emitsStreamErrorAndStopsAccepting() throws Exception {
        ReflectionTestUtils.setField(handler, "realtimeAsyncAudioQueueEnabled", true);
        ReflectionTestUtils.setField(handler, "realtimeAsyncQueueMaxSize", 1);
        attributes.put("meetingId", 905L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("recordingSessionId", 1L);
        attributes.put("attemptId", 1L);
        attributes.put("MEETING_STATUS_CHECKED_ATTR", Boolean.TRUE);

        CountDownLatch firstChunkStarted = new CountDownLatch(1);
        CountDownLatch allowFirstChunk = new CountDownLatch(1);
        when(aiServiceClient.streamAudioChunk(
                eq(905L),
                any(byte[].class),
                anyLong(),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        )).thenAnswer(invocation -> {
            firstChunkStarted.countDown();
            allowFirstChunk.await(5, TimeUnit.SECONDS);
            return Map.of("transcript", "queued", "is_final", false, "language", "vi");
        });
        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 1L,
                "size", 2L,
                "recording_session_id", 1L,
                "attempt_id", 1L
        ));

        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2})));
        assertTrue(firstChunkStarted.await(3, TimeUnit.SECONDS));

        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 2L,
                "size", 2L,
                "recording_session_id", 1L,
                "attempt_id", 1L
        ));
        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {3, 4})));

        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 3L,
                "size", 2L,
                "recording_session_id", 1L,
                "attempt_id", 1L
        ));
        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {5, 6})));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber, timeout(3000)).dispatchMeetingEvent(eq(905L), eventCaptor.capture());
        Map<String, Object> errorEvent = eventCaptor.getValue();
        assertEquals("stream.error", errorEvent.get("type"));
        assertEquals(Boolean.FALSE, errorEvent.get("recoverable"));
        assertEquals(Boolean.TRUE, errorEvent.get("resetRequired"));
        verify(session, timeout(3000)).close(new CloseStatus(1013, "backpressure"));
        assertFalse(realtimeAudioWorkerRegistry.contains("ws-session-1"));

        allowFirstChunk.countDown();
    }

    @Test
    void handleBinaryMessage_asyncEnabled_staleMetadataNeverEnqueued() throws Exception {
        ReflectionTestUtils.setField(handler, "realtimeAsyncAudioQueueEnabled", true);
        attributes.put("meetingId", 906L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("recordingSessionId", 1L);
        attributes.put("attemptId", 1L);
        attributes.put("MEETING_STATUS_CHECKED_ATTR", Boolean.TRUE);
        attributes.put("lastAudioSeq", 14L);

        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 15L,
                "size", 4L,
                "attempt_id", 1L
        ));

        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2, 3, 4})));

        assertNull(attributes.get("lastAudioSeq"));
        verifyNoInteractions(aiServiceClient);
        assertFalse(realtimeAudioWorkerRegistry.contains("ws-session-1"));
    }

    @Test
    void afterConnectionClosed_asyncEnabled_cleansWorkerRegistry() throws Exception {
        ReflectionTestUtils.setField(handler, "realtimeAsyncAudioQueueEnabled", true);
        attributes.put("meetingId", 907L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("recordingSessionId", 1L);
        attributes.put("attemptId", 1L);
        attributes.put("MEETING_STATUS_CHECKED_ATTR", Boolean.TRUE);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);
        attributes.put("lastAudioSeq", 1L);

        lenient().when(aiServiceClient.streamAudioChunk(
                eq(907L),
                any(byte[].class),
                anyLong(),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("transcript", "chunk", "is_final", false, "language", "vi"));
        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 1L,
                "size", 2L,
                "recording_session_id", 1L,
                "attempt_id", 1L
        ));

        handler.handleTextMessage(session, new TextMessage("{}"));
        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[] {1, 2})));
        assertTrue(realtimeAudioWorkerRegistry.contains("ws-session-1"));

        lenient().when(aiServiceClient.streamAudioChunk(
                eq(907L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("transcript", "done", "is_final", true, "language", "vi"));

        handler.afterConnectionClosed(session, CloseStatus.NORMAL);

        verify(aiServiceClient, timeout(5000)).streamAudioChunk(
                eq(907L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        );
        assertFalse(realtimeAudioWorkerRegistry.contains("ws-session-1"));
    }

    @Test
    void handleTextMessage_streamStop_shouldKeepTranscriptSuccessWhenAnalysisCircuitOpen() throws Exception {
        attributes.put("meetingId", 114L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 35L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        when(aiServiceClient.streamAudioChunk(
                eq(114L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of(
                "transcript", "transcript saved line",
                "is_final", true,
                "language", "vi"
        ));
        when(aiServiceClient.getTranscript(eq(114L), anyString())).thenReturn(Map.of(
                "meeting_id", 114L,
                "transcripts", List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "transcript saved line")
                )
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(114L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        )).thenThrow(io.github.resilience4j.circuitbreaker.CallNotPermittedException.createCallNotPermittedException(
                io.github.resilience4j.circuitbreaker.CircuitBreaker.ofDefaults("ai-service")
        ));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber, atLeastOnce()).dispatchMeetingEvent(eq(114L), eventCaptor.capture());
        assertEquals("transcript.final", lastCapturedBroadcast(eventCaptor).get("type"));

        verify(jobStateStore, timeout(1000)).markAnalysisFailed(
                eq(114L),
                anyString(),
                eq("stream_stop"),
                eq("processing_ws_realtime_stop"),
                anyString(),
                eq(com.example.processingservice.service.AnalysisFailureMapping.ERROR_CODE_CIRCUIT_OPEN),
                anyString(),
                eq(com.example.processingservice.service.AnalysisFailureMapping.DEFAULT_CIRCUIT_OPEN_RETRY_AFTER_SECONDS)
        );
        verify(meetingServiceClient, never()).updateMeetingStatus(eq(114L), eq("failed"), anyString(), anyString());
    }

    @Test
    void handleTextMessage_streamStop_withoutAudio_shouldMarkFailedAudioCapture() throws Exception {
        attributes.put("meetingId", 401L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber, timeout(1000).times(2)).dispatchMeetingEvent(eq(401L), eventCaptor.capture());
        Map<String, Object> terminalEvent = eventCaptor.getAllValues().get(1);
        assertEquals("FAILED_AUDIO_CAPTURE", terminalEvent.get("status"));
        verify(jobStateStore, timeout(1000)).upsertJobState(
                eq(401L),
                eq("FAILED_AUDIO_CAPTURE"),
                eq("realtime-meeting:401"),
                any(),
                isNull(),
                anyString()
        );
        verify(meetingServiceClient, timeout(1000)).updateMeetingStatus(eq(401L), eq("failed"), anyString(), eq("Bearer test-token"));
        verify(aiServiceClient, never()).streamAudioChunk(anyLong(), any(), anyLong(), anyString(), eq(true), any(), anyString());
    }

    @Test
    void handleTextMessage_streamStop_withoutAudio_butPersistedTranscript_shouldRecoverAndTriggerAnalysis() throws Exception {
        attributes.put("meetingId", 411L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        when(aiServiceClient.getTranscript(eq(411L), anyString())).thenReturn(Map.of(
                "meeting_id", 411L,
                "transcripts", List.of(Map.of("speaker", "SPEAKER_1", "text", "persisted transcript"))
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(411L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("status", "COMPLETED"));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        verify(aiServiceClient, never()).streamAudioChunk(anyLong(), any(), anyLong(), anyString(), eq(true), any(), anyString());
        verify(aiServiceClient, timeout(1000)).analyzeRealtimeTranscript(
                eq(411L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        );
        verify(meetingServiceClient, never()).updateMeetingStatus(eq(411L), eq("failed"), anyString(), anyString());
        verify(meetingServiceClient, timeout(1000)).updateMeetingStatus(eq(411L), eq("completed"), anyString(), eq("Bearer test-token"));
        verify(jobStateStore, never()).upsertJobState(
                eq(411L),
                eq("FAILED_AUDIO_CAPTURE"),
                anyString(),
                any(),
                any(),
                anyString()
        );
    }

    @Test
    void handleTextMessage_streamStop_withoutAudio_shouldScheduleRecoveryWithoutBlockingCallerOrDuplicating() throws Exception {
        ReflectionTestUtils.setField(handler, "realtimeFinalizeRecoveryTimeoutMs", 5000L);
        attributes.put("meetingId", 417L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");

        CountDownLatch getTranscriptStarted = new CountDownLatch(1);
        CountDownLatch releaseGetTranscript = new CountDownLatch(1);
        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        when(aiServiceClient.getTranscript(eq(417L), anyString())).thenAnswer(invocation -> {
            getTranscriptStarted.countDown();
            assertTrue(releaseGetTranscript.await(2, TimeUnit.SECONDS));
            return Map.of(
                    "meeting_id", 417L,
                    "transcripts", List.of(Map.of("speaker", "SPEAKER_1", "text", "persisted transcript"))
            );
        });
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(417L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("status", "COMPLETED"));

        Assertions.assertTimeoutPreemptively(Duration.ofMillis(300), () ->
                handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"))
        );
        assertTrue(getTranscriptStarted.await(1, TimeUnit.SECONDS));

        Assertions.assertTimeoutPreemptively(Duration.ofMillis(300), () ->
                handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"))
        );
        releaseGetTranscript.countDown();

        verify(aiServiceClient, timeout(1000).times(1)).getTranscript(eq(417L), anyString());
        verify(aiServiceClient, timeout(1000).times(1)).analyzeRealtimeTranscript(
                eq(417L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        );
        verify(meetingServiceClient, timeout(1000).times(1))
                .updateMeetingStatus(eq(417L), eq("completed"), anyString(), eq("Bearer test-token"));
        verify(meetingServiceClient, after(300).never())
                .updateMeetingStatus(eq(417L), eq("failed"), anyString(), anyString());
    }

    @Test
    void handleTextMessage_streamStop_twoBlockedRecoveries_shouldTimeoutWithoutSchedulerStarvation() throws Exception {
        ReflectionTestUtils.setField(handler, "realtimeFinalizeRecoveryTimeoutMs", 200L);
        WebSocketSession firstSession = org.mockito.Mockito.mock(WebSocketSession.class);
        WebSocketSession secondSession = org.mockito.Mockito.mock(WebSocketSession.class);
        Map<String, Object> firstAttributes = new HashMap<>();
        Map<String, Object> secondAttributes = new HashMap<>();
        firstAttributes.put("meetingId", 418L);
        firstAttributes.put("authenticated", true);
        firstAttributes.put("authorization", "Bearer test-token");
        secondAttributes.put("meetingId", 419L);
        secondAttributes.put("authenticated", true);
        secondAttributes.put("authorization", "Bearer test-token");
        when(firstSession.getAttributes()).thenReturn(firstAttributes);
        when(secondSession.getAttributes()).thenReturn(secondAttributes);
        when(firstSession.getId()).thenReturn("ws-session-418");
        when(secondSession.getId()).thenReturn("ws-session-419");
        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));

        CountDownLatch bothFetchesStarted = new CountDownLatch(2);
        CountDownLatch releaseFetches = new CountDownLatch(1);
        when(aiServiceClient.getTranscript(argThat(id -> id == 418L || id == 419L), anyString()))
                .thenAnswer(invocation -> {
                    bothFetchesStarted.countDown();
                    assertTrue(releaseFetches.await(2, TimeUnit.SECONDS));
                    return Map.of(
                            "meeting_id", invocation.getArgument(0),
                            "transcripts", List.of(Map.of("speaker", "SPEAKER_1", "text", "late transcript"))
                    );
                });

        Assertions.assertTimeoutPreemptively(Duration.ofMillis(300), () -> {
            handler.handleTextMessage(firstSession, new TextMessage("{\"type\":\"stream.stop\"}"));
            handler.handleTextMessage(secondSession, new TextMessage("{\"type\":\"stream.stop\"}"));
        });
        assertTrue(bothFetchesStarted.await(1, TimeUnit.SECONDS));

        verify(meetingServiceClient, timeout(1000)).updateMeetingStatus(eq(418L), eq("failed"), anyString(), eq("Bearer test-token"));
        verify(meetingServiceClient, timeout(1000)).updateMeetingStatus(eq(419L), eq("failed"), anyString(), eq("Bearer test-token"));

        releaseFetches.countDown();
        verify(aiServiceClient, after(300).never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
        verify(meetingServiceClient, after(300).never())
                .updateMeetingStatus(anyLong(), eq("completed"), anyString(), anyString());
    }

    @Test
    void handleTextMessage_streamStop_withoutAudio_blankRecoveredTranscript_shouldKeepFailedAudioCapture() throws Exception {
        attributes.put("meetingId", 412L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        when(aiServiceClient.getTranscript(eq(412L), anyString())).thenReturn(Map.of(
                "meeting_id", 412L,
                "transcripts", List.of(Map.of("speaker", "SPEAKER_1", "text", "   "))
        ));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber, timeout(1000).times(2)).dispatchMeetingEvent(eq(412L), eventCaptor.capture());
        assertEquals("FAILED_AUDIO_CAPTURE", eventCaptor.getAllValues().get(1).get("status"));
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
        verify(meetingServiceClient, timeout(1000)).updateMeetingStatus(eq(412L), eq("failed"), anyString(), eq("Bearer test-token"));
    }

    @Test
    void handleBinaryMessage_validationEnabled_rejectsLargeInvalidBinaryWithoutAcceptedAudioState() throws Exception {
        when(epic2FeatureFlags.isRealtimeValidationEnabled()).thenReturn(true);
        attributes.put("meetingId", 416L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");

        sendAudioMetadata(1L, 100);
        sendBinary(bytes((int) RealtimePayloadValidator.MAX_CHUNK_BYTES + 1));

        assertNull(attributes.get("AUDIO_RECEIVED_ATTR"));
        assertNull(attributes.get("validAudioReceived"));
        verify(aiServiceClient, never()).streamAudioChunk(
                anyLong(),
                any(byte[].class),
                anyLong(),
                anyString(),
                anyBoolean(),
                any(),
                anyString()
        );
    }

    @Test
    void handleTextMessage_streamStop_withTinyAudio_shouldMarkFailedAudioCapture() throws Exception {
        attributes.put("meetingId", 402L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 1L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);
        attributes.put("totalAudioBytes", 720L);
        attributes.put("tinyChunkStreak", 10L);

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber, timeout(1000).times(2)).dispatchMeetingEvent(eq(402L), eventCaptor.capture());
        assertEquals("FAILED_AUDIO_CAPTURE", eventCaptor.getAllValues().get(1).get("status"));
        verify(aiServiceClient, never()).streamAudioChunk(anyLong(), any(), eq(-1L), anyString(), eq(true), any(), anyString());
    }

    @Test
    void handleTextMessage_streamStop_withTinyAudio_butPersistedTranscript_shouldRecoverAndTriggerAnalysis() throws Exception {
        attributes.put("meetingId", 413L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 1L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);
        attributes.put("totalAudioBytes", 720L);
        attributes.put("tinyChunkStreak", 10L);

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        when(aiServiceClient.getTranscript(eq(413L), anyString())).thenReturn(Map.of(
                "meeting_id", 413L,
                "transcripts", List.of(Map.of("speaker", "SPEAKER_1", "text", "tiny audio recovered transcript"))
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(413L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("status", "COMPLETED"));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        verify(aiServiceClient, never()).streamAudioChunk(anyLong(), any(), eq(-1L), anyString(), eq(true), any(), anyString());
        verify(aiServiceClient, timeout(1000)).analyzeRealtimeTranscript(
                eq(413L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        );
        verify(meetingServiceClient, never()).updateMeetingStatus(eq(413L), eq("failed"), anyString(), anyString());
        verify(meetingServiceClient, timeout(1000)).updateMeetingStatus(eq(413L), eq("completed"), anyString(), eq("Bearer test-token"));
    }

    @Test
    void handleTextMessage_streamStop_tinyTailAfterValidAudio_shouldNotFailAudioCapture() throws Exception {
        when(epic2FeatureFlags.isRealtimeValidationEnabled()).thenReturn(true);
        attributes.put("meetingId", 414L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");

        when(aiServiceClient.streamAudioChunk(
                eq(414L),
                any(byte[].class),
                anyLong(),
                eq("vi"),
                anyBoolean(),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(null);
        when(aiServiceClient.streamAudioChunk(
                eq(414L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("transcript", "final transcript", "is_final", true, "language", "vi"));
        when(aiServiceClient.getTranscript(eq(414L), anyString())).thenReturn(Map.of(
                "meeting_id", 414L,
                "transcripts", List.of(Map.of("speaker", "SPEAKER_1", "text", "final transcript"))
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(414L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("status", "COMPLETED"));

        sendAudioMetadata(1L, 512);
        sendBinary(bytes(512));
        for (long seq = 2L; seq <= 11L; seq++) {
            sendAudioMetadata(seq, 64);
            sendBinary(bytes(64));
        }
        assertEquals(Boolean.TRUE, attributes.get("AUDIO_RECEIVED_ATTR"));
        assertEquals(Boolean.TRUE, attributes.get("validAudioReceived"));

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        verify(aiServiceClient).streamAudioChunk(
                eq(414L),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        );
        verify(meetingServiceClient, after(300).never()).updateMeetingStatus(eq(414L), eq("failed"), anyString(), anyString());
        verify(meetingServiceClient, timeout(1000)).updateMeetingStatus(eq(414L), eq("completed"), anyString(), eq("Bearer test-token"));
    }

    @Test
    void handleTextMessage_streamStop_dualStreamMicTinyButTabValid_shouldNotFailAudioCapture() throws Exception {
        when(epic2FeatureFlags.isRealtimeValidationEnabled()).thenReturn(true);
        ReflectionTestUtils.setField(handler, "dualStreamTabMicEnabled", true);
        attributes.put("meetingId", 415L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");

        when(aiServiceClient.streamAudioChunk(
                eq(415L),
                anyString(),
                any(byte[].class),
                anyLong(),
                eq("vi"),
                anyBoolean(),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(null);
        when(aiServiceClient.streamAudioChunk(
                eq(415L),
                anyString(),
                argThat(bytes -> bytes != null && bytes.length == 0),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("transcript", "ok", "is_final", true));
        when(aiServiceClient.getTranscript(eq(415L), anyString())).thenReturn(Map.of(
                "meeting_id", 415L,
                "transcripts", List.of(Map.of("speaker", "SPEAKER_1", "text", "tab valid transcript"))
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(415L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("status", "COMPLETED"));

        doReturn(Map.of("type", "dual_stream.configure", "dualStream", true, "activeStreams", List.of("tab", "mic")))
                .when(objectMapper).readValue(anyString(), any(Class.class));
        handler.handleTextMessage(session, new TextMessage("{}"));

        sendAudioMetadata(1L, 512, "tab");
        sendBinary(bytes(512));
        for (long seq = 2L; seq <= 11L; seq++) {
            sendAudioMetadata(seq, 64, "mic");
            sendBinary(bytes(64));
        }
        RealtimeStreamAudioState tabState = RealtimeStreamAudioState.stateFor(attributes, "tab");
        RealtimeStreamAudioState micState = RealtimeStreamAudioState.stateFor(attributes, "mic");
        assertTrue(tabState.validAudioReceived());
        assertFalse(micState.validAudioReceived());

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        verify(aiServiceClient, timeout(1000)).analyzeRealtimeTranscript(
                eq(415L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        );
        verify(meetingServiceClient, after(300).never()).updateMeetingStatus(eq(415L), eq("failed"), anyString(), anyString());
        verify(meetingServiceClient, timeout(1000)).updateMeetingStatus(eq(415L), eq("completed"), anyString(), eq("Bearer test-token"));
    }

    @Test
    void handleTextMessage_streamStop_finalizeConflict_shouldRecoverWithoutStreamError() throws Exception {
        attributes.put("meetingId", 403L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 12L);
        attributes.put("AUDIO_RECEIVED_ATTR", Boolean.TRUE);
        attributes.put("totalAudioBytes", 4096L);

        doReturn(Map.of("type", "stream.stop")).when(objectMapper).readValue(anyString(), any(Class.class));
        when(aiServiceClient.streamAudioChunk(
                eq(403L),
                any(byte[].class),
                eq(-1L),
                eq("vi"),
                eq(true),
                isNull(),
                eq("Bearer test-token")
        )).thenThrow(new org.springframework.web.client.HttpClientErrorException(
                org.springframework.http.HttpStatus.CONFLICT,
                "Conflict",
                "{\"detail\":\"STT stream failed: actor closed\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8),
                java.nio.charset.StandardCharsets.UTF_8
        ));
        when(aiServiceClient.isTerminalStreamConflict(any())).thenReturn(true);
        when(aiServiceClient.getTranscript(eq(403L), anyString())).thenReturn(Map.of(
                "meeting_id", 403L,
                "transcripts", List.of(Map.of("speaker", "SPEAKER_1", "text", "saved transcript"))
        ));
        when(jobStateStore.tryStartAnalysis(anyLong(), anyString(), anyString(), anyString()))
                .thenReturn(new JobStateStore.AnalysisTriggerDecision(
                        true,
                        "RUNNING",
                        "lock-token",
                        "accepted",
                        0,
                        null
                ));

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        verify(realtimeEventSubscriber, never()).dispatchMeetingEvent(eq(403L), argThat(event ->
                "stream.error".equals(event.get("type"))
        ));
        verify(aiServiceClient, timeout(1000)).analyzeRealtimeTranscript(
                eq(403L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                eq("Bearer test-token")
        );
    }

    @Test
    void handleTextMessage_realtimeValidationEnabled_rejectsOversizedMetadata() throws Exception {
        when(epic2FeatureFlags.isRealtimeValidationEnabled()).thenReturn(true);
        attributes.put("meetingId", 501L);
        attributes.put("authenticated", true);
        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 1L,
                "size", RealtimePayloadValidator.MAX_CHUNK_BYTES + 1,
                "mime_type", "audio/webm; codecs=opus",
                "encoding", "webm-opus"
        ));

        handler.handleTextMessage(session, new TextMessage("{}"));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber).dispatchMeetingEvent(eq(501L), eventCaptor.capture());
        Map<String, Object> errorEvent = eventCaptor.getValue();
        assertEquals("stream.error", errorEvent.get("type"));
        assertEquals("REALTIME_CHUNK_TOO_LARGE", errorEvent.get("errorCode"));
        assertNull(attributes.get("lastAudioSeq"));
        verifyNoInteractions(aiServiceClient);
    }

    @Test
    void handleTextMessage_realtimeValidationEnabled_rejectsNonMonotonicSeq() throws Exception {
        when(epic2FeatureFlags.isRealtimeValidationEnabled()).thenReturn(true);
        attributes.put("meetingId", 502L);
        attributes.put("authenticated", true);
        attributes.put("lastAcceptedAudioSeq", 3L);
        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 3L,
                "size", 100L,
                "mime_type", "audio/webm; codecs=opus",
                "encoding", "webm-opus"
        ));

        handler.handleTextMessage(session, new TextMessage("{}"));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber).dispatchMeetingEvent(eq(502L), eventCaptor.capture());
        assertEquals("REALTIME_INVALID_PAYLOAD", eventCaptor.getValue().get("errorCode"));
        verifyNoInteractions(aiServiceClient);
    }

    @Test
    void handleTextMessage_realtimeValidationEnabled_rejectsUnsupportedEncoding() throws Exception {
        when(epic2FeatureFlags.isRealtimeValidationEnabled()).thenReturn(true);
        attributes.put("meetingId", 503L);
        attributes.put("authenticated", true);
        when(objectMapper.readValue(any(String.class), eq(Map.class))).thenReturn(Map.of(
                "type", "audio.chunk",
                "seq", 1L,
                "size", 4L,
                "mime_type", "audio/mp4",
                "encoding", "aac"
        ));

        handler.handleTextMessage(session, new TextMessage("{}"));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber).dispatchMeetingEvent(eq(503L), eventCaptor.capture());
        assertEquals("REALTIME_UNSUPPORTED_ENCODING", eventCaptor.getValue().get("errorCode"));
        verifyNoInteractions(aiServiceClient);
    }

    @Test
    void handleBinaryMessage_realtimeValidationEnabled_acceptsClusterFragmentWithoutEbmlMagic() throws Exception {
        when(epic2FeatureFlags.isRealtimeValidationEnabled()).thenReturn(true);
        attributes.put("meetingId", 504L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 1L);
        attributes.put("lastAudioDeclaredSize", 5L);
        byte[] clusterFragment = new byte[] {1, 2, 3, 4, 5};

        when(aiServiceClient.streamAudioChunk(
                eq(504L),
                argThat(bytes -> bytes != null && bytes.length == 5),
                eq(1L),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        )).thenReturn(Map.of("transcript", "ok", "is_final", false));

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(clusterFragment)));

        assertEquals(1L, attributes.get("lastAcceptedAudioSeq"));
        verify(aiServiceClient).streamAudioChunk(
                eq(504L),
                argThat(bytes -> bytes != null && bytes.length == 5),
                eq(1L),
                eq("vi"),
                eq(false),
                isNull(),
                eq("Bearer test-token")
        );
    }

    @Test
    void handleBinaryMessage_shouldSendVietnameseQuotaErrorWhenSttQuotaExceeded() throws Exception {
        UserQuotaClient userQuotaClient = org.mockito.Mockito.mock(UserQuotaClient.class);
        ReflectionTestUtils.setField(handler, "userQuotaClient", userQuotaClient);
        ReflectionTestUtils.setField(handler, "quotaFailOpen", false);
        ReflectionTestUtils.setField(handler, "objectMapper", new ObjectMapper());
        when(epic2FeatureFlags.isErrorUxEnabled()).thenReturn(true);

        attributes.put("meetingId", 900L);
        attributes.put("userId", 1L);
        attributes.put("authenticated", true);
        attributes.put("language", "vi");
        attributes.put("authorization", "Bearer test-token");
        attributes.put("lastAudioSeq", 1L);
        when(userQuotaClient.consume(eq(1L), anyLong(), eq(0L)))
                .thenReturn(new UserQuotaClient.QuotaConsumeResult(false, Map.of(), null));
        when(session.isOpen()).thenReturn(true);

        ArgumentCaptor<TextMessage> messageCaptor = ArgumentCaptor.forClass(TextMessage.class);
        doNothing().when(session).sendMessage(messageCaptor.capture());
        doNothing().when(session).close(any(CloseStatus.class));

        handler.handleBinaryMessage(session, new BinaryMessage(ByteBuffer.wrap(new byte[4000])));

        verify(session).sendMessage(any(TextMessage.class));
        verify(session).close(any(CloseStatus.class));
        verifyNoInteractions(aiServiceClient);

        TextMessage sent = messageCaptor.getValue();
        @SuppressWarnings("unchecked")
        Map<String, Object> parsed = new ObjectMapper().readValue(sent.getPayload(), Map.class);
        assertEquals("QUOTA_EXCEEDED", parsed.get("errorCode"));
        assertTrue(String.valueOf(parsed.get("message")).contains("Nâng cấp Pro"));
    }
}
