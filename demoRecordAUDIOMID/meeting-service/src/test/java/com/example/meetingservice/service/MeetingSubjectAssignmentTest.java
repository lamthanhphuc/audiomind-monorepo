package com.example.meetingservice.service;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.entity.Subject;
import com.example.meetingservice.repository.MeetingRepository;
import com.example.meetingservice.repository.MeetingShareRepository;
import com.example.meetingservice.repository.SubjectRepository;
import java.time.LocalDateTime;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

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

@ExtendWith(MockitoExtension.class)
class MeetingSubjectAssignmentTest {

    @Mock
    private MeetingRepository meetingRepository;

    @Mock
    private MeetingShareRepository meetingShareRepository;

    @Mock
    private SubjectRepository subjectRepository;

    @InjectMocks
    private MeetingService meetingService;

    @Test
    void assignSubject_assignsUnclassifiedMeetingToActiveSubject() {
        Meeting meeting = ownedMeeting(10L, null);
        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 9L))
                .thenReturn(Optional.of(meeting));
        when(subjectRepository.findByIdAndOwnerUserId(12L, 9L)).thenReturn(Optional.of(activeSubject(12L, 9L)));
        when(meetingRepository.save(any(Meeting.class))).thenAnswer(invocation -> invocation.getArgument(0));

        Meeting result = meetingService.assignSubject(10L, 9L, 12L);

        assertEquals(12L, result.getSubjectId());
        verify(meetingRepository).save(meeting);
    }

    @Test
    void assignSubject_movesSubjectAToB() {
        Meeting meeting = ownedMeeting(10L, 11L);
        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 9L))
                .thenReturn(Optional.of(meeting));
        when(subjectRepository.findByIdAndOwnerUserId(12L, 9L)).thenReturn(Optional.of(activeSubject(12L, 9L)));
        when(meetingRepository.save(any(Meeting.class))).thenAnswer(invocation -> invocation.getArgument(0));

        Meeting result = meetingService.assignSubject(10L, 9L, 12L);

        assertEquals(12L, result.getSubjectId());
    }

    @Test
    void assignSubject_clearSubjectToUnclassified() {
        Meeting meeting = ownedMeeting(10L, 11L);
        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 9L))
                .thenReturn(Optional.of(meeting));
        when(meetingRepository.save(any(Meeting.class))).thenAnswer(invocation -> invocation.getArgument(0));

        Meeting result = meetingService.assignSubject(10L, 9L, null);

        assertNull(result.getSubjectId());
        verify(subjectRepository, never()).findByIdAndOwnerUserId(any(), any());
    }

    @Test
    void assignSubject_sameSubjectIsIdempotentWithoutSave() {
        Meeting meeting = ownedMeeting(10L, 12L);
        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 9L))
                .thenReturn(Optional.of(meeting));
        when(subjectRepository.findByIdAndOwnerUserId(12L, 9L)).thenReturn(Optional.of(activeSubject(12L, 9L)));

        Meeting result = meetingService.assignSubject(10L, 9L, 12L);

        assertEquals(12L, result.getSubjectId());
        verify(meetingRepository, never()).save(any());
    }

    @Test
    void assignSubject_clearAlreadyNullIsIdempotent() {
        Meeting meeting = ownedMeeting(10L, null);
        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 9L))
                .thenReturn(Optional.of(meeting));

        Meeting result = meetingService.assignSubject(10L, 9L, null);

        assertNull(result.getSubjectId());
        verify(meetingRepository, never()).save(any());
    }

    @Test
    void assignSubject_otherUsersMeeting_returnsNotFound() {
        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 9L))
                .thenReturn(Optional.empty());

        assertThrows(NoSuchElementException.class, () -> meetingService.assignSubject(10L, 9L, 12L));
        verify(meetingRepository, never()).save(any());
    }

    @Test
    void assignSubject_sharedMeetingNotMutatedViaOwnerLookup() {
        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 9L))
                .thenReturn(Optional.empty());

        assertThrows(NoSuchElementException.class, () -> meetingService.assignSubject(10L, 9L, 12L));
        verify(meetingShareRepository, never()).existsByMeetingIdAndSharedWithUserId(any(), any());
        verify(meetingRepository, never()).save(any());
    }

    @Test
    void assignSubject_otherUsersSubject_returnsNotFound() {
        Meeting meeting = ownedMeeting(10L, null);
        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 9L))
                .thenReturn(Optional.of(meeting));
        when(subjectRepository.findByIdAndOwnerUserId(12L, 9L)).thenReturn(Optional.empty());

        assertThrows(NoSuchElementException.class, () -> meetingService.assignSubject(10L, 9L, 12L));
        verify(meetingRepository, never()).save(any());
    }

    @Test
    void assignSubject_archivedSubject_conflicts() {
        Meeting meeting = ownedMeeting(10L, null);
        Subject archived = activeSubject(12L, 9L);
        archived.setArchivedAt(LocalDateTime.now());
        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 9L))
                .thenReturn(Optional.of(meeting));
        when(subjectRepository.findByIdAndOwnerUserId(12L, 9L)).thenReturn(Optional.of(archived));

        ResponseStatusException ex =
                assertThrows(ResponseStatusException.class, () -> meetingService.assignSubject(10L, 9L, 12L));
        assertEquals(HttpStatus.CONFLICT, ex.getStatusCode());
        verify(meetingRepository, never()).save(any());
    }

    @Test
    void assignSubject_softDeletedMeeting_notFound() {
        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 9L))
                .thenReturn(Optional.empty());

        assertThrows(NoSuchElementException.class, () -> meetingService.assignSubject(10L, 9L, 12L));
    }

    @Test
    void saveMeeting_withSubjectPersistsSubjectId() {
        when(subjectRepository.findByIdAndOwnerUserId(12L, 9L)).thenReturn(Optional.of(activeSubject(12L, 9L)));
        when(meetingRepository.save(any(Meeting.class))).thenAnswer(invocation -> invocation.getArgument(0));

        Meeting result = meetingService.saveMeeting(
                "title", "/a.wav", 9L, "a.wav", "vi", "hash", 3L, MeetingService.MEETING_STATUS_PROCESSING, 12L);

        assertEquals(12L, result.getSubjectId());
    }

    @Test
    void saveMeeting_withoutSubjectLeavesNull() {
        when(meetingRepository.save(any(Meeting.class))).thenAnswer(invocation -> invocation.getArgument(0));

        Meeting result = meetingService.saveMeeting(
                "title", "/a.wav", 9L, "a.wav", "vi", "hash", 3L, MeetingService.MEETING_STATUS_PROCESSING, null);

        assertNull(result.getSubjectId());
        verify(subjectRepository, never()).findByIdAndOwnerUserId(any(), any());
    }

    @Test
    void saveMeeting_otherUsersSubjectRejectedBeforePersist() {
        when(subjectRepository.findByIdAndOwnerUserId(12L, 9L)).thenReturn(Optional.empty());

        assertThrows(
                NoSuchElementException.class,
                () -> meetingService.saveMeeting(
                        "title",
                        "/a.wav",
                        9L,
                        "a.wav",
                        "vi",
                        "hash",
                        3L,
                        MeetingService.MEETING_STATUS_PROCESSING,
                        12L));
        verify(meetingRepository, never()).save(any());
    }

    @Test
    void saveMeeting_archivedSubjectRejectedBeforePersist() {
        Subject archived = activeSubject(12L, 9L);
        archived.setArchivedAt(LocalDateTime.now());
        when(subjectRepository.findByIdAndOwnerUserId(12L, 9L)).thenReturn(Optional.of(archived));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> meetingService.saveMeeting(
                        "title",
                        "/a.wav",
                        9L,
                        "a.wav",
                        "vi",
                        "hash",
                        3L,
                        MeetingService.MEETING_STATUS_PROCESSING,
                        12L));
        assertEquals(HttpStatus.CONFLICT, ex.getStatusCode());
        verify(meetingRepository, never()).save(any());
    }

    @Test
    void findUnclassifiedForOwnerPage_queriesOwnedNullSubjectOnly() {
        Meeting meeting = ownedMeeting(1L, null);
        when(meetingRepository.findUnclassifiedForOwner(eq(9L), isNull(), any(Pageable.class)))
                .thenReturn(new PageImpl<>(List.of(meeting)));

        MeetingPageResult page = meetingService.findUnclassifiedForOwnerPage(9L, null, null, 1, 20);

        assertEquals(1, page.items().size());
        assertEquals(1, page.page());
        assertEquals(20, page.pageSize());
        assertNull(page.items().getFirst().getSubjectId());

        ArgumentCaptor<Pageable> pageableCaptor = ArgumentCaptor.forClass(Pageable.class);
        verify(meetingRepository).findUnclassifiedForOwner(eq(9L), isNull(), pageableCaptor.capture());
        assertEquals(0, pageableCaptor.getValue().getPageNumber());
        assertEquals(20, pageableCaptor.getValue().getPageSize());
    }

    @Test
    void findUnclassifiedForOwnerPage_unknownSort_validationError() {
        IllegalArgumentException ex = assertThrows(
                IllegalArgumentException.class,
                () -> meetingService.findUnclassifiedForOwnerPage(9L, null, "updatedAt_desc", 1, 20));
        assertTrue(ex.getMessage().contains("Unsupported sort"));
        verify(meetingRepository, never()).findUnclassifiedForOwner(any(), any(), any());
    }

    @Test
    void findUnclassifiedForOwnerPage_emptyShapeUsesDefaults() {
        when(meetingRepository.findUnclassifiedForOwner(eq(9L), isNull(), any(Pageable.class)))
                .thenReturn(new PageImpl<>(List.of()));

        MeetingPageResult page = meetingService.findUnclassifiedForOwnerPage(9L, null, null, null, null);

        assertEquals(0, page.total());
        assertEquals(1, page.page());
        assertEquals(10, page.pageSize());
        assertEquals(0, page.totalPages());
        assertTrue(page.items().isEmpty());
    }

    private static Meeting ownedMeeting(Long id, Long subjectId) {
        Meeting meeting = new Meeting();
        meeting.setId(id);
        meeting.setOwnerUserId(9L);
        meeting.setTitle("Meeting " + id);
        meeting.setSubjectId(subjectId);
        meeting.setStatus(MeetingService.MEETING_STATUS_PROCESSING);
        meeting.setCreatedAt(LocalDateTime.now());
        return meeting;
    }

    private static Subject activeSubject(Long id, Long ownerUserId) {
        Subject subject = new Subject();
        subject.setId(id);
        subject.setOwnerUserId(ownerUserId);
        subject.setName("SWP391");
        subject.setArchivedAt(null);
        return subject;
    }
}
