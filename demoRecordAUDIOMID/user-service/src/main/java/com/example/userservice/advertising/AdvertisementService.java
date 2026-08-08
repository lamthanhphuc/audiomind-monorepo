package com.example.userservice.advertising;

import com.example.userservice.entity.Advertisement;
import com.example.userservice.entity.SubscriptionPlan;
import com.example.userservice.plan.SubscriptionPlanService;
import com.example.userservice.plan.UserPlanService;
import com.example.userservice.repository.AdvertisementRepository;
import java.net.URI;
import java.time.Clock;
import java.time.Instant;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
public class AdvertisementService {

    private static final Set<String> TYPES = Set.of("BANNER", "VIDEO", "SPONSORED_CONTENT");
    private static final Set<String> PLACEMENTS = Set.of("DASHBOARD", "MEETING_DETAIL", "POST_ANALYSIS", "EXPORT");
    private static final Set<String> STATUSES = Set.of("DRAFT", "ACTIVE", "PAUSED", "EXPIRED");

    private final AdvertisementRepository advertisementRepository;
    private final SubscriptionPlanService subscriptionPlanService;
    private final Clock clock = Clock.systemUTC();

    @Transactional(readOnly = true)
    public List<Advertisement> listAll() {
        return advertisementRepository.findAllByOrderByUpdatedAtDescIdDesc();
    }

    @Transactional(readOnly = true)
    public Advertisement requireById(Long id) {
        return advertisementRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Advertisement not found"));
    }

    @Transactional(readOnly = true)
    public List<Advertisement> eligibleForPlan(String planCode) {
        SubscriptionPlan plan = subscriptionPlanService.requireByCode(planCode);
        if (!plan.isAdvertisementEnabled()) {
            return List.of();
        }
        Instant now = clock.instant();
        String normalizedPlan = plan.getCode().toUpperCase(Locale.ROOT);
        return advertisementRepository.findByStatusIgnoreCaseOrderByUpdatedAtDescIdDesc("ACTIVE")
                .stream()
                .filter(ad -> withinSchedule(ad, now))
                .filter(ad -> targetPlans(ad).contains(normalizedPlan))
                .toList();
    }

    @Transactional
    public Advertisement create(AdvertisementRequest request) {
        Advertisement ad = new Advertisement();
        apply(ad, request);
        return advertisementRepository.save(ad);
    }

    @Transactional
    public Advertisement update(Long id, AdvertisementRequest request) {
        Advertisement ad = requireById(id);
        apply(ad, request);
        return advertisementRepository.save(ad);
    }

    @Transactional
    public Advertisement setStatus(Long id, String status) {
        Advertisement ad = requireById(id);
        String normalized = normalizeEnum(status, STATUSES, "Invalid advertisement status");
        if ("ACTIVE".equals(normalized)) {
            validateActivatable(ad);
        }
        ad.setStatus(normalized);
        return advertisementRepository.save(ad);
    }

    @Transactional
    public void delete(Long id) {
        advertisementRepository.delete(requireById(id));
    }

    public Map<String, Object> toView(Advertisement ad) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", ad.getId());
        out.put("brandName", ad.getBrandName());
        out.put("title", ad.getTitle());
        out.put("description", ad.getDescription());
        out.put("mediaUrl", ad.getMediaUrl());
        out.put("thumbnailUrl", ad.getThumbnailUrl());
        out.put("targetUrl", ad.getTargetUrl());
        out.put("type", ad.getType());
        out.put("placement", ad.getPlacement());
        out.put("duration", ad.getDurationSeconds());
        out.put("status", effectiveStatus(ad, clock.instant()));
        out.put("storedStatus", ad.getStatus());
        out.put("targetPlans", targetPlans(ad).stream().toList());
        out.put("startAt", ad.getStartAt() == null ? null : ad.getStartAt().toString());
        out.put("endAt", ad.getEndAt() == null ? null : ad.getEndAt().toString());
        out.put("createdAt", ad.getCreatedAt() == null ? null : ad.getCreatedAt().toString());
        out.put("updatedAt", ad.getUpdatedAt() == null ? null : ad.getUpdatedAt().toString());
        return out;
    }

    private void apply(Advertisement ad, AdvertisementRequest request) {
        ad.setBrandName(requireText(request.brandName(), "Brand name is required", 120));
        ad.setTitle(requireText(request.title(), "Advertisement title is required", 180));
        ad.setDescription(limit(request.description(), 2000));
        ad.setMediaUrl(optionalUrl(request.mediaUrl(), "Invalid media URL"));
        ad.setThumbnailUrl(optionalUrl(request.thumbnailUrl(), "Invalid thumbnail URL"));
        ad.setTargetUrl(optionalUrl(request.targetUrl(), "Invalid target URL"));
        ad.setType(normalizeEnum(request.type(), TYPES, "Invalid advertisement type"));
        ad.setPlacement(normalizeEnum(request.placement(), PLACEMENTS, "Invalid advertisement placement"));
        ad.setDurationSeconds(request.duration() == null ? null : requirePositive(request.duration(), "Duration must be > 0"));
        ad.setTargetPlans(normalizeTargetPlans(request.targetPlans()));
        ad.setStartAt(request.startAt());
        ad.setEndAt(request.endAt());
        if (ad.getEndAt() != null && ad.getStartAt() != null && ad.getEndAt().isBefore(ad.getStartAt())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "End date must be after start date");
        }
        String status = normalizeEnum(request.status(), STATUSES, "Invalid advertisement status");
        if ("ACTIVE".equals(status)) {
            validateActivatable(ad);
        }
        ad.setStatus(status);
    }

    private void validateActivatable(Advertisement ad) {
        requireText(ad.getBrandName(), "Brand name is required", 120);
        requireText(ad.getTitle(), "Advertisement title is required", 180);
        if (!StringUtils.hasText(ad.getMediaUrl())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Advertisement media URL is required");
        }
        if ("VIDEO".equals(ad.getType())) {
            if (ad.getDurationSeconds() == null || ad.getDurationSeconds() <= 0) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Video duration must be > 0");
            }
        }
        if (ad.getEndAt() != null && ad.getStartAt() != null && ad.getEndAt().isBefore(ad.getStartAt())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "End date must be after start date");
        }
    }

    private static boolean withinSchedule(Advertisement ad, Instant now) {
        return (ad.getStartAt() == null || !now.isBefore(ad.getStartAt()))
                && (ad.getEndAt() == null || now.isBefore(ad.getEndAt()));
    }

    private static String effectiveStatus(Advertisement ad, Instant now) {
        if ("ACTIVE".equalsIgnoreCase(ad.getStatus()) && ad.getEndAt() != null && !now.isBefore(ad.getEndAt())) {
            return "EXPIRED";
        }
        return ad.getStatus();
    }

    private Set<String> targetPlans(Advertisement ad) {
        String raw = StringUtils.hasText(ad.getTargetPlans()) ? ad.getTargetPlans() : UserPlanService.PLAN_FREE;
        return Arrays.stream(raw.split(","))
                .map(SubscriptionPlanService::normalizeCode)
                .collect(Collectors.toCollection(java.util.LinkedHashSet::new));
    }

    private String normalizeTargetPlans(List<String> targetPlans) {
        List<String> plans = targetPlans == null || targetPlans.isEmpty()
                ? List.of(UserPlanService.PLAN_FREE)
                : targetPlans;
        return plans.stream()
                .map(SubscriptionPlanService::normalizeCode)
                .distinct()
                .peek(subscriptionPlanService::requireByCode)
                .collect(Collectors.joining(","));
    }

    private static String normalizeEnum(String value, Set<String> allowed, String message) {
        String normalized = value == null ? "" : value.trim().toUpperCase(Locale.ROOT);
        if (!allowed.contains(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
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

    private static String optionalUrl(String value, String message) {
        if (!StringUtils.hasText(value)) {
            return null;
        }
        String trimmed = value.trim();
        try {
            URI uri = URI.create(trimmed);
            if (!"http".equalsIgnoreCase(uri.getScheme()) && !"https".equalsIgnoreCase(uri.getScheme())) {
                throw new IllegalArgumentException("unsupported scheme");
            }
            return trimmed;
        } catch (RuntimeException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
        }
    }

    private static int requirePositive(Integer value, String message) {
        if (value == null || value <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
        }
        return value;
    }

    public record AdvertisementRequest(
            String brandName,
            String title,
            String description,
            String mediaUrl,
            String thumbnailUrl,
            String targetUrl,
            String type,
            String placement,
            Integer duration,
            String status,
            List<String> targetPlans,
            Instant startAt,
            Instant endAt
    ) {
    }
}
