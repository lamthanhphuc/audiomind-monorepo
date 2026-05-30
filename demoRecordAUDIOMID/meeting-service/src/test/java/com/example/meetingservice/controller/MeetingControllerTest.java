package com.example.meetingservice.controller;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.MeetingService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.core.Authentication;

import java.nio.file.Path;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class MeetingControllerTest {

    @TempDir
    Path tempDir;

    @Test
    void upload_shouldForwardAcceptedLanguage() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = new MeetingController(meetingService);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(9L, "user"));
        when(meetingService.findActiveDuplicateForOwner(eq(9L), anyString())).thenReturn(Optional.empty());
        when(meetingService.normalizeMeetingStatus(anyString())).thenAnswer((invocation) -> invocation.getArgument(0));

        Meeting meeting = new Meeting();
        meeting.setId(10L);
        meeting.setLanguage("en");
        when(meetingService.saveMeeting(eq("sample"), anyString(), eq(9L), eq("sample.wav"), eq("en"), anyString(), eq(3L), eq(MeetingService.MEETING_STATUS_PROCESSING)))
                .thenReturn(meeting);

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[]{1, 2, 3});
        controller.upload("sample", file, "en", authentication);

        verify(meetingService).saveMeeting(eq("sample"), anyString(), eq(9L), eq("sample.wav"), eq("en"), anyString(), eq(3L), eq(MeetingService.MEETING_STATUS_PROCESSING));
    }

    @Test
    void upload_shouldFallbackToViForInvalidLanguage() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = new MeetingController(meetingService);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(9L, "user"));
        when(meetingService.findActiveDuplicateForOwner(eq(9L), anyString())).thenReturn(Optional.empty());
        when(meetingService.normalizeMeetingStatus(anyString())).thenAnswer((invocation) -> invocation.getArgument(0));

        Meeting meeting = new Meeting();
        meeting.setLanguage("vi");
        when(meetingService.saveMeeting(eq("sample"), anyString(), eq(9L), eq("sample.wav"), eq("vi"), anyString(), eq(3L), eq(MeetingService.MEETING_STATUS_PROCESSING)))
                .thenReturn(meeting);

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[]{1, 2, 3});
        Map<String, Object> result = controller.upload("sample", file, "fr", authentication);

        assertEquals("vi", result.get("language"));
        verify(meetingService).saveMeeting(eq("sample"), anyString(), eq(9L), eq("sample.wav"), eq("vi"), anyString(), eq(3L), eq(MeetingService.MEETING_STATUS_PROCESSING));
    }

    @Test
    void upload_shouldReuseExistingMeetingWhenDuplicateDetected() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = new MeetingController(meetingService);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(9L, "user"));
        when(meetingService.normalizeMeetingStatus(anyString())).thenAnswer((invocation) -> invocation.getArgument(0));

        Meeting existing = new Meeting();
        existing.setId(77L);
        existing.setTitle("existing");
        existing.setAudioPath("/tmp/existing.wav");
        existing.setLanguage("vi");
        existing.setStatus(MeetingService.MEETING_STATUS_COMPLETED);

        when(meetingService.findActiveDuplicateForOwner(eq(9L), anyString()))
                .thenReturn(Optional.of(new MeetingService.DuplicateMatch(existing, true, MeetingService.MEETING_STATUS_COMPLETED)));

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[]{1, 2, 3});
        Map<String, Object> result = controller.upload("sample", file, "vi", authentication);

        assertEquals(true, result.get("duplicate"));
        assertEquals(true, result.get("reused"));
        assertEquals(77L, result.get("existingMeetingId"));
        assertEquals("completed", result.get("status"));
        assertTrue(result.containsKey("id"));
        verify(meetingService, never()).saveMeeting(anyString(), anyString(), anyLong(), anyString(), anyString(), anyString(), anyLong(), anyString());
    }
}
