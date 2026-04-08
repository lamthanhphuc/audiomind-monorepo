package com.example.processingservice.service;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import lombok.RequiredArgsConstructor;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.lang.reflect.Type;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

@Component
@RequiredArgsConstructor
public class JobStateStore {

    private static final Duration TTL = Duration.ofSeconds(3600);
    private static final Type MAP_TYPE = new TypeToken<Map<String, Object>>() {
    }.getType();

    private final StringRedisTemplate redisTemplate;
    private final Gson gson = new Gson();

    public record IdempotencyClaim(Long jobId, boolean owner) {
    }

    public Optional<Long> getIdempotentJobId(String fileId) {
        String value = redisTemplate.opsForValue().get(idempotencyKey(fileId));
        if (value == null || value.isBlank()) {
            return Optional.empty();
        }
        try {
            return Optional.of(Long.parseLong(value));
        } catch (NumberFormatException ex) {
            return Optional.empty();
        }
    }

    public boolean createIdempotencyMapping(String fileId, Long jobId) {
        Boolean created = redisTemplate.opsForValue().setIfAbsent(idempotencyKey(fileId), String.valueOf(jobId), TTL);
        return Boolean.TRUE.equals(created);
    }

    public IdempotencyClaim claimIdempotency(String fileId, Long requestedJobId) {
        Boolean created = redisTemplate.opsForValue().setIfAbsent(idempotencyKey(fileId), String.valueOf(requestedJobId), TTL);
        if (Boolean.TRUE.equals(created)) {
            return new IdempotencyClaim(requestedJobId, true);
        }

        Long existing = getIdempotentJobId(fileId).orElse(requestedJobId);
        return new IdempotencyClaim(existing, false);
    }

    public void upsertJobState(
            Long jobId,
            String status,
            String fileId,
            Map<String, Object> result,
            String error,
            String traceId
    ) {
        Map<String, Object> state = getJobState(jobId).orElseGet(HashMap::new);
        if (!state.containsKey("createdAt")) {
            state.put("createdAt", Instant.now().toString());
        }

        state.put("jobId", String.valueOf(jobId));
        state.put("fileId", fileId);
        state.put("status", status == null ? "UNKNOWN" : status.toUpperCase());
        state.put("traceId", traceId);
        state.put("result", result);
        state.put("error", (error == null || error.isBlank()) ? null : error);
        state.put("updatedAt", Instant.now().toString());

        writeJobState(jobId, state);
    }

    public Optional<Map<String, Object>> getJobState(Long jobId) {
        String json = redisTemplate.opsForValue().get(jobKey(jobId));
        if (json == null || json.isBlank()) {
            return Optional.empty();
        }

        try {
            return Optional.ofNullable(gson.fromJson(json, MAP_TYPE));
        } catch (RuntimeException ex) {
            return Optional.empty();
        }
    }

    public void writeJobState(Long jobId, Map<String, Object> state) {
        redisTemplate.opsForValue().set(jobKey(jobId), gson.toJson(state), TTL);
    }

    private String jobKey(Long jobId) {
        return "job:" + jobId;
    }

    private String idempotencyKey(String fileId) {
        return "idem:" + fileId;
    }
}
