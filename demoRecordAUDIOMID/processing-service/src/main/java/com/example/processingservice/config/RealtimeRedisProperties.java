package com.example.processingservice.config;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Getter
@Setter
@Component
@ConfigurationProperties(prefix = "app.realtime")
public class RealtimeRedisProperties {

    /**
     * When true, WS events are published to Redis Streams and consumed on every replica.
     */
    private boolean redisStreamsEnabled = false;

    private String meetingEventsStreamKey = "stream:realtime:meeting-events";

    private String keywordStreamKey = "realtime.keyword_hits";

    private String consumerGroup = "processing-realtime";
}
