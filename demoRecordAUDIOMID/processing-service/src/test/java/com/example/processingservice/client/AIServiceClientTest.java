package com.example.processingservice.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.lang.reflect.Method;
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
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import org.springframework.retry.annotation.Retryable;

class AIServiceClientTest {

    @Test
    void streamAudioChunk_shouldLogProcessingOutWithSafeMetadataOnly() {
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
                event.getFormattedMessage().contains("AUDIO_CHUNK_PROCESSING_OUT meetingId=9 seq=4 byteLength=3")
        );
        assertTrue(sawLog);
        boolean sawRawPreview = appender.list.stream().anyMatch(event ->
                event.getFormattedMessage().contains("first16" + "hex")
                        || event.getFormattedMessage().contains("010" + "203")
        );
        assertTrue(!sawRawPreview);

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
    void streamAudioChunk_shouldSendCompleteProvenanceAsDecimalMultipartFields() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        ResponseEntity<Map<String, Object>> response = new ResponseEntity<>(Map.of("transcript", "ok"), HttpStatus.OK);
        when(restTemplate.exchange(
                any(String.class),
                eq(HttpMethod.POST),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        )).thenReturn(response);

        client.streamAudioChunk(
                12L,
                "tab",
                new byte[] {0x03},
                7L,
                "vi",
                "multiple",
                false,
                null,
                null,
                1001L,
                2L
        );

        @SuppressWarnings("unchecked")
        ArgumentCaptor<HttpEntity<MultiValueMap<String, Object>>> captor = ArgumentCaptor.forClass(HttpEntity.class);
        verify(restTemplate).exchange(
                eq("http://ai-service/api/v1/stt/stream"),
                eq(HttpMethod.POST),
                captor.capture(),
                any(org.springframework.core.ParameterizedTypeReference.class)
        );

        MultiValueMap<String, Object> body = captor.getValue().getBody();
        assertEquals("1001", body.getFirst("recording_session_id"));
        assertEquals("2", body.getFirst("attempt_id"));
    }

    @Test
    void streamAudioChunk_shouldOmitProvenanceForLegacyRequest() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        ResponseEntity<Map<String, Object>> response = new ResponseEntity<>(Map.of("transcript", "ok"), HttpStatus.OK);
        when(restTemplate.exchange(
                any(String.class),
                eq(HttpMethod.POST),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        )).thenReturn(response);

        client.streamAudioChunk(13L, new byte[] {0x04}, 8L, "vi", null, false, null, null);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<HttpEntity<MultiValueMap<String, Object>>> captor = ArgumentCaptor.forClass(HttpEntity.class);
        verify(restTemplate).exchange(
                eq("http://ai-service/api/v1/stt/stream"),
                eq(HttpMethod.POST),
                captor.capture(),
                any(org.springframework.core.ParameterizedTypeReference.class)
        );

        MultiValueMap<String, Object> body = captor.getValue().getBody();
        assertNull(body.getFirst("recording_session_id"));
        assertNull(body.getFirst("attempt_id"));
    }

    @Test
    void getTranscript_shouldSendV2ScopeAsSnakeCaseQueryParams() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        ResponseEntity<Map<String, Object>> response = new ResponseEntity<>(Map.of("transcripts", java.util.List.of()), HttpStatus.OK);
        when(restTemplate.exchange(
                any(String.class),
                eq(HttpMethod.GET),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        )).thenReturn(response);

        client.getTranscript(88L, "trace-v2", 1001L, 2L);

        ArgumentCaptor<String> urlCaptor = ArgumentCaptor.forClass(String.class);
        verify(restTemplate).exchange(
                urlCaptor.capture(),
                eq(HttpMethod.GET),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        );
        String url = urlCaptor.getValue();
        assertTrue(url.startsWith("http://ai-service/api/meeting/88/transcript?"));
        assertTrue(url.contains("recording_session_id=1001"));
        assertTrue(url.contains("attempt_id=2"));
    }

    @Test
    void getTranscript_shouldOmitProvenanceForLegacyScope() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        ResponseEntity<Map<String, Object>> response = new ResponseEntity<>(Map.of("transcripts", java.util.List.of()), HttpStatus.OK);
        when(restTemplate.exchange(
                any(String.class),
                eq(HttpMethod.GET),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        )).thenReturn(response);

        client.getTranscript(89L, "trace-legacy");

        ArgumentCaptor<String> urlCaptor = ArgumentCaptor.forClass(String.class);
        verify(restTemplate).exchange(
                urlCaptor.capture(),
                eq(HttpMethod.GET),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        );
        assertEquals("http://ai-service/api/meeting/89/transcript", urlCaptor.getValue());
    }

    @Test
    void getTranscript_shouldRejectPartialProvenanceBeforeHttp() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        assertThrows(IllegalArgumentException.class, () ->
                client.getTranscript(90L, "trace-partial", 1001L, null)
        );

        verify(restTemplate, never()).exchange(
                any(String.class),
                any(HttpMethod.class),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        );
    }

    @Test
    void getTranscript_v2OverloadShouldKeepResilienceAnnotations() throws Exception {
        Method v2GetTranscript = AIServiceClient.class.getMethod(
                "getTranscript",
                Long.class,
                String.class,
                Long.class,
                Long.class
        );

        assertTrue(v2GetTranscript.isAnnotationPresent(Retry.class));
        assertTrue(v2GetTranscript.isAnnotationPresent(CircuitBreaker.class));
        assertTrue(v2GetTranscript.isAnnotationPresent(Retryable.class));
    }

    @Test
    void streamAudioChunk_shouldRejectPartialProvenanceBeforeHttpRequest() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        assertThrows(IllegalArgumentException.class, () -> client.streamAudioChunk(
                14L,
                "mic",
                new byte[] {0x05},
                9L,
                "vi",
                "multiple",
                false,
                null,
                null,
                1001L,
                null
        ));

        verify(restTemplate, org.mockito.Mockito.never()).exchange(
                any(String.class),
                any(HttpMethod.class),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        );
    }

    @Test
    void streamAudioChunk_shouldRejectDisplayOnlyDefaultStreamIdBeforeHttpRequest() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        assertThrows(IllegalArgumentException.class, () -> client.streamAudioChunk(
                15L,
                "default",
                new byte[] {0x06},
                10L,
                "vi",
                "multiple",
                false,
                null,
                null,
                1001L,
                1L
        ));

        verify(restTemplate, org.mockito.Mockito.never()).exchange(
                any(String.class),
                any(HttpMethod.class),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        );
    }

    @Test
    void streamAudioChunk_v2PublicOverloadsShouldKeepResilienceAnnotations() throws Exception {
        Method v2NoStream = AIServiceClient.class.getMethod(
                "streamAudioChunk",
                Long.class,
                byte[].class,
                Long.class,
                String.class,
                String.class,
                boolean.class,
                String.class,
                String.class,
                Long.class,
                Long.class
        );
        Method v2WithStream = AIServiceClient.class.getMethod(
                "streamAudioChunk",
                Long.class,
                String.class,
                byte[].class,
                Long.class,
                String.class,
                String.class,
                boolean.class,
                String.class,
                String.class,
                Long.class,
                Long.class
        );

        assertRealtimeResilienceAnnotations(v2NoStream);
        assertRealtimeResilienceAnnotations(v2WithStream);
    }

    private static void assertRealtimeResilienceAnnotations(Method method) {
        Retry retry = method.getAnnotation(Retry.class);
        CircuitBreaker circuitBreaker = method.getAnnotation(CircuitBreaker.class);
        Retryable retryable = method.getAnnotation(Retryable.class);

        assertEquals("ai-service", retry.name());
        assertEquals("ai-service", circuitBreaker.name());
        assertEquals(3, retryable.maxAttempts());
        assertEquals(1000L, retryable.backoff().delay());
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

    @Test
    void getSavedAnalysisCacheOnly_shouldPostCacheOnlyPayloadToInternalEndpoint() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        ResponseEntity<Map<String, Object>> response = new ResponseEntity<>(
                Map.of("status", "completed", "cacheHit", true),
                HttpStatus.OK
        );
        when(restTemplate.exchange(
                any(String.class),
                eq(HttpMethod.POST),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        )).thenReturn(response);

        Map<String, Object> result = client.getSavedAnalysisCacheOnly(
                55L,
                "Speaker 1: export text",
                "hash-55",
                "prompt-v1",
                "schema-v1",
                "trace-cache-only",
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
        assertEquals(55L, payload.get("meeting_id"));
        assertEquals("Speaker 1: export text", payload.get("transcript"));
        assertEquals("export_report", payload.get("source"));
        assertEquals("cache_only", payload.get("mode"));
        assertEquals("hash-55", payload.get("transcript_hash"));
        assertEquals("prompt-v1", payload.get("prompt_version"));
        assertEquals("schema-v1", payload.get("schema_version"));
        assertEquals("Bearer test-token", entity.getHeaders().getFirst(HttpHeaders.AUTHORIZATION));
        assertEquals("application/json", entity.getHeaders().getContentType().toString());
    }

    @Test
    void rerunAnalysis_shouldPostModeReasonToRerunEndpointAndReturnMetadata() {
        RestTemplate restTemplate = mock(RestTemplate.class);
        AIServiceClient client = new AIServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "aiUrl", "http://ai-service");

        ResponseEntity<Map<String, Object>> response = new ResponseEntity<>(
                Map.of(
                        "analysisStatus", "ANALYZING",
                        "cacheHit", false,
                        "provider", "gemini",
                        "retryAfterSeconds", 5
                ),
                HttpStatus.OK
        );
        when(restTemplate.exchange(
                any(String.class),
                eq(HttpMethod.POST),
                any(HttpEntity.class),
                any(org.springframework.core.ParameterizedTypeReference.class)
        )).thenReturn(response);

        Map<String, Object> result = client.rerunAnalysis(
                77L,
                "force",
                "manual_reanalyze",
                "SPEAKER_1: saved transcript",
                "a".repeat(64),
                "prompt-v1",
                "schema-v1",
                "b".repeat(64),
                "canonical-v1",
                "trace-rerun",
                "Bearer test-token"
        );

        assertEquals("ANALYZING", result.get("analysisStatus"));
        assertEquals("gemini", result.get("provider"));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<HttpEntity<Map<String, Object>>> captor = ArgumentCaptor.forClass(HttpEntity.class);
        verify(restTemplate).exchange(
                eq("http://ai-service/api/meeting/77/analysis/rerun"),
                eq(HttpMethod.POST),
                captor.capture(),
                any(org.springframework.core.ParameterizedTypeReference.class)
        );

        HttpEntity<Map<String, Object>> entity = captor.getValue();
        Map<String, Object> payload = entity.getBody();
        assertEquals("force", payload.get("mode"));
        assertEquals("manual_reanalyze", payload.get("reason"));
        assertEquals("SPEAKER_1: saved transcript", payload.get("transcript"));
        assertEquals("a".repeat(64), payload.get("transcript_hash"));
        assertEquals("prompt-v1", payload.get("prompt_version"));
        assertEquals("schema-v1", payload.get("schema_version"));
        assertEquals("b".repeat(64), payload.get("canonical_transcript_hash"));
        assertEquals("canonical-v1", payload.get("canonical_transcript_version"));
        assertEquals("Bearer test-token", entity.getHeaders().getFirst(HttpHeaders.AUTHORIZATION));
        assertEquals("application/json", entity.getHeaders().getContentType().toString());
    }
}
