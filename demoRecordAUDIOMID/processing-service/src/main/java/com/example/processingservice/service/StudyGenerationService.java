package com.example.processingservice.service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.client.UserQuotaClient;
import com.example.processingservice.controller.ErrorCode;

import lombok.RequiredArgsConstructor;

@Service
@RequiredArgsConstructor
public class StudyGenerationService {

    private static final Logger log = LoggerFactory.getLogger(StudyGenerationService.class);

    private final MeetingServiceClient meetingServiceClient;
    private final AIServiceClient aiServiceClient;
    private final UserQuotaClient userQuotaClient;

    @Value("${study.quota.gemini-chars-per-artifact:8000}")
    private long geminiCharsPerArtifact;

    public Map<String, Object> createOrGetSynthesis(
            Long subjectId,
            Long ownerUserId,
            List<Long> meetingIds,
            String sourceSelectionMode,
            String language,
            boolean force,
            String traceId,
            String authorization) {
        List<Long> resolvedMeetingIds = resolveAndValidateMeetings(
                subjectId, ownerUserId, meetingIds, sourceSelectionMode, traceId, authorization);

        Map<String, Object> prepareBody = new HashMap<>();
        prepareBody.put("ownerUserId", ownerUserId);
        prepareBody.put("subjectId", subjectId);
        prepareBody.put("meetingIds", resolvedMeetingIds);
        prepareBody.put(
                "sourceSelectionMode",
                normalizeMode(sourceSelectionMode, meetingIds));
        prepareBody.put("language", language == null || language.isBlank() ? "vi" : language);
        prepareBody.put("force", force);

        Map<String, Object> prepared;
        try {
            prepared = aiServiceClient.prepareSubjectSynthesis(prepareBody, traceId);
        } catch (HttpStatusCodeException ex) {
            throw mapAiException(ex);
        }

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> newlyCreated = (List<Map<String, Object>>) prepared.getOrDefault(
                "newlyCreated", List.of());
        if (newlyCreated == null || newlyCreated.isEmpty()) {
            Object synthesis = prepared.get("synthesis");
            if (synthesis instanceof Map<?, ?> map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> cast = new HashMap<>((Map<String, Object>) map);
                cast.put("cacheHit", Boolean.TRUE.equals(cast.get("cacheHit"))
                        || "cacheHit".equals(prepared.get("kind")));
                return cast;
            }
            return prepared;
        }

        Object idObj = newlyCreated.get(0).get("id");
        Long synthesisId = idObj instanceof Number n ? n.longValue() : null;
        if (!consumeQuota(ownerUserId, 1)) {
            if (synthesisId != null) {
                aiServiceClient.markStudyQuotaFailed(
                        Map.of("ownerUserId", ownerUserId, "synthesisIds", List.of(synthesisId), "artifactIds", List.of()),
                        traceId);
            }
            throw new ResponseStatusException(HttpStatus.PAYMENT_REQUIRED, ErrorCode.QUOTA_EXCEEDED.name());
        }
        aiServiceClient.dispatchStudyJobs(
                Map.of(
                        "ownerUserId", ownerUserId,
                        "synthesisIds", List.of(synthesisId),
                        "artifactIds", List.of()),
                traceId);
        @SuppressWarnings("unchecked")
        Map<String, Object> synthesis = new HashMap<>((Map<String, Object>) newlyCreated.get(0));
        synthesis.put("cacheHit", false);
        return synthesis;
    }

    public Map<String, Object> getSynthesis(
            Long subjectId,
            Long ownerUserId,
            String traceId,
            String authorization) {
        List<Long> allMeetingIds = listSubjectMeetingIds(subjectId, traceId, authorization);
        try {
            return aiServiceClient.getSubjectSynthesis(subjectId, ownerUserId, allMeetingIds, traceId);
        } catch (HttpStatusCodeException ex) {
            throw mapAiException(ex);
        }
    }

    public Map<String, Object> createStudyArtifacts(
            Long ownerUserId,
            Long subjectId,
            List<Long> meetingIds,
            List<String> artifactTypes,
            String sourceSelectionMode,
            Map<String, Object> options,
            Long synthesisId,
            boolean force,
            String traceId,
            String authorization) {
        List<Long> resolvedMeetingIds = resolveAndValidateMeetings(
                subjectId, ownerUserId, meetingIds, sourceSelectionMode, traceId, authorization);

        Map<String, Object> prepareBody = new HashMap<>();
        prepareBody.put("ownerUserId", ownerUserId);
        prepareBody.put("subjectId", subjectId);
        prepareBody.put("meetingIds", resolvedMeetingIds);
        prepareBody.put("artifactTypes", artifactTypes == null ? List.of() : artifactTypes);
        prepareBody.put("sourceSelectionMode", normalizeMode(sourceSelectionMode, meetingIds));
        prepareBody.put("options", options == null ? Map.of() : options);
        prepareBody.put("synthesisId", synthesisId);
        prepareBody.put("force", force);

        Map<String, Object> prepared;
        try {
            prepared = aiServiceClient.prepareStudyArtifacts(prepareBody, traceId);
        } catch (HttpStatusCodeException ex) {
            throw mapAiException(ex);
        }

        @SuppressWarnings("unchecked")
        List<Number> newlyCreatedIds = (List<Number>) prepared.getOrDefault("newlyCreatedArtifactIds", List.of());
        List<Long> toDispatch = newlyCreatedIds == null
                ? List.of()
                : newlyCreatedIds.stream().filter(Objects::nonNull).map(Number::longValue).toList();

        if (!toDispatch.isEmpty()) {
            if (!consumeQuota(ownerUserId, toDispatch.size())) {
                aiServiceClient.markStudyQuotaFailed(
                        Map.of(
                                "ownerUserId", ownerUserId,
                                "synthesisIds", List.of(),
                                "artifactIds", toDispatch),
                        traceId);
                throw new ResponseStatusException(HttpStatus.PAYMENT_REQUIRED, ErrorCode.QUOTA_EXCEEDED.name());
            }
            aiServiceClient.dispatchStudyJobs(
                    Map.of(
                            "ownerUserId", ownerUserId,
                            "synthesisIds", List.of(),
                            "artifactIds", toDispatch),
                    traceId);
        }
        return prepared;
    }

    public Map<String, Object> getArtifact(
            Long artifactId,
            Long ownerUserId,
            String traceId,
            String authorization) {
        try {
            Map<String, Object> artifact = aiServiceClient.getStudyArtifact(
                    artifactId, ownerUserId, List.of(), traceId);
            Object subjectIdObj = artifact.get("subjectId");
            if (subjectIdObj instanceof Number subjectId) {
                List<Long> meetingIds = listSubjectMeetingIds(subjectId.longValue(), traceId, authorization);
                return aiServiceClient.getStudyArtifact(artifactId, ownerUserId, meetingIds, traceId);
            }
            return artifact;
        } catch (HttpStatusCodeException ex) {
            throw mapAiException(ex);
        }
    }

    public Map<String, Object> listArtifacts(
            Long subjectId,
            Long ownerUserId,
            String artifactType,
            String status,
            String traceId,
            String authorization) {
        // ownership check via subject fetch
        meetingServiceClient.getSubjectById(subjectId, traceId, authorization);
        try {
            return aiServiceClient.listStudyArtifacts(subjectId, ownerUserId, artifactType, status, traceId);
        } catch (HttpStatusCodeException ex) {
            throw mapAiException(ex);
        }
    }

    public Map<String, Object> deleteArtifact(
            Long artifactId,
            Long ownerUserId,
            String traceId) {
        try {
            return aiServiceClient.deleteStudyArtifact(artifactId, ownerUserId, traceId);
        } catch (HttpStatusCodeException ex) {
            throw mapAiException(ex);
        }
    }

    private boolean consumeQuota(Long ownerUserId, int newlyCreatedCount) {
        long chars = Math.max(0, newlyCreatedCount) * Math.max(0, geminiCharsPerArtifact);
        UserQuotaClient.QuotaConsumeResult result = userQuotaClient.consume(ownerUserId, 0, chars);
        if (!result.allowed()) {
            log.warn("event=STUDY_QUOTA_DENIED userId={} newlyCreated={}", ownerUserId, newlyCreatedCount);
        }
        return result.allowed();
    }

    private String normalizeMode(String sourceSelectionMode, List<Long> meetingIds) {
        if (meetingIds != null && !meetingIds.isEmpty()) {
            return "EXPLICIT";
        }
        if (sourceSelectionMode == null || sourceSelectionMode.isBlank()) {
            return "ALL_READY";
        }
        return sourceSelectionMode.trim().toUpperCase();
    }

    private List<Long> resolveAndValidateMeetings(
            Long subjectId,
            Long ownerUserId,
            List<Long> requestedMeetingIds,
            String sourceSelectionMode,
            String traceId,
            String authorization) {
        meetingServiceClient.getSubjectById(subjectId, traceId, authorization);
        List<Map<String, Object>> meetings = meetingServiceClient.listAllSubjectMeetings(
                subjectId, traceId, authorization);
        Set<Long> subjectMeetingIds = new LinkedHashSet<>();
        for (Map<String, Object> meeting : meetings) {
            Object id = meeting.get("id");
            if (id instanceof Number n) {
                subjectMeetingIds.add(n.longValue());
            }
        }

        String mode = normalizeMode(sourceSelectionMode, requestedMeetingIds);
        List<Long> selected;
        if ("EXPLICIT".equals(mode)) {
            if (requestedMeetingIds == null || requestedMeetingIds.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR.name());
            }
            Set<Long> unique = new LinkedHashSet<>(requestedMeetingIds);
            if (unique.size() != requestedMeetingIds.size()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR.name());
            }
            for (Long meetingId : unique) {
                if (!subjectMeetingIds.contains(meetingId)) {
                    throw new ResponseStatusException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN.name());
                }
                Map<String, Object> meeting = meetingServiceClient.getMeetingById(meetingId, traceId, authorization);
                Object owner = meeting.get("ownerUserId");
                if (owner instanceof Number n && n.longValue() != ownerUserId) {
                    throw new ResponseStatusException(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN.name());
                }
            }
            selected = new ArrayList<>(unique);
        } else {
            selected = new ArrayList<>(subjectMeetingIds);
            if (selected.isEmpty()) {
                throw new ResponseStatusException(
                        HttpStatus.CONFLICT,
                        ErrorCode.SOURCE_MEETINGS_NOT_READY.name());
            }
        }
        return selected;
    }

    private List<Long> listSubjectMeetingIds(Long subjectId, String traceId, String authorization) {
        return meetingServiceClient.listAllSubjectMeetings(subjectId, traceId, authorization).stream()
                .map(m -> m.get("id"))
                .filter(Number.class::isInstance)
                .map(Number.class::cast)
                .map(Number::longValue)
                .collect(Collectors.toList());
    }

    private ResponseStatusException mapAiException(HttpStatusCodeException ex) {
        if (ex.getStatusCode().value() == 409) {
            String body = ex.getResponseBodyAsString();
            if (body != null && body.contains("SOURCE_MEETINGS_NOT_READY")) {
                return new ResponseStatusException(HttpStatus.CONFLICT, ErrorCode.SOURCE_MEETINGS_NOT_READY.name(), ex);
            }
            return new ResponseStatusException(HttpStatus.CONFLICT, ErrorCode.CONFLICT.name(), ex);
        }
        if (ex.getStatusCode().value() == 404) {
            return new ResponseStatusException(HttpStatus.NOT_FOUND, ErrorCode.RESOURCE_NOT_FOUND.name(), ex);
        }
        if (ex.getStatusCode().value() == 400) {
            return new ResponseStatusException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR.name(), ex);
        }
        return new ResponseStatusException(HttpStatus.BAD_GATEWAY, ErrorCode.AI_SERVICE_UNAVAILABLE.name(), ex);
    }
}
