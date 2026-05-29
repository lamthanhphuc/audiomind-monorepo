package com.example.meetingservice.service;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.repository.MeetingRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Locale;
import java.util.NoSuchElementException;
import java.util.Optional;
import java.util.stream.Stream;

@Service
@RequiredArgsConstructor
public class MeetingService {

    public static final String MEETING_STATUS_PROCESSING = "processing";
    public static final String MEETING_STATUS_COMPLETED = "completed";
    public static final String MEETING_STATUS_FAILED = "failed";

    private final MeetingRepository meetingRepository;

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

        Meeting meeting = new Meeting();

        meeting.setTitle(normalizeTitle(title));
        meeting.setAudioPath(audioPath);
        meeting.setOwnerUserId(ownerUserId);
        meeting.setOriginalFileName(originalFileName);
        meeting.setLanguage(language);
        meeting.setAudioHash(normalizeNullable(audioHash));
        meeting.setFileSize(fileSize);
        meeting.setStatus(normalizeMeetingStatus(status));
        meeting.setCreatedAt(LocalDateTime.now());
        meeting.setDeletedAt(null);

        return meetingRepository.save(meeting);
    }

    public Meeting findById(Long id) {
        return meetingRepository.findById(id)
                .orElseThrow(() -> new NoSuchElementException("Meeting not found: " + id));
    }

    public Meeting findByIdForOwner(Long id, Long ownerUserId) {
        return meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(id, ownerUserId)
                .orElseThrow(() -> new NoSuchElementException("Meeting not found: " + id));
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
            default -> MEETING_STATUS_PROCESSING;
        };
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
