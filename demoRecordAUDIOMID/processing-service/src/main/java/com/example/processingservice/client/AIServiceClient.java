package com.example.processingservice.client;

import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
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
import org.springframework.http.client.BufferingClientHttpRequestFactory;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.retry.annotation.Backoff;
import org.springframework.retry.annotation.Retryable;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.util.StringUtils;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.util.UriComponentsBuilder;

import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import lombok.RequiredArgsConstructor;

import com.example.processingservice.service.TranscriptQualityContext;

@Service
@RequiredArgsConstructor
public class AIServiceClient {

    private static final Set<String> VALID_REALTIME_LANGUAGES = Set.of("vi", "en", "multi");
    private static final String TRACE_HEADER = "x-trace-id";
    private static final String REQUEST_HEADER = "x-request-id";
    private static final String DEFAULT_ANALYSIS_FEATURE_SET = "grouped-action-plan-v1";
    private static final String TRANSCRIPT_NOT_READY_STATUS = "NOT_READY";
    private static final String TRANSCRIPT_NOT_READY_ERROR_CODE = "TRANSCRIPT_NOT_READY";

    private static final Logger log = LoggerFactory.getLogger(AIServiceClient.class);

    private final RestTemplate restTemplate;

    @Value("${ai.service.url}")
    private String aiUrl;

    @Value("${deepgram.language:vi}")
    private String deepgramLanguage;

    public Map<String, Object> processAudio(Long meetingId, String audioPath) {
        return processAudio(meetingId, audioPath, null, null, null, "vi", null, null, null, null);
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
            boolean isFinal,
            String traceId,
            String authorization) {
        return streamAudioChunk(meetingId, audioChunk, seq, language, null, isFinal, traceId, authorization);
    }

    public Map<String, Object> streamAudioChunk(
            Long meetingId,
            String streamId,
            byte[] audioChunk,
            Long seq,
            String language,
            boolean isFinal,
            String traceId,
            String authorization) {
        return streamAudioChunk(meetingId, streamId, audioChunk, seq, language, null, isFinal, traceId, authorization);
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
        return processAudio(
                meetingId,
                audioPath,
                fileId,
                topic,
                glossaryTerms,
                language,
                null,
                traceId,
                authorization,
                null
        );
    }

    public Map<String, Object> processAudio(
            Long meetingId,
            String audioPath,
            String fileId,
            String topic,
            List<String> glossaryTerms,
            String language,
            String domainMode,
            String traceId,
            String authorization,
            Long ownerUserId) {

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

        if (StringUtils.hasText(domainMode)) {
            request.put("domain_mode", domainMode.trim());
        }

        if (ownerUserId != null && ownerUserId > 0) {
            request.put("owner_user_id", ownerUserId);
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
        return getTranscriptInternal(restTemplate, "getTranscript", meetingId, traceId, null, null);
    }

    @Retry(name = "ai-service")
    @CircuitBreaker(name = "ai-service")
    @Retryable(
        retryFor = { RestClientException.class, IllegalStateException.class },
        maxAttempts = 3,
        backoff = @Backoff(delay = 1000, multiplier = 2.0)
    )
    public Map<String, Object> getTranscript(
            Long meetingId,
            String traceId,
            Long recordingSessionId,
            Long attemptId) {
        return getTranscriptInternal(
                restTemplate,
                "getTranscript",
                meetingId,
                traceId,
                recordingSessionId,
                attemptId
        );
    }

    public Map<String, Object> getTranscriptForRecovery(Long meetingId, String traceId, long timeoutMs) {
        return getTranscriptInternal(
                createRecoveryRestTemplate(timeoutMs),
                "getTranscriptRecovery",
                meetingId,
                traceId,
                null,
                null
        );
    }

    public Map<String, Object> getTranscriptForRecovery(
            Long meetingId,
            String traceId,
            long timeoutMs,
            Long recordingSessionId,
            Long attemptId) {
        return getTranscriptInternal(
                createRecoveryRestTemplate(timeoutMs),
                "getTranscriptRecovery",
                meetingId,
                traceId,
                recordingSessionId,
                attemptId
        );
    }

    private Map<String, Object> getTranscriptInternal(
            RestTemplate client,
            String operation,
            Long meetingId,
            String traceId,
            Long recordingSessionId,
            Long attemptId) {
        if ((recordingSessionId == null) != (attemptId == null)) {
            throw new IllegalArgumentException("recordingSessionId and attemptId must be provided together");
        }
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        String resolvedRequestId = resolveRequestId(resolvedTraceId);
        headers.add(TRACE_HEADER, resolvedTraceId);
        headers.add(REQUEST_HEADER, resolvedRequestId);
        String url = buildTranscriptUrl(meetingId, recordingSessionId, attemptId);
        ResponseEntity<Map<String, Object>> response;
        try {
            response = executeAiServiceCall(
                    client,
                    operation,
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    resolvedTraceId,
                    resolvedRequestId,
                    meetingId
            );
        } catch (HttpClientErrorException ex) {
            if (isScopedTranscriptNotReady(operation, recordingSessionId, attemptId, ex)) {
                return buildTranscriptNotReadyResponse(meetingId, recordingSessionId, attemptId);
            }
            throw ex;
        }
        return requireBody(response, operation, meetingId);
    }

    public static boolean isTranscriptNotReadyResponse(Map<String, Object> response) {
        if (response == null) {
            return false;
        }
        Object marker = response.get("transcriptNotReady");
        if (Boolean.TRUE.equals(marker)) {
            return true;
        }
        String status = String.valueOf(response.getOrDefault("status", "")).trim().toUpperCase(Locale.ROOT);
        String errorCode = String.valueOf(response.getOrDefault("errorCode", "")).trim().toUpperCase(Locale.ROOT);
        return TRANSCRIPT_NOT_READY_STATUS.equals(status)
                || TRANSCRIPT_NOT_READY_ERROR_CODE.equals(errorCode);
    }

    private boolean isScopedTranscriptNotReady(
            String operation,
            Long recordingSessionId,
            Long attemptId,
            HttpClientErrorException ex) {
        return operation != null
                && operation.startsWith("getTranscript")
                && recordingSessionId != null
                && attemptId != null
                && ex.getStatusCode() == HttpStatus.NOT_FOUND;
    }

    private Map<String, Object> buildTranscriptNotReadyResponse(
            Long meetingId,
            Long recordingSessionId,
            Long attemptId) {
        Map<String, Object> response = new HashMap<>();
        response.put("meeting_id", meetingId);
        response.put("recording_session_id", recordingSessionId);
        response.put("attempt_id", attemptId);
        response.put("transcripts", List.of());
        response.put("status", TRANSCRIPT_NOT_READY_STATUS);
        response.put("errorCode", TRANSCRIPT_NOT_READY_ERROR_CODE);
        response.put("transcriptNotReady", true);
        return response;
    }

    private String buildTranscriptUrl(Long meetingId, Long recordingSessionId, Long attemptId) {
        UriComponentsBuilder builder = UriComponentsBuilder
                .fromUriString(aiUrl)
                .pathSegment("api", "meeting", String.valueOf(meetingId), "transcript");
        if (recordingSessionId != null) {
            builder.queryParam("recording_session_id", recordingSessionId);
            builder.queryParam("attempt_id", attemptId);
        }
        return builder.toUriString();
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

    @Retry(name = "ai-service")
    @CircuitBreaker(name = "ai-service")
    @Retryable(
        retryFor = { RestClientException.class, IllegalStateException.class },
        maxAttempts = 3,
        backoff = @Backoff(delay = 1000, multiplier = 2.0)
    )
    public Map<String, Object> rerunAnalysis(
            Long meetingId,
            String mode,
            String reason,
            String transcript,
            String transcriptHash,
            String promptVersion,
            String schemaVersion,
            String canonicalTranscriptHash,
            String canonicalTranscriptVersion,
            String traceId,
            String authorization) {
        return rerunAnalysis(
                meetingId,
                mode,
                reason,
                transcript,
                transcriptHash,
                promptVersion,
                schemaVersion,
                DEFAULT_ANALYSIS_FEATURE_SET,
                canonicalTranscriptHash,
                canonicalTranscriptVersion,
                null,
                traceId,
                authorization
        );
    }

    public Map<String, Object> rerunAnalysis(
            Long meetingId,
            String mode,
            String reason,
            String transcript,
            String transcriptHash,
            String promptVersion,
            String schemaVersion,
            String analysisFeatureSet,
            String canonicalTranscriptHash,
            String canonicalTranscriptVersion,
            String domainMode,
            String traceId,
            String authorization) {
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
        request.put("mode", StringUtils.hasText(mode) ? mode : "force");
        request.put("reason", StringUtils.hasText(reason) ? reason : "manual_reanalyze");
        if (StringUtils.hasText(transcript)) {
            request.put("transcript", transcript);
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
        if (StringUtils.hasText(analysisFeatureSet)) {
            request.put("analysis_feature_set", analysisFeatureSet);
        }
        if (StringUtils.hasText(canonicalTranscriptHash)) {
            request.put("canonical_transcript_hash", canonicalTranscriptHash);
        }
        if (StringUtils.hasText(canonicalTranscriptVersion)) {
            request.put("canonical_transcript_version", canonicalTranscriptVersion);
        }
        if (StringUtils.hasText(domainMode)) {
            request.put("domain_mode", domainMode.trim());
        }

        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "rerunAnalysis",
                aiUrl + "/api/meeting/" + meetingId + "/analysis/rerun",
                HttpMethod.POST,
                new HttpEntity<>(request, headers),
                resolvedTraceId,
                resolvedRequestId,
                meetingId
        );
        return requireBody(response, "rerunAnalysis", meetingId);
    }

    public Map<String, Object> answerMeetingChat(
            Long meetingId,
            String question,
            String summary,
            String transcriptExcerpt,
            Map<String, Object> analysis,
            List<Map<String, Object>> sourceSegments,
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
        request.put("question", question);
        request.put("summary", summary);
        request.put("transcript_excerpt", transcriptExcerpt);
        request.put("analysis", analysis == null ? Map.of() : analysis);
        request.put("source_segments", sourceSegments == null ? List.of() : sourceSegments);

        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "answerMeetingChat",
                aiUrl + "/api/meeting/" + meetingId + "/chat",
                HttpMethod.POST,
                new HttpEntity<>(request, headers),
                resolvedTraceId,
                resolvedRequestId,
                meetingId
        );
        return requireBody(response, "answerMeetingChat", meetingId);
    }

    public Map<String, Object> semanticRerankMeetings(
            String query,
            List<Map<String, Object>> candidates,
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
        request.put("query", query);
        request.put("candidates", candidates == null ? List.of() : candidates);

        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "semanticRerankMeetings",
                aiUrl + "/api/search/semantic-rerank",
                HttpMethod.POST,
                new HttpEntity<>(request, headers),
                resolvedTraceId,
                resolvedRequestId,
                null
        );
        return requireBody(response, "semanticRerankMeetings", null);
    }

    public Map<String, Object> askCrossMeeting(
            String question,
            List<Map<String, Object>> meetings,
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
        request.put("question", question);
        request.put("meetings", meetings == null ? List.of() : meetings);
        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "askCrossMeeting",
                aiUrl + "/api/search/cross-meeting/ask",
                HttpMethod.POST,
                new HttpEntity<>(request, headers),
                resolvedTraceId,
                resolvedRequestId,
                null
        );
        return requireBody(response, "askCrossMeeting", null);
    }

    public Map<String, Object> explainMeetingTerm(
            Long meetingId,
            String term,
            String summary,
            String transcriptExcerpt,
            Map<String, Object> analysis,
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
        request.put("term", term);
        request.put("summary", summary);
        request.put("transcript_excerpt", transcriptExcerpt);
        request.put("analysis", analysis == null ? Map.of() : analysis);

        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "explainMeetingTerm",
                aiUrl + "/api/meeting/" + meetingId + "/terms/explain",
                HttpMethod.POST,
                new HttpEntity<>(request, headers),
                resolvedTraceId,
                resolvedRequestId,
                meetingId
        );
        return requireBody(response, "explainMeetingTerm", meetingId);
    }

    public Map<String, Object> getSavedAnalysisCacheOnly(
            Long meetingId,
            String transcript,
            String transcriptHash,
            String promptVersion,
            String schemaVersion,
            String traceId,
            String authorization
    ) {
        return getSavedAnalysisCacheOnly(
                meetingId,
                transcript,
                transcriptHash,
                promptVersion,
                schemaVersion,
                DEFAULT_ANALYSIS_FEATURE_SET,
                traceId,
                authorization
        );
    }

    public Map<String, Object> getSavedAnalysisCacheOnly(
            Long meetingId,
            String transcript,
            String transcriptHash,
            String promptVersion,
            String schemaVersion,
            String analysisFeatureSet,
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
        request.put("domain_mode", "it");
        request.put("source", "export_report");
        request.put("mode", "cache_only");
        if (StringUtils.hasText(transcriptHash)) {
            request.put("transcript_hash", transcriptHash);
        }
        if (StringUtils.hasText(promptVersion)) {
            request.put("prompt_version", promptVersion);
        }
        if (StringUtils.hasText(schemaVersion)) {
            request.put("schema_version", schemaVersion);
        }
        if (StringUtils.hasText(analysisFeatureSet)) {
            request.put("analysis_feature_set", analysisFeatureSet);
        }

        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "getSavedAnalysisCacheOnly",
                aiUrl + "/api/internal/realtime-analysis",
                HttpMethod.POST,
                new HttpEntity<>(request, headers),
                resolvedTraceId,
                resolvedRequestId,
                meetingId
        );
        return requireBody(response, "getSavedAnalysisCacheOnly", meetingId);
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
                DEFAULT_ANALYSIS_FEATURE_SET,
                traceId,
                null
        );
    }

    @Retry(name = "ai-service")
    @CircuitBreaker(name = "ai-service")
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
                DEFAULT_ANALYSIS_FEATURE_SET,
                traceId,
                authorization
        );
    }

    @Retry(name = "ai-service")
    @CircuitBreaker(name = "ai-service")
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
        return analyzeRealtimeTranscript(
                meetingId,
                transcript,
                domainMode,
                source,
                transcriptHash,
                promptVersion,
                schemaVersion,
                DEFAULT_ANALYSIS_FEATURE_SET,
                traceId,
                authorization
        );
    }

    @Retry(name = "ai-service")
    @CircuitBreaker(name = "ai-service")
    public Map<String, Object> analyzeRealtimeTranscript(
            Long meetingId,
            String transcript,
            String domainMode,
            String source,
            String transcriptHash,
            String promptVersion,
            String schemaVersion,
            String analysisFeatureSet,
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
        if (StringUtils.hasText(analysisFeatureSet)) {
            request.put("analysis_feature_set", analysisFeatureSet);
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

    public Map<String, Object> runFinalAudioFallback(
            Long meetingId,
            String audioPath,
            String language,
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
        body.add("audio_path", audioPath);
        body.add("language", normalizeRealtimeLanguage(language));

        log.info(
                "event=REALTIME_FINAL_AUDIO_FALLBACK_REQUESTED traceId={} requestId={} meetingId={} source=final_audio_fallback",
                resolvedTraceId,
                resolvedRequestId,
                meetingId
        );

        ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                "runFinalAudioFallback",
                aiUrl + "/api/v1/stt/final-audio-fallback",
                HttpMethod.POST,
                new HttpEntity<>(body, headers),
                resolvedTraceId,
                resolvedRequestId,
                meetingId
        );
        return requireBody(response, "runFinalAudioFallback", meetingId);
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
        return streamAudioChunk(
                meetingId,
                null,
                audioChunk,
                seq,
                language,
                speakerMode,
                isFinal,
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
    public Map<String, Object> streamAudioChunk(
            Long meetingId,
            byte[] audioChunk,
            Long seq,
            String language,
            String speakerMode,
            boolean isFinal,
            String traceId,
            String authorization,
            Long recordingSessionId,
            Long attemptId) {
        return streamAudioChunk(
                meetingId,
                null,
                audioChunk,
                seq,
                language,
                speakerMode,
                isFinal,
                traceId,
                authorization,
                recordingSessionId,
                attemptId
        );
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
            String streamId,
            byte[] audioChunk,
            Long seq,
            String language,
            String speakerMode,
            boolean isFinal,
            String traceId,
            String authorization) {
        return streamAudioChunk(
                meetingId,
                streamId,
                audioChunk,
                seq,
                language,
                speakerMode,
                isFinal,
                traceId,
                authorization,
                null,
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
    public Map<String, Object> streamAudioChunk(
            Long meetingId,
            String streamId,
            byte[] audioChunk,
            Long seq,
            String language,
            String speakerMode,
            boolean isFinal,
            String traceId,
            String authorization,
            Long recordingSessionId,
            Long attemptId) {
        if ((recordingSessionId == null) != (attemptId == null)) {
            throw new IllegalArgumentException("recordingSessionId and attemptId must be provided together");
        }
        String normalizedStreamId = null;
        if (StringUtils.hasText(streamId)) {
            normalizedStreamId = streamId.trim().toLowerCase();
            if ("default".equals(normalizedStreamId)) {
                throw new IllegalArgumentException("stream_id=default is display-only and must not be sent");
            }
        }

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
        if (StringUtils.hasText(normalizedStreamId)) {
            body.add("stream_id", normalizedStreamId);
        }
        body.add("audio_chunk", toNamedResource(audioChunk, meetingId, seq));
        body.add("seq", String.valueOf(seq == null ? 0L : seq));
        body.add("language", normalizeRealtimeLanguage(language));
        body.add("speaker_mode", normalizeSpeakerMode(speakerMode));
        body.add("is_final", String.valueOf(isFinal));
        if (recordingSessionId != null) {
            body.add("recording_session_id", String.valueOf(recordingSessionId));
            body.add("attempt_id", String.valueOf(attemptId));
        }
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
                "AUDIO_CHUNK_PROCESSING_OUT meetingId={} seq={} byteLength={}",
                meetingId,
                seq,
                audioChunk == null ? 0 : audioChunk.length
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

            if (isTerminalStreamConflict(ex)) {
                log.info(
                        "AI service reported terminal stream conflict for meetingId={} seq={} as controlled no-op",
                        meetingId,
                        seq
                );
                return null;
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
        return executeAiServiceCall(restTemplate, operation, url, method, requestEntity, traceId, requestId, meetingId);
    }

    private ResponseEntity<Map<String, Object>> executeAiServiceCall(
            RestTemplate client,
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
            ResponseEntity<Map<String, Object>> response = client.exchange(
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
            if (isExpectedTranscriptNotReady(operation, url, ex)) {
                HttpStatusCodeException statusException = (HttpStatusCodeException) ex;
                log.info(
                        "event=TRANSCRIPT_GET_NOT_READY traceId={} requestId={} meetingId={} path={} operation={} httpStatus={} durationMs={}",
                        traceId,
                        requestId,
                        meetingId,
                        url,
                        operation,
                        statusException.getStatusCode().value(),
                        System.currentTimeMillis() - startedAt
                );
                throw ex;
            }
            if (isExpectedAnalysisNotReady(operation, ex)) {
                HttpStatusCodeException statusException = (HttpStatusCodeException) ex;
                log.info(
                        "event=ANALYSIS_GET_NOT_READY traceId={} requestId={} meetingId={} path={} operation={} httpStatus={} errorCode={} durationMs={}",
                        traceId,
                        requestId,
                        meetingId,
                        url,
                        operation,
                        statusException.getStatusCode().value(),
                        ex.getClass().getSimpleName(),
                        System.currentTimeMillis() - startedAt
                );
                throw ex;
            }
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

    private boolean isExpectedTranscriptNotReady(String operation, String url, RestClientException ex) {
        return operation != null
                && operation.startsWith("getTranscript")
                && url != null
                && url.contains("recording_session_id=")
                && ex instanceof HttpStatusCodeException statusException
                && statusException.getStatusCode() == HttpStatus.NOT_FOUND;
    }

    private RestTemplate createRecoveryRestTemplate(long timeoutMs) {
        int boundedTimeoutMs = (int) Math.min(Integer.MAX_VALUE, Math.max(100L, timeoutMs));
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(boundedTimeoutMs);
        factory.setReadTimeout(boundedTimeoutMs);
        return new RestTemplate(new BufferingClientHttpRequestFactory(factory));
    }

    private boolean isExpectedAnalysisNotReady(String operation, RestClientException ex) {
        return "getAnalysis".equals(operation)
                && ex instanceof HttpStatusCodeException statusException
                && HttpStatus.NOT_FOUND.equals(statusException.getStatusCode());
    }

    private Map<String, Object> requireBody(ResponseEntity<Map<String, Object>> response, String operation, Long meetingId) {
        Map<String, Object> body = response.getBody();
        if (body == null) {
            throw new IllegalStateException("AI service returned empty body for " + operation + " (meetingId=" + meetingId + ")");
        }
        return body;
    }

    public boolean isTerminalStreamConflict(HttpClientErrorException exception) {
        if (!HttpStatus.CONFLICT.equals(exception.getStatusCode())) {
            return false;
        }
        if (isFinalizationReplayConflict(exception) || isResetRequiredConflict(exception)) {
            return true;
        }
        String conflictDetail = exception.getResponseBodyAsString().toLowerCase(Locale.ROOT);
        return conflictDetail.contains("stt stream failed")
                || conflictDetail.contains("ownership lost")
                || conflictDetail.contains("meeting stt ownership")
                || conflictDetail.contains("already finalized")
                || conflictDetail.contains("cached_final_response")
                || conflictDetail.contains("stt_shutdown_close_expected")
                || conflictDetail.contains("session is not connected")
                || conflictDetail.contains("websocket closed");
    }

    private boolean isFinalizationReplayConflict(HttpClientErrorException exception) {
        if (!HttpStatus.CONFLICT.equals(exception.getStatusCode())) {
            return false;
        }

        String conflictDetail = exception.getResponseBodyAsString();
        return conflictDetail.contains("cached_final_response") || conflictDetail.contains("Meeting already finalized");
    }

    private boolean isResetRequiredConflict(HttpClientErrorException exception) {
        if (!HttpStatus.CONFLICT.equals(exception.getStatusCode())) {
            return false;
        }

        String conflictDetail = exception.getResponseBodyAsString();
        return conflictDetail.contains("reset_required") || conflictDetail.contains("webm_continuation_after_reconnect_blocked");
    }

    public void requestCanonicalize(Long meetingId, Long runId, String traceId) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        String resolvedRequestId = resolveRequestId(resolvedTraceId);
        headers.add(TRACE_HEADER, resolvedTraceId);
        headers.add(REQUEST_HEADER, resolvedRequestId);
        headers.setContentType(MediaType.APPLICATION_JSON);

        Map<String, Object> body = new HashMap<>();
        if (runId != null) {
            body.put("runId", runId);
        }

        try {
            executeAiServiceCall(
                    "requestCanonicalize",
                    aiUrl + "/api/internal/meetings/" + meetingId + "/canonicalize",
                    HttpMethod.POST,
                    new HttpEntity<>(body, headers),
                    resolvedTraceId,
                    resolvedRequestId,
                    meetingId
            );
        } catch (Exception ex) {
            log.warn(
                    "event=TRANSCRIPT_QUALITY_CANONICALIZE_FAILED meetingId={} errorCode={}",
                    meetingId,
                    ex.getClass().getSimpleName()
            );
        }
    }

    public TranscriptQualityContext getTranscriptQuality(Long meetingId, String traceId) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        String resolvedRequestId = resolveRequestId(resolvedTraceId);
        headers.add(TRACE_HEADER, resolvedTraceId);
        headers.add(REQUEST_HEADER, resolvedRequestId);
        try {
            ResponseEntity<Map<String, Object>> response = executeAiServiceCall(
                    "getTranscriptQuality",
                    aiUrl + "/api/internal/meetings/" + meetingId + "/transcript-quality",
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    resolvedTraceId,
                    resolvedRequestId,
                    meetingId
            );
            Map<String, Object> body = requireBody(response, "getTranscriptQuality", meetingId);
            return mapTranscriptQualityContext(body);
        } catch (Exception ex) {
            log.warn(
                    "event=TRANSCRIPT_QUALITY_NOT_READY meetingId={} reason=http_error",
                    meetingId
            );
            return TranscriptQualityContext.empty();
        }
    }

    @SuppressWarnings("unchecked")
    private TranscriptQualityContext mapTranscriptQualityContext(Map<String, Object> body) {
        if (body == null || !Boolean.TRUE.equals(body.get("ready"))) {
            return TranscriptQualityContext.empty();
        }
        Object rowsRaw = body.get("canonicalTranscriptRows");
        List<Map<String, Object>> rows = rowsRaw instanceof List<?> list
                ? (List<Map<String, Object>>) list
                : List.of();
        Object statsRaw = body.get("evidenceStats");
        Map<String, Object> stats = statsRaw instanceof Map<?, ?> map
                ? (Map<String, Object>) map
                : Map.of();
        return new TranscriptQualityContext(
                body.get("canonicalTranscriptVersion") == null
                        ? null
                        : String.valueOf(body.get("canonicalTranscriptVersion")),
                body.get("canonicalTranscriptHash") == null
                        ? null
                        : String.valueOf(body.get("canonicalTranscriptHash")),
                rows,
                stats
        );
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

}
