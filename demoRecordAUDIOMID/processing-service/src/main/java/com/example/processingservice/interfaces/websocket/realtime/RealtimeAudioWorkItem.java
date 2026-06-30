package com.example.processingservice.interfaces.websocket.realtime;

public final class RealtimeAudioWorkItem {

    private final long meetingId;
    private final String streamId;
    private final long seq;
    private byte[] audioBytes;
    private final int byteLength;
    private final String language;
    private final String speakerMode;
    private final boolean isFinal;
    private final String authorization;
    private final long enqueuedAtMs;

    public RealtimeAudioWorkItem(
            long meetingId,
            long seq,
            byte[] audioBytes,
            String language,
            String speakerMode,
            boolean isFinal,
            String authorization) {
        this(meetingId, RealtimeStreamAudioState.LEGACY_STREAM_ID, seq, audioBytes, language, speakerMode, isFinal, authorization);
    }

    public RealtimeAudioWorkItem(
            long meetingId,
            String streamId,
            long seq,
            byte[] audioBytes,
            String language,
            String speakerMode,
            boolean isFinal,
            String authorization) {
        this.meetingId = meetingId;
        this.streamId = RealtimeStreamAudioState.normalizeStreamId(streamId);
        this.seq = seq;
        this.audioBytes = audioBytes;
        this.byteLength = audioBytes == null ? 0 : audioBytes.length;
        this.language = language;
        this.speakerMode = speakerMode;
        this.isFinal = isFinal;
        this.authorization = authorization;
        this.enqueuedAtMs = System.currentTimeMillis();
    }

    public long meetingId() {
        return meetingId;
    }

    public String streamId() {
        return streamId;
    }

    public long seq() {
        return seq;
    }

    public byte[] audioBytes() {
        return audioBytes;
    }

    public int byteLength() {
        return byteLength;
    }

    public String language() {
        return language;
    }

    public String speakerMode() {
        return speakerMode;
    }

    public boolean isFinal() {
        return isFinal;
    }

    public String authorization() {
        return authorization;
    }

    public long enqueuedAtMs() {
        return enqueuedAtMs;
    }

    public void clearAudioBytes() {
        this.audioBytes = null;
    }
}
