package com.example.meetingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ScanCircuitBreakerTest {

    @Test
    void opensAfterThreeFailuresWithinWindow() {
        ScanCircuitBreaker breaker = new ScanCircuitBreaker();
        assertFalse(breaker.isOpen());
        breaker.recordFailure();
        breaker.recordFailure();
        assertFalse(breaker.isOpen());
        breaker.recordFailure();
        assertTrue(breaker.isOpen());
        assertEquals(3, breaker.failureCount());
    }

    @Test
    void successResetsFailureCount() {
        ScanCircuitBreaker breaker = new ScanCircuitBreaker();
        breaker.recordFailure();
        breaker.recordFailure();
        breaker.recordSuccess();
        assertFalse(breaker.isOpen());
        assertEquals(0, breaker.failureCount());
    }
}
