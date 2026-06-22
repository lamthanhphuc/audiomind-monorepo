package com.example.meetingservice.service;

import java.util.HashMap;
import java.util.Map;
import org.springframework.stereotype.Component;
import org.springframework.web.context.annotation.RequestScope;

@Component
@RequestScope
public class MimeSniffRequestCache {

    private final Map<String, MimeSniffer.MimeSniffResult> cache = new HashMap<>();

    public MimeSniffer.MimeSniffResult get(String cacheKey) {
        return cache.get(cacheKey);
    }

    public void put(String cacheKey, MimeSniffer.MimeSniffResult result) {
        cache.put(cacheKey, result);
    }
}
