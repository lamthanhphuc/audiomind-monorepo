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

    private final UserAccountRepository userAccountRepository;
    private final Clock clock = Clock.systemUTC();

    @Value("${billing.new-user-trial-days:3}")
    private int newUserTrialDays;

    public void applyNewUserTrial(UserAccount user) {
        if (user == null || newUserTrialDays <= 0) {
            return;
        }
        user.setPlan("PRO");
        user.setPlanExpiresAt(clock.instant().plus(newUserTrialDays, ChronoUnit.DAYS));
    }

    @Transactional
    public UserAccount refreshExpiredPlan(UserAccount user) {
        if (user == null || !isExpiredTrial(user)) {
            return user;
        }
        user.setPlan("FREE");
        user.setPlanExpiresAt(null);
        return userAccountRepository.save(user);
    }

    @Transactional(readOnly = true)
    public UserAccount requireUserWithCurrentPlan(Long userId) {
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        return refreshExpiredPlan(user);
    }

    public String resolveEffectivePlan(UserAccount user) {
        if (user == null) {
            return "FREE";
        }
        if (isExpiredTrial(user)) {
            return "FREE";
        }
        String plan = user.getPlan() == null ? "" : user.getPlan().trim().toUpperCase();
        return plan.isBlank() ? "FREE" : plan;
    }

    public boolean isOnTrial(UserAccount user) {
        return user != null
                && "PRO".equalsIgnoreCase(user.getPlan())
                && user.getPlanExpiresAt() != null
                && !isExpiredTrial(user);
    }

    public boolean hasPermanentPro(UserAccount user) {
        return user != null
                && "PRO".equalsIgnoreCase(user.getPlan())
                && user.getPlanExpiresAt() == null;
    }

    public void markPermanentPro(UserAccount user) {
        user.setPlan("PRO");
        user.setPlanExpiresAt(null);
    }

    private boolean isExpiredTrial(UserAccount user) {
        return user.getPlanExpiresAt() != null && !clock.instant().isBefore(user.getPlanExpiresAt());
    }
}
