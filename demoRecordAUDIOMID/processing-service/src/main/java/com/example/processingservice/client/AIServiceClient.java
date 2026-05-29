package com.example.processingservice.client;

import java.io.IOException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.retry.annotation.Backoff;
import org.springframework.retry.annotation.Retryable;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.util.StringUtils;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.multipart.MultipartFile;

import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import lombok.RequiredArgsConstructor;

@Service
@RequiredArgsConstructor
public class AIServiceClient {

    private static final Set<String> VALID_REALTIME_LANGUAGES = Set.of("vi", "en", "multi");
    private static final String TRACE_HEADER = "x-trace-id";
    private static final String REQUEST_HEADER = "x-request-id";

    private static final Logger log = LoggerFactory.getLogger(AIServiceClient.class);

    private final RestTemplate restTemplate;

    @Value("${ai.service.url}")
    private String aiUrl;

    @Value("${deepgram.language:vi}")
    private String deepgramLanguage;

    public Map<String, Object> processAudio(Long meetingId, String audioPath) {
        return processAudio(meetingId, audioPath, null, null, null, "vi", null, null);
    }

    public Map<String, Object> streamAudioChunk(
            Long meetingId,
            byte[] audioChunk,
            Long seq,
            String language,
            boolean isFinal,
            String traceId,
            String authorization) {
        return streamAudioChunk(meetingId, audioChunk, seq, language, null, isFinal, traceId, authorization);
    }

    @Retry(name = "ai-service")
    @CircuitBreaker(name = "ai-service")
    @Retryable(
        retryFor = { RestClientException.class, IllegalStateException.class },
        maxAttempts = 3,
        backoff = @Backoff(delay = 1000, multiplier = 2.0)
    )
    public Map<String, Object> processAudio(
            Long meetingId,
            String audioPath,
            String fileId,
            String topic,
            List<String> glossaryTerms,
            String language,
            String traceId,
            String authorization) {

        Map<String, Object> request = new HashMap<>();

        request.put("meeting_id", meetingId);
        request.put("audio_path", audioPath);
        request.put("file_id", fileId);

        if (topic != null && !topic.isBlank()) {
            request.put("topic", topic);
        }

        if (glossaryTerms != null && !glossaryTerms.isEmpty()) {
            request.put("glossary_terms", glossaryTerms);
        }

        if (language != null && !language.isBlank()) {
            request.put("language", language);
        }

        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        String resolvedRequestId = resolveRequestId(resolvedTraceId);
        headers.add(TRACE_HEADER, resolvedTraceId);
        headers.add(REQUEST_HEADER, resolvedRequestId);
        if (StringUtils.hasText(authorization)) {
            headers.add(HttpHeaders.AUTHORIZATION, authorization);
        }
        log.info(
                "event=BATCH_STT_EFFECTIVE_CONFIG traceId={} requestId={} meetingId={} source=upload requestedLanguage={} effectiveLanguage={}",
                resolvedTraceId,
                resolvedRequestId,
                meetingId,
                language == null ? "" : language,
                normalizeRealtimeLanguage(language)
        );
        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "processAudio",
                aiUrl + "/api/process",
                HttpMethod.POST,
                new HttpEntity<>(request, headers),
                resolvedTraceId,
                resolvedRequestId,
                meetingId
        );

        return requireBody(response, "processAudio", meetingId);
    }

    public Map<String, Object> getTranscript(Long meetingId, String traceId) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        String resolvedRequestId = resolveRequestId(resolvedTraceId);
        headers.add(TRACE_HEADER, resolvedTraceId);
        headers.add(REQUEST_HEADER, resolvedRequestId);
        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "getTranscript",
                aiUrl + "/api/meeting/" + meetingId + "/transcript",
                HttpMethod.GET,
                new HttpEntity<>(headers),
                resolvedTraceId,
                resolvedRequestId,
                meetingId
        );
        return requireBody(response, "getTranscript", meetingId);
    }

    @Retry(name = "ai-service")
    @CircuitBreaker(name = "ai-service")
    @Retryable(
        retryFor = { RestClientException.class, IllegalStateException.class },
        maxAttempts = 3,
        backoff = @Backoff(delay = 1000, multiplier = 2.0)
    )
    public Map<String, Object> getAnalysis(Long meetingId, String traceId) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        String resolvedRequestId = resolveRequestId(resolvedTraceId);
        headers.add(TRACE_HEADER, resolvedTraceId);
        headers.add(REQUEST_HEADER, resolvedRequestId);
        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "getAnalysis",
                aiUrl + "/api/meeting/" + meetingId + "/analysis",
                HttpMethod.GET,
                new HttpEntity<>(headers),
                resolvedTraceId,
                resolvedRequestId,
                meetingId
        );
        return requireBody(response, "getAnalysis", meetingId);
    }

    public Map<String, Object> analyzeRealtimeTranscript(
            Long meetingId,
            String transcript,
            String domainMode,
            String source,
            String transcriptHash,
            String traceId
    ) {
        return analyzeRealtimeTranscript(
                meetingId,
                transcript,
                domainMode,
                source,
                transcriptHash,
                null,
                null,
                traceId,
                null
        );
    }

    public Map<String, Object> analyzeRealtimeTranscript(
            Long meetingId,
            String transcript,
            String domainMode,
            String source,
            String transcriptHash,
            String promptVersion,
            String schemaVersion,
            String traceId
    ) {
        return analyzeRealtimeTranscript(
                meetingId,
                transcript,
                domainMode,
                source,
                transcriptHash,
                promptVersion,
                schemaVersion,
                traceId,
                null
        );
    }

    @Retry(name = "ai-service")
    @CircuitBreaker(name = "ai-service")
    @Retryable(
        retryFor = { RestClientException.class, IllegalStateException.class },
        maxAttempts = 3,
        backoff = @Backoff(delay = 1000, multiplier = 2.0)
    )
    public Map<String, Object> analyzeRealtimeTranscript(
            Long meetingId,
            String transcript,
            String domainMode,
            String source,
            String transcriptHash,
            String traceId,
            String authorization
    ) {
        return analyzeRealtimeTranscript(
                meetingId,
                transcript,
                domainMode,
                source,
                transcriptHash,
                null,
                null,
                traceId,
                authorization
        );
    }

    @Retry(name = "ai-service")
    @CircuitBreaker(name = "ai-service")
    @Retryable(
        retryFor = { RestClientException.class, IllegalStateException.class },
        maxAttempts = 3,
        backoff = @Backoff(delay = 1000, multiplier = 2.0)
    )
    public Map<String, Object> analyzeRealtimeTranscript(
            Long meetingId,
            String transcript,
            String domainMode,
            String source,
            String transcriptHash,
            String promptVersion,
            String schemaVersion,
            String traceId,
            String authorization
    ) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        String resolvedRequestId = resolveRequestId(resolvedTraceId);
        headers.add(TRACE_HEADER, resolvedTraceId);
        headers.add(REQUEST_HEADER, resolvedRequestId);
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (StringUtils.hasText(authorization)) {
            headers.add(HttpHeaders.AUTHORIZATION, authorization);
        }

        Map<String, Object> request = new HashMap<>();
        request.put("meeting_id", meetingId);
        request.put("transcript", transcript == null ? "" : transcript);
        if (StringUtils.hasText(domainMode)) {
            request.put("domain_mode", domainMode);
        }
        if (StringUtils.hasText(source)) {
            request.put("source", source);
        }
        if (StringUtils.hasText(transcriptHash)) {
            request.put("transcript_hash", transcriptHash);
        }
        if (StringUtils.hasText(promptVersion)) {
            request.put("prompt_version", promptVersion);
        }
        if (StringUtils.hasText(schemaVersion)) {
            request.put("schema_version", schemaVersion);
        }

        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "analyzeRealtimeTranscript",
                aiUrl + "/api/internal/realtime-analysis",
                HttpMethod.POST,
                new HttpEntity<>(request, headers),
                resolvedTraceId,
                resolvedRequestId,
                meetingId
        );
        return requireBody(response, "analyzeRealtimeTranscript", meetingId);
    }

    @Retry(name = "ai-service")
    @CircuitBreaker(name = "ai-service")
    @Retryable(
        retryFor = { RestClientException.class, IllegalStateException.class },
        maxAttempts = 3,
        backoff = @Backoff(delay = 1000, multiplier = 2.0)
    )
    public Map<String, Object> getStatus(Long meetingId, String traceId) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        String resolvedRequestId = resolveRequestId(resolvedTraceId);
        headers.add(TRACE_HEADER, resolvedTraceId);
        headers.add(REQUEST_HEADER, resolvedRequestId);
        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "getStatus",
                aiUrl + "/api/meeting/" + meetingId + "/status",
                HttpMethod.GET,
                new HttpEntity<>(headers),
                resolvedTraceId,
                resolvedRequestId,
                meetingId
        );
        return requireBody(response, "getStatus", meetingId);
    }

    @Retry(name = "ai-service")
    @CircuitBreaker(name = "ai-service")
    @Retryable(
        retryFor = { RestClientException.class, IllegalStateException.class },
        maxAttempts = 3,
        backoff = @Backoff(delay = 1000, multiplier = 2.0)
    )
    public Map<String, Object> uploadAudio(MultipartFile file, String traceId, String authorization) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        String resolvedRequestId = resolveRequestId(resolvedTraceId);
        headers.add(TRACE_HEADER, resolvedTraceId);
        headers.add(REQUEST_HEADER, resolvedRequestId);
        if (StringUtils.hasText(authorization)) {
            headers.add(HttpHeaders.AUTHORIZATION, authorization);
        }
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);

        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("file", toNamedResource(file));

        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "uploadAudio",
                aiUrl + "/api/upload-audio",
                HttpMethod.POST,
                new HttpEntity<>(body, headers),
                resolvedTraceId,
                resolvedRequestId,
                0L
        );
        return requireBody(response, "uploadAudio", 0L);
    }

    @Retry(name = "ai-service")
    @CircuitBreaker(name = "ai-service")
    @Retryable(
        retryFor = { RestClientException.class, IllegalStateException.class },
        maxAttempts = 3,
        backoff = @Backoff(delay = 1000, multiplier = 2.0)
    )
    public Map<String, Object> streamAudioChunk(
            Long meetingId,
            byte[] audioChunk,
            Long seq,
            String language,
            String speakerMode,
            boolean isFinal,
            String traceId,
            String authorization) {

        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        String resolvedRequestId = resolveRequestId(resolvedTraceId);
        headers.add(TRACE_HEADER, resolvedTraceId);
        headers.add(REQUEST_HEADER, resolvedRequestId);
        if (StringUtils.hasText(authorization)) {
            headers.add(HttpHeaders.AUTHORIZATION, authorization);
        }
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);

        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("meeting_id", String.valueOf(meetingId));
        body.add("audio_chunk", toNamedResource(audioChunk, meetingId, seq));
        body.add("seq", String.valueOf(seq == null ? 0L : seq));
        body.add("language", normalizeRealtimeLanguage(language));
        body.add("speaker_mode", normalizeSpeakerMode(speakerMode));
        body.add("is_final", String.valueOf(isFinal));
        String requestedLanguage = normalizeFallbackLanguage(language);
        String effectiveLanguage = normalizeRealtimeLanguage(language);
        log.info(
                "event=DEEPGRAM_STT_CONFIG traceId={} requestId={} meetingId={} source=realtime requestedLanguage={} effectiveLanguage={} model={}",
                resolvedTraceId,
                resolvedRequestId,
                meetingId,
                requestedLanguage,
                effectiveLanguage,
                "nova-2"
        );
        log.info(
                "AUDIO HASH PROCESSING_OUT meetingId={} seq={} size={} first16hex={}",
                meetingId,
                seq,
                audioChunk == null ? 0 : audioChunk.length,
                first16Hex(audioChunk)
        );

        try {
            ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                    "streamAudioChunk",
                    aiUrl + "/api/v1/stt/stream",
                    HttpMethod.POST,
                    new HttpEntity<>(body, headers),
                    resolvedTraceId,
                    resolvedRequestId,
                    meetingId
            );
            return requireBody(response, "streamAudioChunk", meetingId);
        } catch (HttpClientErrorException ex) {
            if (isFinalizationReplayConflict(ex)) {
                log.info(
                        "AI service reported finalization replay for meetingId={} seq={} as a terminal no-op",
                        meetingId,
                        seq
                );
                return null;
            }

            if (isResetRequiredConflict(ex)) {
                throw new AudioStreamResetRequiredException(meetingId, seq, ex);
            }

            throw ex;
        }
    }

    public void health() {
        probeEndpoint("/health", "health");
    }

    public void ready() {
        probeEndpoint("/ready", "ready");
    }

    private void probeEndpoint(String path, String endpointName) {
        try {
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    aiUrl + path,
                    HttpMethod.GET,
                    null,
                    new ParameterizedTypeReference<>() {
                    }
            );
            if (!response.getStatusCode().is2xxSuccessful()) {
                throw new IllegalStateException(
                    "AI " + endpointName + " endpoint returned non-2xx"
                );
            }
        } catch (RestClientException ex) {
            throw new IllegalStateException(
                "AI " + endpointName + " check failed",
                ex
            );
        }
    }

    private String resolveTraceId(String traceId) {
        if (traceId == null || traceId.isBlank()) {
            return UUID.randomUUID().toString();
        }
        return traceId;
    }

    private String resolveRequestId(String traceId) {
        String requestId = MDC.get("requestId");
        if (requestId != null && !requestId.isBlank()) {
            return requestId;
        }
        if (traceId != null && !traceId.isBlank()) {
            return traceId;
        }
        String mdcTrace = MDC.get("traceId");
        if (mdcTrace != null && !mdcTrace.isBlank()) {
            return mdcTrace;
        }
        return UUID.randomUUID().toString();
    }

    private String normalizeRealtimeLanguage(String language) {
        String defaultLanguage = normalizeFallbackLanguage(deepgramLanguage);
        String requestedLanguage = normalizeFallbackLanguage(language);

        if (VALID_REALTIME_LANGUAGES.contains(requestedLanguage)) {
            return requestedLanguage;
        }

        if (VALID_REALTIME_LANGUAGES.contains(defaultLanguage)) {
            return defaultLanguage;
        }

        return "vi";
    }

    private String normalizeSpeakerMode(String speakerMode) {
        String normalized = normalizeFallbackLanguage(speakerMode);
        if ("multiple".equals(normalized)) {
            return "multiple";
        }
        return "single";
    }

    private String normalizeFallbackLanguage(String candidateLanguage) {
        if (!StringUtils.hasText(candidateLanguage)) {
            return "";
        }

        return candidateLanguage.trim().toLowerCase();
    }

    private ResponseEntity<Map<String, Object>> executeAiServiceCall(
            String operation,
            String url,
            HttpMethod method,
            HttpEntity<?> requestEntity,
            String traceId,
            String requestId,
            Long meetingId
    ) {
        long startedAt = System.currentTimeMillis();
        log.info(
                "event=AI_SERVICE_CALL_STARTED traceId={} requestId={} meetingId={} path={} source={} operation={}",
                traceId,
                requestId,
                meetingId,
                url,
                "processing-api",
                operation
        );
        try {
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    url,
                    method,
                    requestEntity,
                    new ParameterizedTypeReference<>() {
                    }
            );
            log.info(
                    "event=AI_SERVICE_CALL_COMPLETED traceId={} requestId={} meetingId={} path={} operation={} httpStatus={} durationMs={}",
                    traceId,
                    requestId,
                    meetingId,
                    url,
                    operation,
                    response.getStatusCode().value(),
                    System.currentTimeMillis() - startedAt
            );
            return response;
        } catch (RestClientException ex) {
            log.warn(
                    "event=AI_SERVICE_CALL_FAILED traceId={} requestId={} meetingId={} path={} operation={} errorCode={} durationMs={}",
                    traceId,
                    requestId,
                    meetingId,
                    url,
                    operation,
                    ex.getClass().getSimpleName(),
                    System.currentTimeMillis() - startedAt
            );
            throw ex;
        }
    }

    private Map<String, Object> requireBody(ResponseEntity<Map<String, Object>> response, String operation, Long meetingId) {
        Map<String, Object> body = response.getBody();
        if (body == null) {
            throw new IllegalStateException("AI service returned empty body for " + operation + " (meetingId=" + meetingId + ")");
        }
        return body;
    }

    private boolean isFinalizationReplayConflict(HttpClientErrorException exception) {
        if (!HttpStatus.CONFLICT.equals(exception.getStatusCode())) {
            return false;
        }

        String responseBody = exception.getResponseBodyAsString();
        return responseBody.contains("cached_final_response") || responseBody.contains("Meeting already finalized");
    }

    private boolean isResetRequiredConflict(HttpClientErrorException exception) {
        if (!HttpStatus.CONFLICT.equals(exception.getStatusCode())) {
            return false;
        }

        String responseBody = exception.getResponseBodyAsString();
        return responseBody.contains("reset_required") || responseBody.contains("webm_continuation_after_reconnect_blocked");
    }

    private ByteArrayResource toNamedResource(MultipartFile file) {
        try {
            return new ByteArrayResource(file.getBytes()) {
                @Override
                public String getFilename() {
                    if (file.getOriginalFilename() == null || file.getOriginalFilename().isBlank()) {
                        return "audio.webm";
                    }
                    return file.getOriginalFilename();
                }
            };
        } catch (IOException e) {
            throw new IllegalStateException("Unable to read upload payload", e);
        }
    }

    private ByteArrayResource toNamedResource(byte[] audioChunk, Long meetingId, Long seq) {
        // Avoid unnecessary copy - use the original array
        // If audioChunk is empty, use empty array
        final byte[] payload = audioChunk == null ? new byte[0] : audioChunk;
        return new ByteArrayResource(payload) {
            @Override
            public String getFilename() {
                long resolvedSeq = seq == null ? 0L : seq;
                return "meeting-" + meetingId + "-seq-" + resolvedSeq + ".webm";
            }

            @Override
            public long contentLength() {
                // Override to return correct content length without creating additional copies
                return payload.length;
            }
        };
    }

    private String first16Hex(byte[] audioBytes) {
        byte[] payload = audioBytes == null ? new byte[0] : audioBytes;
        return HexFormat.of().formatHex(Arrays.copyOfRange(payload, 0, Math.min(16, payload.length)));
    }
}
