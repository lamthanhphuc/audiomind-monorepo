package com.example.userservice.quota;

import com.example.userservice.entity.QuotaConsumption;
import com.example.userservice.entity.UsageCounter;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.plan.UserPlanService;
import com.example.userservice.repository.QuotaConsumptionRepository;
import com.example.userservice.repository.UsageCounterRepository;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.quota.QuotaService.QuotaConsumeResult;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.ReentrantLock;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.test.util.ReflectionTestUtils;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Unit tests for {@link QuotaService}.
 *
 * <p>Real PostgreSQL concurrent coverage lives in {@link QuotaConcurrencyIT}
 * (Testcontainers + {@code @DataJpaTest}).
 */
@ExtendWith(MockitoExtension.class)
class QuotaServiceTest {

  private static final DateTimeFormatter YYYYMM = DateTimeFormatter.ofPattern("yyyyMM");

  @Mock
  private UsageCounterRepository usageCounterRepository;

  @Mock
  private UserAccountRepository userAccountRepository;

  @Mock
  private UserPlanService userPlanService;

  @Mock
  private QuotaConsumptionRepository quotaConsumptionRepository;

  @Mock
  private EntityManager entityManager;

  @Mock
  private Query nativeQuery;

  @InjectMocks
  private QuotaService quotaService;

  @BeforeEach
  void setUpClock() {
    Clock fixedClock = Clock.fixed(Instant.parse("2026-06-15T12:00:00Z"), ZoneOffset.UTC);
    ReflectionTestUtils.setField(quotaService, "clock", fixedClock);
    ReflectionTestUtils.setField(quotaService, "self", quotaService);
    lenient().when(userPlanService.refreshExpiredPlan(any(UserAccount.class)))
        .thenAnswer(invocation -> invocation.getArgument(0));
    lenient().when(userPlanService.resolveEffectivePlan(any(UserAccount.class)))
        .thenAnswer(invocation -> {
          UserAccount account = invocation.getArgument(0);
          return account.getPlan();
        });
    stubAdvisoryLockAndUpsert();
  }

  private void stubAdvisoryLockAndUpsert() {
    lenient().when(entityManager.createNativeQuery(anyString())).thenReturn(nativeQuery);
    lenient().when(nativeQuery.setParameter(anyString(), any())).thenReturn(nativeQuery);
    lenient().when(nativeQuery.getSingleResult()).thenReturn(1);
    lenient().when(nativeQuery.executeUpdate()).thenReturn(1);
  }

  @Test
  void advisoryLockKey_isStableForUserAndPeriod() {
    assertEquals(
        QuotaService.advisoryLockKey(7L, "202606"),
        QuotaService.advisoryLockKey(7L, "202606"));
    assertTrue(QuotaService.advisoryLockKey(7L, "202606") != QuotaService.advisoryLockKey(8L, "202606"));
    assertTrue(QuotaService.advisoryLockKey(7L, "202606") != QuotaService.advisoryLockKey(7L, "202607"));
  }

  @Test
  void consume_takesAdvisoryLockBeforeUsageCounter() {
    UserAccount user = userWithPlan("FREE");
    when(userAccountRepository.findById(7L)).thenReturn(Optional.of(user));
    UsageCounter counter = new UsageCounter();
    counter.setUserId(7L);
    counter.setPeriodYyyymm(currentPeriod());
    counter.setSttSecondsUsed(0);
    counter.setGeminiInputCharsUsed(0);
    when(usageCounterRepository.lockByUserAndPeriod(7L, currentPeriod()))
        .thenReturn(Optional.of(counter));
    when(usageCounterRepository.save(any(UsageCounter.class)))
        .thenAnswer(invocation -> invocation.getArgument(0));

    quotaService.consume(7L, 10L, 0L);

    verify(entityManager, times(2)).createNativeQuery(anyString());
    verify(nativeQuery).getSingleResult();
    verify(nativeQuery).executeUpdate();
    verify(usageCounterRepository).lockByUserAndPeriod(7L, currentPeriod());
  }

  @Test
  void consume_shouldAllowAndPersistWhenWithinFreePlanLimits() {
    UserAccount user = userWithPlan("FREE");
    when(userAccountRepository.findById(7L)).thenReturn(Optional.of(user));
    UsageCounter counter = emptyCounter(7L);
    when(usageCounterRepository.lockByUserAndPeriod(7L, currentPeriod()))
        .thenReturn(Optional.of(counter));
    when(usageCounterRepository.save(any(UsageCounter.class)))
        .thenAnswer(invocation -> invocation.getArgument(0));

    QuotaConsumeResult result = quotaService.consume(7L, 120L, 1_000L);

    assertTrue(result.allowed());
    assertEquals("ALLOWED", result.status());
    assertEquals(120L, result.sttSecondsUsed());
    assertEquals(1_000L, result.geminiInputCharsUsed());
    ArgumentCaptor<UsageCounter> captor = ArgumentCaptor.forClass(UsageCounter.class);
    verify(usageCounterRepository).save(captor.capture());
    assertEquals(120L, captor.getValue().getSttSecondsUsed());
    assertEquals(1_000L, captor.getValue().getGeminiInputCharsUsed());
    verify(quotaConsumptionRepository, never()).saveAndFlush(any());
  }

  @Test
  void consume_shouldRejectWhenGeminiCharsWouldExceedFreePlan() {
    UserAccount user = userWithPlan("FREE");
    UsageCounter counter = new UsageCounter();
    counter.setUserId(8L);
    counter.setPeriodYyyymm(currentPeriod());
    counter.setSttSecondsUsed(0);
    counter.setGeminiInputCharsUsed(49_500L);

    when(userAccountRepository.findById(8L)).thenReturn(Optional.of(user));
    when(usageCounterRepository.lockByUserAndPeriod(8L, currentPeriod()))
        .thenReturn(Optional.of(counter));

    QuotaConsumeResult result = quotaService.consume(8L, 0, 1_000L);

    assertFalse(result.allowed());
    assertEquals("DENIED", result.status());
    verify(usageCounterRepository, never()).save(any());
  }

  @Test
  void consume_shouldUseProLimits() {
    UserAccount user = userWithPlan("PRO");
    when(userAccountRepository.findById(9L)).thenReturn(Optional.of(user));
    when(usageCounterRepository.lockByUserAndPeriod(9L, currentPeriod()))
        .thenReturn(Optional.of(emptyCounter(9L)));
    when(usageCounterRepository.save(any(UsageCounter.class)))
        .thenAnswer(invocation -> invocation.getArgument(0));

    QuotaConsumeResult result = quotaService.consume(9L, 0, 100_000L);

    assertTrue(result.allowed());
    assertEquals(2_000_000L, result.geminiInputCharsLimit());
  }

  @Test
  void consume_sameIdempotencyKeyTwice_deductsOnlyOnce() {
    UserAccount user = userWithPlan("FREE");
    when(userAccountRepository.findById(10L)).thenReturn(Optional.of(user));
    when(usageCounterRepository.lockByUserAndPeriod(10L, currentPeriod()))
        .thenReturn(Optional.of(emptyCounter(10L)));
    when(usageCounterRepository.save(any(UsageCounter.class)))
        .thenAnswer(invocation -> invocation.getArgument(0));
    when(usageCounterRepository.findByUserIdAndPeriodYyyymm(10L, currentPeriod()))
        .thenAnswer(invocation -> {
          UsageCounter c = new UsageCounter();
          c.setUserId(10L);
          c.setPeriodYyyymm(currentPeriod());
          c.setSttSecondsUsed(60L);
          c.setGeminiInputCharsUsed(500L);
          return Optional.of(c);
        });

    AtomicReference<QuotaConsumption> stored = new AtomicReference<>();
    when(quotaConsumptionRepository.findByOwnerUserIdAndIdempotencyKey(10L, "study-art-1"))
        .thenAnswer(invocation -> Optional.ofNullable(stored.get()));
    when(quotaConsumptionRepository.saveAndFlush(any(QuotaConsumption.class)))
        .thenAnswer(invocation -> {
          QuotaConsumption row = invocation.getArgument(0);
          if (row.getId() == null) {
            row.setId(1L);
          }
          stored.set(row);
          return row;
        });

    QuotaConsumeResult first = quotaService.consume(10L, 60L, 500L, "study-art-1");
    QuotaConsumeResult second = quotaService.consume(10L, 60L, 500L, "study-art-1");

    assertTrue(first.allowed());
    assertTrue(second.allowed());
    assertEquals(60L, first.sttSecondsUsed());
    assertEquals(60L, second.sttSecondsUsed());
    verify(usageCounterRepository, times(1)).save(any(UsageCounter.class));
    verify(quotaConsumptionRepository, times(1)).saveAndFlush(any(QuotaConsumption.class));
    assertEquals(QuotaConsumption.TYPE_STUDY_ARTIFACT, stored.get().getQuotaType());
  }

  @Test
  void consume_persistsCallerQuotaType_subjectSynthesis() {
    UserAccount user = userWithPlan("FREE");
    when(userAccountRepository.findById(20L)).thenReturn(Optional.of(user));
    when(usageCounterRepository.lockByUserAndPeriod(20L, currentPeriod()))
        .thenReturn(Optional.of(emptyCounter(20L)));
    when(usageCounterRepository.save(any(UsageCounter.class)))
        .thenAnswer(invocation -> invocation.getArgument(0));

    AtomicReference<QuotaConsumption> stored = new AtomicReference<>();
    when(quotaConsumptionRepository.findByOwnerUserIdAndIdempotencyKey(20L, "syn-key"))
        .thenAnswer(invocation -> Optional.ofNullable(stored.get()));
    when(quotaConsumptionRepository.saveAndFlush(any(QuotaConsumption.class)))
        .thenAnswer(invocation -> {
          QuotaConsumption row = invocation.getArgument(0);
          row.setId(1L);
          stored.set(row);
          return row;
        });

    QuotaConsumeResult result = quotaService.consume(
        20L, 0, 100L, "syn-key", QuotaConsumption.TYPE_SUBJECT_SYNTHESIS);

    assertTrue(result.allowed());
    assertEquals(QuotaConsumption.TYPE_SUBJECT_SYNTHESIS, stored.get().getQuotaType());
  }

  @Test
  void consume_concurrentSameKey_onlyOneDeduction() throws Exception {
    UserAccount user = userWithPlan("FREE");
    when(userAccountRepository.findById(11L)).thenReturn(Optional.of(user));

    // Simulate pessimistic usage-counter lock so concurrent same-key callers serialize.
    ReentrantLock dbLock = new ReentrantLock(true);
    UsageCounter sharedCounter = emptyCounter(11L);

    org.mockito.Mockito.lenient()
        .when(usageCounterRepository.findByUserIdAndPeriodYyyymm(11L, currentPeriod()))
        .thenAnswer(invocation -> {
          UsageCounter c = new UsageCounter();
          c.setUserId(11L);
          c.setPeriodYyyymm(currentPeriod());
          c.setSttSecondsUsed(sharedCounter.getSttSecondsUsed());
          c.setGeminiInputCharsUsed(sharedCounter.getGeminiInputCharsUsed());
          return Optional.of(c);
        });

    AtomicReference<QuotaConsumption> winner = new AtomicReference<>();
    AtomicInteger counterSaves = new AtomicInteger();
    AtomicInteger ledgerInserts = new AtomicInteger();

    when(usageCounterRepository.lockByUserAndPeriod(11L, currentPeriod()))
        .thenAnswer(invocation -> {
          dbLock.lock();
          return Optional.of(sharedCounter);
        });
    when(usageCounterRepository.save(any(UsageCounter.class)))
        .thenAnswer(invocation -> {
          counterSaves.incrementAndGet();
          UsageCounter saved = invocation.getArgument(0);
          sharedCounter.setSttSecondsUsed(saved.getSttSecondsUsed());
          sharedCounter.setGeminiInputCharsUsed(saved.getGeminiInputCharsUsed());
          return saved;
        });
    when(quotaConsumptionRepository.findByOwnerUserIdAndIdempotencyKey(eq(11L), eq("race-key")))
        .thenAnswer(invocation -> Optional.ofNullable(winner.get()));
    when(quotaConsumptionRepository.saveAndFlush(any(QuotaConsumption.class)))
        .thenAnswer(invocation -> {
          if (winner.get() != null) {
            throw new DataIntegrityViolationException("uq_quota_consumption_owner_key");
          }
          QuotaConsumption row = invocation.getArgument(0);
          row.setId(42L);
          winner.set(row);
          ledgerInserts.incrementAndGet();
          return row;
        });

    int threads = 8;
    ExecutorService pool = Executors.newFixedThreadPool(threads);
    CountDownLatch ready = new CountDownLatch(threads);
    CountDownLatch start = new CountDownLatch(1);
    List<Future<QuotaConsumeResult>> futures = new ArrayList<>();
    try {
      for (int i = 0; i < threads; i++) {
        futures.add(pool.submit(() -> {
          ready.countDown();
          start.await(5, TimeUnit.SECONDS);
          try {
            return quotaService.consume(11L, 30L, 100L, "race-key");
          } finally {
            if (dbLock.isHeldByCurrentThread()) {
              dbLock.unlock();
            }
          }
        }));
      }
      assertTrue(ready.await(5, TimeUnit.SECONDS));
      start.countDown();

      for (Future<QuotaConsumeResult> future : futures) {
        QuotaConsumeResult result = future.get(10, TimeUnit.SECONDS);
        assertTrue(result.allowed());
        assertEquals(30L, result.sttSecondsUsed());
      }
    } finally {
      pool.shutdownNow();
    }

    assertEquals(1, counterSaves.get());
    assertEquals(1, ledgerInserts.get());
    assertEquals(30L, sharedCounter.getSttSecondsUsed());
    assertEquals(QuotaConsumption.STATUS_ALLOWED, winner.get().getStatus());
  }

  @Test
  void consume_uniqueConstraintRace_returnsExistingAllowedWithoutSecondDeduction() {
    UserAccount user = userWithPlan("FREE");
    when(userAccountRepository.findById(14L)).thenReturn(Optional.of(user));
    when(usageCounterRepository.lockByUserAndPeriod(14L, currentPeriod()))
        .thenReturn(Optional.of(emptyCounter(14L)));
    when(usageCounterRepository.save(any(UsageCounter.class)))
        .thenAnswer(invocation -> invocation.getArgument(0));
    when(usageCounterRepository.findByUserIdAndPeriodYyyymm(14L, currentPeriod()))
        .thenAnswer(invocation -> {
          UsageCounter c = new UsageCounter();
          c.setUserId(14L);
          c.setPeriodYyyymm(currentPeriod());
          c.setSttSecondsUsed(15L);
          c.setGeminiInputCharsUsed(50L);
          return Optional.of(c);
        });

    QuotaConsumption existing = new QuotaConsumption();
    existing.setId(99L);
    existing.setOwnerUserId(14L);
    existing.setIdempotencyKey("race-key");
    existing.setQuotaType(QuotaConsumption.TYPE_STUDY_ARTIFACT);
    existing.setSttSecondsDelta(15L);
    existing.setGeminiCharsDelta(50L);
    existing.setStatus(QuotaConsumption.STATUS_ALLOWED);
    existing.setPeriodYyyymm(currentPeriod());

    AtomicInteger finds = new AtomicInteger();
    when(quotaConsumptionRepository.findByOwnerUserIdAndIdempotencyKey(14L, "race-key"))
        .thenAnswer(invocation -> {
          // Calls 1–3 happen inside the failed insert TX (pre-check, after-lock, upsert).
          // Call 4+ is race recovery re-read.
          if (finds.incrementAndGet() <= 3) {
            return Optional.empty();
          }
          return Optional.of(existing);
        });
    when(quotaConsumptionRepository.saveAndFlush(any(QuotaConsumption.class)))
        .thenThrow(new DataIntegrityViolationException("uq_quota_consumption_owner_key"));

    QuotaConsumeResult result = quotaService.consume(14L, 15L, 50L, "race-key");

    assertTrue(result.allowed());
    assertEquals(15L, result.sttSecondsUsed());
    verify(quotaConsumptionRepository, times(1)).saveAndFlush(any(QuotaConsumption.class));
  }

  @Test
  void consume_nonLedgerConstraint_throwsClearInternalError() {
    UserAccount user = userWithPlan("FREE");
    when(userAccountRepository.findById(15L)).thenReturn(Optional.of(user));
    when(usageCounterRepository.lockByUserAndPeriod(15L, currentPeriod()))
        .thenReturn(Optional.of(emptyCounter(15L)));
    when(quotaConsumptionRepository.findByOwnerUserIdAndIdempotencyKey(15L, "other-key"))
        .thenReturn(Optional.empty());
    when(quotaConsumptionRepository.saveAndFlush(any(QuotaConsumption.class)))
        .thenThrow(new DataIntegrityViolationException("fk_some_other_constraint"));

    IllegalStateException ex = assertThrows(
        IllegalStateException.class,
        () -> quotaService.consume(15L, 1L, 1L, "other-key"));
    assertTrue(ex.getMessage().contains("non-ledger"));
    assertFalse(ex.getMessage().contains("ledger race lost"));
  }

  @Test
  void isLedgerOwnerKeyViolation_detectsConstraintName() {
    assertTrue(QuotaService.isLedgerOwnerKeyViolation(
        new DataIntegrityViolationException("ERROR: uq_quota_consumption_owner_key")));
    assertFalse(QuotaService.isLedgerOwnerKeyViolation(
        new DataIntegrityViolationException("ERROR: ux_usage_counters_user_period")));
  }

  @Test
  void consume_deniedThenTopUpSameKey_canSucceed() {
    AtomicReference<String> plan = new AtomicReference<>("FREE");
    when(userAccountRepository.findById(12L)).thenAnswer(invocation -> {
      UserAccount account = userWithPlan(plan.get());
      account.setId(12L);
      return Optional.of(account);
    });

    UsageCounter counter = new UsageCounter();
    counter.setUserId(12L);
    counter.setPeriodYyyymm(currentPeriod());
    counter.setSttSecondsUsed(0);
    counter.setGeminiInputCharsUsed(49_500L);
    when(usageCounterRepository.lockByUserAndPeriod(12L, currentPeriod()))
        .thenReturn(Optional.of(counter));
    when(usageCounterRepository.save(any(UsageCounter.class)))
        .thenAnswer(invocation -> invocation.getArgument(0));

    AtomicReference<QuotaConsumption> stored = new AtomicReference<>();
    when(quotaConsumptionRepository.findByOwnerUserIdAndIdempotencyKey(12L, "syn-1"))
        .thenAnswer(invocation -> Optional.ofNullable(stored.get()));
    when(quotaConsumptionRepository.saveAndFlush(any(QuotaConsumption.class)))
        .thenAnswer(invocation -> {
          QuotaConsumption row = invocation.getArgument(0);
          if (row.getId() == null) {
            row.setId(7L);
          }
          stored.set(row);
          return row;
        });

    QuotaConsumeResult denied = quotaService.consume(
        12L, 0, 1_000L, "syn-1", QuotaConsumption.TYPE_SUBJECT_SYNTHESIS);
    assertFalse(denied.allowed());
    assertEquals(QuotaConsumption.STATUS_DENIED, stored.get().getStatus());
    assertEquals(QuotaConsumption.TYPE_SUBJECT_SYNTHESIS, stored.get().getQuotaType());
    verify(usageCounterRepository, never()).save(any());

    // Top-up: plan upgraded to PRO — same key re-evaluates and may become ALLOWED.
    plan.set("PRO");

    QuotaConsumeResult allowed = quotaService.consume(
        12L, 0, 1_000L, "syn-1", QuotaConsumption.TYPE_SUBJECT_SYNTHESIS);
    assertTrue(allowed.allowed());
    assertEquals(QuotaConsumption.STATUS_ALLOWED, stored.get().getStatus());
    verify(usageCounterRepository, times(1)).save(any(UsageCounter.class));
  }

  @Test
  void consume_differentKeys_chargeSeparately() {
    UserAccount user = userWithPlan("FREE");
    when(userAccountRepository.findById(13L)).thenReturn(Optional.of(user));
    when(usageCounterRepository.lockByUserAndPeriod(13L, currentPeriod()))
        .thenAnswer(invocation -> Optional.of(emptyCounter(13L)));
    when(usageCounterRepository.save(any(UsageCounter.class)))
        .thenAnswer(invocation -> invocation.getArgument(0));

    AtomicReference<QuotaConsumption> keyA = new AtomicReference<>();
    AtomicReference<QuotaConsumption> keyB = new AtomicReference<>();
    when(quotaConsumptionRepository.findByOwnerUserIdAndIdempotencyKey(13L, "key-a"))
        .thenAnswer(invocation -> Optional.ofNullable(keyA.get()));
    when(quotaConsumptionRepository.findByOwnerUserIdAndIdempotencyKey(13L, "key-b"))
        .thenAnswer(invocation -> Optional.ofNullable(keyB.get()));
    when(quotaConsumptionRepository.saveAndFlush(any(QuotaConsumption.class)))
        .thenAnswer(invocation -> {
          QuotaConsumption row = invocation.getArgument(0);
          if (row.getId() == null) {
            row.setId(row.getIdempotencyKey().equals("key-a") ? 1L : 2L);
          }
          if ("key-a".equals(row.getIdempotencyKey())) {
            keyA.set(row);
          } else {
            keyB.set(row);
          }
          return row;
        });

    QuotaConsumeResult a = quotaService.consume(13L, 10L, 100L, "key-a");
    when(usageCounterRepository.lockByUserAndPeriod(13L, currentPeriod()))
        .thenAnswer(invocation -> {
          UsageCounter c = emptyCounter(13L);
          c.setSttSecondsUsed(10L);
          c.setGeminiInputCharsUsed(100L);
          return Optional.of(c);
        });
    QuotaConsumeResult b = quotaService.consume(13L, 10L, 100L, "key-b");

    assertTrue(a.allowed());
    assertTrue(b.allowed());
    assertEquals(10L, a.sttSecondsUsed());
    assertEquals(20L, b.sttSecondsUsed());
    verify(usageCounterRepository, times(2)).save(any(UsageCounter.class));
    verify(quotaConsumptionRepository, times(2)).saveAndFlush(any(QuotaConsumption.class));
  }

  private static UsageCounter emptyCounter(long userId) {
    UsageCounter counter = new UsageCounter();
    counter.setUserId(userId);
    counter.setPeriodYyyymm(currentPeriod());
    counter.setSttSecondsUsed(0);
    counter.setGeminiInputCharsUsed(0);
    return counter;
  }

  private static UserAccount userWithPlan(String plan) {
    UserAccount user = new UserAccount();
    user.setId(1L);
    user.setPlan(plan);
    return user;
  }

  private static String currentPeriod() {
    return LocalDate.of(2026, 6, 15).format(YYYYMM);
  }
}
