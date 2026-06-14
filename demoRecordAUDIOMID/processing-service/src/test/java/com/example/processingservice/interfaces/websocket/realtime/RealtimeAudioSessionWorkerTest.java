package com.example.processingservice.interfaces.websocket.realtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.WebSocketSession;

class RealtimeAudioSessionWorkerTest {

    @Test
    void enqueue_processesItemsInFifoOrder() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getId()).thenReturn("worker-session-1");

        List<Long> processedSeq = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch processedThree = new CountDownLatch(3);
        RealtimeAudioSessionWorker worker = new RealtimeAudioSessionWorker(
                "worker-session-1",
                100L,
                session,
                (ignoredSession, item) -> {
                    processedSeq.add(item.seq());
                    item.clearAudioBytes();
                    processedThree.countDown();
                },
                64,
                5000L
        );

        for (long seq = 1L; seq <= 3L; seq++) {
            RealtimeAudioEnqueueResult result = worker.enqueue(new RealtimeAudioWorkItem(
                    100L,
                    seq,
                    new byte[] {(byte) seq},
                    "vi",
                    "single",
                    false,
                    "Bearer token"
            ));
            assertEquals(RealtimeAudioEnqueueResult.ACCEPTED, result);
        }

        assertTrue(processedThree.await(5, TimeUnit.SECONDS));
        assertEquals(List.of(1L, 2L, 3L), processedSeq);
        assertEquals(0, worker.queueDepth());
    }

    @Test
    void enqueue_queueFull_returnsQueueFullWithoutSilentDrop() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getId()).thenReturn("worker-session-2");

        CountDownLatch processingStarted = new CountDownLatch(1);
        CountDownLatch holdProcessing = new CountDownLatch(1);
        RealtimeAudioSessionWorker worker = new RealtimeAudioSessionWorker(
                "worker-session-2",
                200L,
                session,
                (ignoredSession, item) -> {
                    processingStarted.countDown();
                    holdProcessing.await(5, TimeUnit.SECONDS);
                    item.clearAudioBytes();
                },
                1,
                5000L
        );

        assertEquals(
                RealtimeAudioEnqueueResult.ACCEPTED,
                worker.enqueue(workItem(200L, 1L))
        );
        assertTrue(processingStarted.await(5, TimeUnit.SECONDS));
        assertEquals(
                RealtimeAudioEnqueueResult.ACCEPTED,
                worker.enqueue(workItem(200L, 2L))
        );
        assertEquals(
                RealtimeAudioEnqueueResult.QUEUE_FULL,
                worker.enqueue(workItem(200L, 3L))
        );
        assertEquals(RealtimeSessionLifecycleState.ACTIVE, worker.state());
        holdProcessing.countDown();
    }

    @Test
    void shutdownAndFinalize_onlyOnePathWinsFinalize() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getId()).thenReturn("worker-session-3");

        AtomicBoolean finalizeInvoked = new AtomicBoolean(false);
        RealtimeAudioSessionWorker worker = new RealtimeAudioSessionWorker(
                "worker-session-3",
                300L,
                session,
                (ignoredSession, item) -> item.clearAudioBytes(),
                64,
                5000L
        );
        worker.enqueue(workItem(300L, 1L));

        RealtimeAudioSessionWorker.ShutdownResult first = worker.shutdownAndFinalize(() -> {
            finalizeInvoked.set(true);
            return true;
        });
        RealtimeAudioSessionWorker.ShutdownResult second = worker.shutdownAndFinalize(() -> {
            finalizeInvoked.set(true);
            return true;
        });

        assertTrue(first.finalizeInvoked());
        assertFalse(second.finalizeInvoked());
        assertTrue(finalizeInvoked.get());
        assertEquals(RealtimeSessionLifecycleState.FINALIZED, worker.state());
        assertEquals(0, worker.queueDepth());
    }

    @Test
    void rejectQueueFull_clearsQueuedAudioReferences() {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.getId()).thenReturn("worker-session-4");

        RealtimeAudioSessionWorker worker = new RealtimeAudioSessionWorker(
                "worker-session-4",
                400L,
                session,
                (ignoredSession, item) -> item.clearAudioBytes(),
                64,
                5000L
        );

        RealtimeAudioWorkItem pending = workItem(400L, 9L);
        worker.enqueue(pending);
        worker.rejectQueueFull();

        assertEquals(RealtimeSessionLifecycleState.REJECTED, worker.state());
        assertEquals(0, worker.queueDepth());
        assertNull(pending.audioBytes());
    }

    private RealtimeAudioWorkItem workItem(long meetingId, long seq) {
        return new RealtimeAudioWorkItem(
                meetingId,
                seq,
                new byte[] {1, 2},
                "vi",
                "single",
                false,
                "Bearer token"
        );
    }
}
