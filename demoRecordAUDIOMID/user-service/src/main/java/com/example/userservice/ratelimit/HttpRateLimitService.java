package com.example.userservice.ratelimit;



import io.github.bucket4j.Bandwidth;

import io.github.bucket4j.BucketConfiguration;

import io.github.bucket4j.Refill;

import io.github.bucket4j.distributed.proxy.ProxyManager;

import java.time.Duration;

import java.util.function.Supplier;

import lombok.RequiredArgsConstructor;

import org.springframework.stereotype.Service;



@Service

@RequiredArgsConstructor

public class HttpRateLimitService {



    private static final String KEY_PREFIX = "rate-limit:user:";



    private final ProxyManager<String> proxyManager;



    public boolean tryConsume(String bucket, int limit, Duration window) {

        if (limit <= 0) {

            return true;

        }

        String key = KEY_PREFIX + bucket;

        Supplier<BucketConfiguration> configurationSupplier = () -> BucketConfiguration.builder()

                .addLimit(Bandwidth.classic(limit, Refill.greedy(limit, window)))

                .build();

        return proxyManager.builder().build(key, configurationSupplier).tryConsume(1);

    }

}

