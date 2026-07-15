package com.example.processingservice.interfaces.websocket.realtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

class RealtimeFinalizeDeadlineServiceTest {

    private RealtimeFinalizeDeadlineService service;

    @BeforeEach
    void setUp() {
        service = new RealtimeFinalizeDeadlineService();
    }

    @AfterEach
    void tearDown() {
        service.clear(1L);
        service.clear(2L);
        // Drain any leaked timers between tests.
        service.clear(context(1L, "ws-1", 40L, 1L));
        service.clear(context(1L, "ws-short", 52L, 1L));
        service.clear(context(1L, "ws-retry", 51L, 1L));
        service.clear(context(1L, "ws-immediate", 50L, 1L));
        service.clear(context(1L, "ws-old", 30L, 1L));
        service.clear(context(1L, "ws-new", 31L, 2L));
        service.clear(context(2L, "ws-a", 20L, 1L));
        service.clear(context(2L, "ws-b", 21L, 2L));
    }

    private RealtimeFinalizeDeadlineService.FinalizeAttemptContext context(
            Long meetingId,
            String webSocketSessionId,
            Long recordingSessionId,
            Long attemptId
    ) {
        return new RealtimeFinalizeDeadlineService.FinalizeAttemptContext(
                meetingId,
                webSocketSessionId,
                recordingSessionId,
                attemptId,
                "vi",
                "single",
                "Bearer token",
                9L,
                "trace",
                "stream_stop",
                true
        );
    }

    @Test
    void rescheduleInactivityDeadline_shouldKeepSeparateTimersPerAttemptIdentity() throws Exception {
        AtomicInteger attemptOneRuns = new AtomicInteger();
        AtomicInteger attemptTwoRuns = new AtomicInteger();
        CountDownLatch attemptOneLatch = new CountDownLatch(1);

        service.rescheduleInactivityDeadline(
                2L,
                context(2L, "ws-a", 20L, 1L),
                ctx -> {
                    attemptOneRuns.incrementAndGet();
                    attemptOneLatch.countDown();
                },
                50L
        );
        service.rescheduleInactivityDeadline(
                2L,
                context(2L, "ws-b", 21L, 2L),
                ctx -> attemptTwoRuns.incrementAndGet(),
                500L
        );

        assertTrue(attemptOneLatch.await(2, TimeUnit.SECONDS));
        Thread.sleep(100L);
        assertEquals(1, attemptOneRuns.get());
        assertEquals(0, attemptTwoRuns.get());
    }

    @Test
    void clearContext_shouldCancelOnlyMatchingAttemptDeadline() throws Exception {
        CountDownLatch staleLatch = new CountDownLatch(1);
        CountDownLatch activeLatch = new CountDownLatch(1);

        service.rescheduleInactivityDeadline(
                1L,
                context(1L, "ws-old", 30L, 1L),
                ctx -> staleLatch.countDown(),
                500L
        );
        RealtimeFinalizeDeadlineService.FinalizeAttemptContext activeContext = context(1L, "ws-new", 31L, 2L);
        service.rescheduleInactivityDeadline(1L, activeContext, ctx -> activeLatch.countDown(), 500L);

        service.clear(context(1L, "ws-old", 30L, 1L));

        assertFalse(staleLatch.await(300, TimeUnit.MILLISECONDS));
        service.clear(activeContext);
        assertFalse(activeLatch.await(300, TimeUnit.MILLISECONDS));
    }

    @Test
    void staleGenerationCallback_shouldNotRunAfterReschedule() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch latch = new CountDownLatch(1);
        RealtimeFinalizeDeadlineService.FinalizeAttemptContext firstContext = context(1L, "ws-1", 40L, 1L);

        // Use a long initial delay so supersede is deterministic (not racing a 120ms timer).
        service.rescheduleInactivityDeadline(1L, firstContext, ctx -> {
            runs.incrementAndGet();
            latch.countDown();
        }, 5_000L);
        service.rescheduleInactivityDeadline(
                1L,
                firstContext,
                mock(RealtimeFinalizeDeadlineService.FinalizeRunner.class),
                5_000L
        );

        assertFalse(latch.await(300, TimeUnit.MILLISECONDS));
        assertEquals(0, runs.get());
        service.clear(firstContext);
    }

    @Test
    void requestFinalize_shouldRunRunnerImmediately() {
        AtomicInteger runs = new AtomicInteger();
        RealtimeFinalizeDeadlineService.FinalizeAttemptContext ctx = context(1L, "ws-immediate", 50L, 1L);

        service.requestFinalize(1L, ctx, ignored -> runs.incrementAndGet());

        assertEquals(1, runs.get());
        assertTrue(pendingDeadlinesForTesting().isEmpty());
    }

    @Test
    void requestFinalize_shouldScheduleRetryWhenRunnerFails() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch retryLatch = new CountDownLatch(1);
        RealtimeFinalizeDeadlineService.FinalizeAttemptContext ctx = context(1L, "ws-retry", 51L, 1L);

        service.requestFinalize(1L, ctx, ignored -> {
            if (runs.incrementAndGet() == 1) {
                throw new RuntimeException("fail first");
            }
            retryLatch.countDown();
        });

        assertEquals(1, runs.get());
        assertTrue(retryLatch.await(5, TimeUnit.SECONDS));
        assertEquals(2, runs.get());
    }

    @Test
    void shortDelayCallback_shouldNotBecomeStaleBeforeStateRegistration() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        CountDownLatch latch = new CountDownLatch(1);
        RealtimeFinalizeDeadlineService.FinalizeAttemptContext ctx = context(1L, "ws-short", 52L, 1L);

        service.rescheduleInactivityDeadline(1L, ctx, ignored -> {
            runs.incrementAndGet();
            latch.countDown();
        }, 1L);

        assertTrue(latch.await(2, TimeUnit.SECONDS));
        assertEquals(1, runs.get());
        // Runner counts down before clearIfCurrent; wait for map cleanup.
        assertTrue(awaitPendingDeadlinesEmpty(2, TimeUnit.SECONDS));
        assertEquals(1, runs.get());

        AtomicInteger secondRuns = new AtomicInteger();
        CountDownLatch secondLatch = new CountDownLatch(1);
        service.rescheduleInactivityDeadline(1L, ctx, ignored -> {
            secondRuns.incrementAndGet();
            secondLatch.countDown();
        }, 1L);

        assertTrue(secondLatch.await(2, TimeUnit.SECONDS));
        assertEquals(1, secondRuns.get());
        assertTrue(awaitPendingDeadlinesEmpty(2, TimeUnit.SECONDS));
    }

    private boolean awaitPendingDeadlinesEmpty(long timeout, TimeUnit unit) throws InterruptedException {
        long deadlineNs = System.nanoTime() + unit.toNanos(timeout);
        while (System.nanoTime() < deadlineNs) {
            if (pendingDeadlinesForTesting().isEmpty()) {
                return true;
            }
            Thread.sleep(10L);
        }
        return pendingDeadlinesForTesting().isEmpty();
    }

    @SuppressWarnings("unchecked")
    private ConcurrentHashMap<Object, Object> pendingDeadlinesForTesting() {
        return (ConcurrentHashMap<Object, Object>) ReflectionTestUtils.getField(service, "pendingDeadlines");
    }
}
