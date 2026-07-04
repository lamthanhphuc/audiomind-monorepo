package com.example.userservice.quota;

import com.example.userservice.entity.UsageCounter;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.repository.UsageCounterRepository;
import com.example.userservice.repository.UserAccountRepository;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class QuotaService {

    private static final DateTimeFormatter YYYYMM = DateTimeFormatter.ofPattern("yyyyMM");

    private final UsageCounterRepository usageCounterRepository;
    private final UserAccountRepository userAccountRepository;
    private final Clock clock = Clock.systemUTC();

    @Transactional
    public QuotaConsumeResult consume(Long userId, long sttSecondsDelta, long geminiCharsDelta) {
        if (userId == null || userId <= 0) {
            throw new IllegalArgumentException("Invalid userId");
        }
        if (sttSecondsDelta < 0 || geminiCharsDelta < 0) {
            throw new IllegalArgumentException("Deltas must be non-negative");
        }

        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));

        String period = currentPeriod();
        UsageCounter counter = usageCounterRepository.lockByUserAndPeriod(userId, period)
                .orElseGet(() -> {
                    UsageCounter created = new UsageCounter();
                    created.setUserId(userId);
                    created.setPeriodYyyymm(period);
                    created.setSttSecondsUsed(0);
                    created.setGeminiInputCharsUsed(0);
                    return created;
                });

        QuotaPolicy.PlanLimits limits = QuotaPolicy.limitsForPlan(user.getPlan());
        long nextStt = safeAdd(counter.getSttSecondsUsed(), sttSecondsDelta);
        long nextChars = safeAdd(counter.getGeminiInputCharsUsed(), geminiCharsDelta);

        boolean overStt = nextStt > limits.sttSecondsMonthly();
        boolean overChars = nextChars > limits.geminiInputCharsMonthly();
        if (overStt || overChars) {
            return new QuotaConsumeResult(
                    false,
                    period,
                    counter.getSttSecondsUsed(),
                    counter.getGeminiInputCharsUsed(),
                    limits.sttSecondsMonthly(),
                    limits.geminiInputCharsMonthly()
            );
        }

        counter.setSttSecondsUsed(nextStt);
        counter.setGeminiInputCharsUsed(nextChars);
        usageCounterRepository.save(counter);

        return new QuotaConsumeResult(
                true,
                period,
                nextStt,
                nextChars,
                limits.sttSecondsMonthly(),
                limits.geminiInputCharsMonthly()
        );
    }

    @Transactional(readOnly = true)
    public QuotaSnapshot snapshot(Long userId) {
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        String period = currentPeriod();
        UsageCounter counter = usageCounterRepository.findByUserIdAndPeriodYyyymm(userId, period)
                .orElse(null);
        QuotaPolicy.PlanLimits limits = QuotaPolicy.limitsForPlan(user.getPlan());
        return new QuotaSnapshot(
                user.getPlan(),
                period,
                counter == null ? 0 : counter.getSttSecondsUsed(),
                counter == null ? 0 : counter.getGeminiInputCharsUsed(),
                limits.sttSecondsMonthly(),
                limits.geminiInputCharsMonthly()
        );
    }

    private String currentPeriod() {
        LocalDate date = LocalDate.now(clock.withZone(ZoneOffset.UTC));
        return date.format(YYYYMM);
    }

    private static long safeAdd(long a, long b) {
        long out = a + b;
        if (((a ^ out) & (b ^ out)) < 0) {
            return Long.MAX_VALUE;
        }
        return out;
    }

    public record QuotaConsumeResult(
            boolean allowed,
            String periodYyyymm,
            long sttSecondsUsed,
            long geminiInputCharsUsed,
            long sttSecondsLimit,
            long geminiInputCharsLimit
    ) {
    }

    public record QuotaSnapshot(
            String plan,
            String periodYyyymm,
            long sttSecondsUsed,
            long geminiInputCharsUsed,
            long sttSecondsLimit,
            long geminiInputCharsLimit
    ) {
    }
}

