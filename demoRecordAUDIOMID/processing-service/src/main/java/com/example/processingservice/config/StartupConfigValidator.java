package com.example.processingservice.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

@Component
public class StartupConfigValidator implements ApplicationRunner {

    @Value("${JWT_SECRET:}")
    private String jwtSecret;

    @Override
    public void run(ApplicationArguments args) throws Exception {
        if (jwtSecret == null || jwtSecret.length() < 32) {
            throw new IllegalStateException("Missing or too-short JWT_SECRET: must be set and at least 32 characters long");
        }
    }
}
