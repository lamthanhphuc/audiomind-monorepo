package com.example.processingservice.interfaces.websocket.realtime;

import java.time.Duration;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * Activity-aware inactivity finalize: arms once on first audio, then re-checks last activity
 * when the timer fires instead of treating an open WebSocket as an active stream.
 */
@Slf4j
@Component
public class RealtimeFinalizeDeadlineService {

    private static final Duration[] RETRY_DELAYS = new Duration[] {
            Duration.ofSeconds(2),
            Duration.ofSeconds(5),
            Duration.ofSeconds(12)
    };
    private static final Duration AUDIO_INACTIVITY_TIMEOUT = Duration.ofSeconds(45);

    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);
    private final ConcurrentHashMap<DeadlineKey, DeadlineState> pendingDeadlines = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<DeadlineKey, AtomicInteger> retryAttempts = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<DeadlineKey, Object> keyLocks = new ConcurrentHashMap<>();
    private final AtomicLong generations = new AtomicLong(0L);

    public record FinalizeAttemptContext(
            Long meetingId,
            String webSocketSessionId,
            Long recordingSessionId,
            Long attemptId,
            String language,
            String speakerMode,
            String authorization,
            Long userId,
            String traceId,
            String analysisSource,
            boolean sessionStillOpen
    ) {
    }

    @FunctionalInterface
    public interface FinalizeRunner {
        void run(FinalizeAttemptContext context) throws Exception;
    }

    private record DeadlineKey(
            Long meetingId,
            String webSocketSessionId,
            Long recordingSessionId,
            Long attemptId
    ) {
        static DeadlineKey from(FinalizeAttemptContext context) {
            return new DeadlineKey(
                    context.meetingId(),
                    context.webSocketSessionId(),
                    context.recordingSessionId(),
                    context.attemptId()
            );
        }
    }

    private record DeadlineState(ScheduledFuture<?> future, long generation) {
    }

    public long audioInactivityTimeoutMs() {
        return AUDIO_INACTIVITY_TIMEOUT.toMillis();
    }

    /** Arm the inactivity deadline once (first accepted audio). */
    public void markAudioReceived(Long meetingId, FinalizeAttemptContext context, FinalizeRunner runner) {
        scheduleDeadline(DeadlineKey.from(context), context, runner, AUDIO_INACTIVITY_TIMEOUT.toMillis(), "inactivity");
    }

    /** Reschedule after a deadline callback observes recent audio activity. */
    public void rescheduleInactivityDeadline(
            Long meetingId,
            FinalizeAttemptContext context,
            FinalizeRunner runner,
            long delayMs
    ) {
        scheduleDeadline(
                DeadlineKey.from(context),
                context,
                runner,
                Math.max(1L, delayMs),
                "inactivity"
        );
    }

    private void scheduleDeadline(
            DeadlineKey key,
            FinalizeAttemptContext context,
            FinalizeRunner runner,
            long delayMs,
            String source
    ) {
        // Serialize schedule/cancel for a key so a short-delay timer cannot observe a
        // half-registered generation and orphaned futures cannot survive a reschedule.
        synchronized (lockFor(key)) {
            long generation = beginGeneration(key);
            ScheduledFuture<?> future = scheduler.schedule(
                    () -> attemptFinalize(key, context, runner, source, generation),
                    delayMs,
                    TimeUnit.MILLISECONDS);
            DeadlineState current = pendingDeadlines.get(key);
            if (current == null || current.generation() != generation) {
                future.cancel(false);
                return;
            }
            pendingDeadlines.put(key, new DeadlineState(future, generation));
        }
    }

    private Object lockFor(DeadlineKey key) {
        return keyLocks.computeIfAbsent(key, ignored -> new Object());
    }

    public void requestFinalize(Long meetingId, FinalizeAttemptContext context, FinalizeRunner runner) {
        DeadlineKey key = DeadlineKey.from(context);
        long generation;
        synchronized (lockFor(key)) {
            generation = beginGeneration(key);
        }
        attemptFinalize(key, context, runner, "immediate", generation);
    }

    public void scheduleRetry(Long meetingId, FinalizeAttemptContext context, FinalizeRunner runner) {
        DeadlineKey key = DeadlineKey.from(context);
        AtomicInteger attempts = retryAttempts.computeIfAbsent(key, ignored -> new AtomicInteger(0));
        int attempt = attempts.incrementAndGet();
        if (attempt > RETRY_DELAYS.length) {
            log.warn("event=REALTIME_FINALIZE_RETRY_EXHAUSTED meetingId={} attempts={}", meetingId, attempt);
            clear(key);
            return;
        }
        Duration delay = RETRY_DELAYS[attempt - 1];
        log.info("event=REALTIME_FINALIZE_RETRY_SCHEDULED meetingId={} attempt={} delayMs={}",
                meetingId, attempt, delay.toMillis());
        scheduleDeadline(key, context, runner, delay.toMillis(), "retry-" + attempt);
    }

    public void clear(Long meetingId) {
        pendingDeadlines.keySet().stream()
                .filter(key -> meetingId.equals(key.meetingId()))
                .toList()
                .forEach(this::clear);
    }

    public void clear(FinalizeAttemptContext context) {
        clear(DeadlineKey.from(context));
    }

    private void clear(DeadlineKey key) {
        synchronized (lockFor(key)) {
            cancelDeadline(key);
            retryAttempts.remove(key);
        }
    }

    private void attemptFinalize(
            DeadlineKey key,
            FinalizeAttemptContext context,
            FinalizeRunner runner,
            String source,
            long generation
    ) {
        if (!isCurrentGeneration(key, generation)) {
            log.info(
                    "event=REALTIME_FINALIZE_DEADLINE_STALE_IGNORED meetingId={} webSocketSessionId={} recordingSessionId={} attemptId={} source={}",
                    context.meetingId(),
                    context.webSocketSessionId(),
                    context.recordingSessionId(),
                    context.attemptId(),
                    source
            );
            return;
        }
        try {
            log.info(
                    "event=REALTIME_FINALIZE_ATTEMPT meetingId={} webSocketSessionId={} recordingSessionId={} attemptId={} source={}",
                    context.meetingId(),
                    context.webSocketSessionId(),
                    context.recordingSessionId(),
                    context.attemptId(),
                    source
            );
            runner.run(context);
            clearIfCurrent(key, generation);
        } catch (Exception ex) {
            log.warn("event=REALTIME_FINALIZE_ATTEMPT_FAILED meetingId={} source={} error={}",
                    context.meetingId(), source, ex.getMessage());
            if (isCurrentGeneration(key, generation)) {
                scheduleRetry(context.meetingId(), context, runner);
            }
        }
    }

    private boolean isCurrentGeneration(DeadlineKey key, long generation) {
        DeadlineState existing = pendingDeadlines.get(key);
        return existing != null && existing.generation() == generation;
    }

    private void clearIfCurrent(DeadlineKey key, long generation) {
        synchronized (lockFor(key)) {
            DeadlineState existing = pendingDeadlines.get(key);
            if (existing != null && existing.generation() == generation) {
                cancelDeadline(key);
                retryAttempts.remove(key);
            }
        }
    }

    private long beginGeneration(DeadlineKey key) {
        cancelDeadline(key);
        long generation = generations.incrementAndGet();
        pendingDeadlines.put(key, new DeadlineState(null, generation));
        return generation;
    }

    private void cancelDeadline(DeadlineKey key) {
        DeadlineState existing = pendingDeadlines.remove(key);
        if (existing != null && existing.future() != null) {
            existing.future().cancel(false);
        }
    }
}
