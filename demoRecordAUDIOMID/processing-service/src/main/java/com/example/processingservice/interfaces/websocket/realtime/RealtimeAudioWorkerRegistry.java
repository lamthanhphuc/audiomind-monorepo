package com.example.processingservice.interfaces.websocket.realtime;

import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

import org.springframework.stereotype.Component;

@Component
public class RealtimeAudioWorkerRegistry {

    private final ConcurrentHashMap<String, RealtimeAudioSessionWorker> workers = new ConcurrentHashMap<>();

    public RealtimeAudioSessionWorker getOrCreate(
            String sessionId,
            Function<String, RealtimeAudioSessionWorker> factory) {
        return workers.computeIfAbsent(sessionId, factory);
    }

    public RealtimeAudioSessionWorker get(String sessionId) {
        return workers.get(sessionId);
    }

    public RealtimeAudioSessionWorker remove(String sessionId) {
        return workers.remove(sessionId);
    }

    public boolean remove(String sessionId, RealtimeAudioSessionWorker worker) {
        return workers.remove(sessionId, worker);
    }

    public boolean contains(String sessionId) {
        return workers.containsKey(sessionId);
    }

    public int size() {
        return workers.size();
    }
}
