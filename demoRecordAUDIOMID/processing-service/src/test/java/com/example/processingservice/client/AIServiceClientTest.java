package com.example.processingservice.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.nio.charset.StandardCharsets;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;

class AIServiceClientTest {

    @Test
    void streamAudioChunk_shouldLogProcessingOutWithMeetingIdAndSeq() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        org.springframework.test.util.ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        ResponseEntity<Map<String, Object>> response = new ResponseEntity<>(Map.of("transcript", "ok"), HttpStatus.OK);
        when(restTemplate.exchange(
                any(String.class),
                eq(HttpMethod.POST),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        )).thenReturn(response);

        Logger logger = (Logger) org.slf4j.LoggerFactory.getLogger(AIServiceClient.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);

        try {
            Map<String, Object> body = client.streamAudioChunk(9L, new byte[] {0x01, 0x02, 0x03}, 4L, "vi", "multiple", false, null, null);
            assertEquals("ok", body.get("transcript"));
        } finally {
            logger.detachAppender(appender);
        }

        verify(restTemplate).exchange(
                eq("http://ai-service/api/v1/stt/stream"),
                eq(HttpMethod.POST),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        );

        boolean sawLog = appender.list.stream().anyMatch(event ->
                event.getFormattedMessage().contains("AUDIO HASH PROCESSING_OUT meetingId=9 seq=4 size=3 first16hex=010203")
        );
        assertTrue(sawLog);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<HttpEntity<MultiValueMap<String, Object>>> captor = ArgumentCaptor.forClass(HttpEntity.class);
        verify(restTemplate).exchange(
            eq("http://ai-service/api/v1/stt/stream"),
            eq(HttpMethod.POST),
            captor.capture(),
            any(org.springframework.core.ParameterizedTypeReference.class)
        );
        assertEquals("multiple", captor.getValue().getBody().getFirst("speaker_mode"));
    }

        @Test
        void streamAudioChunk_shouldReturnNullForFinalizationReplayConflict() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        org.springframework.test.util.ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        HttpClientErrorException conflict = HttpClientErrorException.create(
            HttpStatus.CONFLICT,
            "Conflict",
            HttpHeaders.EMPTY,
            "{\"detail\":\"Meeting already finalized\"}".getBytes(StandardCharsets.UTF_8),
            StandardCharsets.UTF_8
        );

        when(restTemplate.exchange(
            any(String.class),
            eq(HttpMethod.POST),
            any(HttpEntity.class),
            any(org.springframework.core.ParameterizedTypeReference.class)
        )).thenThrow(conflict);

        Map<String, Object> body = client.streamAudioChunk(9L, new byte[] {0x01, 0x02, 0x03}, 4L, "vi", null, false, null, null);

        assertNull(body);
        verify(restTemplate).exchange(
            eq("http://ai-service/api/v1/stt/stream"),
            eq(HttpMethod.POST),
            any(HttpEntity.class),
            any(org.springframework.core.ParameterizedTypeReference.class)
        );
        }

    @Test
    void streamAudioChunk_shouldRaiseResetRequiredForBlockedWebmContinuation() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        org.springframework.test.util.ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        HttpClientErrorException conflict = HttpClientErrorException.create(
            HttpStatus.CONFLICT,
            "Conflict",
            HttpHeaders.EMPTY,
            "{\"error\":\"webm_continuation_after_reconnect_blocked\",\"reset_required\":true}".getBytes(StandardCharsets.UTF_8),
            StandardCharsets.UTF_8
        );

        when(restTemplate.exchange(
            any(String.class),
            eq(HttpMethod.POST),
            any(HttpEntity.class),
            any(org.springframework.core.ParameterizedTypeReference.class)
        )).thenThrow(conflict);

        assertThrows(AudioStreamResetRequiredException.class, () ->
            client.streamAudioChunk(9L, new byte[] {0x01, 0x02, 0x03}, 4L, "vi", false, null, null)
        );
    }

    @Test
    void streamAudioChunk_shouldUseConfiguredDefaultWhenLanguageMissing() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");
        ReflectionTestUtils.setField(client, "deepgramLanguage", "multi");

        ResponseEntity<Map<String, Object>> response = new ResponseEntity<>(Map.of("transcript", "ok"), HttpStatus.OK);
        when(restTemplate.exchange(
                any(String.class),
                eq(HttpMethod.POST),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        )).thenReturn(response);

        client.streamAudioChunk(10L, new byte[] {0x01}, 1L, null, null, false, null, null);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<HttpEntity<MultiValueMap<String, Object>>> captor = ArgumentCaptor.forClass(HttpEntity.class);
        verify(restTemplate).exchange(
                eq("http://ai-service/api/v1/stt/stream"),
                eq(HttpMethod.POST),
                captor.capture(),
                any(org.springframework.core.ParameterizedTypeReference.class)
        );

        MultiValueMap<String, Object> body = captor.getValue().getBody();
        assertEquals("multi", body.getFirst("language"));
    }

    @Test
    void streamAudioChunk_shouldFallbackToViForInvalidLanguageAndInvalidConfiguredDefault() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");
        ReflectionTestUtils.setField(client, "deepgramLanguage", "bogus");

        ResponseEntity<Map<String, Object>> response = new ResponseEntity<>(Map.of("transcript", "ok"), HttpStatus.OK);
        when(restTemplate.exchange(
                any(String.class),
                eq(HttpMethod.POST),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        )).thenReturn(response);

        client.streamAudioChunk(11L, new byte[] {0x02}, 2L, "fr", null, false, null, null);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<HttpEntity<MultiValueMap<String, Object>>> captor = ArgumentCaptor.forClass(HttpEntity.class);
        verify(restTemplate).exchange(
                eq("http://ai-service/api/v1/stt/stream"),
                eq(HttpMethod.POST),
                captor.capture(),
                any(org.springframework.core.ParameterizedTypeReference.class)
        );

        MultiValueMap<String, Object> body = captor.getValue().getBody();
        assertEquals("vi", body.getFirst("language"));
    }

    @Test
    void analyzeRealtimeTranscript_shouldPostTranscriptPayloadToInternalEndpoint() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        ResponseEntity<Map<String, Object>> response = new ResponseEntity<>(
                Map.of("status", "completed"),
                HttpStatus.OK
        );
        when(restTemplate.exchange(
                any(String.class),
                eq(HttpMethod.POST),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        )).thenReturn(response);

        Map<String, Object> result = client.analyzeRealtimeTranscript(
                44L,
                "Speaker 1: demo text",
                "it",
                "realtime",
                "abc123",
                "trace-realtime",
                "Bearer test-token"
        );

        assertEquals("completed", result.get("status"));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<HttpEntity<Map<String, Object>>> captor = ArgumentCaptor.forClass(HttpEntity.class);
        verify(restTemplate).exchange(
                eq("http://ai-service/api/internal/realtime-analysis"),
                eq(HttpMethod.POST),
                captor.capture(),
                any(org.springframework.core.ParameterizedTypeReference.class)
        );

        HttpEntity<Map<String, Object>> entity = captor.getValue();
        Map<String, Object> payload = entity.getBody();
        assertEquals(44L, payload.get("meeting_id"));
        assertEquals("Speaker 1: demo text", payload.get("transcript"));
        assertEquals("it", payload.get("domain_mode"));
        assertEquals("realtime", payload.get("source"));
        assertEquals("abc123", payload.get("transcript_hash"));
        assertEquals("Bearer test-token", entity.getHeaders().getFirst(HttpHeaders.AUTHORIZATION));
        assertEquals("application/json", entity.getHeaders().getContentType().toString());
    }
}
