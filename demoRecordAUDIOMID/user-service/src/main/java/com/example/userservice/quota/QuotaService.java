package com.example.userservice.quota;

import com.example.userservice.entity.QuotaConsumption;
import com.example.userservice.entity.UsageCounter;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.plan.SubscriptionPlanService;
import com.example.userservice.plan.UserPlanService;
import com.example.userservice.repository.QuotaConsumptionRepository;
import com.example.userservice.repository.UsageCounterRepository;
import com.example.userservice.repository.UserAccountRepository;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Objects;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

@Service
@RequiredArgsConstructor
public class QuotaService {

    private static final DateTimeFormatter YYYYMM = DateTimeFormatter.ofPattern("yyyyMM");
    private static final int NON_LEDGER_INTEGRITY_RETRIES = 2;

    private final UsageCounterRepository usageCounterRepository;
    private final UserAccountRepository userAccountRepository;
    private final UserPlanService userPlanService;
    private final SubscriptionPlanService subscriptionPlanService;
    private final QuotaConsumptionRepository quotaConsumptionRepository;
    private final EntityManager entityManager;
    private final Clock clock = Clock.systemUTC();

    @Value("${billing.quota-zone-id:Asia/Ho_Chi_Minh}")
    private String quotaZoneId;

    /**
     * Self-proxy for race recovery: unique-constraint failures mark the insert TX
     * rollback-only, so the winner's ledger row is re-read in a fresh transaction.
     */
    private QuotaService self;

    @Autowired
    void setSelf(@Lazy QuotaService self) {
        this.self = self;
    }

    /**
     * Legacy non-idempotent path (STT / realtime callers). Each call may deduct.
     */
    @Transactional
    public QuotaConsumeResult consume(Long userId, long sttSecondsDelta, long geminiCharsDelta) {
        return consume(userId, sttSecondsDelta, geminiCharsDelta, null, null);
    }

    /**
     * Consume quota with optional durable idempotency.
     *
     * <p>When {@code idempotencyKey} is blank, behaves like the legacy path (no ledger write).
     *
     * <p>When {@code idempotencyKey} is non-blank, the same {@code (userId, key)} charges at most
     * once while status is {@code ALLOWED}. Concurrent callers race on the unique constraint;
     * losers re-read the winner's ledger row and return that outcome without a second deduction.
     *
     * <p><b>DENIED is retryable:</b> a prior {@code DENIED} row does not permanently lock the key.
     * A later consume with the same key re-evaluates against current balances/limits (e.g. after
     * plan upgrade / top-up) and may update the row to {@code ALLOWED} and deduct once.
     */
    public QuotaConsumeResult consume(
            Long userId,
            long sttSecondsDelta,
            long geminiCharsDelta,
            String idempotencyKey
    ) {
        return consume(userId, sttSecondsDelta, geminiCharsDelta, idempotencyKey, null);
    }

    public QuotaConsumeResult consume(
            Long userId,
            long sttSecondsDelta,
            long geminiCharsDelta,
            String idempotencyKey,
            String quotaType
    ) {
        if (!StringUtils.hasText(idempotencyKey)) {
            return self.consumeLegacy(userId, sttSecondsDelta, geminiCharsDelta);
        }
        String key = idempotencyKey.trim();
        String resolvedType = resolveQuotaType(key, quotaType);
        DataIntegrityViolationException lastNonLedger = null;
        for (int attempt = 0; attempt < NON_LEDGER_INTEGRITY_RETRIES; attempt++) {
            try {
                return self.consumeIdempotent(userId, sttSecondsDelta, geminiCharsDelta, key, resolvedType);
            } catch (DataIntegrityViolationException ex) {
                if (isLedgerOwnerKeyViolation(ex)) {
                    return self.resultFromExistingLedger(userId, key);
                }
                lastNonLedger = ex;
            }
        }
        throw new IllegalStateException(
                "Quota consume data-integrity failure (non-ledger) for userId=" + userId,
                lastNonLedger);
    }

    @Transactional
    public QuotaConsumeResult consumeLegacy(Long userId, long sttSecondsDelta, long geminiCharsDelta) {
        return evaluateAndMaybeDeduct(userId, sttSecondsDelta, geminiCharsDelta, null, null);
    }

    /**
     * Idempotent consume. See {@link #consume(Long, long, long, String)} for DENIED retry semantics.
     */
    @Transactional
    public QuotaConsumeResult consumeIdempotent(
            Long userId,
            long sttSecondsDelta,
            long geminiCharsDelta,
            String idempotencyKey,
            String quotaType
    ) {
        QuotaConsumption existing = quotaConsumptionRepository
                .findByOwnerUserIdAndIdempotencyKey(userId, idempotencyKey)
                .orElse(null);
        if (existing != null && QuotaConsumption.STATUS_ALLOWED.equals(existing.getStatus())) {
            return snapshotAfterPriorAllow(userId);
        }
        // DENIED (or missing): re-evaluate; DENIED does not lock the key forever.
        return evaluateAndMaybeDeduct(userId, sttSecondsDelta, geminiCharsDelta, idempotencyKey, quotaType);
    }

    @Transactional(readOnly = true)
    public QuotaConsumeResult resultFromExistingLedger(Long userId, String idempotencyKey) {
        QuotaConsumption existing = quotaConsumptionRepository
                .findByOwnerUserIdAndIdempotencyKey(userId, idempotencyKey)
                .orElseThrow(() -> new IllegalStateException(
                        "Quota consumption unique conflict but ledger row missing for userId="
                                + userId + " key=" + idempotencyKey));
        if (QuotaConsumption.STATUS_ALLOWED.equals(existing.getStatus())) {
            return snapshotAfterPriorAllow(userId);
        }
        return snapshotDenied(userId);
    }

    private QuotaConsumeResult evaluateAndMaybeDeduct(
            Long userId,
            long sttSecondsDelta,
            long geminiCharsDelta,
            String idempotencyKey,
            String quotaType
    ) {
        if (userId == null || userId <= 0) {
            throw new IllegalArgumentException("Invalid userId");
        }
        if (sttSecondsDelta < 0 || geminiCharsDelta < 0) {
            throw new IllegalArgumentException("Deltas must be non-negative");
        }

        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        UserAccount currentUser = userPlanService.refreshExpiredPlan(user);
        String effectivePlan = userPlanService.resolveEffectivePlan(currentUser);

        String period = currentPeriod();
        UsageCounter counter = lockOrCreateUsageCounter(userId, period);

        // After acquiring the usage lock, re-check ledger so concurrent same-key callers
        // that serialized on the counter only deduct once.
        if (StringUtils.hasText(idempotencyKey)) {
            QuotaConsumption afterLock = quotaConsumptionRepository
                    .findByOwnerUserIdAndIdempotencyKey(userId, idempotencyKey)
                    .orElse(null);
            if (afterLock != null && QuotaConsumption.STATUS_ALLOWED.equals(afterLock.getStatus())) {
                SubscriptionPlanService.PlanLimits limits = subscriptionPlanService.limitsForPlan(effectivePlan);
                return new QuotaConsumeResult(
                        true,
                        period,
                        counter.getSttSecondsUsed(),
                        counter.getGeminiInputCharsUsed(),
                        limits.sttSecondsMonthly(),
                        limits.geminiInputCharsMonthly()
                );
            }
        }

        SubscriptionPlanService.PlanLimits limits = subscriptionPlanService.limitsForPlan(effectivePlan);
        long nextStt = safeAdd(counter.getSttSecondsUsed(), sttSecondsDelta);
        long nextChars = safeAdd(counter.getGeminiInputCharsUsed(), geminiCharsDelta);

        boolean overStt = nextStt > limits.sttSecondsMonthly();
        boolean overChars = nextChars > limits.geminiInputCharsMonthly();
        if (overStt || overChars) {
            if (StringUtils.hasText(idempotencyKey)) {
                upsertLedger(
                        userId,
                        idempotencyKey,
                        quotaType,
                        sttSecondsDelta,
                        geminiCharsDelta,
                        QuotaConsumption.STATUS_DENIED,
                        period
                );
            }
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

        if (StringUtils.hasText(idempotencyKey)) {
            upsertLedger(
                    userId,
                    idempotencyKey,
                    quotaType,
                    sttSecondsDelta,
                    geminiCharsDelta,
                    QuotaConsumption.STATUS_ALLOWED,
                    period
            );
        }

        return new QuotaConsumeResult(
                true,
                period,
                nextStt,
                nextChars,
                limits.sttSecondsMonthly(),
                limits.geminiInputCharsMonthly()
        );
    }

    /**
     * Take a PostgreSQL advisory transaction lock keyed by (userId, period), upsert the
     * usage_counters row if missing, then SELECT FOR UPDATE.
     */
    UsageCounter lockOrCreateUsageCounter(Long userId, String period) {
        long lockKey = advisoryLockKey(userId, period);
        Query lockQuery = entityManager.createNativeQuery("SELECT pg_advisory_xact_lock(:k)");
        lockQuery.setParameter("k", lockKey);
        lockQuery.getSingleResult();

        entityManager.createNativeQuery(
                        "INSERT INTO usage_counters "
                                + "(user_id, period_yyyymm, stt_seconds_used, gemini_input_chars_used, created_at, updated_at) "
                                + "VALUES (:userId, :period, 0, 0, NOW(), NOW()) "
                                + "ON CONFLICT (user_id, period_yyyymm) DO NOTHING")
                .setParameter("userId", userId)
                .setParameter("period", period)
                .executeUpdate();

        return usageCounterRepository.lockByUserAndPeriod(userId, period)
                .orElseThrow(() -> new IllegalStateException(
                        "Usage counter missing after upsert for userId=" + userId + " period=" + period));
    }

    /**
     * Stable advisory-lock key for (userId, periodYyyymm). Package-visible for unit tests.
     */
    static long advisoryLockKey(Long userId, String periodYyyymm) {
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(periodYyyymm, "periodYyyymm");
        long periodNum;
        try {
            periodNum = Long.parseLong(periodYyyymm);
        } catch (NumberFormatException ex) {
            periodNum = periodYyyymm.hashCode() & 0xffffffffL;
        }
        return (userId * 1_000_000L) + periodNum;
    }

    static boolean isLedgerOwnerKeyViolation(DataIntegrityViolationException ex) {
        String message = ex.getMessage();
        if (message != null && message.contains(QuotaConsumption.CONSTRAINT_OWNER_KEY)) {
            return true;
        }
        Throwable cause = ex.getMostSpecificCause();
        if (cause != null) {
            String causeMsg = cause.getMessage();
            if (causeMsg != null && causeMsg.contains(QuotaConsumption.CONSTRAINT_OWNER_KEY)) {
                return true;
            }
        }
        return false;
    }

    private void upsertLedger(
            Long userId,
            String idempotencyKey,
            String quotaType,
            long sttSecondsDelta,
            long geminiCharsDelta,
            String status,
            String period
    ) {
        QuotaConsumption row = quotaConsumptionRepository
                .findByOwnerUserIdAndIdempotencyKey(userId, idempotencyKey)
                .orElseGet(QuotaConsumption::new);
        if (row.getId() == null) {
            row.setOwnerUserId(userId);
            row.setIdempotencyKey(idempotencyKey);
            row.setCreatedAt(java.time.Instant.now());
        }
        row.setQuotaType(quotaType);
        row.setSttSecondsDelta(sttSecondsDelta);
        row.setGeminiCharsDelta(geminiCharsDelta);
        row.setStatus(status);
        row.setPeriodYyyymm(period);
        quotaConsumptionRepository.saveAndFlush(row);
    }

    private QuotaConsumeResult snapshotAfterPriorAllow(Long userId) {
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        UserAccount currentUser = userPlanService.refreshExpiredPlan(user);
        String effectivePlan = userPlanService.resolveEffectivePlan(currentUser);
        String period = currentPeriod();
        UsageCounter counter = usageCounterRepository.findByUserIdAndPeriodYyyymm(userId, period)
                .orElse(null);
        SubscriptionPlanService.PlanLimits limits = subscriptionPlanService.limitsForPlan(effectivePlan);
        return new QuotaConsumeResult(
                true,
                period,
                counter == null ? 0 : counter.getSttSecondsUsed(),
                counter == null ? 0 : counter.getGeminiInputCharsUsed(),
                limits.sttSecondsMonthly(),
                limits.geminiInputCharsMonthly()
        );
    }

    private QuotaConsumeResult snapshotDenied(Long userId) {
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        UserAccount currentUser = userPlanService.refreshExpiredPlan(user);
        String effectivePlan = userPlanService.resolveEffectivePlan(currentUser);
        String period = currentPeriod();
        UsageCounter counter = usageCounterRepository.findByUserIdAndPeriodYyyymm(userId, period)
                .orElse(null);
        SubscriptionPlanService.PlanLimits limits = subscriptionPlanService.limitsForPlan(effectivePlan);
        return new QuotaConsumeResult(
                false,
                period,
                counter == null ? 0 : counter.getSttSecondsUsed(),
                counter == null ? 0 : counter.getGeminiInputCharsUsed(),
                limits.sttSecondsMonthly(),
                limits.geminiInputCharsMonthly()
        );
    }

    /**
     * Blank key → LEGACY. Non-blank key uses caller type when provided, else STUDY_ARTIFACT.
     */
    static String resolveQuotaType(String idempotencyKey, String quotaType) {
        if (!StringUtils.hasText(idempotencyKey)) {
            return QuotaConsumption.TYPE_LEGACY;
        }
        if (StringUtils.hasText(quotaType)) {
            return quotaType.trim();
        }
        return QuotaConsumption.TYPE_STUDY_ARTIFACT;
    }

    @Transactional
    public QuotaSnapshot snapshot(Long userId) {
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        UserAccount currentUser = userPlanService.refreshExpiredPlan(user);
        String effectivePlan = userPlanService.resolveEffectivePlan(currentUser);
        String period = currentPeriod();
        UsageCounter counter = usageCounterRepository.findByUserIdAndPeriodYyyymm(userId, period)
                .orElse(null);
        SubscriptionPlanService.PlanLimits limits = subscriptionPlanService.limitsForPlan(effectivePlan);
        return new QuotaSnapshot(
                effectivePlan,
                period,
                counter == null ? 0 : counter.getSttSecondsUsed(),
                counter == null ? 0 : counter.getGeminiInputCharsUsed(),
                limits.sttSecondsMonthly(),
                limits.geminiInputCharsMonthly()
        );
    }

    private String currentPeriod() {
        ZoneId zone = resolveQuotaZone();
        LocalDate date = LocalDate.now(clock.withZone(zone));
        return date.format(YYYYMM);
    }

    private ZoneId resolveQuotaZone() {
        if (!StringUtils.hasText(quotaZoneId)) {
            return ZoneOffset.UTC;
        }
        try {
            return ZoneId.of(quotaZoneId.trim());
        } catch (RuntimeException ex) {
            return ZoneOffset.UTC;
        }
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
        public String status() {
            return allowed ? QuotaConsumption.STATUS_ALLOWED : QuotaConsumption.STATUS_DENIED;
        }
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
