package com.example.processingservice.service;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import lombok.RequiredArgsConstructor;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.connection.DataType;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.lang.reflect.Type;
import java.util.HashMap;
import java.util.List;
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
        String key = jobKey(jobId);
        DataType type = redisTemplate.type(key);
        if (type == null || DataType.NONE.equals(type)) {
            return Optional.empty();
        }

        if (DataType.HASH.equals(type)) {
            Map<Object, Object> entries = redisTemplate.opsForHash().entries(key);
            if (entries == null || entries.isEmpty()) {
                return Optional.empty();
            }

            Map<String, Object> mapped = new HashMap<>();
            for (Map.Entry<Object, Object> entry : entries.entrySet()) {
                String field = String.valueOf(entry.getKey());
                String value = entry.getValue() == null ? null : String.valueOf(entry.getValue());
                mapped.put(field, decodeHashValue(field, value));
            }
            return Optional.of(mapped);
        }

        String json = redisTemplate.opsForValue().get(key);
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
        Map<String, String> hash = new HashMap<>();
        for (Map.Entry<String, Object> entry : state.entrySet()) {
            hash.put(entry.getKey(), encodeHashValue(entry.getValue()));
        }
        redisTemplate.opsForHash().putAll(jobKey(jobId), hash);
        redisTemplate.expire(jobKey(jobId), TTL);
    }

    private Object decodeHashValue(String field, String value) {
        if (value == null || value.isBlank()) {
            return null;
        }

        if ("result".equals(field) || "failed_chunks".equals(field)) {
            try {
                return gson.fromJson(value, Object.class);
            } catch (RuntimeException ignored) {
                return value;
            }
        }

        if ("progress".equals(field) || "attempts".equals(field) || "total_chunks".equals(field) || "completed_chunks".equals(field)) {
            try {
                return Integer.parseInt(value);
            } catch (NumberFormatException ignored) {
                return 0;
            }
        }

        return value;
    }

    private String encodeHashValue(Object value) {
        if (value == null) {
            return "";
        }
        if (value instanceof String || value instanceof Number || value instanceof Boolean) {
            return String.valueOf(value);
        }
        if (value instanceof Map<?, ?> || value instanceof List<?>) {
            return gson.toJson(value);
        }
        return String.valueOf(value);
    }

    private String jobKey(Long jobId) {
        return "job:" + jobId;
    }

    private String idempotencyKey(String fileId) {
        return "idem:" + fileId;
    }
}
