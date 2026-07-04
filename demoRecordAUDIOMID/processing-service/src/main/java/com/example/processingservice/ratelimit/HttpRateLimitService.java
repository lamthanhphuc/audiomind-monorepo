package com.example.processingservice.ratelimit;

import io.github.bucket4j.Bandwidth;
import io.github.bucket4j.BucketConfiguration;
import io.github.bucket4j.Refill;
import io.github.bucket4j.distributed.proxy.ProxyManager;
import java.time.Duration;
import java.util.Optional;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Service
public class HttpRateLimitService {

    private static final String KEY_PREFIX = "rate-limit:processing:";

    private final Optional<ProxyManager<String>> proxyManager;

    @Autowired
    HttpRateLimitService(@Autowired(required = false) ProxyManager<String> proxyManager) {
        this.proxyManager = Optional.ofNullable(proxyManager);
    }

    public boolean tryConsume(String bucket, int limit, Duration window) {
        if (limit <= 0 || proxyManager.isEmpty()) {
            return true;
        }

        String key = KEY_PREFIX + bucket;
        Supplier<BucketConfiguration> configurationSupplier = () -> BucketConfiguration.builder()
                .addLimit(Bandwidth.classic(limit, Refill.greedy(limit, window)))
                .build();

        return proxyManager.get().builder().build(key, configurationSupplier).tryConsume(1);
    }
}
