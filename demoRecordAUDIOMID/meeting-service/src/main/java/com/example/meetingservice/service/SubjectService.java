package com.example.meetingservice.service;

import com.example.meetingservice.controller.dto.CreateSubjectRequest;
import com.example.meetingservice.controller.dto.PageResponse;
import com.example.meetingservice.controller.dto.SubjectDetailResponse;
import com.example.meetingservice.controller.dto.SubjectMeetingResponse;
import com.example.meetingservice.controller.dto.SubjectResponse;
import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.entity.Subject;
import com.example.meetingservice.repository.MeetingRepository;
import com.example.meetingservice.repository.StudyFolderRepository;
import com.example.meetingservice.repository.SubjectRepository;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.Set;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class SubjectService {

    private static final int NAME_MAX = 200;
    private static final int CODE_MAX = 50;
    private static final int SEMESTER_MAX = 100;
    private static final int COLOR_MAX = 20;
    private static final int DEFAULT_PAGE = 1;
    private static final int DEFAULT_PAGE_SIZE = 10;
    private static final int MAX_PAGE_SIZE = 50;
    private static final Set<String> SORT_WHITELIST = Set.of(
            "name_asc",
            "name_desc",
            "updatedAt_asc",
            "updatedAt_desc",
            "createdAt_asc",
            "createdAt_desc",
            "meetingCount_asc",
            "meetingCount_desc");

    private final SubjectRepository subjectRepository;
    private final StudyFolderRepository studyFolderRepository;
    private final MeetingRepository meetingRepository;

    public SubjectService(
            SubjectRepository subjectRepository,
            StudyFolderRepository studyFolderRepository,
            MeetingRepository meetingRepository) {
        this.subjectRepository = subjectRepository;
        this.studyFolderRepository = studyFolderRepository;
        this.meetingRepository = meetingRepository;
    }

    @Transactional
    public SubjectResponse create(Long ownerUserId, CreateSubjectRequest request) {
        String name = requireName(request == null ? null : request.name());
        String code = normalizeOptionalText(request == null ? null : request.code(), CODE_MAX, "code");
        String semester =
                normalizeOptionalText(request == null ? null : request.semester(), SEMESTER_MAX, "semester");
        String description =
                normalizeOptionalText(request == null ? null : request.description(), Integer.MAX_VALUE, "description");
        String color = normalizeOptionalText(request == null ? null : request.color(), COLOR_MAX, "color");
        Long folderId = request == null ? null : request.folderId();
        if (folderId != null) {
            requireActiveOwnedFolder(folderId, ownerUserId);
        }
        assertNoDuplicateName(ownerUserId, name, null);

        LocalDateTime now = LocalDateTime.now();
        Subject subject = new Subject();
        subject.setOwnerUserId(ownerUserId);
        subject.setFolderId(folderId);
        subject.setName(name);
        subject.setCode(code);
        subject.setSemester(semester);
        subject.setDescription(description);
        subject.setColor(color);
        subject.setCreatedAt(now);
        subject.setUpdatedAt(now);
        try {
            subject = subjectRepository.save(subject);
        } catch (DataIntegrityViolationException ex) {
            throw conflict("A subject with this name already exists");
        }
        return toResponse(subject, 0L);
    }

    @Transactional(readOnly = true)
    public PageResponse<SubjectResponse> list(
            Long ownerUserId,
            Long folderId,
            String search,
            boolean archived,
            Integer page,
            Integer pageSize,
            String sort) {
        String sortKey = resolveSort(sort);
        List<Subject> source;
        if (archived) {
            source = subjectRepository.findByOwnerUserIdAndArchivedAtIsNotNullOrderByNameAscIdAsc(ownerUserId);
        } else {
            source = subjectRepository.findByOwnerUserIdAndArchivedAtIsNullOrderByNameAscIdAsc(ownerUserId);
        }
        if (folderId != null) {
            source = source.stream()
                    .filter(subject -> Objects.equals(subject.getFolderId(), folderId))
                    .toList();
        }
        String normalizedSearch = normalizeSearch(search);
        List<SubjectResponse> mapped = new ArrayList<>();
        for (Subject subject : source) {
            if (normalizedSearch != null && !matchesSearch(subject, normalizedSearch)) {
                continue;
            }
            long meetingCount =
                    meetingRepository.countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(
                            subject.getId(), ownerUserId);
            mapped.add(toResponse(subject, meetingCount));
        }
        mapped.sort(comparatorFor(sortKey));

        int safePageSize = clampPageSize(pageSize);
        int safePage = clampPage(page);
        long total = mapped.size();
        int totalPages = total == 0 ? 0 : (int) Math.ceil((double) total / safePageSize);
        int from = (safePage - 1) * safePageSize;
        if (from >= total) {
            return new PageResponse<>(List.of(), total, safePage, safePageSize, totalPages);
        }
        int to = Math.min(from + safePageSize, mapped.size());
        return new PageResponse<>(mapped.subList(from, to), total, safePage, safePageSize, totalPages);
    }

    @Transactional(readOnly = true)
    public SubjectDetailResponse get(Long subjectId, Long ownerUserId) {
        Subject subject = requireOwnedSubject(subjectId, ownerUserId);
        long meetingCount =
                meetingRepository.countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(
                        subject.getId(), ownerUserId);
        return new SubjectDetailResponse(toResponse(subject, meetingCount));
    }

    @Transactional
    public SubjectResponse update(Long subjectId, Long ownerUserId, Map<String, Object> payload) {
        Subject subject = requireOwnedSubject(subjectId, ownerUserId);
        if (subject.getArchivedAt() != null) {
            throw conflict("Archived subjects cannot be updated");
        }
        Map<String, Object> body = payload == null ? Map.of() : payload;
        boolean dirty = false;

        if (body.containsKey("name")) {
            String name = requireName(asString(body.get("name")));
            if (!Objects.equals(subject.getName(), name)) {
                subject.setName(name);
                dirty = true;
            }
        }
        if (body.containsKey("code")) {
            String code = normalizeOptionalText(asString(body.get("code")), CODE_MAX, "code");
            if (!Objects.equals(subject.getCode(), code)) {
                subject.setCode(code);
                dirty = true;
            }
        }
        if (body.containsKey("semester")) {
            String semester =
                    normalizeOptionalText(asString(body.get("semester")), SEMESTER_MAX, "semester");
            if (!Objects.equals(subject.getSemester(), semester)) {
                subject.setSemester(semester);
                dirty = true;
            }
        }
        if (body.containsKey("description")) {
            String description =
                    normalizeOptionalText(
                            asString(body.get("description")), Integer.MAX_VALUE, "description");
            if (!Objects.equals(subject.getDescription(), description)) {
                subject.setDescription(description);
                dirty = true;
            }
        }
        if (body.containsKey("color")) {
            String color = normalizeOptionalText(asString(body.get("color")), COLOR_MAX, "color");
            if (!Objects.equals(subject.getColor(), color)) {
                subject.setColor(color);
                dirty = true;
            }
        }
        if (body.containsKey("folderId")) {
            Object rawFolder = body.get("folderId");
            Long folderId;
            if (rawFolder == null) {
                folderId = null;
            } else if (rawFolder instanceof Number number) {
                folderId = number.longValue();
            } else {
                throw new IllegalArgumentException("folderId must be a number or null");
            }
            if (folderId != null) {
                requireActiveOwnedFolder(folderId, ownerUserId);
            }
            if (!Objects.equals(subject.getFolderId(), folderId)) {
                subject.setFolderId(folderId);
                dirty = true;
            }
        }

        if (!dirty) {
            long meetingCount =
                    meetingRepository.countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(
                            subject.getId(), ownerUserId);
            return toResponse(subject, meetingCount);
        }

        assertNoDuplicateName(ownerUserId, subject.getName(), subject.getId());
        subject.setUpdatedAt(LocalDateTime.now());
        try {
            subject = subjectRepository.save(subject);
        } catch (DataIntegrityViolationException ex) {
            throw conflict("A subject with this name already exists");
        }
        long meetingCount =
                meetingRepository.countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(
                        subject.getId(), ownerUserId);
        return toResponse(subject, meetingCount);
    }

    @Transactional
    public SubjectResponse archive(Long subjectId, Long ownerUserId) {
        Subject subject = requireOwnedSubject(subjectId, ownerUserId);
        if (subject.getArchivedAt() != null) {
            long meetingCount =
                    meetingRepository.countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(
                            subject.getId(), ownerUserId);
            return toResponse(subject, meetingCount);
        }

        meetingRepository.clearSubjectAssignmentsForOwner(subjectId, ownerUserId);
        LocalDateTime now = LocalDateTime.now();
        subject.setArchivedAt(now);
        subject.setUpdatedAt(now);
        subject = subjectRepository.save(subject);
        return toResponse(subject, 0L);
    }

    @Transactional(readOnly = true)
    public PageResponse<SubjectMeetingResponse> listMeetings(
            Long subjectId, Long ownerUserId, Integer page, Integer pageSize) {
        requireOwnedSubject(subjectId, ownerUserId);
        int safePageSize = clampPageSize(pageSize);
        int safePage = clampPage(page);
        PageRequest pageable = PageRequest.of(safePage - 1, safePageSize);
        Page<Meeting> result =
                meetingRepository.findBySubjectIdAndOwnerUserIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(
                        subjectId, ownerUserId, pageable);
        List<SubjectMeetingResponse> items =
                result.getContent().stream().map(this::toMeetingResponse).toList();
        return new PageResponse<>(
                items,
                result.getTotalElements(),
                safePage,
                safePageSize,
                result.getTotalPages());
    }

    private Subject requireOwnedSubject(Long subjectId, Long ownerUserId) {
        return subjectRepository
                .findByIdAndOwnerUserId(subjectId, ownerUserId)
                .orElseThrow(() -> notFound("Subject not found"));
    }

    private void requireActiveOwnedFolder(Long folderId, Long ownerUserId) {
        studyFolderRepository
                .findByIdAndOwnerUserIdAndDeletedAtIsNull(folderId, ownerUserId)
                .orElseThrow(() -> notFound("Folder not found"));
    }

    private void assertNoDuplicateName(Long ownerUserId, String name, Long excludeId) {
        if (subjectRepository.existsActiveDuplicateName(ownerUserId, name, excludeId)) {
            throw conflict("A subject with this name already exists");
        }
    }

    private SubjectResponse toResponse(Subject subject, long meetingCount) {
        return new SubjectResponse(
                subject.getId(),
                subject.getOwnerUserId(),
                subject.getFolderId(),
                subject.getName(),
                subject.getCode(),
                subject.getSemester(),
                subject.getDescription(),
                subject.getColor(),
                subject.getCreatedAt(),
                subject.getUpdatedAt(),
                subject.getArchivedAt(),
                meetingCount);
    }

    private SubjectMeetingResponse toMeetingResponse(Meeting meeting) {
        return new SubjectMeetingResponse(
                meeting.getId(),
                meeting.getTitle(),
                meeting.getStatus(),
                meeting.getLanguage(),
                meeting.getCreatedAt(),
                meeting.getSubjectId());
    }

    private static String resolveSort(String sort) {
        if (sort == null || sort.isBlank()) {
            return "name_asc";
        }
        String normalized = sort.trim();
        if (!SORT_WHITELIST.contains(normalized)) {
            throw new IllegalArgumentException("Unsupported sort: " + normalized);
        }
        return normalized;
    }

    private static Comparator<SubjectResponse> comparatorFor(String sortKey) {
        Comparator<SubjectResponse> byName =
                Comparator.comparing(
                        (SubjectResponse subject) ->
                                subject.name() == null
                                        ? ""
                                        : subject.name().trim().toLowerCase(Locale.ROOT));
        Comparator<SubjectResponse> byId =
                Comparator.comparing(SubjectResponse::id, Comparator.nullsLast(Long::compareTo));
        return switch (sortKey) {
            case "name_desc" -> byName.reversed().thenComparing(byId);
            case "updatedAt_asc" -> Comparator.comparing(
                            SubjectResponse::updatedAt, Comparator.nullsLast(Comparator.naturalOrder()))
                    .thenComparing(byId);
            case "updatedAt_desc" -> Comparator.comparing(
                            SubjectResponse::updatedAt, Comparator.nullsLast(Comparator.reverseOrder()))
                    .thenComparing(byId);
            case "createdAt_asc" -> Comparator.comparing(
                            SubjectResponse::createdAt, Comparator.nullsLast(Comparator.naturalOrder()))
                    .thenComparing(byId);
            case "createdAt_desc" -> Comparator.comparing(
                            SubjectResponse::createdAt, Comparator.nullsLast(Comparator.reverseOrder()))
                    .thenComparing(byId);
            case "meetingCount_asc" -> Comparator.comparingLong(SubjectResponse::meetingCount)
                    .thenComparing(byName)
                    .thenComparing(byId);
            case "meetingCount_desc" -> Comparator.comparingLong(SubjectResponse::meetingCount)
                    .reversed()
                    .thenComparing(byName)
                    .thenComparing(byId);
            default -> byName.thenComparing(byId);
        };
    }

    private static boolean matchesSearch(Subject subject, String search) {
        return contains(subject.getName(), search)
                || contains(subject.getCode(), search)
                || contains(subject.getSemester(), search)
                || contains(subject.getDescription(), search);
    }

    private static boolean contains(String value, String search) {
        return value != null && value.toLowerCase(Locale.ROOT).contains(search);
    }

    private static String normalizeSearch(String search) {
        if (search == null) {
            return null;
        }
        String trimmed = search.trim().toLowerCase(Locale.ROOT);
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static int clampPage(Integer page) {
        if (page == null) {
            return DEFAULT_PAGE;
        }
        return Math.max(1, page);
    }

    private static int clampPageSize(Integer pageSize) {
        if (pageSize == null) {
            return DEFAULT_PAGE_SIZE;
        }
        return Math.max(1, Math.min(pageSize, MAX_PAGE_SIZE));
    }

    private static String requireName(String raw) {
        String name = raw == null ? "" : raw.trim();
        if (name.isEmpty()) {
            throw new IllegalArgumentException("name is required");
        }
        if (name.length() > NAME_MAX) {
            throw new IllegalArgumentException("name must be at most " + NAME_MAX + " characters");
        }
        return name;
    }

    private static String normalizeOptionalText(String raw, int max, String field) {
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        if (trimmed.length() > max) {
            throw new IllegalArgumentException(field + " must be at most " + max + " characters");
        }
        return trimmed;
    }

    private static String asString(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private static NoSuchElementException notFound(String message) {
        return new NoSuchElementException(message);
    }

    private static ResponseStatusException conflict(String message) {
        return new ResponseStatusException(HttpStatus.CONFLICT, message);
    }
}
