package com.example.userservice.quota;

public final class QuotaPolicy {

    private QuotaPolicy() {
    }

    public static PlanLimits limitsForPlan(String plan) {
        String normalized = plan == null ? "" : plan.trim().toUpperCase();
        return switch (normalized) {
            case "PRO" -> new PlanLimits(60L * 60L * 10L, 2_000_000L); // 10 hours STT, 2M chars/month
            default -> new PlanLimits(60L * 10L, 50_000L); // 10 minutes STT, 50k chars/month
        };
    }

    public record PlanLimits(long sttSecondsMonthly, long geminiInputCharsMonthly) {
    }
}

