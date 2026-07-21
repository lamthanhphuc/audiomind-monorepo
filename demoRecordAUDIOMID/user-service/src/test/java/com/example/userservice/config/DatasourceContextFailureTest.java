package com.example.userservice.config;

import static org.junit.jupiter.api.Assertions.assertThrows;

import com.example.userservice.UserServiceApplication;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;

/** Negative datasource wiring for user-service. */
class DatasourceContextFailureTest {

    @Test
    void invalidJdbcUrlFailsApplicationContext() {
        SpringApplication app = new SpringApplication(UserServiceApplication.class);
        app.setWebApplicationType(WebApplicationType.NONE);
        assertThrows(
                Exception.class,
                () ->
                        app.run(
                                "--spring.main.lazy-initialization=false",
                                "--spring.datasource.url=jdbc:not-a-postgresql-url",
                                "--spring.datasource.username=test",
                                "--spring.datasource.password=test",
                                "--spring.datasource.driver-class-name=org.postgresql.Driver",
                                "--spring.flyway.enabled=false",
                                "--spring.data.redis.host=127.0.0.1",
                                "--spring.data.redis.port=6399",
                                "--JWT_SECRET=development-jwt-secret-at-least-32-characters"));
    }

    @Test
    void unreachableDatabaseFailsApplicationContext() {
        SpringApplication app = new SpringApplication(UserServiceApplication.class);
        app.setWebApplicationType(WebApplicationType.NONE);
        assertThrows(
                Exception.class,
                () ->
                        app.run(
                                "--spring.main.lazy-initialization=false",
                                "--spring.datasource.url=jdbc:postgresql://127.0.0.1:1/audiomind",
                                "--spring.datasource.username=test",
                                "--spring.datasource.password=test",
                                "--spring.datasource.driver-class-name=org.postgresql.Driver",
                                "--spring.flyway.enabled=true",
                                "--spring.data.redis.host=127.0.0.1",
                                "--spring.data.redis.port=6399",
                                "--JWT_SECRET=development-jwt-secret-at-least-32-characters"));
    }
}
