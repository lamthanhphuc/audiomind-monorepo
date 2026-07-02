package com.example.processingservice.interfaces.websocket.realtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

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

        service.rescheduleInactivityDeadline(1L, firstContext, ctx -> {
            runs.incrementAndGet();
            latch.countDown();
        }, 120L);
        service.rescheduleInactivityDeadline(
                1L,
                firstContext,
                mock(RealtimeFinalizeDeadlineService.FinalizeRunner.class),
                500L
        );

        assertFalse(latch.await(200, TimeUnit.MILLISECONDS));
        assertEquals(0, runs.get());
    }
}
