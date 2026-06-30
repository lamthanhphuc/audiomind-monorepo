package com.example.processingservice.interfaces.websocket.realtime;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Per-stream audio state for dual-stream tab+mic realtime sessions.
 */
public final class RealtimeStreamAudioState {

    public static final String LEGACY_STREAM_ID = "";

    private long lastPendingSeq;
    private long lastAcceptedSeq;
    private boolean audioReceived;
    private boolean streamFinalized;
    private boolean invalidCapture;
    private long totalAudioBytes;
    private int tinyChunkStreak;

    public long lastPendingSeq() {
        return lastPendingSeq;
    }

    public void setLastPendingSeq(long lastPendingSeq) {
        this.lastPendingSeq = lastPendingSeq;
    }

    public long lastAcceptedSeq() {
        return lastAcceptedSeq;
    }

    public void setLastAcceptedSeq(long lastAcceptedSeq) {
        this.lastAcceptedSeq = lastAcceptedSeq;
    }

    public boolean audioReceived() {
        return audioReceived;
    }

    public void setAudioReceived(boolean audioReceived) {
        this.audioReceived = audioReceived;
    }

    public boolean streamFinalized() {
        return streamFinalized;
    }

    public void setStreamFinalized(boolean streamFinalized) {
        this.streamFinalized = streamFinalized;
    }

    public boolean invalidCapture() {
        return invalidCapture;
    }

    public void setInvalidCapture(boolean invalidCapture) {
        this.invalidCapture = invalidCapture;
    }

    public long totalAudioBytes() {
        return totalAudioBytes;
    }

    public void addTotalAudioBytes(long payloadSize) {
        if (payloadSize > 0) {
            this.totalAudioBytes += payloadSize;
        }
    }

    public int tinyChunkStreak() {
        return tinyChunkStreak;
    }

    public void setTinyChunkStreak(int tinyChunkStreak) {
        this.tinyChunkStreak = Math.max(0, tinyChunkStreak);
    }

    public static String normalizeStreamId(String raw) {
        if (raw == null || raw.isBlank()) {
            return LEGACY_STREAM_ID;
        }
        String normalized = raw.trim().toLowerCase();
        if ("tab".equals(normalized) || "mic".equals(normalized)) {
            return normalized;
        }
        return LEGACY_STREAM_ID;
    }

    public static boolean isDualStreamCapable(String streamId) {
        return "tab".equals(streamId) || "mic".equals(streamId);
    }

    @SuppressWarnings("unchecked")
    public static Map<String, RealtimeStreamAudioState> getOrCreateStateMap(Map<String, Object> sessionAttributes) {
        Object existing = sessionAttributes.get(RealtimeDualStreamSessionKeys.STREAM_AUDIO_STATE_MAP_ATTR);
        if (existing instanceof Map<?, ?> map) {
            return (Map<String, RealtimeStreamAudioState>) map;
        }
        Map<String, RealtimeStreamAudioState> created = new ConcurrentHashMap<>();
        sessionAttributes.put(RealtimeDualStreamSessionKeys.STREAM_AUDIO_STATE_MAP_ATTR, created);
        return created;
    }

    public static RealtimeStreamAudioState stateFor(Map<String, Object> sessionAttributes, String streamId) {
        String normalized = normalizeStreamId(streamId);
        Map<String, RealtimeStreamAudioState> states = getOrCreateStateMap(sessionAttributes);
        return states.computeIfAbsent(normalized, ignored -> new RealtimeStreamAudioState());
    }

    public static List<String> getActiveStreams(Map<String, Object> sessionAttributes) {
        Object raw = sessionAttributes.get(RealtimeDualStreamSessionKeys.ACTIVE_STREAMS_ATTR);
        if (raw instanceof List<?> list && !list.isEmpty()) {
            return list.stream()
                    .map(String::valueOf)
                    .map(RealtimeStreamAudioState::normalizeStreamId)
                    .filter(RealtimeStreamAudioState::isDualStreamCapable)
                    .distinct()
                    .toList();
        }
        return List.of();
    }

    public static boolean isDualStreamSession(Map<String, Object> sessionAttributes) {
        return Boolean.TRUE.equals(sessionAttributes.get(RealtimeDualStreamSessionKeys.DUAL_STREAM_ENABLED_ATTR));
    }

    public static Set<String> streamsPendingFinalize(Map<String, Object> sessionAttributes) {
        List<String> active = getActiveStreams(sessionAttributes);
        if (active.isEmpty()) {
            return Set.of(LEGACY_STREAM_ID);
        }
        Map<String, RealtimeStreamAudioState> states = getOrCreateStateMap(sessionAttributes);
        return active.stream()
                .filter(streamId -> {
                    RealtimeStreamAudioState state = states.get(streamId);
                    return state == null || !state.streamFinalized();
                })
                .collect(java.util.stream.Collectors.toSet());
    }

    public static boolean anyStreamReceivedAudio(Map<String, Object> sessionAttributes) {
        if (!isDualStreamSession(sessionAttributes)) {
            return Boolean.TRUE.equals(sessionAttributes.get("AUDIO_RECEIVED_ATTR"));
        }
        List<String> active = getActiveStreams(sessionAttributes);
        if (active.isEmpty()) {
            return false;
        }
        Map<String, RealtimeStreamAudioState> states = getOrCreateStateMap(sessionAttributes);
        for (String streamId : active) {
            RealtimeStreamAudioState state = states.get(streamId);
            if (state != null && state.audioReceived()) {
                return true;
            }
        }
        return false;
    }

    public static boolean allActiveStreamsFinalized(Map<String, Object> sessionAttributes) {
        if (!isDualStreamSession(sessionAttributes)) {
            return true;
        }
        return streamsPendingFinalize(sessionAttributes).isEmpty();
    }

    public static Map<String, Object> toSummary(Map<String, Object> sessionAttributes) {
        Map<String, Object> summary = new HashMap<>();
        summary.put("dualStream", isDualStreamSession(sessionAttributes));
        summary.put("activeStreams", getActiveStreams(sessionAttributes));
        return summary;
    }
}
