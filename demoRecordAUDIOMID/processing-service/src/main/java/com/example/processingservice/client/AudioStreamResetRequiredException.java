package com.example.processingservice.client;

public class AudioStreamResetRequiredException extends RuntimeException {

    private final Long meetingId;
    private final Long seq;

    public AudioStreamResetRequiredException(Long meetingId, Long seq, Throwable cause) {
        super("Audio stream reset required for meetingId=" + meetingId + " seq=" + seq, cause);
        this.meetingId = meetingId;
        this.seq = seq;
    }

    public Long getMeetingId() {
        return meetingId;
    }

    public Long getSeq() {
        return seq;
    }
}
