package com.example.meetingservice.service;

import java.util.ArrayDeque;
import java.util.Deque;
import org.springframework.stereotype.Component;

@Component
public class ScanCircuitBreaker {

    static final int FAILURE_THRESHOLD = 3;
    static final long WINDOW_MS = 5L * 60L * 1000L;

    private final Deque<Long> failureTimestamps = new ArrayDeque<>();

    public synchronized boolean isOpen() {
        pruneExpiredFailures();
        return failureTimestamps.size() >= FAILURE_THRESHOLD;
    }

    public synchronized void recordFailure() {
        pruneExpiredFailures();
        failureTimestamps.addLast(System.currentTimeMillis());
    }

    public synchronized void recordSuccess() {
        failureTimestamps.clear();
    }

    synchronized int failureCount() {
        pruneExpiredFailures();
        return failureTimestamps.size();
    }

    private void pruneExpiredFailures() {
        long cutoff = System.currentTimeMillis() - WINDOW_MS;
        while (!failureTimestamps.isEmpty() && failureTimestamps.peekFirst() < cutoff) {
            failureTimestamps.removeFirst();
        }
    }
}
