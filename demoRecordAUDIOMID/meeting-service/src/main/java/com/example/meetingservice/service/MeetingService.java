package com.example.meetingservice.service;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.entity.Subject;
import com.example.meetingservice.client.WorkspaceAccessClient;
import com.example.meetingservice.repository.MeetingRepository;
import com.example.meetingservice.repository.MeetingShareRepository;
import com.example.meetingservice.repository.SubjectRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;

@Service
@RequiredArgsConstructor
public class MeetingService {

    public static final String MEETING_STATUS_PROCESSING = "processing";
    public static final String MEETING_STATUS_COMPLETED = "completed";
    public static final String MEETING_STATUS_FAILED = "failed";
    public static final String MEETING_STATUS_SCHEDULED = "scheduled";

    private static final int DEFAULT_PAGE = 1;
    private static final int DEFAULT_PAGE_SIZE = 10;
    private static final int MAX_PAGE_SIZE = 50;
    private static final Set<String> UNCLASSIFIED_SORT_WHITELIST = Set.of(
            "createdAt_desc",
            "createdAt_asc",
            "title_asc",
            "title_desc");
    private static final Map<String, Sort> UNCLASSIFIED_SORTS = Map.of(
            "createdAt_desc", Sort.by(Sort.Order.desc("createdAt"), Sort.Order.desc("id")),
            "createdAt_asc", Sort.by(Sort.Order.asc("createdAt"), Sort.Order.asc("id")),
            "title_asc", Sort.by(Sort.Order.asc("title"), Sort.Order.asc("id")),
            "title_desc", Sort.by(Sort.Order.desc("title"), Sort.Order.desc("id")));

    private final MeetingRepository meetingRepository;
    private final MeetingShareRepository meetingShareRepository;
    private final SubjectRepository subjectRepository;
    private final WorkspaceAccessClient workspaceAccessClient;

    public Meeting saveMeeting(String title, String audioPath){
        return saveMeeting(title, audioPath, null);
    }

    public Meeting saveMeeting(String title, String audioPath, Long ownerUserId){
        return saveMeeting(title, audioPath, ownerUserId, null, "vi");
    }

    public Meeting saveMeeting(String title, String audioPath, Long ownerUserId, String originalFileName){
        return saveMeeting(title, audioPath, ownerUserId, originalFileName, "vi");
    }

    public Meeting saveMeeting(String title, String audioPath, Long ownerUserId, String originalFileName, String language){
        return saveMeeting(title, audioPath, ownerUserId, originalFileName, language, null, null, MEETING_STATUS_PROCESSING);
    }

    public Meeting saveMeeting(
            String title,
            String audioPath,
            Long ownerUserId,
            String originalFileName,
            String language,
            String audioHash,
            Long fileSize,
            String status
    ) {
        return saveMeeting(
                title,
                audioPath,
                ownerUserId,
                originalFileName,
                language,
                audioHash,
                fileSize,
                status,
                null);
    }

    @Transactional
    public Meeting saveMeeting(
            String title,
            String audioPath,
            Long ownerUserId,
            String originalFileName,
            String language,
            String audioHash,
            Long fileSize,
            String status,
            Long subjectId
    ) {
        Long resolvedSubjectId = null;
        if (subjectId != null) {
            requireActiveOwnedSubject(subjectId, ownerUserId);
            resolvedSubjectId = subjectId;
        }

        Meeting meeting = new Meeting();

        meeting.setTitle(normalizeTitle(title));
        meeting.setAudioPath(audioPath);
        meeting.setOwnerUserId(ownerUserId);
        meeting.setOriginalFileName(originalFileName);
        meeting.setLanguage(language);
        meeting.setAudioHash(normalizeNullable(audioHash));
        meeting.setFileSize(fileSize);
        meeting.setStatus(normalizeMeetingStatus(status));
        meeting.setSubjectId(resolvedSubjectId);
        meeting.setCreatedAt(LocalDateTime.now());
        meeting.setDeletedAt(null);

        return meetingRepository.save(meeting);
    }

    public Meeting findById(Long id) {
        return meetingRepository.findById(id)
                .orElseThrow(() -> new NoSuchElementException("Meeting not found: " + id));
    }

    public Meeting saveScheduledMeeting(
            String title,
            Long ownerUserId,
            String language,
            OffsetDateTime startAt,
            OffsetDateTime endAt,
            String timeZone) {
        if (ownerUserId == null) {
            throw new IllegalArgumentException("Owner is required");
        }
        if (startAt == null || endAt == null || !endAt.isAfter(startAt)) {
            throw new IllegalArgumentException("Scheduled end time must be after start time");
        }
        // Allow ongoing slots (e.g. 7–8 PM while user schedules at 7:30 PM) as long as the meeting has not ended.
        if (!endAt.isAfter(OffsetDateTime.now())) {
            throw new IllegalArgumentException("Scheduled end time must be in the future");
        }
        Meeting meeting = new Meeting();
        meeting.setTitle(normalizeTitle(title));
        meeting.setAudioPath("");
        meeting.setOriginalFileName("scheduled");
        meeting.setOwnerUserId(ownerUserId);
        meeting.setLanguage(normalizeLanguage(language));
        meeting.setFileSize(0L);
        meeting.setStatus(MEETING_STATUS_SCHEDULED);
        meeting.setCreatedAt(LocalDateTime.now());
        meeting.setScheduledStartAt(startAt);
        meeting.setScheduledEndAt(endAt);
        meeting.setScheduledTimezone(timeZone);
        meeting.setDeletedAt(null);
        return meetingRepository.save(meeting);
    }

    public Meeting findByIdForOwner(Long id, Long ownerUserId) {
        return meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(id, ownerUserId)
                .orElseThrow(() -> new NoSuchElementException("Meeting not found: " + id));
    }

    public Meeting findByIdForUser(Long id, Long userId) {
        Optional<Meeting> owned = meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(id, userId);
        if (owned.isPresent()) {
            return owned.get();
        }
        if (meetingShareRepository.existsByMeetingIdAndSharedWithUserId(id, userId)) {
            return meetingRepository.findById(id)
                    .filter(meeting -> meeting.getDeletedAt() == null)
                    .orElseThrow(() -> new NoSuchElementException("Meeting not found: " + id));
        }
        Optional<Meeting> workspaceMeeting = meetingRepository.findById(id)
                .filter(meeting -> meeting.getDeletedAt() == null)
                .filter(meeting -> workspaceAccessClient.canAccessOwnerMeetings(userId, meeting.getOwnerUserId()));
        if (workspaceMeeting.isPresent()) {
            workspaceMeeting.get().setSharedWithMe(true);
            return workspaceMeeting.get();
        }
        throw new NoSuchElementException("Meeting not found: " + id);
    }

    public List<Meeting> findRecentMeetings() {
        return meetingRepository.findTop20ByOrderByIdDesc();
    }

    public List<Meeting> findRecentMeetingsForOwner(Long ownerUserId) {
        return meetingRepository.findByOwnerUserIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(ownerUserId)
                .stream()
                .limit(20)
                .toList();
    }

    public List<Meeting> findMeetingsForOwner(
            Long ownerUserId,
            String query,
            String status,
            String language,
            String sort
    ) {
        List<Meeting> ordered = isSortAscending(sort)
                ? meetingRepository.findByOwnerUserIdAndDeletedAtIsNullOrderByCreatedAtAscIdAsc(ownerUserId)
                : meetingRepository.findByOwnerUserIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(ownerUserId);

        Stream<Meeting> stream = ordered.stream();
        String normalizedQuery = normalizeNullable(query);
        if (normalizedQuery != null) {
            String queryValue = normalizedQuery.toLowerCase(Locale.ROOT);
            stream = stream.filter((meeting) -> containsIgnoreCase(meeting.getTitle(), queryValue)
                    || containsIgnoreCase(meeting.getOriginalFileName(), queryValue));
        }

        String normalizedStatus = normalizeFilterStatus(status);
        if (normalizedStatus != null) {
            stream = stream.filter((meeting) -> normalizedStatus.equals(normalizeMeetingStatus(meeting.getStatus())));
        }

        String normalizedLanguage = normalizeNullable(language);
        if (normalizedLanguage != null) {
            String languageValue = normalizedLanguage.toLowerCase(Locale.ROOT);
            stream = stream.filter((meeting) -> languageValue.equals(normalizeLanguage(meeting.getLanguage())));
        }

        return stream.toList();
    }

    public List<Meeting> findMeetingsForUser(
            Long userId,
            String query,
            String status,
            String language,
            String sort
    ) {
        List<Meeting> owned = findMeetingsForOwner(userId, query, status, language, sort);
        Set<Long> seen = new LinkedHashSet<>(owned.stream().map(Meeting::getId).toList());
        List<Meeting> sharedMeetings = new ArrayList<>();
        for (var share : meetingShareRepository.findBySharedWithUserIdOrderByCreatedAtDesc(userId)) {
            if (seen.contains(share.getMeetingId())) {
                continue;
            }
            meetingRepository.findById(share.getMeetingId())
                    .filter(meeting -> meeting.getDeletedAt() == null)
                    .ifPresent(meeting -> {
                        if (matchesMeetingFilters(meeting, query, status, language)) {
                            sharedMeetings.add(meeting);
                            seen.add(meeting.getId());
                        }
                    });
        }
        List<Meeting> workspaceMeetings = meetingRepository.findTop20ByOrderByIdDesc().stream()
                .filter(meeting -> !seen.contains(meeting.getId()))
                .filter(meeting -> meeting.getDeletedAt() == null)
                .filter(meeting -> workspaceAccessClient.canAccessOwnerMeetings(userId, meeting.getOwnerUserId()))
                .peek(meeting -> meeting.setSharedWithMe(true))
                .toList();
        List<Meeting> merged = new ArrayList<>(owned);
        merged.addAll(sharedMeetings);
        merged.addAll(workspaceMeetings);
        return merged;
    }

    public MeetingPageResult findMeetingsForUserPage(
            Long userId,
            String query,
            String status,
            String language,
            String sort,
            int page,
            int pageSize
    ) {
        List<Meeting> all = findMeetingsForUser(userId, query, status, language, sort);
        int safePageSize = Math.max(1, Math.min(pageSize, MAX_PAGE_SIZE));
        int safePage = Math.max(1, page);
        long total = all.size();
        int totalPages = total == 0 ? 0 : (int) Math.ceil((double) total / safePageSize);
        int fromIndex = (safePage - 1) * safePageSize;
        if (fromIndex >= total) {
            return new MeetingPageResult(List.of(), total, safePage, safePageSize, totalPages);
        }
        int toIndex = Math.min(fromIndex + safePageSize, all.size());
        return new MeetingPageResult(all.subList(fromIndex, toIndex), total, safePage, safePageSize, totalPages);
    }

    @Transactional(readOnly = true)
    public MeetingPageResult findUnclassifiedForOwnerPage(
            Long ownerUserId,
            String search,
            String sort,
            Integer page,
            Integer pageSize
    ) {
        int safePage = page == null ? DEFAULT_PAGE : Math.max(1, page);
        int safePageSize = pageSize == null
                ? DEFAULT_PAGE_SIZE
                : Math.max(1, Math.min(pageSize, MAX_PAGE_SIZE));
        Sort resolvedSort = resolveUnclassifiedSort(sort);
        PageRequest pageable = PageRequest.of(safePage - 1, safePageSize, resolvedSort);
        String normalizedSearch = normalizeNullable(search);
        Page<Meeting> result = normalizedSearch == null
                ? meetingRepository.findByOwnerUserIdAndSubjectIdIsNullAndDeletedAtIsNull(
                        ownerUserId, pageable)
                : meetingRepository.findUnclassifiedForOwner(
                        ownerUserId, "%" + normalizedSearch + "%", pageable);
        long total = result.getTotalElements();
        int totalPages = total == 0 ? 0 : result.getTotalPages();
        return new MeetingPageResult(
                result.getContent(),
                total,
                safePage,
                safePageSize,
                totalPages);
    }

    @Transactional
    public Meeting assignSubject(Long meetingId, Long ownerUserId, Long subjectId) {
        Meeting meeting = findByIdForOwner(meetingId, ownerUserId);
        if (subjectId == null) {
            if (meeting.getSubjectId() == null) {
                return meeting;
            }
            meeting.setSubjectId(null);
            return meetingRepository.save(meeting);
        }

        requireActiveOwnedSubject(subjectId, ownerUserId);
        if (Objects.equals(meeting.getSubjectId(), subjectId)) {
            return meeting;
        }
        meeting.setSubjectId(subjectId);
        return meetingRepository.save(meeting);
    }

    public void requireActiveOwnedSubject(Long subjectId, Long ownerUserId) {
        if (ownerUserId == null) {
            throw new IllegalArgumentException("Owner is required");
        }
        Subject subject = subjectRepository
                .findByIdAndOwnerUserId(subjectId, ownerUserId)
                .orElseThrow(() -> new NoSuchElementException("Subject not found"));
        if (subject.getArchivedAt() != null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Archived subjects cannot be assigned");
        }
    }

    private boolean matchesMeetingFilters(Meeting meeting, String query, String status, String language) {
        String normalizedQuery = normalizeNullable(query);
        if (normalizedQuery != null) {
            String queryValue = normalizedQuery.toLowerCase(Locale.ROOT);
            if (!containsIgnoreCase(meeting.getTitle(), queryValue)
                    && !containsIgnoreCase(meeting.getOriginalFileName(), queryValue)) {
                return false;
            }
        }
        String normalizedStatus = normalizeFilterStatus(status);
        if (normalizedStatus != null
                && !normalizedStatus.equals(normalizeMeetingStatus(meeting.getStatus()))) {
            return false;
        }
        String normalizedLanguage = normalizeNullable(language);
        if (normalizedLanguage != null
                && !normalizedLanguage.equalsIgnoreCase(normalizeLanguage(meeting.getLanguage()))) {
            return false;
        }
        return true;
    }

    public Optional<DuplicateMatch> findActiveDuplicateForOwner(Long ownerUserId, String audioHash) {
        String normalizedHash = normalizeNullable(audioHash);
        if (normalizedHash == null) {
            return Optional.empty();
        }
        return meetingRepository.findFirstByOwnerUserIdAndAudioHashAndDeletedAtIsNullOrderByIdDesc(ownerUserId, normalizedHash)
                .map((meeting) -> {
                    String resolvedStatus = normalizeMeetingStatus(meeting.getStatus());
                    meeting.setStatus(resolvedStatus);
                    return new DuplicateMatch(
                            meeting,
                            MEETING_STATUS_COMPLETED.equals(resolvedStatus),
                            resolvedStatus
                    );
                });
    }

    public Meeting renameMeetingForOwner(Long meetingId, Long ownerUserId, String title) {
        Meeting meeting = findByIdForOwner(meetingId, ownerUserId);
        meeting.setTitle(normalizeTitle(title));
        return meetingRepository.save(meeting);
    }

    public Meeting updateMeetingStatusForOwner(Long meetingId, Long ownerUserId, String status) {
        Meeting meeting = findByIdForOwner(meetingId, ownerUserId);
        meeting.setStatus(normalizeMeetingStatus(status));
        return meetingRepository.save(meeting);
    }

    public Meeting softDeleteForOwner(Long meetingId, Long ownerUserId) {
        Meeting meeting = findByIdForOwner(meetingId, ownerUserId);
        meeting.setDeletedAt(LocalDateTime.now());
        return meetingRepository.save(meeting);
    }

    public String normalizeMeetingStatus(String value) {
        String normalized = normalizeNullable(value);
        if (normalized == null) {
            return MEETING_STATUS_PROCESSING;
        }
        String lowered = normalized.toLowerCase(Locale.ROOT);
        return switch (lowered) {
            case MEETING_STATUS_COMPLETED, "success", "succeeded" -> MEETING_STATUS_COMPLETED;
            case MEETING_STATUS_FAILED, "error" -> MEETING_STATUS_FAILED;
            case MEETING_STATUS_SCHEDULED -> MEETING_STATUS_SCHEDULED;
            default -> MEETING_STATUS_PROCESSING;
        };
    }

    private Sort resolveUnclassifiedSort(String sort) {
        if (sort == null || sort.isBlank()) {
            return UNCLASSIFIED_SORTS.get("createdAt_desc");
        }
        String normalized = sort.trim();
        if (!UNCLASSIFIED_SORT_WHITELIST.contains(normalized)) {
            throw new IllegalArgumentException("Unsupported sort: " + normalized);
        }
        return UNCLASSIFIED_SORTS.get(normalized);
    }

    private boolean isSortAscending(String sort) {
        String normalized = normalizeNullable(sort);
        if (normalized == null) {
            return false;
        }
        String lowered = normalized.toLowerCase(Locale.ROOT);
        return lowered.contains("asc") || lowered.contains("oldest");
    }

    private String normalizeFilterStatus(String status) {
        String normalized = normalizeNullable(status);
        if (normalized == null) {
            return null;
        }
        String lowered = normalized.toLowerCase(Locale.ROOT);
        return switch (lowered) {
            case MEETING_STATUS_COMPLETED, "success", "succeeded" -> MEETING_STATUS_COMPLETED;
            case MEETING_STATUS_FAILED, "error" -> MEETING_STATUS_FAILED;
            case MEETING_STATUS_SCHEDULED -> MEETING_STATUS_SCHEDULED;
            case MEETING_STATUS_PROCESSING, "queued", "running", "pending", "unknown", "not_found" -> MEETING_STATUS_PROCESSING;
            default -> null;
        };
    }

    private String normalizeLanguage(String language) {
        String normalized = normalizeNullable(language);
        if (normalized == null) {
            return "vi";
        }
        return normalized.toLowerCase(Locale.ROOT);
    }

    private String normalizeTitle(String title) {
        String normalized = normalizeNullable(title);
        if (normalized == null) {
            throw new IllegalArgumentException("Title is required");
        }
        return normalized;
    }

    private String normalizeNullable(String value) {
        if (value == null) {
            return null;
        }
        String normalized = value.trim();
        if (normalized.isBlank()) {
            return null;
        }
        return normalized;
    }

    private boolean containsIgnoreCase(String value, String queryValueLower) {
        if (value == null || queryValueLower == null || queryValueLower.isBlank()) {
            return false;
        }
        return value.toLowerCase(Locale.ROOT).contains(queryValueLower);
    }

    public record DuplicateMatch(Meeting meeting, boolean reused, String status) {
    }
}
