package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class RealtimeStatusCodesTest {

    @Test
    void isNoTranscriptTerminal_acceptsCanonicalAndLegacyAliases() {
        assertTrue(RealtimeStatusCodes.isNoTranscriptTerminal(RealtimeStatusCodes.NO_TRANSCRIPT));
        assertTrue(RealtimeStatusCodes.isNoTranscriptTerminal(RealtimeStatusCodes.NO_TRANSCRIPT_AFTER_FINALIZE));
        assertTrue(RealtimeStatusCodes.isNoTranscriptTerminal(RealtimeStatusCodes.COMPLETED_WITH_NO_SPEECH_DETECTED));
    }

    @Test
    void resolveMeetingStatusForTerminalOutcome_mapsFailedAudioCaptureToFailed() {
        assertEquals("failed", RealtimeStatusCodes.resolveMeetingStatusForTerminalOutcome(
                RealtimeStatusCodes.FAILED_AUDIO_CAPTURE
        ));
        assertEquals("completed", RealtimeStatusCodes.resolveMeetingStatusForTerminalOutcome(
                RealtimeStatusCodes.NO_TRANSCRIPT
        ));
    }
}
