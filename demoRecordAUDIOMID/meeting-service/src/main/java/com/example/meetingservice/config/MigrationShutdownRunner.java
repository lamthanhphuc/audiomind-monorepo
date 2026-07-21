package com.example.meetingservice.config;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Profile;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * Migration Job entry: Flyway runs during context refresh, then this runner exits the JVM
 * without leaving an HTTP server running.
 */
@Component
@Profile("migration")
@Order(Ordered.LOWEST_PRECEDENCE)
public class MigrationShutdownRunner implements ApplicationRunner {

    private final ConfigurableApplicationContext context;

    public MigrationShutdownRunner(ConfigurableApplicationContext context) {
        this.context = context;
    }

    @Override
    public void run(ApplicationArguments args) {
        int code = SpringApplication.exit(context, () -> 0);
        System.exit(code);
    }
}
