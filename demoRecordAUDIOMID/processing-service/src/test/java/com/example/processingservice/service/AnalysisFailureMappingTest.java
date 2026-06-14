package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.http.HttpStatus;

import io.github.resilience4j.circuitbreaker.CallNotPermittedException;

class AnalysisFailureMappingTest {

    @Test
    void mapFailureCode_shouldMapCallNotPermittedToCircuitOpen() {
        CallNotPermittedException ex = CallNotPermittedException.createCallNotPermittedException(
                io.github.resilience4j.circuitbreaker.CircuitBreaker.ofDefaults("ai-service")
        );

        assertEquals(AnalysisFailureMapping.ERROR_CODE_CIRCUIT_OPEN, AnalysisFailureMapping.mapFailureCode(ex));
        assertTrue(AnalysisFailureMapping.isRetryableErrorCode(AnalysisFailureMapping.ERROR_CODE_CIRCUIT_OPEN));
        assertEquals(
                AnalysisFailureMapping.ANALYSIS_STATUS_FAILED_RETRYABLE,
                AnalysisFailureMapping.resolveFailedAnalysisStatus(AnalysisFailureMapping.ERROR_CODE_CIRCUIT_OPEN)
        );
    }

    @Test
    void mapFailureCode_shouldMapServiceUnavailableToGeminiUnavailable() {
        HttpServerErrorException ex = new HttpServerErrorException(HttpStatus.SERVICE_UNAVAILABLE, "Service Unavailable");

        assertEquals(AnalysisFailureMapping.ERROR_CODE_GEMINI_UNAVAILABLE, AnalysisFailureMapping.mapFailureCode(ex));
        assertTrue(AnalysisFailureMapping.isRetryableErrorCode(AnalysisFailureMapping.ERROR_CODE_GEMINI_UNAVAILABLE));
    }
}
