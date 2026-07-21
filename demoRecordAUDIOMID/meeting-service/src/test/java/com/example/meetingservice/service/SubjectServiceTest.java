package com.example.meetingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.meetingservice.controller.dto.CreateSubjectRequest;
import com.example.meetingservice.controller.dto.PageResponse;
import com.example.meetingservice.controller.dto.SubjectMeetingResponse;
import com.example.meetingservice.controller.dto.SubjectResponse;
import com.example.meetingservice.entity.Meeting;
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
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

@ExtendWith(MockitoExtension.class)
class SubjectServiceTest {

    @Mock
    private SubjectRepository subjectRepository;

    @Mock
    private StudyFolderRepository studyFolderRepository;

    @Mock
    private MeetingRepository meetingRepository;

    @InjectMocks
    private SubjectService subjectService;

    @Test
    void createRootSubject_succeeds() {
        when(subjectRepository.existsActiveDuplicateName(1L, "SWP391", null)).thenReturn(false);
        when(subjectRepository.save(any(Subject.class))).thenAnswer(invocation -> {
            Subject subject = invocation.getArgument(0);
            subject.setId(50L);
            return subject;
        });

        SubjectResponse response = subjectService.create(
                1L, new CreateSubjectRequest("  SWP391  ", "  code  ", "  Fall  ", "  desc  ", " blue ", null));

        assertEquals(50L, response.id());
        assertEquals("SWP391", response.name());
        assertEquals("code", response.code());
        assertEquals("Fall", response.semester());
        assertEquals("desc", response.description());
        assertEquals("blue", response.color());
        assertNull(response.folderId());
    }

    @Test
    void create_inFolderOwnedByOther_notFound() {
        when(studyFolderRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(9L, 1L))
                .thenReturn(Optional.empty());

        assertThrows(
                NoSuchElementException.class,
                () -> subjectService.create(
                        1L, new CreateSubjectRequest("SWP391", null, null, null, null, 9L)));
    }

    @Test
    void create_duplicateNormalizedName_conflicts() {
        when(subjectRepository.existsActiveDuplicateName(1L, "swp391", null)).thenReturn(true);

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> subjectService.create(
                        1L, new CreateSubjectRequest("  swp391  ", null, null, null, null, null)));
        assertEquals(HttpStatus.CONFLICT, ex.getStatusCode());
    }

    @Test
    void update_archivedSubject_conflicts() {
        Subject subject = subject(3L, 1L, null, "SWP391");
        subject.setArchivedAt(LocalDateTime.now());
        when(subjectRepository.findByIdAndOwnerUserId(3L, 1L)).thenReturn(Optional.of(subject));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> subjectService.update(3L, 1L, Map.of("name", "New")));
        assertEquals(HttpStatus.CONFLICT, ex.getStatusCode());
    }

    @Test
    void update_moveFolder_andNoOpIdempotent() {
        Subject subject = subject(3L, 1L, null, "SWP391");
        when(subjectRepository.findByIdAndOwnerUserId(3L, 1L)).thenReturn(Optional.of(subject));
        when(studyFolderRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(7L, 1L))
                .thenReturn(Optional.of(folder(7L, 1L)));
        when(subjectRepository.existsActiveDuplicateName(1L, "SWP391", 3L)).thenReturn(false);
        when(subjectRepository.save(any(Subject.class))).thenAnswer(invocation -> invocation.getArgument(0));
        when(meetingRepository.countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(3L, 1L)).thenReturn(4L);

        SubjectResponse moved = subjectService.update(3L, 1L, Map.of("folderId", 7));
        assertEquals(7L, moved.folderId());
        assertEquals(4L, moved.meetingCount());

        SubjectResponse noOp = subjectService.update(3L, 1L, Map.of());
        assertEquals(7L, noOp.folderId());
    }

    @Test
    void archive_unassignsOwnedMeetingsAndIsIdempotent() {
        Subject subject = subject(3L, 1L, null, "SWP391");
        when(subjectRepository.findByIdAndOwnerUserId(3L, 1L)).thenReturn(Optional.of(subject));
        when(subjectRepository.save(any(Subject.class))).thenAnswer(invocation -> invocation.getArgument(0));

        SubjectResponse archived = subjectService.archive(3L, 1L);
        verify(meetingRepository, times(1)).clearSubjectAssignmentsForOwner(3L, 1L);
        assertTrue(archived.archivedAt() != null);
        assertEquals(0L, archived.meetingCount());

        when(meetingRepository.countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(3L, 1L)).thenReturn(0L);
        SubjectResponse again = subjectService.archive(3L, 1L);
        verify(meetingRepository, times(1)).clearSubjectAssignmentsForOwner(3L, 1L);
        assertEquals(archived.archivedAt(), again.archivedAt());
    }

    @Test
    void list_defaultHidesArchived_andUnknownSortIsValidationError() {
        Subject active = subject(1L, 1L, null, "Active");
        when(subjectRepository.findByOwnerUserIdAndArchivedAtIsNullOrderByNameAscIdAsc(1L))
                .thenReturn(List.of(active));
        when(meetingRepository.countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(1L, 1L)).thenReturn(1L);

        PageResponse<SubjectResponse> page =
                subjectService.list(1L, null, null, false, 1, 10, "name_asc");
        assertEquals(1, page.items().size());

        IllegalArgumentException ex = assertThrows(
                IllegalArgumentException.class,
                () -> subjectService.list(1L, null, null, false, 1, 10, "hack;drop"));
        assertTrue(ex.getMessage().contains("Unsupported sort"));
    }

    @Test
    void list_archivedTrue_returnsArchivedOnly() {
        Subject archived = subject(2L, 1L, null, "Old");
        archived.setArchivedAt(LocalDateTime.now());
        when(subjectRepository.findByOwnerUserIdAndArchivedAtIsNotNullOrderByNameAscIdAsc(1L))
                .thenReturn(List.of(archived));
        when(meetingRepository.countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(2L, 1L)).thenReturn(0L);

        PageResponse<SubjectResponse> page =
                subjectService.list(1L, null, null, true, 1, 10, null);
        assertEquals(1, page.items().size());
        assertEquals("Old", page.items().getFirst().name());
    }

    @Test
    void get_otherOwner_notFound() {
        when(subjectRepository.findByIdAndOwnerUserId(3L, 2L)).thenReturn(Optional.empty());
        assertThrows(NoSuchElementException.class, () -> subjectService.get(3L, 2L));
    }

    @Test
    void listMeetings_ownerScopedPagination() {
        Subject subject = subject(3L, 1L, null, "SWP391");
        Meeting meeting = new Meeting();
        meeting.setId(100L);
        meeting.setTitle("Lecture 1");
        meeting.setOwnerUserId(1L);
        meeting.setSubjectId(3L);
        meeting.setStatus("completed");
        meeting.setCreatedAt(LocalDateTime.now());

        when(subjectRepository.findByIdAndOwnerUserId(3L, 1L)).thenReturn(Optional.of(subject));
        when(meetingRepository.findBySubjectIdAndOwnerUserIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(
                        eq(3L), eq(1L), any(PageRequest.class)))
                .thenReturn(new PageImpl<>(List.of(meeting), PageRequest.of(0, 10), 1));

        PageResponse<SubjectMeetingResponse> page = subjectService.listMeetings(3L, 1L, 1, 10);
        assertEquals(1, page.items().size());
        assertEquals(100L, page.items().getFirst().id());
        assertEquals(3L, page.items().getFirst().subjectId());
    }

    @Test
    void blankOptionalFieldsNormalizeToNull_butBlankNameFails() {
        assertThrows(
                IllegalArgumentException.class,
                () -> subjectService.create(1L, new CreateSubjectRequest("   ", null, null, null, null, null)));

        when(subjectRepository.existsActiveDuplicateName(1L, "OK", null)).thenReturn(false);
        when(subjectRepository.save(any(Subject.class))).thenAnswer(invocation -> {
            Subject subject = invocation.getArgument(0);
            subject.setId(9L);
            assertNull(subject.getCode());
            assertNull(subject.getSemester());
            assertNull(subject.getDescription());
            assertNull(subject.getColor());
            return subject;
        });

        subjectService.create(1L, new CreateSubjectRequest("OK", "  ", " ", "\t", "", null));
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

    private static StudyFolder folder(Long id, Long ownerId) {
        StudyFolder folder = new StudyFolder();
        folder.setId(id);
        folder.setOwnerUserId(ownerId);
        folder.setName("Folder");
        folder.setCreatedAt(LocalDateTime.now());
        folder.setUpdatedAt(LocalDateTime.now());
        return folder;
    }
}
