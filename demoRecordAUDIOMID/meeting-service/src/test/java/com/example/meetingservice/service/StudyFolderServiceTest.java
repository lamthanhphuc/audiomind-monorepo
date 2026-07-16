package com.example.meetingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.meetingservice.controller.dto.CreateStudyFolderRequest;
import com.example.meetingservice.controller.dto.StudyFolderResponse;
import com.example.meetingservice.controller.dto.StudyFolderTreeResponse;
import com.example.meetingservice.entity.StudyFolder;
import com.example.meetingservice.entity.Subject;
import com.example.meetingservice.repository.MeetingRepository;
import com.example.meetingservice.repository.StudyFolderRepository;
import com.example.meetingservice.repository.SubjectRepository;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

@ExtendWith(MockitoExtension.class)
class StudyFolderServiceTest {

    @Mock
    private StudyFolderRepository studyFolderRepository;

    @Mock
    private SubjectRepository subjectRepository;

    @Mock
    private MeetingRepository meetingRepository;

    @InjectMocks
    private StudyFolderService studyFolderService;

    @Test
    void createRootFolder_succeeds() {
        when(studyFolderRepository.existsActiveDuplicateName(1L, null, "Kỳ 1", null)).thenReturn(false);
        when(studyFolderRepository.save(any(StudyFolder.class))).thenAnswer(invocation -> {
            StudyFolder folder = invocation.getArgument(0);
            folder.setId(10L);
            return folder;
        });

        StudyFolderResponse response =
                studyFolderService.create(1L, new CreateStudyFolderRequest("  Kỳ 1  ", " #fff ", null));

        assertEquals(10L, response.id());
        assertEquals("Kỳ 1", response.name());
        assertEquals("#fff", response.color());
        assertNull(response.parentFolderId());
    }

    @Test
    void createChild_requiresOwnedActiveParent() {
        when(studyFolderRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(5L, 1L))
                .thenReturn(Optional.of(folder(5L, 1L, null, "Parent")));
        when(studyFolderRepository.existsActiveDuplicateName(1L, 5L, "Child", null)).thenReturn(false);
        when(studyFolderRepository.save(any(StudyFolder.class))).thenAnswer(invocation -> {
            StudyFolder folder = invocation.getArgument(0);
            folder.setId(11L);
            return folder;
        });

        StudyFolderResponse response =
                studyFolderService.create(1L, new CreateStudyFolderRequest("Child", null, 5L));

        assertEquals(5L, response.parentFolderId());
    }

    @Test
    void create_duplicateNormalizedName_conflicts() {
        when(studyFolderRepository.existsActiveDuplicateName(1L, null, "kỳ 1", null)).thenReturn(true);

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> studyFolderService.create(1L, new CreateStudyFolderRequest("  kỳ 1 ", null, null)));
        assertEquals(HttpStatus.CONFLICT, ex.getStatusCode());
    }

    @Test
    void create_parentOwnedByOtherUser_notFound() {
        when(studyFolderRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(9L, 1L))
                .thenReturn(Optional.empty());

        assertThrows(
                NoSuchElementException.class,
                () -> studyFolderService.create(1L, new CreateStudyFolderRequest("Child", null, 9L)));
    }

    @Test
    void update_selfParent_conflicts() {
        when(studyFolderRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(3L, 1L))
                .thenReturn(Optional.of(folder(3L, 1L, null, "Root")));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> studyFolderService.update(3L, 1L, Map.of("parentFolderId", 3)));
        assertEquals(HttpStatus.CONFLICT, ex.getStatusCode());
    }

    @Test
    void update_moveIntoDescendant_conflicts() {
        when(studyFolderRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(1L, 1L))
                .thenReturn(Optional.of(folder(1L, 1L, null, "Root")));
        when(studyFolderRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(2L, 1L))
                .thenReturn(Optional.of(folder(2L, 1L, 1L, "Child")));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> studyFolderService.update(1L, 1L, Map.of("parentFolderId", 2)));
        assertEquals(HttpStatus.CONFLICT, ex.getStatusCode());
    }

    @Test
    void update_clearParentToRoot_usesContainsKeyNull() {
        StudyFolder child = folder(4L, 1L, 1L, "Child");
        when(studyFolderRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(4L, 1L))
                .thenReturn(Optional.of(child));
        when(studyFolderRepository.existsActiveDuplicateName(eq(1L), isNull(), eq("Child"), eq(4L)))
                .thenReturn(false);
        when(studyFolderRepository.save(any(StudyFolder.class))).thenAnswer(invocation -> invocation.getArgument(0));
        when(subjectRepository.countByFolderIdAndOwnerUserIdAndArchivedAtIsNull(4L, 1L)).thenReturn(0L);

        StudyFolderResponse response =
                studyFolderService.update(4L, 1L, new java.util.HashMap<>(Map.of()) {{
                    put("parentFolderId", null);
                }});

        assertNull(response.parentFolderId());
    }

    @Test
    void delete_withActiveChild_conflicts() {
        when(studyFolderRepository.findByIdAndOwnerUserId(7L, 1L))
                .thenReturn(Optional.of(folder(7L, 1L, null, "Parent")));
        when(studyFolderRepository.countByOwnerUserIdAndParentFolderIdAndDeletedAtIsNull(1L, 7L))
                .thenReturn(1L);

        ResponseStatusException ex =
                assertThrows(ResponseStatusException.class, () -> studyFolderService.delete(7L, 1L));
        assertEquals(HttpStatus.CONFLICT, ex.getStatusCode());
        verify(subjectRepository, never()).detachSubjectsFromFolder(any(), any());
    }

    @Test
    void delete_detachesSubjectsAndSoftDeletes() {
        StudyFolder folder = folder(8L, 1L, null, "Folder");
        when(studyFolderRepository.findByIdAndOwnerUserId(8L, 1L)).thenReturn(Optional.of(folder));
        when(studyFolderRepository.countByOwnerUserIdAndParentFolderIdAndDeletedAtIsNull(1L, 8L))
                .thenReturn(0L);
        when(studyFolderRepository.save(any(StudyFolder.class))).thenAnswer(invocation -> invocation.getArgument(0));

        StudyFolderResponse response = studyFolderService.delete(8L, 1L);

        verify(subjectRepository).detachSubjectsFromFolder(8L, 1L);
        assertTrue(response.deletedAt() != null);
    }

    @Test
    void delete_alreadyDeleted_isIdempotent() {
        StudyFolder folder = folder(8L, 1L, null, "Folder");
        folder.setDeletedAt(LocalDateTime.of(2025, 1, 1, 0, 0));
        when(studyFolderRepository.findByIdAndOwnerUserId(8L, 1L)).thenReturn(Optional.of(folder));

        StudyFolderResponse response = studyFolderService.delete(8L, 1L);

        assertEquals(folder.getDeletedAt(), response.deletedAt());
        verify(subjectRepository, never()).detachSubjectsFromFolder(any(), any());
    }

    @Test
    void delete_otherOwner_notFound() {
        when(studyFolderRepository.findByIdAndOwnerUserId(8L, 2L)).thenReturn(Optional.empty());
        assertThrows(NoSuchElementException.class, () -> studyFolderService.delete(8L, 2L));
    }

    @Test
    void tree_ownerIsolationAndRootSubjects() {
        StudyFolder root = folder(1L, 1L, null, "A");
        StudyFolder child = folder(2L, 1L, 1L, "B");
        Subject inFolder = subject(20L, 1L, 1L, "In folder");
        Subject rootSubject = subject(21L, 1L, null, "Root subject");

        when(studyFolderRepository.findByOwnerUserIdAndDeletedAtIsNullOrderByNameAscIdAsc(1L))
                .thenReturn(List.of(root, child));
        when(subjectRepository.findByOwnerUserIdAndArchivedAtIsNullOrderByNameAscIdAsc(1L))
                .thenReturn(List.of(inFolder, rootSubject));
        when(meetingRepository.countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(20L, 1L)).thenReturn(2L);
        when(meetingRepository.countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(21L, 1L)).thenReturn(0L);

        StudyFolderTreeResponse tree = studyFolderService.tree(1L);

        assertEquals(1, tree.folders().size());
        assertEquals("A", tree.folders().getFirst().name());
        assertEquals(1, tree.folders().getFirst().children().size());
        assertEquals(1, tree.folders().getFirst().subjects().size());
        assertEquals("Root subject", tree.rootSubjects().getFirst().name());
        assertEquals(2L, tree.folders().getFirst().subjects().getFirst().meetingCount());
    }

    @Test
    void get_otherOwner_notFound() {
        when(studyFolderRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(1L, 2L))
                .thenReturn(Optional.empty());
        assertThrows(NoSuchElementException.class, () -> studyFolderService.get(1L, 2L));
    }

    private static StudyFolder folder(Long id, Long ownerId, Long parentId, String name) {
        StudyFolder folder = new StudyFolder();
        folder.setId(id);
        folder.setOwnerUserId(ownerId);
        folder.setParentFolderId(parentId);
        folder.setName(name);
        folder.setCreatedAt(LocalDateTime.now());
        folder.setUpdatedAt(LocalDateTime.now());
        return folder;
    }

    private static Subject subject(Long id, Long ownerId, Long folderId, String name) {
        Subject subject = new Subject();
        subject.setId(id);
        subject.setOwnerUserId(ownerId);
        subject.setFolderId(folderId);
        subject.setName(name);
        subject.setCreatedAt(LocalDateTime.now());
        subject.setUpdatedAt(LocalDateTime.now());
        return subject;
    }
}
