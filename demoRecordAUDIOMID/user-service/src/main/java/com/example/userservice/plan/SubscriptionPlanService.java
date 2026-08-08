package com.example.userservice.plan;

import com.example.userservice.entity.SubscriptionPlan;
import com.example.userservice.repository.SubscriptionPlanRepository;
import com.example.userservice.repository.UserAccountRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
public class SubscriptionPlanService {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final String BILLING_MONTHLY = "MONTHLY";
    private static final String BILLING_YEARLY = "YEARLY";
    private static final String BILLING_ONCE = "ONCE";

    private final SubscriptionPlanRepository planRepository;
    private final UserAccountRepository userAccountRepository;

    @Transactional(readOnly = true)
    public List<SubscriptionPlan> listActive() {
        return planRepository.findByActiveTrueOrderBySortOrderAscIdAsc();
    }

    @Transactional(readOnly = true)
    public List<SubscriptionPlan> listAll() {
        return planRepository.findAllByOrderBySortOrderAscIdAsc();
    }

    @Transactional(readOnly = true)
    public SubscriptionPlan requireActiveByCode(String code) {
        SubscriptionPlan plan = requireByCode(code);
        if (!plan.isActive()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Plan is inactive");
        }
        return plan;
    }

    @Transactional(readOnly = true)
    public SubscriptionPlan requireByCode(String code) {
        return planRepository.findByCodeIgnoreCase(normalizeLookupCode(code))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Plan not found"));
    }

    @Transactional(readOnly = true)
    public SubscriptionPlan requireById(Long id) {
        return planRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Plan not found"));
    }

    @Transactional(readOnly = true)
    public PlanLimits limitsForPlan(String code) {
        SubscriptionPlan plan = planRepository.findByCodeIgnoreCase(normalizeLookupCode(code))
                .orElseGet(() -> planRepository.findByCodeIgnoreCase(UserPlanService.PLAN_FREE).orElse(null));
        if (plan == null) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Subscription plans are not configured");
        }
        return new PlanLimits(
                plan.getRecordingMinutesLimit() * 60L,
                plan.getAiAnalysisLimit()
        );
    }

    @Transactional(readOnly = true)
    public boolean advertisementsEnabled(String code) {
        return requireByCode(code).isAdvertisementEnabled();
    }

    @Transactional(readOnly = true)
    public boolean featureEnabled(String code, String feature) {
        if (!StringUtils.hasText(feature)) {
            return false;
        }
        SubscriptionPlan plan = requireByCode(code);
        try {
            JsonNode root = OBJECT_MAPPER.readTree(plan.getFeaturesJson());
            if (root == null || !root.isObject()) {
                return false;
            }
            String expected = normalizeFeatureName(feature);
            var fields = root.fields();
            while (fields.hasNext()) {
                var entry = fields.next();
                if (normalizeFeatureName(entry.getKey()).equals(expected)) {
                    return entry.getValue().asBoolean(false);
                }
            }
            return false;
        } catch (JsonProcessingException ex) {
            return false;
        }
    }

    @Transactional
    public SubscriptionPlan create(PlanRequest request) {
        String code = normalizeWritableCode(request.code());
        if (planRepository.existsByCodeIgnoreCase(code)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Plan code already exists");
        }
        SubscriptionPlan plan = new SubscriptionPlan();
        apply(plan, request, true);
        return planRepository.save(plan);
    }

    @Transactional
    public SubscriptionPlan update(Long id, PlanRequest request) {
        SubscriptionPlan plan = requireById(id);
        String nextCode = normalizeWritableCode(request.code());
        if (!plan.getCode().equalsIgnoreCase(nextCode)
                && planRepository.existsByCodeIgnoreCase(nextCode)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Plan code already exists");
        }
        apply(plan, request, true);
        return planRepository.save(plan);
    }

    @Transactional
    public SubscriptionPlan setStatus(Long id, boolean active) {
        SubscriptionPlan plan = requireById(id);
        plan.setActive(active);
        return planRepository.save(plan);
    }

    @Transactional
    public void delete(Long id) {
        SubscriptionPlan plan = requireById(id);
        long activeUsers = userAccountRepository.countByPlanIgnoreCase(plan.getCode());
        if (activeUsers > 0) {
            throw new ResponseStatusException(
                    HttpStatus.CONFLICT,
                    "This plan cannot be deleted because it has active subscriptions. Deactivate it instead.");
        }
        planRepository.delete(plan);
    }

    public Map<String, Object> toView(SubscriptionPlan plan) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", plan.getId());
        out.put("code", plan.getCode());
        out.put("name", plan.getName());
        out.put("description", plan.getDescription());
        out.put("priceVnd", plan.getPriceVnd());
        out.put("currency", plan.getCurrency());
        out.put("billingPeriod", plan.getBillingPeriod());
        out.put("advertisementEnabled", plan.isAdvertisementEnabled());
        out.put("recordingMinutesLimit", plan.getRecordingMinutesLimit());
        out.put("aiAnalysisLimit", plan.getAiAnalysisLimit());
        out.put("uploadLimit", plan.getUploadLimit());
        out.put("flashcardLimit", plan.getFlashcardLimit());
        out.put("quizLimit", plan.getQuizLimit());
        out.put("mindmapLimit", plan.getMindmapLimit());
        out.put("exportLimit", plan.getExportLimit());
        out.put("featuresJson", plan.getFeaturesJson());
        out.put("active", plan.isActive());
        out.put("sortOrder", plan.getSortOrder());
        out.put("createdAt", plan.getCreatedAt() == null ? null : plan.getCreatedAt().toString());
        out.put("updatedAt", plan.getUpdatedAt() == null ? null : plan.getUpdatedAt().toString());
        return out;
    }

    private void apply(SubscriptionPlan plan, PlanRequest request, boolean allowCodeUpdate) {
        if (allowCodeUpdate) {
            plan.setCode(normalizeWritableCode(request.code()));
        }
        plan.setName(requireText(request.name(), "Plan name is required", 120));
        plan.setDescription(limit(request.description(), 2000));
        plan.setPriceVnd(requireNonNegative(request.priceVnd(), "Price must be >= 0"));
        plan.setCurrency(normalizeCurrency(request.currency()));
        plan.setBillingPeriod(normalizeBillingPeriod(request.billingPeriod()));
        plan.setAdvertisementEnabled(Boolean.TRUE.equals(request.advertisementEnabled()));
        plan.setRecordingMinutesLimit(requireNonNegative(request.recordingMinutesLimit(), "Recording limit must be >= 0"));
        plan.setAiAnalysisLimit(requireNonNegative(request.aiAnalysisLimit(), "AI analysis limit must be >= 0"));
        plan.setUploadLimit(requireNonNegative(request.uploadLimit(), "Upload limit must be >= 0"));
        plan.setFlashcardLimit(requireNonNegative(request.flashcardLimit(), "Flashcard limit must be >= 0"));
        plan.setQuizLimit(requireNonNegative(request.quizLimit(), "Quiz limit must be >= 0"));
        plan.setMindmapLimit(requireNonNegative(request.mindmapLimit(), "Mindmap limit must be >= 0"));
        plan.setExportLimit(requireNonNegative(request.exportLimit(), "Export limit must be >= 0"));
        plan.setFeaturesJson(validateFeaturesJson(request.featuresJson()));
        plan.setSortOrder((int) requireNonNegative(request.sortOrder(), "Sort order must be >= 0"));
        plan.setActive(request.active() == null || request.active());
    }

    public static String normalizeCode(String code) {
        String normalized = code == null ? "" : code.trim().toUpperCase(Locale.ROOT);
        if (!normalized.matches("[A-Z0-9_]{2,50}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid plan code");
        }
        return normalized;
    }

    private static String normalizeLookupCode(String code) {
        return UserPlanService.normalizePlanOrFree(normalizeCode(code));
    }

    private static String normalizeWritableCode(String code) {
        String normalized = normalizeCode(code);
        if ("PRO".equals(normalized) || "STUDENT".equals(normalized)) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    "PRO and STUDENT are legacy plan codes. Use STANDARD or another new code.");
        }
        return normalized;
    }

    private static String validateFeaturesJson(String value) {
        String json = StringUtils.hasText(value) ? value.trim() : "{}";
        try {
            JsonNode root = OBJECT_MAPPER.readTree(json);
            if (root == null || !root.isObject()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Features JSON must be an object");
            }
            return json;
        } catch (JsonProcessingException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid features JSON");
        }
    }

    private static String normalizeFeatureName(String value) {
        return value == null ? "" : value.replaceAll("[^A-Za-z0-9]", "").toLowerCase(Locale.ROOT);
    }

    private static String normalizeCurrency(String currency) {
        String normalized = currency == null ? "" : currency.trim().toUpperCase(Locale.ROOT);
        if (!normalized.matches("[A-Z]{3}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid currency");
        }
        return normalized;
    }

    private static String normalizeBillingPeriod(String billingPeriod) {
        String normalized = billingPeriod == null ? BILLING_MONTHLY : billingPeriod.trim().toUpperCase(Locale.ROOT);
        if (!BILLING_MONTHLY.equals(normalized) && !BILLING_YEARLY.equals(normalized) && !BILLING_ONCE.equals(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid billing period");
        }
        return normalized;
    }

    private static String requireText(String value, String message, int maxLength) {
        if (!StringUtils.hasText(value)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
        }
        return limit(value.trim(), maxLength);
    }

    private static String limit(String value, int maxLength) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.length() <= maxLength ? trimmed : trimmed.substring(0, maxLength);
    }

    private static long requireNonNegative(Number value, String message) {
        long resolved = value == null ? 0L : value.longValue();
        if (resolved < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
        }
        return resolved;
    }

    public record PlanLimits(long sttSecondsMonthly, long geminiInputCharsMonthly) {
    }

    public record PlanRequest(
            String code,
            String name,
            String description,
            Long priceVnd,
            String currency,
            String billingPeriod,
            Boolean advertisementEnabled,
            Long recordingMinutesLimit,
            Long aiAnalysisLimit,
            Long uploadLimit,
            Long flashcardLimit,
            Long quizLimit,
            Long mindmapLimit,
            Long exportLimit,
            String featuresJson,
            Integer sortOrder,
            Boolean active
    ) {
    }
}
