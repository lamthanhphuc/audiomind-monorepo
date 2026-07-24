package com.example.userservice.controller;

import com.example.userservice.entity.QuotaConsumption;
import com.example.userservice.quota.QuotaService;
import com.example.userservice.repository.QuotaConsumptionRepository;
import com.example.userservice.security.UserPrincipal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.data.domain.PageRequest;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/users/me/usage")
public class UsageController {

    private final QuotaService quotaService;
    private final QuotaConsumptionRepository quotaConsumptionRepository;

    public UsageController(QuotaService quotaService, QuotaConsumptionRepository quotaConsumptionRepository) {
        this.quotaService = quotaService;
        this.quotaConsumptionRepository = quotaConsumptionRepository;
    }

    @GetMapping
    public Map<String, Object> usage(
            Authentication authentication,
            @RequestParam(defaultValue = "30") int days,
            @RequestParam(defaultValue = "100") int limit
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        int safeDays = Math.max(1, Math.min(days, 366));
        int safeLimit = Math.max(1, Math.min(limit, 500));
        Instant to = Instant.now();
        Instant from = LocalDate.now(ZoneOffset.UTC).minusDays(safeDays - 1L).atStartOfDay().toInstant(ZoneOffset.UTC);
        List<QuotaConsumption> rows = quotaConsumptionRepository.findByOwnerUserIdAndCreatedAtBetweenOrderByCreatedAtDesc(
                principal.userId(),
                from,
                to,
                PageRequest.of(0, safeLimit)
        );
        Map<String, DayBucket> byDay = new LinkedHashMap<>();
        for (QuotaConsumption row : rows) {
            String day = row.getCreatedAt().atZone(ZoneOffset.UTC).toLocalDate().toString();
            DayBucket bucket = byDay.computeIfAbsent(day, DayBucket::new);
            if (QuotaConsumption.STATUS_ALLOWED.equals(row.getStatus())) {
                bucket.sttSeconds += row.getSttSecondsDelta();
                bucket.geminiChars += row.getGeminiCharsDelta();
            } else {
                bucket.deniedCount++;
            }
        }
        QuotaService.QuotaSnapshot snapshot = quotaService.snapshot(principal.userId());
        return Map.of(
                "snapshot", snapshot,
                "daily", byDay.values().stream().map(DayBucket::toMap).toList(),
                "events", rows.stream().map(this::eventView).toList()
        );
    }

    private Map<String, Object> eventView(QuotaConsumption row) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", row.getId());
        view.put("quotaType", row.getQuotaType());
        view.put("status", row.getStatus());
        view.put("periodYyyymm", row.getPeriodYyyymm());
        view.put("sttSecondsDelta", row.getSttSecondsDelta());
        view.put("geminiCharsDelta", row.getGeminiCharsDelta());
        view.put("createdAt", row.getCreatedAt().toString());
        return view;
    }

    private static final class DayBucket {
        private final String day;
        private long sttSeconds;
        private long geminiChars;
        private long deniedCount;

        private DayBucket(String day) {
            this.day = day;
        }

        private Map<String, Object> toMap() {
            return Map.of(
                    "day", day,
                    "sttSeconds", sttSeconds,
                    "geminiChars", geminiChars,
                    "deniedCount", deniedCount
            );
        }
    }
}
