package com.example.meetingservice.service;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.repository.MeetingRepository;
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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class MeetingServiceTest {

    @Mock
    private MeetingRepository meetingRepository;

    @InjectMocks
    private MeetingService meetingService;

    @Test
    void saveMeeting_shouldPersistTitleAndAudioPath() {
        Meeting saved = new Meeting();
        saved.setId(10L);
        saved.setTitle("Team sync");
        saved.setAudioPath("uploads/a.wav");

        when(meetingRepository.save(any(Meeting.class))).thenReturn(saved);

        Meeting result = meetingService.saveMeeting("Team sync", "uploads/a.wav");

        assertEquals(10L, result.getId());
        assertEquals("Team sync", result.getTitle());
        assertEquals("uploads/a.wav", result.getAudioPath());
        ArgumentCaptor<Meeting> captor = ArgumentCaptor.forClass(Meeting.class);
        verify(meetingRepository).save(captor.capture());
        assertEquals("vi", captor.getValue().getLanguage());
        assertTrue(result.getCreatedAt() != null || saved.getCreatedAt() == null);
    }

    @Test
    void findById_shouldThrowWhenMissing() {
        when(meetingRepository.findById(99L)).thenReturn(Optional.empty());

        assertThrows(java.util.NoSuchElementException.class, () -> meetingService.findById(99L));
    }

    @Test
    void findRecentMeetings_shouldReturnTopList() {
        Meeting m = new Meeting();
        m.setId(1L);
        when(meetingRepository.findTop20ByOrderByIdDesc()).thenReturn(List.of(m));

        List<Meeting> result = meetingService.findRecentMeetings();
        assertEquals(1, result.size());
        assertEquals(1L, result.getFirst().getId());
    }

    @Test
    void findById_shouldReturnMeetingWhenPresent() {
        Meeting found = new Meeting();
        found.setId(42L);
        found.setTitle("Demo meeting");

        when(meetingRepository.findById(42L)).thenReturn(Optional.of(found));

        Meeting result = meetingService.findById(42L);

        assertEquals(42L, result.getId());
        assertEquals("Demo meeting", result.getTitle());
    }

    @Test
    void saveMeeting_shouldSetCreatedAtBeforePersist() {
        Meeting saved = new Meeting();
        saved.setId(11L);

        when(meetingRepository.save(any(Meeting.class))).thenReturn(saved);

        meetingService.saveMeeting("Planning", "uploads/p.wav");

        ArgumentCaptor<Meeting> captor = ArgumentCaptor.forClass(Meeting.class);
        verify(meetingRepository).save(captor.capture());

        Meeting persisted = captor.getValue();
        assertEquals("Planning", persisted.getTitle());
        assertEquals("uploads/p.wav", persisted.getAudioPath());
        assertEquals("vi", persisted.getLanguage());
        assertTrue(persisted.getCreatedAt() != null);
    }

    @Test
    void findRecentMeetings_shouldPreserveRepositoryOrder() {
        Meeting first = new Meeting();
        first.setId(5L);
        Meeting second = new Meeting();
        second.setId(4L);

        when(meetingRepository.findTop20ByOrderByIdDesc()).thenReturn(List.of(first, second));

        List<Meeting> result = meetingService.findRecentMeetings();

        assertEquals(2, result.size());
        assertEquals(5L, result.get(0).getId());
        assertEquals(4L, result.get(1).getId());
    }

    @Test
    void findActiveDuplicateForOwner_shouldReturnReusedWhenCompleted() {
        Meeting duplicate = new Meeting();
        duplicate.setId(22L);
        duplicate.setStatus("completed");

        when(meetingRepository.findFirstByOwnerUserIdAndAudioHashAndDeletedAtIsNullOrderByIdDesc(9L, "abc"))
                .thenReturn(Optional.of(duplicate));

        MeetingService.DuplicateMatch result = meetingService.findActiveDuplicateForOwner(9L, "abc").orElseThrow();

        assertEquals(22L, result.meeting().getId());
        assertEquals("completed", result.status());
        assertTrue(result.reused());
    }

    @Test
    void findActiveDuplicateForOwner_shouldReturnProcessingWhenStatusUncertain() {
        Meeting duplicate = new Meeting();
        duplicate.setId(23L);
        duplicate.setStatus(null);

        when(meetingRepository.findFirstByOwnerUserIdAndAudioHashAndDeletedAtIsNullOrderByIdDesc(9L, "hash"))
                .thenReturn(Optional.of(duplicate));

        MeetingService.DuplicateMatch result = meetingService.findActiveDuplicateForOwner(9L, "hash").orElseThrow();

        assertEquals("processing", result.status());
        assertTrue(!result.reused());
    }

    @Test
    void findActiveDuplicateForOwner_shouldReturnFailedWithoutReuse() {
        Meeting duplicate = new Meeting();
        duplicate.setId(24L);
        duplicate.setStatus("FAILED");

        when(meetingRepository.findFirstByOwnerUserIdAndAudioHashAndDeletedAtIsNullOrderByIdDesc(9L, "xyz"))
                .thenReturn(Optional.of(duplicate));

        MeetingService.DuplicateMatch result = meetingService.findActiveDuplicateForOwner(9L, "xyz").orElseThrow();

        assertEquals("failed", result.status());
        assertTrue(!result.reused());
    }

    @Test
    void renameMeetingForOwner_shouldUpdateTitle() {
        Meeting meeting = new Meeting();
        meeting.setId(30L);
        meeting.setTitle("old");

        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(30L, 5L)).thenReturn(Optional.of(meeting));
        when(meetingRepository.save(any(Meeting.class))).thenAnswer((invocation) -> invocation.getArgument(0));

        Meeting result = meetingService.renameMeetingForOwner(30L, 5L, "new title");

        assertEquals("new title", result.getTitle());
        verify(meetingRepository).save(meeting);
    }

    @Test
    void softDeleteForOwner_shouldSetDeletedAt() {
        Meeting meeting = new Meeting();
        meeting.setId(31L);

        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(31L, 5L)).thenReturn(Optional.of(meeting));
        when(meetingRepository.save(any(Meeting.class))).thenAnswer((invocation) -> invocation.getArgument(0));

        Meeting deleted = meetingService.softDeleteForOwner(31L, 5L);

        assertEquals(31L, deleted.getId());
        assertTrue(deleted.getDeletedAt() != null);
    }

    @Test
    void findMeetingsForOwner_shouldHideDeletedAndApplySortAndFilters() {
        Meeting processing = new Meeting();
        processing.setId(1L);
        processing.setTitle("Planning");
        processing.setOriginalFileName("meeting-a.wav");
        processing.setLanguage("vi");
        processing.setStatus("processing");
        processing.setCreatedAt(LocalDateTime.now().minusDays(2));

        Meeting completed = new Meeting();
        completed.setId(2L);
        completed.setTitle("Retrospective");
        completed.setOriginalFileName("meeting-b.wav");
        completed.setLanguage("en");
        completed.setStatus("completed");
        completed.setCreatedAt(LocalDateTime.now().minusDays(1));

        when(meetingRepository.findByOwnerUserIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(8L))
                .thenReturn(List.of(completed, processing));

        List<Meeting> filtered = meetingService.findMeetingsForOwner(8L, "retro", "completed", "en", "created_desc");

        assertEquals(1, filtered.size());
        assertEquals(2L, filtered.getFirst().getId());
    }

    @Test
    void ownerScopedOperations_shouldRejectAnotherUser() {
        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(40L, 1L)).thenReturn(Optional.empty());

        assertThrows(NoSuchElementException.class, () -> meetingService.findByIdForOwner(40L, 1L));
        assertThrows(NoSuchElementException.class, () -> meetingService.renameMeetingForOwner(40L, 1L, "x"));
        assertThrows(NoSuchElementException.class, () -> meetingService.softDeleteForOwner(40L, 1L));
        assertThrows(NoSuchElementException.class, () -> meetingService.updateMeetingStatusForOwner(40L, 1L, "completed"));
    }

    @Test
    void updateMeetingStatusForOwner_shouldNormalizeIncomingStatus() {
        Meeting meeting = new Meeting();
        meeting.setId(50L);
        meeting.setStatus("processing");

        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(50L, 2L)).thenReturn(Optional.of(meeting));
        when(meetingRepository.save(any(Meeting.class))).thenAnswer((invocation) -> invocation.getArgument(0));

        Meeting updated = meetingService.updateMeetingStatusForOwner(50L, 2L, "COMPLETED");

        assertEquals("completed", updated.getStatus());
    }
}
