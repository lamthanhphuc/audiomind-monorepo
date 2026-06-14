package com.example.processingservice.interfaces.websocket.realtime;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

import org.springframework.web.socket.WebSocketSession;

import lombok.extern.slf4j.Slf4j;

@Slf4j
public class RealtimeAudioSessionWorker {

    private final String sessionId;
    private final long meetingId;
    private final WebSocketSession session;
    private final RealtimeAudioChunkProcessor chunkProcessor;
    private final int maxQueueDepth;
    private final long stopDrainTimeoutMs;
    private final Deque<RealtimeAudioWorkItem> queue = new ArrayDeque<>();
    private final AtomicReference<RealtimeSessionLifecycleState> state =
            new AtomicReference<>(RealtimeSessionLifecycleState.ACTIVE);
    private final AtomicBoolean processingInFlight = new AtomicBoolean(false);
    private final AtomicBoolean workerStarted = new AtomicBoolean(false);
    private final ExecutorService executor;
    private final Object queueMonitor = new Object();

    public RealtimeAudioSessionWorker(
            String sessionId,
            long meetingId,
            WebSocketSession session,
            RealtimeAudioChunkProcessor chunkProcessor,
            int maxQueueDepth,
            long stopDrainTimeoutMs) {
        this.sessionId = sessionId;
        this.meetingId = meetingId;
        this.session = session;
        this.chunkProcessor = chunkProcessor;
        this.maxQueueDepth = maxQueueDepth;
        this.stopDrainTimeoutMs = stopDrainTimeoutMs;
        this.executor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable);
            thread.setName("realtime-audio-worker-" + sessionId);
            thread.setDaemon(true);
            return thread;
        });
    }

    public String sessionId() {
        return sessionId;
    }

    public long meetingId() {
        return meetingId;
    }

    public RealtimeSessionLifecycleState state() {
        return state.get();
    }

    public int queueDepth() {
        synchronized (queueMonitor) {
            return queue.size();
        }
    }

    public RealtimeAudioEnqueueResult enqueue(RealtimeAudioWorkItem item) {
        RealtimeSessionLifecycleState current = state.get();
        if (current != RealtimeSessionLifecycleState.ACTIVE) {
            return RealtimeAudioEnqueueResult.REJECTED_STATE;
        }

        synchronized (queueMonitor) {
            if (state.get() != RealtimeSessionLifecycleState.ACTIVE) {
                return RealtimeAudioEnqueueResult.REJECTED_STATE;
            }
            if (queue.size() >= maxQueueDepth) {
                return RealtimeAudioEnqueueResult.QUEUE_FULL;
            }
            queue.addLast(item);
            queueMonitor.notifyAll();
        }

        startWorkerIfNeeded();
        log.info(
                "event=REALTIME_AUDIO_ENQUEUED meetingId={} seq={} byteLength={} queueDepth={} maxQueueDepth={}",
                meetingId,
                item.seq(),
                item.byteLength(),
                queueDepth(),
                maxQueueDepth
        );
        return RealtimeAudioEnqueueResult.ACCEPTED;
    }

    public ShutdownResult shutdownAndFinalize(BooleanSupplier finalizeWinner) {
        int registrySizeBefore = 1;
        beginStopping();

        int pendingBeforeDrain = queueDepth();
        DrainResult drainResult = drainPending(stopDrainTimeoutMs);
        if (pendingBeforeDrain > 0 || drainResult.drainedCount() > 0) {
            log.info(
                    "event=REALTIME_QUEUE_DRAIN_COMPLETE meetingId={} drainedCount={} waitMs={} queueDepth={}",
                    meetingId,
                    drainResult.drainedCount(),
                    drainResult.waitMs(),
                    queueDepth()
            );
        }

        boolean finalizeWinnerResult = false;
        if (tryTransitionToFinalizing()) {
            try {
                finalizeWinnerResult = finalizeWinner.getAsBoolean();
            } catch (Exception ex) {
                log.warn(
                        "event=REALTIME_FINALIZE_FAILED meetingId={} reason={} status=error",
                        meetingId,
                        safeReason(ex)
                );
            }
            state.compareAndSet(
                    RealtimeSessionLifecycleState.FINALIZING,
                    RealtimeSessionLifecycleState.FINALIZED
            );
        } else {
            log.info(
                    "event=REALTIME_FINALIZE_SKIPPED_DUPLICATE meetingId={} reason=another_path_finalizing status=skipped",
                    meetingId
            );
        }

        cleanup("shutdown");
        log.info(
                "event=REALTIME_WORKER_CLEANUP meetingId={} reason=shutdown registrySizeBefore={} registrySizeAfter=0 status=finalized",
                meetingId,
                registrySizeBefore
        );
        return new ShutdownResult(finalizeWinnerResult, drainResult);
    }

    public void rejectQueueFull() {
        transitionToRejected("queue_full");
        cleanup("backpressure");
        log.info(
                "event=REALTIME_WORKER_CLEANUP meetingId={} reason=backpressure registrySizeBefore=1 registrySizeAfter=0 status=rejected",
                meetingId
        );
    }

    public void cleanupOnly(String reason) {
        cleanup(reason);
        log.info(
                "event=REALTIME_WORKER_CLEANUP meetingId={} reason={} registrySizeBefore=1 registrySizeAfter=0 status=cleanup_only",
                meetingId,
                reason
        );
    }

    private void beginStopping() {
        RealtimeSessionLifecycleState current = state.get();
        if (current == RealtimeSessionLifecycleState.ACTIVE) {
            state.compareAndSet(RealtimeSessionLifecycleState.ACTIVE, RealtimeSessionLifecycleState.STOPPING);
            return;
        }
        if (current == RealtimeSessionLifecycleState.STOPPING
                || current == RealtimeSessionLifecycleState.FINALIZING
                || current == RealtimeSessionLifecycleState.FINALIZED) {
            return;
        }
    }

    private boolean tryTransitionToFinalizing() {
        RealtimeSessionLifecycleState current = state.get();
        if (current == RealtimeSessionLifecycleState.FINALIZING
                || current == RealtimeSessionLifecycleState.FINALIZED) {
            return false;
        }
        if (state.compareAndSet(RealtimeSessionLifecycleState.STOPPING, RealtimeSessionLifecycleState.FINALIZING)) {
            return true;
        }
        if (state.compareAndSet(RealtimeSessionLifecycleState.ACTIVE, RealtimeSessionLifecycleState.FINALIZING)) {
            return true;
        }
        return false;
    }

    private void transitionToRejected(String reason) {
        state.set(RealtimeSessionLifecycleState.REJECTED);
        synchronized (queueMonitor) {
            clearQueuedAudio(reason);
            queueMonitor.notifyAll();
        }
    }

    private void startWorkerIfNeeded() {
        if (!workerStarted.compareAndSet(false, true)) {
            synchronized (queueMonitor) {
                queueMonitor.notifyAll();
            }
            return;
        }
        executor.execute(this::runWorkerLoop);
    }

    private void runWorkerLoop() {
        while (true) {
            RealtimeAudioWorkItem item = pollNextItem();
            if (item == null) {
                RealtimeSessionLifecycleState current = state.get();
                if (current != RealtimeSessionLifecycleState.ACTIVE) {
                    break;
                }
                continue;
            }

            processingInFlight.set(true);
            try {
                chunkProcessor.processChunk(session, item);
            } catch (Exception ex) {
                log.warn(
                        "event=REALTIME_WORKER_CHUNK_FAILED meetingId={} seq={} byteLength={} reason={} status=error",
                        meetingId,
                        item.seq(),
                        item.byteLength(),
                        safeReason(ex)
                );
            } finally {
                item.clearAudioBytes();
                processingInFlight.set(false);
                synchronized (queueMonitor) {
                    queueMonitor.notifyAll();
                }
            }
        }
    }

    private RealtimeAudioWorkItem pollNextItem() {
        synchronized (queueMonitor) {
            RealtimeAudioWorkItem item = queue.pollFirst();
            if (item != null) {
                return item;
            }
            RealtimeSessionLifecycleState current = state.get();
            if (current != RealtimeSessionLifecycleState.ACTIVE) {
                return null;
            }
            try {
                queueMonitor.wait(100L);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                return null;
            }
            return queue.pollFirst();
        }
    }

    private DrainResult drainPending(long timeoutMs) {
        long startedAt = System.currentTimeMillis();
        long deadline = startedAt + timeoutMs;
        int initialDepth = queueDepth();
        int processedEstimate = 0;

        while (System.currentTimeMillis() < deadline) {
            synchronized (queueMonitor) {
                if (queue.isEmpty() && !processingInFlight.get()) {
                    break;
                }
                try {
                    queueMonitor.wait(50L);
                } catch (InterruptedException ex) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }

        int remaining = queueDepth();
        processedEstimate = Math.max(0, initialDepth - remaining);
        if (processingInFlight.get()) {
            processedEstimate = Math.max(processedEstimate, initialDepth);
        }
        long waitMs = System.currentTimeMillis() - startedAt;
        return new DrainResult(processedEstimate, waitMs, remaining);
    }

    private void cleanup(String reason) {
        synchronized (queueMonitor) {
            clearQueuedAudio(reason);
            queueMonitor.notifyAll();
        }
        executor.shutdownNow();
        state.set(
                state.get() == RealtimeSessionLifecycleState.REJECTED
                        ? RealtimeSessionLifecycleState.REJECTED
                        : RealtimeSessionLifecycleState.FINALIZED
        );
    }

    private void clearQueuedAudio(String reason) {
        RealtimeAudioWorkItem item;
        while ((item = queue.pollFirst()) != null) {
            item.clearAudioBytes();
        }
        log.debug(
                "event=REALTIME_QUEUE_CLEARED meetingId={} reason={} queueDepth={}",
                meetingId,
                reason,
                queue.size()
        );
    }

    private String safeReason(Throwable throwable) {
        if (throwable == null) {
            return "unknown";
        }
        String code = throwable.getClass().getSimpleName();
        return (code == null || code.isBlank()) ? "unknown" : code;
    }

    public record DrainResult(int drainedCount, long waitMs, int remainingQueueDepth) {
    }

    public record ShutdownResult(boolean finalizeInvoked, DrainResult drainResult) {
    }
}
