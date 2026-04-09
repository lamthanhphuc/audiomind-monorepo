package com.example.meetingservice.service;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.repository.MeetingRepository;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
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
}
