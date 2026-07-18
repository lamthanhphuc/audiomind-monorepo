package com.example.processingservice.service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.client.UserQuotaClient;
import com.example.processingservice.client.UserQuotaClient.QuotaConsumeStatus;
import com.example.processingservice.controller.ErrorCode;

import lombok.RequiredArgsConstructor;

@Service
@RequiredArgsConstructor
public class StudyGenerationService {

    private static final Logger log = LoggerFactory.getLogger(StudyGenerationService.class);

    static final String QUOTA_TYPE_SUBJECT_SYNTHESIS = "SUBJECT_SYNTHESIS";
    static final String QUOTA_TYPE_STUDY_ARTIFACT = "STUDY_ARTIFACT";

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
            prepared = new HashMap<>(aiServiceClient.prepareSubjectSynthesis(prepareBody, traceId));
        } catch (HttpStatusCodeException ex) {
            throw mapAiException(ex);
        }

        List<Long> newlyCreatedIds = extractLongIds(prepared, "newlyCreated", "newlyCreatedSynthesisIds");
        List<Long> dispatchableIds = extractLongIds(
                prepared, "dispatchableIds", "dispatchableSynthesisIds");

        List<Long> allowedNewlyCreated = List.of();
        if (!newlyCreatedIds.isEmpty()) {
            QuotaBatchOutcome outcome = consumeQuotaPerId(ownerUserId, newlyCreatedIds, true);
            applyQuotaOutcome(ownerUserId, outcome, true, traceId);
            annotatePreparedWithQuota(prepared, outcome);
            allowedNewlyCreated = outcome.allowedIds();
            if (!allowedNewlyCreated.isEmpty()) {
                confirmQuota(ownerUserId, allowedNewlyCreated, List.of(), traceId);
            }
        }

        LinkedHashSet<Long> toDispatch = new LinkedHashSet<>(dispatchableIds);
        toDispatch.addAll(allowedNewlyCreated);
        if (!toDispatch.isEmpty()) {
            dispatchJobs(ownerUserId, new ArrayList<>(toDispatch), List.of(), traceId);
        }

        if (!newlyCreatedIds.isEmpty()) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> newlyCreated = (List<Map<String, Object>>) prepared.getOrDefault(
                    "newlyCreated", List.of());
            if (newlyCreated != null && !newlyCreated.isEmpty()) {
                @SuppressWarnings("unchecked")
                Map<String, Object> synthesis = new HashMap<>((Map<String, Object>) newlyCreated.get(0));
                synthesis.put("cacheHit", false);
                if (prepared.containsKey("partialQuota")) {
                    synthesis.put("partialQuota", prepared.get("partialQuota"));
                }
                if (prepared.containsKey("quotaDetails")) {
                    synthesis.put("quotaDetails", prepared.get("quotaDetails"));
                }
                if (prepared.containsKey("status")) {
                    synthesis.put("status", prepared.get("status"));
                }
                return synthesis;
            }
        }

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
            prepared = new HashMap<>(aiServiceClient.prepareStudyArtifacts(prepareBody, traceId));
        } catch (HttpStatusCodeException ex) {
            throw mapAiException(ex);
        }

        List<Long> newlyCreatedIds = extractLongIds(
                prepared, "newlyCreatedArtifactIds", "newlyCreated");
        List<Long> dispatchableIds = extractLongIds(
                prepared, "dispatchableIds", "dispatchableArtifactIds");

        // Orphan dispatchable rows already have quota confirmed — consume only for newlyCreated.
        List<Long> allowedNewlyCreated = List.of();
        if (!newlyCreatedIds.isEmpty()) {
            QuotaBatchOutcome outcome = consumeQuotaPerId(ownerUserId, newlyCreatedIds, false);
            applyQuotaOutcome(ownerUserId, outcome, false, traceId);
            annotatePreparedWithQuota(prepared, outcome);
            allowedNewlyCreated = outcome.allowedIds();
            if (!allowedNewlyCreated.isEmpty()) {
                confirmQuota(ownerUserId, List.of(), allowedNewlyCreated, traceId);
            }
        }

        LinkedHashSet<Long> toDispatch = new LinkedHashSet<>(dispatchableIds);
        toDispatch.addAll(allowedNewlyCreated);
        if (!toDispatch.isEmpty()) {
            dispatchJobs(ownerUserId, List.of(), new ArrayList<>(toDispatch), traceId);
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
            Integer page,
            Integer size,
            String sort,
            String traceId,
            String authorization) {
        meetingServiceClient.getSubjectById(subjectId, traceId, authorization);
        List<Long> meetingIds = listSubjectMeetingIds(subjectId, traceId, authorization);
        try {
            return aiServiceClient.listStudyArtifacts(
                    subjectId,
                    ownerUserId,
                    artifactType,
                    status,
                    meetingIds,
                    page,
                    size,
                    sort,
                    traceId);
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

    private void confirmQuota(
            Long ownerUserId,
            List<Long> synthesisIds,
            List<Long> artifactIds,
            String traceId) {
        aiServiceClient.confirmStudyQuota(
                Map.of(
                        "ownerUserId", ownerUserId,
                        "synthesisIds", synthesisIds,
                        "artifactIds", artifactIds),
                traceId);
    }

    private void dispatchJobs(
            Long ownerUserId,
            List<Long> synthesisIds,
            List<Long> artifactIds,
            String traceId) {
        try {
            aiServiceClient.dispatchStudyJobs(
                    Map.of(
                            "ownerUserId", ownerUserId,
                            "synthesisIds", synthesisIds,
                            "artifactIds", artifactIds),
                    traceId);
        } catch (RestClientException | IllegalStateException ex) {
            log.warn(
                    "event=STUDY_DISPATCH_FAILED userId={} synthesisIds={} artifactIds={} error={}",
                    ownerUserId,
                    synthesisIds,
                    artifactIds,
                    ex.getClass().getSimpleName());
            // Quota already confirmed — leave rows dispatchable so the client can retry.
            throw new ResponseStatusException(
                    HttpStatus.SERVICE_UNAVAILABLE,
                    ErrorCode.SERVICE_UNAVAILABLE.name(),
                    ex);
        }
    }

    private List<Long> extractLongIds(Map<String, Object> prepared, String... keys) {
        LinkedHashSet<Long> ids = new LinkedHashSet<>();
        if (prepared == null) {
            return List.of();
        }
        for (String key : keys) {
            Object raw = prepared.get(key);
            if (!(raw instanceof List<?> list)) {
                continue;
            }
            for (Object item : list) {
                if (item instanceof Number n) {
                    ids.add(n.longValue());
                } else if (item instanceof Map<?, ?> map) {
                    Object id = map.get("id");
                    if (id instanceof Number n) {
                        ids.add(n.longValue());
                    }
                }
            }
        }
        return new ArrayList<>(ids);
    }

    /**
     * Consumes quota once per newly created id with a stable idempotency key.
     * Keys: {@code subject-synthesis:{id}:quota} or {@code study-artifact:{id}:quota}.
     */
    private QuotaBatchOutcome consumeQuotaPerId(
            Long ownerUserId, List<Long> newlyCreatedIds, boolean synthesis) {
        long chars = Math.max(0, geminiCharsPerArtifact);
        String quotaType = synthesis ? QUOTA_TYPE_SUBJECT_SYNTHESIS : QUOTA_TYPE_STUDY_ARTIFACT;
        List<Long> allowed = new ArrayList<>();
        List<Long> denied = new ArrayList<>();
        List<Long> unknown = new ArrayList<>();
        List<Map<String, Object>> details = new ArrayList<>();

        for (Long id : newlyCreatedIds) {
            String idempotencyKey = synthesis
                    ? "subject-synthesis:" + id + ":quota"
                    : "study-artifact:" + id + ":quota";
            UserQuotaClient.QuotaConsumeResult result = userQuotaClient.consume(
                    ownerUserId, 0, chars, idempotencyKey, quotaType);

            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("id", id);
            detail.put("quotaStatus", result.status().name());
            detail.put("idempotencyKey", idempotencyKey);
            detail.put("quotaType", quotaType);
            if (result.errorCode() != null) {
                detail.put("errorCode", result.errorCode());
            }
            details.add(detail);

            if (result.status() == QuotaConsumeStatus.ALLOWED) {
                allowed.add(id);
            } else if (result.status() == QuotaConsumeStatus.DENIED) {
                denied.add(id);
                log.warn(
                        "event=STUDY_QUOTA_DENIED userId={} id={} key={} synthesis={}",
                        ownerUserId,
                        id,
                        idempotencyKey,
                        synthesis);
            } else {
                unknown.add(id);
                log.warn(
                        "event=STUDY_QUOTA_UNKNOWN userId={} id={} key={} synthesis={} errorCode={}",
                        ownerUserId,
                        id,
                        idempotencyKey,
                        synthesis,
                        result.errorCode());
            }
        }
        return new QuotaBatchOutcome(allowed, denied, unknown, details);
    }

    /**
     * Marks denied ids, throws when the whole newlyCreated batch cannot proceed.
     * UNKNOWN ids stay QUEUED (no confirm, no QUOTA_EXCEEDED).
     */
    private void applyQuotaOutcome(
            Long ownerUserId, QuotaBatchOutcome outcome, boolean synthesis, String traceId) {
        if (!outcome.deniedIds().isEmpty()) {
            Map<String, Object> body = new HashMap<>();
            body.put("ownerUserId", ownerUserId);
            if (synthesis) {
                body.put("synthesisIds", outcome.deniedIds());
                body.put("artifactIds", List.of());
            } else {
                body.put("synthesisIds", List.of());
                body.put("artifactIds", outcome.deniedIds());
            }
            aiServiceClient.markStudyQuotaFailed(body, traceId);
        }

        boolean noneAllowed = outcome.allowedIds().isEmpty();
        boolean allUnknown = noneAllowed
                && outcome.deniedIds().isEmpty()
                && !outcome.unknownIds().isEmpty();
        boolean allDenied = noneAllowed
                && outcome.unknownIds().isEmpty()
                && !outcome.deniedIds().isEmpty();
        boolean deniedAndUnknown = noneAllowed
                && !outcome.deniedIds().isEmpty()
                && !outcome.unknownIds().isEmpty();

        if (allUnknown || deniedAndUnknown) {
            throw new ResponseStatusException(
                    HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.SERVICE_UNAVAILABLE.name());
        }
        if (allDenied) {
            throw new ResponseStatusException(HttpStatus.PAYMENT_REQUIRED, ErrorCode.QUOTA_EXCEEDED.name());
        }
        // some allowed (+ optional denied/unknown) → continue with allowed only
    }

    private void annotatePreparedWithQuota(Map<String, Object> prepared, QuotaBatchOutcome outcome) {
        boolean partial = !outcome.deniedIds().isEmpty() || !outcome.unknownIds().isEmpty();
        prepared.put("partialQuota", partial);
        prepared.put("quotaDetails", outcome.details());
        if (partial && !outcome.allowedIds().isEmpty()) {
            prepared.put("status", "PARTIALLY_FAILED");
        } else if (partial && outcome.allowedIds().isEmpty()) {
            // Should have thrown in applyQuotaOutcome; leave as-is if somehow reached.
            prepared.put("status", "PARTIAL");
        }
    }

    private String normalizeMode(String sourceSelectionMode, List<Long> meetingIds) {
        // Preserve explicit ALL_READY even when meetingIds is empty (force regenerate path).
        // Do not treat empty+ALL_READY as EXPLICIT.
        if (sourceSelectionMode != null && !sourceSelectionMode.isBlank()) {
            String mode = sourceSelectionMode.trim().toUpperCase();
            if ("ALL_READY".equals(mode)) {
                return "ALL_READY";
            }
            if ("EXPLICIT".equals(mode)) {
                return "EXPLICIT";
            }
        }
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

    private record QuotaBatchOutcome(
            List<Long> allowedIds,
            List<Long> deniedIds,
            List<Long> unknownIds,
            List<Map<String, Object>> details
    ) {
    }
}
