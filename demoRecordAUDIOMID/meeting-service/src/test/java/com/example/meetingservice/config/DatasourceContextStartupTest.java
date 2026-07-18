package com.example.meetingservice.config;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.flyway.autoconfigure.FlywayAutoConfiguration;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Context-level datasource + Flyway coverage for meeting-service managed PostgreSQL wiring.
 *
 * <p>Seeds shared {@code app_users} (owned by user-service) before Flyway so V15 FK can apply.
 */
@DataJpaTest(
        properties = {
            "spring.jpa.hibernate.ddl-auto=validate",
            "spring.flyway.enabled=true",
            "spring.flyway.table=flyway_schema_history_meeting",
            "spring.flyway.baseline-on-migrate=true",
            "spring.flyway.baseline-version=0",
            "JWT_SECRET=development-jwt-secret-at-least-32-characters"
        })
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@ImportAutoConfiguration(FlywayAutoConfiguration.class)
@Import(StartupConfigValidator.class)
class DatasourceContextStartupTest {

    @SuppressWarnings("resource")
    static PostgreSQLContainer<?> POSTGRES;

    @BeforeAll
    static void startPostgres() throws Exception {
        boolean required =
                Boolean.parseBoolean(
                        System.getenv()
                                .getOrDefault(
                                        "REQUIRE_DATASOURCE_CONTEXT_TESTS",
                                        System.getProperty(
                                                "REQUIRE_DATASOURCE_CONTEXT_TESTS", "false")));
        boolean docker = DockerClientFactory.instance().isDockerAvailable();
        if (required && !docker) {
            throw new IllegalStateException(
                    "REQUIRE_DATASOURCE_CONTEXT_TESTS=true but Docker is unavailable");
        }
        Assumptions.assumeTrue(docker, "Docker required for DatasourceContextStartupTest");

        POSTGRES =
                new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"))
                        .withDatabaseName("meeting_ctx")
                        .withUsername("test")
                        .withPassword("test");
        POSTGRES.start();
        try (Connection connection =
                        DriverManager.getConnection(
                                POSTGRES.getJdbcUrl(),
                                POSTGRES.getUsername(),
                                POSTGRES.getPassword());
                Statement statement = connection.createStatement()) {
            statement.execute(
                    """
                    CREATE TABLE IF NOT EXISTS app_users (
                        id BIGSERIAL PRIMARY KEY,
                        username VARCHAR(50) NOT NULL UNIQUE,
                        email VARCHAR(255) NOT NULL UNIQUE,
                        password_hash VARCHAR(255) NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """);
        }
    }

    @AfterAll
    static void stopPostgres() {
        if (POSTGRES != null) {
            POSTGRES.stop();
        }
    }

    @DynamicPropertySource
    static void registerDatasource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", () -> POSTGRES.getJdbcUrl());
        registry.add("spring.datasource.username", () -> POSTGRES.getUsername());
        registry.add("spring.datasource.password", () -> POSTGRES.getPassword());
        registry.add("spring.datasource.driver-class-name", () -> "org.postgresql.Driver");
        registry.add(
                "spring.jpa.properties.hibernate.dialect",
                () -> "org.hibernate.dialect.PostgreSQLDialect");
        registry.add("JWT_SECRET", () -> "development-jwt-secret-at-least-32-characters");
    }

    @Autowired
    private DataSource dataSource;

    @Autowired
    private Flyway flyway;

    @Autowired
    private StartupConfigValidator startupConfigValidator;

    @Test
    void contextStartsWithValidJdbcAndFlyway() throws Exception {
        assertNotNull(dataSource);
        assertNotNull(flyway);
        assertNotNull(startupConfigValidator);
        startupConfigValidator.run(null);

        try (Connection connection = dataSource.getConnection();
                Statement statement = connection.createStatement();
                ResultSet rs =
                        statement.executeQuery(
                                "SELECT version FROM flyway_schema_history_meeting"
                                        + " WHERE success = true"
                                        + " ORDER BY installed_rank DESC LIMIT 1")) {
            assertTrue(rs.next());
            assertTrue(Integer.parseInt(rs.getString(1)) >= 16);
        }
    }
}
