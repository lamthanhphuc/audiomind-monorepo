package com.example.userservice.ratelimit;

import java.util.HashMap;
import java.util.Map;
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

    private int loginPerMinute = 20;

    private int registerPerMinute = 10;

    private int checkoutPerMinute = 5;

    private int googleOAuthPerMinute = 30;

    private Map<String, Integer> overrides = new HashMap<>();
}
