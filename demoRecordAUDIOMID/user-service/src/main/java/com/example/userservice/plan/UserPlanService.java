package com.example.userservice.plan;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.repository.UserAccountRepository;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class UserPlanService {

    public static final String PLAN_FREE = "FREE";
    public static final String PLAN_STANDARD = "STANDARD";
    public static final String PLAN_PREMIUM = "PREMIUM";
    private static final String LEGACY_PLAN_PRO = "PRO";
    private static final String LEGACY_PLAN_STUDENT = "STUDENT";

    private final UserAccountRepository userAccountRepository;
    private final Clock clock = Clock.systemUTC();

    @Value("${billing.new-user-trial-days:3}")
    private int newUserTrialDays;

    public void applyNewUserTrial(UserAccount user) {
        if (user == null || newUserTrialDays <= 0) {
            return;
        }
        user.setPlan(PLAN_STANDARD);
        user.setPlanExpiresAt(clock.instant().plus(newUserTrialDays, ChronoUnit.DAYS));
    }

    @Transactional
    public UserAccount refreshExpiredPlan(UserAccount user) {
        if (user == null || !isExpiredTrial(user)) {
            return user;
        }
        user.setPlan(PLAN_FREE);
        user.setPlanExpiresAt(null);
        return userAccountRepository.save(user);
    }

    @Transactional
    public UserAccount requireUserWithCurrentPlan(Long userId) {
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        return refreshExpiredPlan(user);
    }

    public String resolveEffectivePlan(UserAccount user) {
        if (user == null) {
            return PLAN_FREE;
        }
        if (isExpiredTrial(user)) {
            return PLAN_FREE;
        }
        String plan = user.getPlan() == null ? "" : user.getPlan().trim().toUpperCase();
        return normalizePlanOrFree(plan);
    }

    public boolean isOnTrial(UserAccount user) {
        return user != null
                && PLAN_STANDARD.equalsIgnoreCase(normalizePlanOrFree(user.getPlan()))
                && user.getPlanExpiresAt() != null
                && !isExpiredTrial(user);
    }

    public boolean hasPermanentStandard(UserAccount user) {
        return user != null
                && PLAN_STANDARD.equalsIgnoreCase(normalizePlanOrFree(user.getPlan()))
                && user.getPlanExpiresAt() == null;
    }

    /** Backward-compatible alias for callers compiled against the legacy plan name. */
    public boolean hasPermanentPro(UserAccount user) {
        return hasPermanentStandard(user);
    }

    public void markPermanentStandard(UserAccount user) {
        user.setPlan(PLAN_STANDARD);
        user.setPlanExpiresAt(null);
    }

    public void markPermanentPremium(UserAccount user) {
        user.setPlan(PLAN_PREMIUM);
        user.setPlanExpiresAt(null);
    }

    /** Backward-compatible alias: legacy Pro now means Standard. */
    public void markPermanentPro(UserAccount user) {
        markPermanentStandard(user);
    }

    /** Backward-compatible alias: legacy Student users are migrated to Standard. */
    public void markPermanentStudent(UserAccount user) {
        markPermanentStandard(user);
    }

    public static boolean isSupportedPlan(String plan) {
        return plan != null && plan.matches("[A-Z0-9_]{2,50}");
    }

    public static String normalizePlanOrFree(String plan) {
        String normalized = plan == null ? "" : plan.trim().toUpperCase();
        if (LEGACY_PLAN_PRO.equals(normalized) || LEGACY_PLAN_STUDENT.equals(normalized)) {
            return PLAN_STANDARD;
        }
        return isSupportedPlan(normalized) ? normalized : PLAN_FREE;
    }

    private boolean isExpiredTrial(UserAccount user) {
        return user.getPlanExpiresAt() != null && !clock.instant().isBefore(user.getPlanExpiresAt());
    }
}
