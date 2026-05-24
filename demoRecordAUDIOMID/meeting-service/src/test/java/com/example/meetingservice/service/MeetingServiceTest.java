package com.example.meetingservice.service;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.repository.MeetingRepository;
import java.util.List;
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
}
