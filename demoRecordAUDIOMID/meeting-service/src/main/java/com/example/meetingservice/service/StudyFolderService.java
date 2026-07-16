package com.example.meetingservice.service;

import com.example.meetingservice.controller.dto.CreateStudyFolderRequest;
import com.example.meetingservice.controller.dto.StudyFolderResponse;
import com.example.meetingservice.controller.dto.StudyFolderTreeNode;
import com.example.meetingservice.controller.dto.StudyFolderTreeResponse;
import com.example.meetingservice.controller.dto.SubjectSummaryResponse;
import com.example.meetingservice.entity.StudyFolder;
import com.example.meetingservice.entity.Subject;
import com.example.meetingservice.repository.MeetingRepository;
import com.example.meetingservice.repository.StudyFolderRepository;
import com.example.meetingservice.repository.SubjectRepository;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class StudyFolderService {

    private static final Logger log = LoggerFactory.getLogger(StudyFolderService.class);
    private static final int NAME_MAX = 150;
    private static final int COLOR_MAX = 20;

    private final StudyFolderRepository studyFolderRepository;
    private final SubjectRepository subjectRepository;
    private final MeetingRepository meetingRepository;

    public StudyFolderService(
            StudyFolderRepository studyFolderRepository,
            SubjectRepository subjectRepository,
            MeetingRepository meetingRepository) {
        this.studyFolderRepository = studyFolderRepository;
        this.subjectRepository = subjectRepository;
        this.meetingRepository = meetingRepository;
    }

    @Transactional
    public StudyFolderResponse create(Long ownerUserId, CreateStudyFolderRequest request) {
        String name = requireName(request == null ? null : request.name());
        String color = normalizeOptionalText(request == null ? null : request.color(), COLOR_MAX, "color");
        Long parentFolderId = request == null ? null : request.parentFolderId();
        if (parentFolderId != null) {
            requireActiveOwnedFolder(parentFolderId, ownerUserId);
        }
        assertNoDuplicateName(ownerUserId, parentFolderId, name, null);

        LocalDateTime now = LocalDateTime.now();
        StudyFolder folder = new StudyFolder();
        folder.setOwnerUserId(ownerUserId);
        folder.setParentFolderId(parentFolderId);
        folder.setName(name);
        folder.setColor(color);
        folder.setCreatedAt(now);
        folder.setUpdatedAt(now);
        try {
            folder = studyFolderRepository.save(folder);
        } catch (DataIntegrityViolationException ex) {
            throw conflict("A folder with this name already exists in the same parent");
        }
        return toResponse(folder, 0L);
    }

    @Transactional(readOnly = true)
    public List<StudyFolderResponse> list(Long ownerUserId) {
        return studyFolderRepository
                .findByOwnerUserIdAndDeletedAtIsNullOrderByNameAscIdAsc(ownerUserId)
                .stream()
                .map(folder -> toResponse(
                        folder,
                        subjectRepository.countByFolderIdAndOwnerUserIdAndArchivedAtIsNull(
                                folder.getId(), ownerUserId)))
                .toList();
    }

    @Transactional(readOnly = true)
    public StudyFolderResponse get(Long folderId, Long ownerUserId) {
        StudyFolder folder = requireActiveOwnedFolder(folderId, ownerUserId);
        return toResponse(
                folder,
                subjectRepository.countByFolderIdAndOwnerUserIdAndArchivedAtIsNull(
                        folder.getId(), ownerUserId));
    }

    @Transactional
    public StudyFolderResponse update(Long folderId, Long ownerUserId, Map<String, Object> payload) {
        StudyFolder folder = requireActiveOwnedFolder(folderId, ownerUserId);
        Map<String, Object> body = payload == null ? Map.of() : payload;

        boolean dirty = false;
        if (body.containsKey("name")) {
            String name = requireName(asString(body.get("name")));
            if (!Objects.equals(folder.getName(), name)) {
                folder.setName(name);
                dirty = true;
            }
        }
        if (body.containsKey("color")) {
            String color = normalizeOptionalText(asString(body.get("color")), COLOR_MAX, "color");
            if (!Objects.equals(folder.getColor(), color)) {
                folder.setColor(color);
                dirty = true;
            }
        }

        Long targetParent = folder.getParentFolderId();
        boolean parentTouched = body.containsKey("parentFolderId");
        if (parentTouched) {
            Object rawParent = body.get("parentFolderId");
            if (rawParent == null) {
                targetParent = null;
            } else if (rawParent instanceof Number number) {
                targetParent = number.longValue();
            } else {
                throw new IllegalArgumentException("parentFolderId must be a number or null");
            }
            if (Objects.equals(targetParent, folderId)) {
                throw conflict("Folder cannot be its own parent");
            }
            if (targetParent != null) {
                requireActiveOwnedFolder(targetParent, ownerUserId);
                assertNotMovingIntoDescendant(folderId, targetParent, ownerUserId);
            }
            if (!Objects.equals(folder.getParentFolderId(), targetParent)) {
                folder.setParentFolderId(targetParent);
                dirty = true;
            }
        }

        if (!dirty) {
            return toResponse(
                    folder,
                    subjectRepository.countByFolderIdAndOwnerUserIdAndArchivedAtIsNull(
                            folder.getId(), ownerUserId));
        }

        assertNoDuplicateName(ownerUserId, folder.getParentFolderId(), folder.getName(), folder.getId());
        folder.setUpdatedAt(LocalDateTime.now());
        try {
            folder = studyFolderRepository.save(folder);
        } catch (DataIntegrityViolationException ex) {
            throw conflict("A folder with this name already exists in the same parent");
        }
        return toResponse(
                folder,
                subjectRepository.countByFolderIdAndOwnerUserIdAndArchivedAtIsNull(
                        folder.getId(), ownerUserId));
    }

    @Transactional
    public StudyFolderResponse delete(Long folderId, Long ownerUserId) {
        StudyFolder folder = studyFolderRepository
                .findByIdAndOwnerUserId(folderId, ownerUserId)
                .orElseThrow(() -> notFound("Folder not found"));
        if (folder.getDeletedAt() != null) {
            return toResponse(folder, 0L);
        }

        long activeChildren =
                studyFolderRepository.countByOwnerUserIdAndParentFolderIdAndDeletedAtIsNull(
                        ownerUserId, folderId);
        if (activeChildren > 0) {
            throw conflict("Folder still has active child folders");
        }

        subjectRepository.detachSubjectsFromFolder(folderId, ownerUserId);
        folder.setDeletedAt(LocalDateTime.now());
        folder.setUpdatedAt(folder.getDeletedAt());
        folder = studyFolderRepository.save(folder);
        return toResponse(folder, 0L);
    }

    @Transactional(readOnly = true)
    public StudyFolderTreeResponse tree(Long ownerUserId) {
        List<StudyFolder> folders =
                studyFolderRepository.findByOwnerUserIdAndDeletedAtIsNullOrderByNameAscIdAsc(
                        ownerUserId);
        List<Subject> subjects =
                subjectRepository.findByOwnerUserIdAndArchivedAtIsNullOrderByNameAscIdAsc(ownerUserId);

        Map<Long, Long> meetingCounts = new HashMap<>();
        for (Subject subject : subjects) {
            meetingCounts.put(
                    subject.getId(),
                    meetingRepository.countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(
                            subject.getId(), ownerUserId));
        }

        Map<Long, List<SubjectSummaryResponse>> subjectsByFolder = new HashMap<>();
        List<SubjectSummaryResponse> rootSubjects = new ArrayList<>();
        for (Subject subject : subjects) {
            SubjectSummaryResponse summary =
                    toSubjectSummary(subject, meetingCounts.getOrDefault(subject.getId(), 0L));
            if (subject.getFolderId() == null) {
                rootSubjects.add(summary);
            } else {
                subjectsByFolder
                        .computeIfAbsent(subject.getFolderId(), ignored -> new ArrayList<>())
                        .add(summary);
            }
        }
        rootSubjects.sort(summaryNameComparator());
        subjectsByFolder.values().forEach(list -> list.sort(summaryNameComparator()));

        Map<Long, List<StudyFolder>> childrenByParent = new HashMap<>();
        List<StudyFolder> roots = new ArrayList<>();
        for (StudyFolder folder : folders) {
            if (folder.getParentFolderId() == null) {
                roots.add(folder);
            } else {
                childrenByParent
                        .computeIfAbsent(folder.getParentFolderId(), ignored -> new ArrayList<>())
                        .add(folder);
            }
        }
        roots.sort(folderNameComparator());
        childrenByParent.values().forEach(list -> list.sort(folderNameComparator()));

        List<StudyFolderTreeNode> treeRoots = new ArrayList<>();
        Set<Long> visited = new HashSet<>();
        for (StudyFolder root : roots) {
            StudyFolderTreeNode node = buildNode(root, childrenByParent, subjectsByFolder, visited);
            if (node != null) {
                treeRoots.add(node);
            }
        }
        return new StudyFolderTreeResponse(treeRoots, rootSubjects);
    }

    private StudyFolderTreeNode buildNode(
            StudyFolder folder,
            Map<Long, List<StudyFolder>> childrenByParent,
            Map<Long, List<SubjectSummaryResponse>> subjectsByFolder,
            Set<Long> visited) {
        if (!visited.add(folder.getId())) {
            log.warn(
                    "event=FOLDER_TREE_CYCLE_SKIPPED folderId={} ownerUserId={}",
                    folder.getId(),
                    folder.getOwnerUserId());
            return null;
        }
        List<StudyFolderTreeNode> children = new ArrayList<>();
        for (StudyFolder child :
                childrenByParent.getOrDefault(folder.getId(), List.of())) {
            StudyFolderTreeNode childNode =
                    buildNode(child, childrenByParent, subjectsByFolder, visited);
            if (childNode != null) {
                children.add(childNode);
            }
        }
        List<SubjectSummaryResponse> subjects =
                subjectsByFolder.getOrDefault(folder.getId(), List.of());
        return new StudyFolderTreeNode(
                folder.getId(),
                folder.getName(),
                folder.getColor(),
                folder.getParentFolderId(),
                children,
                subjects);
    }

    private void assertNotMovingIntoDescendant(Long folderId, Long candidateParentId, Long ownerUserId) {
        Long current = candidateParentId;
        Set<Long> visited = new HashSet<>();
        while (current != null) {
            if (!visited.add(current)) {
                log.warn(
                        "event=FOLDER_ANCESTOR_CYCLE_DETECTED startParentId={} folderId={} ownerUserId={}",
                        candidateParentId,
                        folderId,
                        ownerUserId);
                throw conflict("Folder hierarchy cycle detected");
            }
            if (Objects.equals(current, folderId)) {
                throw conflict("Cannot move folder into its descendant");
            }
            current = studyFolderRepository
                    .findByIdAndOwnerUserIdAndDeletedAtIsNull(current, ownerUserId)
                    .map(StudyFolder::getParentFolderId)
                    .orElse(null);
        }
    }

    private StudyFolder requireActiveOwnedFolder(Long folderId, Long ownerUserId) {
        return studyFolderRepository
                .findByIdAndOwnerUserIdAndDeletedAtIsNull(folderId, ownerUserId)
                .orElseThrow(() -> notFound("Folder not found"));
    }

    private void assertNoDuplicateName(
            Long ownerUserId, Long parentFolderId, String name, Long excludeId) {
        if (studyFolderRepository.existsActiveDuplicateName(
                ownerUserId, parentFolderId, name, excludeId)) {
            throw conflict("A folder with this name already exists in the same parent");
        }
    }

    private StudyFolderResponse toResponse(StudyFolder folder, long subjectCount) {
        return new StudyFolderResponse(
                folder.getId(),
                folder.getOwnerUserId(),
                folder.getParentFolderId(),
                folder.getName(),
                folder.getColor(),
                folder.getCreatedAt(),
                folder.getUpdatedAt(),
                folder.getDeletedAt(),
                subjectCount);
    }

    private SubjectSummaryResponse toSubjectSummary(Subject subject, long meetingCount) {
        return new SubjectSummaryResponse(
                subject.getId(),
                subject.getName(),
                subject.getCode(),
                subject.getSemester(),
                subject.getColor(),
                subject.getFolderId(),
                subject.getArchivedAt(),
                meetingCount);
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

    private static Comparator<StudyFolder> folderNameComparator() {
        return Comparator.comparing(
                        (StudyFolder folder) ->
                                folder.getName() == null
                                        ? ""
                                        : folder.getName().trim().toLowerCase(Locale.ROOT))
                .thenComparing(StudyFolder::getId, Comparator.nullsLast(Long::compareTo));
    }

    private static Comparator<SubjectSummaryResponse> summaryNameComparator() {
        return Comparator.comparing(
                        (SubjectSummaryResponse subject) ->
                                subject.name() == null
                                        ? ""
                                        : subject.name().trim().toLowerCase(Locale.ROOT))
                .thenComparing(SubjectSummaryResponse::id, Comparator.nullsLast(Long::compareTo));
    }

    private static NoSuchElementException notFound(String message) {
        return new NoSuchElementException(message);
    }

    private static ResponseStatusException conflict(String message) {
        return new ResponseStatusException(HttpStatus.CONFLICT, message);
    }
}
