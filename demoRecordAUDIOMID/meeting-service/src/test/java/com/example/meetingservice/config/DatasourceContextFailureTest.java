package com.example.meetingservice.config;

import static org.junit.jupiter.api.Assertions.assertThrows;

import com.example.meetingservice.MeetingServiceApplication;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;

/** Negative datasource wiring: Spring context must fail on invalid JDBC configuration. */
class DatasourceContextFailureTest {

    @Test
    void invalidJdbcUrlFailsApplicationContext() {
        SpringApplication app = new SpringApplication(MeetingServiceApplication.class);
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
                                "--JWT_SECRET=development-jwt-secret-at-least-32-characters"));
    }

    @Test
    void unreachableDatabaseFailsApplicationContext() {
        SpringApplication app = new SpringApplication(MeetingServiceApplication.class);
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
                                "--JWT_SECRET=development-jwt-secret-at-least-32-characters"));
    }

    @Test
    void missingJwtFailsAfterDatasourceWhenValidatorRuns() {
        // Missing JWT is validated by StartupConfigValidator ApplicationRunner.
        SpringApplication app = new SpringApplication(MeetingServiceApplication.class);
        app.setWebApplicationType(WebApplicationType.NONE);
        assertThrows(
                Exception.class,
                () ->
                        app.run(
                                "--spring.main.lazy-initialization=false",
                                "--spring.datasource.url=jdbc:postgresql://127.0.0.1:1/audiomind",
                                "--spring.datasource.username=test",
                                "--spring.datasource.password=test",
                                "--spring.flyway.enabled=false",
                                "--JWT_SECRET=short"));
    }
}
