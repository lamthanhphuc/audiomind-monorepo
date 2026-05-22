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
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
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
            Map<String, Object> body = client.streamAudioChunk(9L, new byte[] {0x01, 0x02, 0x03}, 4L, "vi", false, null, null);
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

        Map<String, Object> body = client.streamAudioChunk(9L, new byte[] {0x01, 0x02, 0x03}, 4L, "vi", false, null, null);

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
}
