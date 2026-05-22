package com.example.processingservice.interfaces.websocket;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

import java.nio.ByteBuffer;
import java.util.HashMap;
import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.AudioStreamResetRequiredException;
import com.example.processingservice.security.JwtUtil;
import com.example.processingservice.security.MeetingChannelAuthorizer;
import com.example.processingservice.services.RealtimeEventSubscriber;
import com.fasterxml.jackson.databind.ObjectMapper;

@ExtendWith(MockitoExtension.class)
class MeetingWebSocketHandlerTest {

    @Mock
    private MeetingChannelAuthorizer meetingChannelAuthorizer;

    @Mock
    private RealtimeEventSubscriber realtimeEventSubscriber;

    @Mock
    private AIServiceClient aiServiceClient;

    @Mock
    private ObjectMapper objectMapper;

    @Mock
    private JwtUtil jwtUtil;

    @Mock
    private WebSocketSession session;

    private MeetingWebSocketHandler handler;
    private Map<String, Object> attributes;

    @BeforeEach
    void setUp() {
        handler = new MeetingWebSocketHandler(
                meetingChannelAuthorizer,
                realtimeEventSubscriber,
                aiServiceClient,
                objectMapper,
                jwtUtil);

        attributes = new HashMap<>();
        when(session.getAttributes()).thenReturn(attributes);
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
        verify(realtimeEventSubscriber).broadcastToMeeting(eq(33L), eventCaptor.capture());

        Map<String, Object> event = eventCaptor.getValue();
        assertEquals("stream.status", event.get("type"));
        assertEquals("connected", event.get("state"));
        assertEquals("Đang lắng nghe...", event.get("message"));
        assertEquals(7L, event.get("seq"));
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
        verify(realtimeEventSubscriber).broadcastToMeeting(eq(34L), eventCaptor.capture());

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
        verify(realtimeEventSubscriber).broadcastToMeeting(eq(340L), eventCaptor.capture());

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
        verify(realtimeEventSubscriber).broadcastToMeeting(eq(343L), eventCaptor.capture());

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
        verify(aiServiceClient, never()).getTranscript(anyLong(), anyString());
            ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
            verify(realtimeEventSubscriber).broadcastToMeeting(eq(35L), eventCaptor.capture());

            Map<String, Object> event = eventCaptor.getValue();
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

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber).broadcastToMeeting(eq(36L), eventCaptor.capture());

        Map<String, Object> event = eventCaptor.getValue();
        assertEquals("stream.status", event.get("type"));
        assertEquals("completed_with_no_speech_detected", event.get("state"));
        assertEquals("completed_with_no_speech_detected", event.get("status"));
        assertEquals(36L, event.get("meetingId"));
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

        handler.handleTextMessage(session, new TextMessage("{\"type\":\"stream.stop\"}"));

        ArgumentCaptor<Map<String, Object>> eventCaptor = ArgumentCaptor.forClass(Map.class);
        verify(realtimeEventSubscriber).broadcastToMeeting(eq(112L), eventCaptor.capture());
        Map<String, Object> event = eventCaptor.getValue();
        assertEquals("transcript.final", event.get("type"));
        assertEquals("meeting-112-start-30.950-unknown", event.get("segmentId"));
        assertEquals(35L, event.get("seq"));
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
        verify(realtimeEventSubscriber).broadcastToMeeting(eq(113L), eventCaptor.capture());
        Map<String, Object> event = eventCaptor.getValue();
        assertEquals("transcript.final", event.get("type"));
        assertEquals(-1L, event.get("seq"));
        assertEquals("meeting-113-start-30.950-speaker_1", event.get("segmentId"));
        assertEquals(30.95, event.get("startTime"));
        assertEquals(35.46, event.get("endTime"));
    }
}
