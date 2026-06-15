package com.example.processingservice.service;

import java.util.Locale;
import java.util.Set;

/**
 * Canonical realtime terminal and lifecycle status codes shared across processing WS,
 * job state, and analysis responses.
 */
public final class RealtimeStatusCodes {

    public static final String COMPLETED = "COMPLETED";
    public static final String FINALIZING = "FINALIZING";
    public static final String NO_TRANSCRIPT = "NO_TRANSCRIPT";
    /** Backward-compatible alias retained for persisted job state and legacy clients. */
    public static final String NO_TRANSCRIPT_AFTER_FINALIZE = "NO_TRANSCRIPT_AFTER_FINALIZE";
    public static final String FAILED_AUDIO_CAPTURE = "FAILED_AUDIO_CAPTURE";
    public static final String COMPLETED_WITH_NO_SPEECH_DETECTED = "COMPLETED_WITH_NO_SPEECH_DETECTED";

    private static final Set<String> NO_TRANSCRIPT_TERMINAL = Set.of(
            NO_TRANSCRIPT,
            NO_TRANSCRIPT_AFTER_FINALIZE,
            COMPLETED_WITH_NO_SPEECH_DETECTED
    );

    private static final Set<String> TERMINAL_REALTIME_OUTCOMES = Set.of(
            NO_TRANSCRIPT,
            NO_TRANSCRIPT_AFTER_FINALIZE,
            COMPLETED_WITH_NO_SPEECH_DETECTED,
            FAILED_AUDIO_CAPTURE,
            COMPLETED
    );

    private RealtimeStatusCodes() {
    }

    public static String normalize(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        return value.trim().toUpperCase(Locale.ROOT);
    }

    public static boolean isNoTranscriptTerminal(String status) {
        return NO_TRANSCRIPT_TERMINAL.contains(normalize(status));
    }

    public static boolean isTerminalRealtimeOutcome(String status) {
        return TERMINAL_REALTIME_OUTCOMES.contains(normalize(status));
    }

    public static String canonicalNoTranscriptCode() {
        return NO_TRANSCRIPT;
    }

    public static String legacyNoTranscriptAlias() {
        return NO_TRANSCRIPT_AFTER_FINALIZE;
    }

    public static String resolveMeetingStatusForTerminalOutcome(String terminalStatus) {
        String normalized = normalize(terminalStatus);
        if (FAILED_AUDIO_CAPTURE.equals(normalized)) {
            return "failed";
        }
        if (isNoTranscriptTerminal(normalized) || COMPLETED.equals(normalized)) {
            return "completed";
        }
        return "completed";
    }
}
