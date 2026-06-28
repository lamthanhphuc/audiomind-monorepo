package com.example.processingservice.ratelimit;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Getter
@Setter
@Component
@ConfigurationProperties(prefix = "app.rate-limit")
public class HttpRateLimitProperties {

    private boolean enabled = true;

    private int uploadPerMinute = 10;

    private int transcriptSearchPerMinute = 60;
}
