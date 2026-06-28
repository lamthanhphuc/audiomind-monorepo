package com.example.processingservice.interfaces.websocket.realtime;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * Plan B: deadline/retry finalize independent of open WebSocket session.
 */
@Slf4j
@Component
public class RealtimeFinalizeDeadlineService {

    private static final Duration[] RETRY_DELAYS = new Duration[] {
            Duration.ofSeconds(2),
            Duration.ofSeconds(5),
            Duration.ofSeconds(12)
    };

    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);
    private final ConcurrentHashMap<Long, ScheduledFuture<?>> pendingDeadlines = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long, AtomicInteger> retryAttempts = new ConcurrentHashMap<>();

    public record FinalizeAttemptContext(
            Long meetingId,
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

    public void markAudioReceived(Long meetingId, FinalizeAttemptContext context, FinalizeRunner runner) {
        cancelDeadline(meetingId);
        ScheduledFuture<?> future = scheduler.schedule(
                () -> attemptFinalize(meetingId, context, runner, "deadline"),
                45,
                TimeUnit.SECONDS);
        pendingDeadlines.put(meetingId, future);
    }

    public void requestFinalize(Long meetingId, FinalizeAttemptContext context, FinalizeRunner runner) {
        cancelDeadline(meetingId);
        attemptFinalize(meetingId, context, runner, "immediate");
    }

    public void scheduleRetry(Long meetingId, FinalizeAttemptContext context, FinalizeRunner runner) {
        AtomicInteger attempts = retryAttempts.computeIfAbsent(meetingId, ignored -> new AtomicInteger(0));
        int attempt = attempts.incrementAndGet();
        if (attempt > RETRY_DELAYS.length) {
            log.warn("event=REALTIME_FINALIZE_RETRY_EXHAUSTED meetingId={} attempts={}", meetingId, attempt);
            clear(meetingId);
            return;
        }
        Duration delay = RETRY_DELAYS[attempt - 1];
        log.info("event=REALTIME_FINALIZE_RETRY_SCHEDULED meetingId={} attempt={} delayMs={}",
                meetingId, attempt, delay.toMillis());
        cancelDeadline(meetingId);
        ScheduledFuture<?> future = scheduler.schedule(
                () -> attemptFinalize(meetingId, context, runner, "retry-" + attempt),
                delay.toMillis(),
                TimeUnit.MILLISECONDS);
        pendingDeadlines.put(meetingId, future);
    }

    public void clear(Long meetingId) {
        cancelDeadline(meetingId);
        retryAttempts.remove(meetingId);
    }

    private void attemptFinalize(
            Long meetingId,
            FinalizeAttemptContext context,
            FinalizeRunner runner,
            String source
    ) {
        try {
            log.info("event=REALTIME_FINALIZE_ATTEMPT meetingId={} source={}", meetingId, source);
            runner.run(context);
            clear(meetingId);
        } catch (Exception ex) {
            log.warn("event=REALTIME_FINALIZE_ATTEMPT_FAILED meetingId={} source={} error={}",
                    meetingId, source, ex.getMessage());
            scheduleRetry(meetingId, context, runner);
        }
    }

    private void cancelDeadline(Long meetingId) {
        ScheduledFuture<?> existing = pendingDeadlines.remove(meetingId);
        if (existing != null) {
            existing.cancel(false);
        }
    }
}
