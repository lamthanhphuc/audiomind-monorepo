package com.example.userservice.quota;

import com.example.userservice.entity.UsageCounter;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.repository.UsageCounterRepository;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.quota.QuotaService.QuotaConsumeResult;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class QuotaServiceTest {

  private static final DateTimeFormatter YYYYMM = DateTimeFormatter.ofPattern("yyyyMM");

  @Mock
  private UsageCounterRepository usageCounterRepository;

  @Mock
  private UserAccountRepository userAccountRepository;

  @InjectMocks
  private QuotaService quotaService;

  @BeforeEach
  void setUpClock() {
    Clock fixedClock = Clock.fixed(Instant.parse("2026-06-15T12:00:00Z"), ZoneOffset.UTC);
    ReflectionTestUtils.setField(quotaService, "clock", fixedClock);
  }

  @Test
  void consume_shouldAllowAndPersistWhenWithinFreePlanLimits() {
    UserAccount user = userWithPlan("FREE");
    when(userAccountRepository.findById(7L)).thenReturn(Optional.of(user));
    when(usageCounterRepository.lockByUserAndPeriod(7L, currentPeriod()))
        .thenReturn(Optional.empty());
    when(usageCounterRepository.save(any(UsageCounter.class)))
        .thenAnswer(invocation -> invocation.getArgument(0));

    QuotaConsumeResult result = quotaService.consume(7L, 120L, 1_000L);

    assertTrue(result.allowed());
    assertEquals(120L, result.sttSecondsUsed());
    assertEquals(1_000L, result.geminiInputCharsUsed());
    ArgumentCaptor<UsageCounter> captor = ArgumentCaptor.forClass(UsageCounter.class);
    verify(usageCounterRepository).save(captor.capture());
    assertEquals(120L, captor.getValue().getSttSecondsUsed());
    assertEquals(1_000L, captor.getValue().getGeminiInputCharsUsed());
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
    verify(usageCounterRepository, never()).save(any());
  }

  @Test
  void consume_shouldUseProLimits() {
    UserAccount user = userWithPlan("PRO");
    when(userAccountRepository.findById(9L)).thenReturn(Optional.of(user));
    when(usageCounterRepository.lockByUserAndPeriod(9L, currentPeriod()))
        .thenReturn(Optional.empty());
    when(usageCounterRepository.save(any(UsageCounter.class)))
        .thenAnswer(invocation -> invocation.getArgument(0));

    QuotaConsumeResult result = quotaService.consume(9L, 0, 100_000L);

    assertTrue(result.allowed());
    assertEquals(2_000_000L, result.geminiInputCharsLimit());
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
