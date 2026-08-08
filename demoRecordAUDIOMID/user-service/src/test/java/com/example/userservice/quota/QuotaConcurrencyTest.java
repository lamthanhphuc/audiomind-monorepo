package com.example.userservice.quota;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.example.userservice.entity.QuotaConsumption;
import com.example.userservice.entity.UsageCounter;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.plan.SubscriptionPlanService;
import com.example.userservice.plan.UserPlanService;
import com.example.userservice.quota.QuotaService.QuotaConsumeResult;
import com.example.userservice.repository.QuotaConsumptionRepository;
import com.example.userservice.repository.UsageCounterRepository;
import com.example.userservice.repository.UserAccountRepository;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
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
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

/**
 * Real PostgreSQL concurrency coverage for idempotent quota consume.
 *
 * <p>Uses {@code @DataJpaTest} + Flyway + Testcontainers so Redis / security / Google OAuth
 * beans are not required. Test methods run without an outer transaction so concurrent
 * {@link QuotaService} calls can commit independently.
 *
 * <p>Docker gate: when {@code REQUIRE_POSTGRES_CONCURRENCY_TESTS=true} and Docker is unavailable,
 * the class fails hard. Otherwise missing Docker skips via {@link Assumptions#assumeTrue}.
 */
@DataJpaTest(
        properties = {
            "spring.jpa.hibernate.ddl-auto=validate",
            "spring.flyway.enabled=true",
            "spring.flyway.table=flyway_schema_history_user"
        })
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@ImportAutoConfiguration(FlywayAutoConfiguration.class)
@Import({QuotaService.class, UserPlanService.class, SubscriptionPlanService.class})
@Transactional(propagation = Propagation.NOT_SUPPORTED)
class QuotaConcurrencyTest {

    private static final DateTimeFormatter YYYYMM = DateTimeFormatter.ofPattern("yyyyMM");
    private static final long FREE_GEMINI_LIMIT = 50_000L;

    @SuppressWarnings("resource")
    static PostgreSQLContainer<?> POSTGRES;

    @BeforeAll
    static void requireDockerWhenForced() {
        boolean required =
                Boolean.parseBoolean(
                        System.getenv()
                                .getOrDefault(
                                        "REQUIRE_POSTGRES_CONCURRENCY_TESTS",
                                        System.getProperty(
                                                "REQUIRE_POSTGRES_CONCURRENCY_TESTS", "false")));
        boolean docker = DockerClientFactory.instance().isDockerAvailable();
        if (required && !docker) {
            throw new IllegalStateException(
                    "REQUIRE_POSTGRES_CONCURRENCY_TESTS=true but Docker is unavailable");
        }
        Assumptions.assumeTrue(docker, "Docker required for QuotaConcurrencyTest");

        POSTGRES =
                new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"))
                        .withDatabaseName("user_quota_it")
                        .withUsername("test")
                        .withPassword("test");
        POSTGRES.start();
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
    }

    @Autowired
    private QuotaService quotaService;

    @Autowired
    private UserAccountRepository userAccountRepository;

    @Autowired
    private UsageCounterRepository usageCounterRepository;

    @Autowired
    private QuotaConsumptionRepository quotaConsumptionRepository;

    @Test
    void concurrentSameKey_deductsOnce_allAllowed() throws Exception {
        UserAccount user = persistFreeUser("same-key");
        long deltaChars = 250L;
        String key = "race-same-" + user.getId();

        List<QuotaConsumeResult> results =
                runConcurrent(8, () -> quotaService.consume(user.getId(), 0L, deltaChars, key));

        assertEquals(8, results.size());
        for (QuotaConsumeResult result : results) {
            assertTrue(result.allowed());
            assertEquals(deltaChars, result.geminiInputCharsUsed());
        }

        UsageCounter counter = requireCounter(user.getId());
        assertEquals(deltaChars, counter.getGeminiInputCharsUsed());
        assertEquals(0L, counter.getSttSecondsUsed());
        assertEquals(1L, countLedgerRows(user.getId()));
        assertEquals(
                QuotaConsumption.STATUS_ALLOWED,
                quotaConsumptionRepository
                        .findByOwnerUserIdAndIdempotencyKey(user.getId(), key)
                        .orElseThrow()
                        .getStatus());
    }

    @Test
    void concurrentDifferentKeys_noPriorCounter_bothAllowed_oneCounterTwoLedgerRows()
            throws Exception {
        UserAccount user = persistFreeUser("diff-keys");
        long deltaChars = 100L;
        String keyA = "key-a-" + user.getId();
        String keyB = "key-b-" + user.getId();

        assertTrue(
                usageCounterRepository
                        .findByUserIdAndPeriodYyyymm(user.getId(), currentPeriod())
                        .isEmpty());

        AtomicInteger toggle = new AtomicInteger();
        List<QuotaConsumeResult> results =
                runConcurrent(
                        2,
                        () -> {
                            String key = toggle.getAndIncrement() == 0 ? keyA : keyB;
                            return quotaService.consume(user.getId(), 0L, deltaChars, key);
                        });

        assertEquals(2, results.size());
        assertTrue(results.get(0).allowed());
        assertTrue(results.get(1).allowed());

        UsageCounter counter = requireCounter(user.getId());
        assertEquals(2L * deltaChars, counter.getGeminiInputCharsUsed());
        assertEquals(1L, countUsageCounterRows(user.getId()));
        assertEquals(2L, countLedgerRows(user.getId()));
        assertTrue(
                quotaConsumptionRepository
                        .findByOwnerUserIdAndIdempotencyKey(user.getId(), keyA)
                        .isPresent());
        assertTrue(
                quotaConsumptionRepository
                        .findByOwnerUserIdAndIdempotencyKey(user.getId(), keyB)
                        .isPresent());
    }

    @Test
    void concurrentDifferentKeys_remainingQuotaForOne_oneAllowedOneDenied() throws Exception {
        UserAccount user = persistFreeUser("near-limit");
        long remaining = 1_000L;
        long deltaChars = remaining;
        seedUsageNearLimit(user.getId(), FREE_GEMINI_LIMIT - remaining);

        String keyA = "limit-a-" + user.getId();
        String keyB = "limit-b-" + user.getId();
        AtomicInteger toggle = new AtomicInteger();

        List<QuotaConsumeResult> results =
                runConcurrent(
                        2,
                        () -> {
                            String key = toggle.getAndIncrement() == 0 ? keyA : keyB;
                            return quotaService.consume(user.getId(), 0L, deltaChars, key);
                        });

        long allowed = results.stream().filter(QuotaConsumeResult::allowed).count();
        long denied = results.stream().filter(r -> !r.allowed()).count();
        assertEquals(1L, allowed);
        assertEquals(1L, denied);

        UsageCounter counter = requireCounter(user.getId());
        assertEquals(FREE_GEMINI_LIMIT, counter.getGeminiInputCharsUsed());
        assertFalse(counter.getGeminiInputCharsUsed() > FREE_GEMINI_LIMIT);

        List<String> statuses =
                List.of(
                        quotaConsumptionRepository
                                .findByOwnerUserIdAndIdempotencyKey(user.getId(), keyA)
                                .orElseThrow()
                                .getStatus(),
                        quotaConsumptionRepository
                                .findByOwnerUserIdAndIdempotencyKey(user.getId(), keyB)
                                .orElseThrow()
                                .getStatus());
        assertTrue(statuses.contains(QuotaConsumption.STATUS_ALLOWED));
        assertTrue(statuses.contains(QuotaConsumption.STATUS_DENIED));
    }

    private UserAccount persistFreeUser(String label) {
        UserAccount user = new UserAccount();
        String suffix = label + "-" + UUID.randomUUID().toString().substring(0, 8);
        user.setUsername("u-" + suffix);
        user.setEmail(suffix + "@example.com");
        user.setPasswordHash("unused-hash");
        user.setAuthProviderPrimary("local");
        user.setRole("USER");
        user.setPlan("FREE");
        user.setPlanExpiresAt(null);
        return userAccountRepository.saveAndFlush(user);
    }

    private void seedUsageNearLimit(Long userId, long geminiCharsUsed) {
        UsageCounter counter = new UsageCounter();
        counter.setUserId(userId);
        counter.setPeriodYyyymm(currentPeriod());
        counter.setSttSecondsUsed(0);
        counter.setGeminiInputCharsUsed(geminiCharsUsed);
        usageCounterRepository.saveAndFlush(counter);
    }

    private UsageCounter requireCounter(Long userId) {
        return usageCounterRepository
                .findByUserIdAndPeriodYyyymm(userId, currentPeriod())
                .orElseThrow();
    }

    private long countLedgerRows(Long userId) {
        return quotaConsumptionRepository.findAll().stream()
                .filter(row -> userId.equals(row.getOwnerUserId()))
                .count();
    }

    private long countUsageCounterRows(Long userId) {
        return usageCounterRepository.findAll().stream()
                .filter(row -> userId.equals(row.getUserId()))
                .count();
    }

    private static String currentPeriod() {
        return LocalDate.now(ZoneOffset.UTC).format(YYYYMM);
    }

    private static List<QuotaConsumeResult> runConcurrent(
            int threads, ConcurrentConsume action) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch ready = new CountDownLatch(threads);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<QuotaConsumeResult>> futures = new ArrayList<>(threads);
        try {
            for (int i = 0; i < threads; i++) {
                futures.add(
                        pool.submit(
                                () -> {
                                    ready.countDown();
                                    assertTrue(start.await(10, TimeUnit.SECONDS));
                                    return action.run();
                                }));
            }
            assertTrue(ready.await(10, TimeUnit.SECONDS));
            start.countDown();

            List<QuotaConsumeResult> results = new ArrayList<>(threads);
            for (Future<QuotaConsumeResult> future : futures) {
                results.add(future.get(30, TimeUnit.SECONDS));
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }

    @FunctionalInterface
    private interface ConcurrentConsume {
        QuotaConsumeResult run() throws Exception;
    }
}
