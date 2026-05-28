package com.example.processingservice.service;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.core.script.RedisScript;
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
import java.util.UUID;

@Component
@RequiredArgsConstructor
public class JobStateStore {

    private static final Type MAP_TYPE = new TypeToken<Map<String, Object>>() {
    }.getType();
        private static final RedisScript<Long> UPSERT_JOB_STATE_SCRIPT = new DefaultRedisScript<>(
            "local key = KEYS[1]\n"
                + "local next_status = string.upper(ARGV[1])\n"
                + "local current_status = string.upper(redis.call('HGET', key, 'status') or 'UNKNOWN')\n"
                + "local function is_terminal(value)\n"
                + "  return value == 'COMPLETED' or value == 'FAILED'\n"
                + "end\n"
                + "local function is_allowed(current, next)\n"
                + "  if current == next then\n"
                + "    return true\n"
                + "  end\n"
                + "  if current == 'UNKNOWN' then\n"
                + "    return true\n"
                + "  end\n"
                + "  if is_terminal(current) then\n"
                + "    return false\n"
                + "  end\n"
                + "  if current == 'PENDING' then\n"
                + "    return next == 'QUEUED'\n"
                + "  end\n"
                + "  if current == 'QUEUED' then\n"
                + "    return next == 'RUNNING' or next == 'RETRYING' or next == 'COMPLETED' or next == 'FAILED'\n"
                + "  end\n"
                + "  if current == 'RUNNING' then\n"
                + "    return next == 'RETRYING' or next == 'COMPLETED' or next == 'FAILED' or next == 'PARTIAL' or next == 'DEGRADED' or next == 'RECONNECTING'\n"
                + "  end\n"
                + "  if current == 'PARTIAL' then\n"
                + "    return next == 'RUNNING' or next == 'RECONNECTING' or next == 'DEGRADED' or next == 'COMPLETED' or next == 'FAILED'\n"
                + "  end\n"
                + "  if current == 'DEGRADED' then\n"
                + "    return next == 'RUNNING' or next == 'PARTIAL' or next == 'RECONNECTING' or next == 'COMPLETED' or next == 'FAILED'\n"
                + "  end\n"
                + "  if current == 'RECONNECTING' then\n"
                + "    return next == 'RUNNING' or next == 'PARTIAL' or next == 'DEGRADED' or next == 'COMPLETED' or next == 'FAILED'\n"
                + "  end\n"
                + "  if current == 'RETRYING' then\n"
                + "    return next == 'RUNNING' or next == 'COMPLETED' or next == 'FAILED' or next == 'PARTIAL' or next == 'DEGRADED' or next == 'RECONNECTING'\n"
                + "  end\n"
                + "  return false\n"
                + "end\n"
                + "if not is_allowed(current_status, next_status) then\n"
                + "  return 0\n"
                + "end\n"
                + "local existing_created = redis.call('HGET', key, 'createdAt')\n"
                + "local created_at = existing_created\n"
                + "if not created_at or created_at == '' then\n"
                + "  created_at = ARGV[7]\n"
                + "end\n"
                + "redis.call('HSET', key, 'jobId', ARGV[9], 'fileId', ARGV[2], 'status', next_status, 'traceId', ARGV[5], 'createdAt', created_at, 'updatedAt', ARGV[6])\n"
                + "if ARGV[3] == '' then\n"
                + "  redis.call('HDEL', key, 'result')\n"
                + "else\n"
                + "  redis.call('HSET', key, 'result', ARGV[3])\n"
                + "end\n"
                + "if ARGV[4] == '' then\n"
                + "  redis.call('HDEL', key, 'error')\n"
                + "else\n"
                + "  redis.call('HSET', key, 'error', ARGV[4])\n"
                + "end\n"
                + "redis.call('EXPIRE', key, tonumber(ARGV[8]))\n"
                + "return 1\n",
            Long.class
        );

    private final StringRedisTemplate redisTemplate;
    private final Gson gson = new Gson();

    @Value("${processing.job-state-ttl-seconds:21600}")
    private long jobStateTtlSeconds;
    @Value("${processing.analysis-lock-ttl-seconds:180}")
    private long analysisLockTtlSeconds;
    @Value("${processing.analysis-failure-cooldown-seconds:90}")
    private long analysisFailureCooldownSeconds;
    @Value("${processing.analysis-skip-log-throttle-seconds:45}")
    private long analysisSkipLogThrottleSeconds;

    public record IdempotencyClaim(Long jobId, boolean owner) {
    }

    public record AnalysisTriggerDecision(
            boolean shouldTrigger,
            String status,
            String reason,
            String lockToken,
            int retryAfterSeconds,
            String errorCode
    ) {
    }

    public record AnalysisStateSnapshot(
            String status,
            String transcriptHash,
            String source,
            String errorCode,
            String errorMessage,
            long cooldownUntilMs,
            int retryAfterSeconds
    ) {
        boolean isRunning() {
            return "RUNNING".equals(status) || "PENDING".equals(status) || "QUEUED".equals(status);
        }

        boolean isFailed() {
            return "FAILED".equals(status);
        }

        boolean isSkipped() {
            return "SKIPPED".equals(status);
        }

        boolean isCompleted() {
            return "COMPLETED".equals(status);
        }
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
        Boolean created = redisTemplate.opsForValue().setIfAbsent(idempotencyKey(fileId), String.valueOf(jobId), jobStateTtl());
        return Boolean.TRUE.equals(created);
    }

    public IdempotencyClaim claimIdempotency(String fileId, Long requestedJobId) {
        Boolean created = redisTemplate.opsForValue().setIfAbsent(idempotencyKey(fileId), String.valueOf(requestedJobId), jobStateTtl());
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
        String nextStatus = normalizeStatus(status);
            String now = Instant.now().toString();
            String createdAt = state.containsKey("createdAt")
                ? String.valueOf(state.get("createdAt"))
                : now;
            String resolvedFileId = (fileId == null || fileId.isBlank())
                ? String.valueOf(state.getOrDefault("fileId", ""))
                : fileId;
            String resolvedTraceId = (traceId == null || traceId.isBlank())
                ? String.valueOf(state.getOrDefault("traceId", ""))
                : traceId;
            String serializedResult = result == null ? "" : gson.toJson(result);
            String sanitizedError = (error == null || error.isBlank()) ? "" : error;

            Long updated = redisTemplate.execute(
                UPSERT_JOB_STATE_SCRIPT,
                List.of(jobKey(jobId)),
                nextStatus,
                resolvedFileId,
                serializedResult,
                sanitizedError,
                resolvedTraceId,
                now,
                createdAt,
                String.valueOf(jobStateTtlSeconds),
                String.valueOf(jobId)
            );

            if (!Long.valueOf(1L).equals(updated)) {
                return;
            }
    }

    private boolean isTerminal(String status) {
        return "COMPLETED".equals(status) || "FAILED".equals(status);
    }

    private String normalizeStatus(Object value) {
        if (value == null) {
            return "UNKNOWN";
        }
        String normalized = String.valueOf(value).trim().toUpperCase();
        if (normalized.isBlank()) {
            return "UNKNOWN";
        }
        return normalized;
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
        redisTemplate.expire(jobKey(jobId), jobStateTtl());
    }

    public AnalysisTriggerDecision tryStartAnalysis(Long meetingId, String transcriptHash, String source, String triggeredBy) {
        long nowMs = System.currentTimeMillis();
        String normalizedHash = normalizeTranscriptHash(transcriptHash);
        AnalysisStateSnapshot snapshot = getAnalysisState(meetingId).orElse(null);
        if (snapshot != null) {
            if (snapshot.isCompleted() && normalizedHash.equals(snapshot.transcriptHash())) {
                return new AnalysisTriggerDecision(false, "COMPLETED", "already_exists", null, 0, null);
            }
            if (snapshot.isRunning()) {
                int retryAfter = lockRetryAfterSeconds(meetingId);
                return new AnalysisTriggerDecision(false, snapshot.status(), "in_progress", null, retryAfter, null);
            }
            if (snapshot.isSkipped() && snapshot.retryAfterSeconds() > 0) {
                return new AnalysisTriggerDecision(
                        false,
                        snapshot.status(),
                        "in_progress",
                        null,
                        snapshot.retryAfterSeconds(),
                        null
                );
            }
            if (snapshot.isFailed() && snapshot.retryAfterSeconds() > 0) {
                return new AnalysisTriggerDecision(
                        false,
                        "FAILED",
                        "cooldown_active",
                        null,
                        snapshot.retryAfterSeconds(),
                        snapshot.errorCode()
                );
            }
        }

        String lockToken = UUID.randomUUID().toString();
        Boolean locked = redisTemplate.opsForValue().setIfAbsent(
                analysisLockKey(meetingId),
                lockToken,
                analysisLockTtl()
        );
        if (!Boolean.TRUE.equals(locked)) {
            int retryAfter = lockRetryAfterSeconds(meetingId);
            return new AnalysisTriggerDecision(false, "RUNNING", "lock_busy", null, retryAfter, null);
        }

        Map<String, String> state = new HashMap<>();
        state.put("meetingId", String.valueOf(meetingId));
        state.put("status", "RUNNING");
        state.put("source", safeText(source));
        state.put("transcriptHash", normalizedHash);
        state.put("updatedAtMs", String.valueOf(nowMs));
        state.put("startedAtMs", String.valueOf(nowMs));
        state.put("lastTriggeredBy", safeText(triggeredBy));
        state.put("errorCode", "");
        state.put("errorMessage", "");
        redisTemplate.opsForHash().putAll(analysisStateKey(meetingId), state);
        redisTemplate.expire(analysisStateKey(meetingId), jobStateTtl());
        redisTemplate.delete(analysisCooldownKey(meetingId));
        return new AnalysisTriggerDecision(true, "RUNNING", "started", lockToken, 0, null);
    }

    public void markAnalysisCompleted(
            Long meetingId,
            String transcriptHash,
            String source,
            String triggeredBy,
            String lockToken
    ) {
        long nowMs = System.currentTimeMillis();
        Map<String, String> state = new HashMap<>();
        state.put("meetingId", String.valueOf(meetingId));
        state.put("status", "COMPLETED");
        state.put("source", safeText(source));
        state.put("transcriptHash", normalizeTranscriptHash(transcriptHash));
        state.put("updatedAtMs", String.valueOf(nowMs));
        state.put("completedAtMs", String.valueOf(nowMs));
        state.put("lastTriggeredBy", safeText(triggeredBy));
        state.put("errorCode", "");
        state.put("errorMessage", "");
        redisTemplate.opsForHash().putAll(analysisStateKey(meetingId), state);
        redisTemplate.expire(analysisStateKey(meetingId), jobStateTtl());
        redisTemplate.delete(analysisCooldownKey(meetingId));
        releaseAnalysisLock(meetingId, lockToken);
    }

    public void markAnalysisFailed(
            Long meetingId,
            String transcriptHash,
            String source,
            String triggeredBy,
            String lockToken,
            String errorCode,
            String errorMessage
    ) {
        long nowMs = System.currentTimeMillis();
        long cooldownUntilMs = nowMs + Math.max(1, analysisFailureCooldownSeconds) * 1000L;
        int retryAfterSeconds = Math.max(1, (int) Math.ceil((cooldownUntilMs - nowMs) / 1000.0));

        Map<String, String> state = new HashMap<>();
        state.put("meetingId", String.valueOf(meetingId));
        state.put("status", "FAILED");
        state.put("source", safeText(source));
        state.put("transcriptHash", normalizeTranscriptHash(transcriptHash));
        state.put("updatedAtMs", String.valueOf(nowMs));
        state.put("failedAtMs", String.valueOf(nowMs));
        state.put("cooldownUntilMs", String.valueOf(cooldownUntilMs));
        state.put("retryAfterSeconds", String.valueOf(retryAfterSeconds));
        state.put("lastTriggeredBy", safeText(triggeredBy));
        state.put("errorCode", safeText(errorCode));
        state.put("errorMessage", safeText(errorMessage));
        redisTemplate.opsForHash().putAll(analysisStateKey(meetingId), state);
        redisTemplate.expire(analysisStateKey(meetingId), jobStateTtl());
        redisTemplate.opsForValue().set(
                analysisCooldownKey(meetingId),
                String.valueOf(cooldownUntilMs),
                Duration.ofSeconds(Math.max(1, analysisFailureCooldownSeconds))
        );
        releaseAnalysisLock(meetingId, lockToken);
    }

    public void markAnalysisSkipped(
            Long meetingId,
            String transcriptHash,
            String source,
            String triggeredBy,
            String lockToken,
            String reason,
            int retryAfterSeconds
    ) {
        long nowMs = System.currentTimeMillis();
        Map<String, String> state = new HashMap<>();
        state.put("meetingId", String.valueOf(meetingId));
        state.put("status", "SKIPPED");
        state.put("source", safeText(source));
        state.put("transcriptHash", normalizeTranscriptHash(transcriptHash));
        state.put("updatedAtMs", String.valueOf(nowMs));
        state.put("lastTriggeredBy", safeText(triggeredBy));
        state.put("errorCode", safeText(reason));
        state.put("errorMessage", safeText(reason));

        int normalizedRetryAfter = Math.max(0, retryAfterSeconds);
        if (normalizedRetryAfter > 0) {
            long cooldownUntilMs = nowMs + normalizedRetryAfter * 1000L;
            state.put("cooldownUntilMs", String.valueOf(cooldownUntilMs));
            state.put("retryAfterSeconds", String.valueOf(normalizedRetryAfter));
            redisTemplate.opsForValue().set(
                    analysisCooldownKey(meetingId),
                    String.valueOf(cooldownUntilMs),
                    Duration.ofSeconds(normalizedRetryAfter)
            );
        } else {
            state.put("cooldownUntilMs", "0");
            state.put("retryAfterSeconds", "0");
            redisTemplate.delete(analysisCooldownKey(meetingId));
        }

        redisTemplate.opsForHash().putAll(analysisStateKey(meetingId), state);
        redisTemplate.expire(analysisStateKey(meetingId), jobStateTtl());
        releaseAnalysisLock(meetingId, lockToken);
    }

    public Optional<AnalysisStateSnapshot> getAnalysisState(Long meetingId) {
        Map<Object, Object> raw = redisTemplate.opsForHash().entries(analysisStateKey(meetingId));
        if (raw == null || raw.isEmpty()) {
            return Optional.empty();
        }
        long nowMs = System.currentTimeMillis();
        String status = normalizeStatus(raw.get("status"));
        String transcriptHash = String.valueOf(raw.getOrDefault("transcriptHash", "")).trim().toLowerCase();
        String source = String.valueOf(raw.getOrDefault("source", "")).trim();
        String errorCode = String.valueOf(raw.getOrDefault("errorCode", "")).trim();
        String errorMessage = String.valueOf(raw.getOrDefault("errorMessage", "")).trim();
        long cooldownUntilMs = parseLong(String.valueOf(raw.getOrDefault("cooldownUntilMs", "0")), 0L);
        String cooldownValue = redisTemplate.opsForValue().get(analysisCooldownKey(meetingId));
        long cooldownFromKey = parseLong(cooldownValue, 0L);
        if (cooldownFromKey > cooldownUntilMs) {
            cooldownUntilMs = cooldownFromKey;
        }
        int retryAfterSeconds = cooldownUntilMs > nowMs
                ? Math.max(1, (int) Math.ceil((cooldownUntilMs - nowMs) / 1000.0))
                : 0;
        return Optional.of(new AnalysisStateSnapshot(
                status,
                transcriptHash,
                source,
                errorCode,
                errorMessage,
                cooldownUntilMs,
                retryAfterSeconds
        ));
    }

    public boolean shouldLogAnalysisSkip(Long meetingId, String source, String reason) {
        String key = analysisSkipLogKey(meetingId, source, reason);
        Boolean created = redisTemplate.opsForValue().setIfAbsent(
                key,
                String.valueOf(System.currentTimeMillis()),
                Duration.ofSeconds(Math.max(1, analysisSkipLogThrottleSeconds))
        );
        return Boolean.TRUE.equals(created);
    }

    private Duration jobStateTtl() {
        return Duration.ofSeconds(jobStateTtlSeconds);
    }

    private Duration analysisLockTtl() {
        return Duration.ofSeconds(Math.max(120, analysisLockTtlSeconds));
    }

    private int lockRetryAfterSeconds(Long meetingId) {
        Long ttl = redisTemplate.getExpire(analysisLockKey(meetingId));
        if (ttl == null || ttl < 0) {
            return (int) Math.max(1, analysisLockTtlSeconds);
        }
        return (int) Math.max(1, ttl);
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

    private String analysisLockKey(Long meetingId) {
        return "analysis:lock:" + meetingId;
    }

    private String analysisStateKey(Long meetingId) {
        return "analysis:state:" + meetingId;
    }

    private String analysisCooldownKey(Long meetingId) {
        return "analysis:cooldown:" + meetingId;
    }

    private String analysisSkipLogKey(Long meetingId, String source, String reason) {
        return "analysis:skiplog:" + meetingId + ":" + safeText(source) + ":" + safeText(reason);
    }

    private String normalizeTranscriptHash(String transcriptHash) {
        return transcriptHash == null ? "" : transcriptHash.trim().toLowerCase();
    }

    private long parseLong(String value, long fallback) {
        if (value == null || value.isBlank()) {
            return fallback;
        }
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private String safeText(String value) {
        if (value == null) {
            return "";
        }
        String trimmed = value.trim();
        if (trimmed.length() <= 180) {
            return trimmed;
        }
        return trimmed.substring(0, 180);
    }

    private void releaseAnalysisLock(Long meetingId, String lockToken) {
        if (lockToken == null || lockToken.isBlank()) {
            return;
        }
        String key = analysisLockKey(meetingId);
        String current = redisTemplate.opsForValue().get(key);
        if (lockToken.equals(current)) {
            redisTemplate.delete(key);
        }
    }
}
