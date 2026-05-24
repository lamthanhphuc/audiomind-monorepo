package com.example.meetingservice.controller;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.MeetingService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.core.Authentication;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
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

        Meeting meeting = new Meeting();
        meeting.setId(10L);
        when(meetingService.saveMeeting(eq("sample"), org.mockito.ArgumentMatchers.anyString(), eq(9L), eq("sample.wav"), eq("en")))
                .thenReturn(meeting);

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[]{1, 2, 3});
        controller.upload("sample", file, "en", authentication);

        verify(meetingService).saveMeeting(eq("sample"), org.mockito.ArgumentMatchers.anyString(), eq(9L), eq("sample.wav"), eq("en"));
    }

    @Test
    void upload_shouldFallbackToViForInvalidLanguage() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = new MeetingController(meetingService);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(9L, "user"));

        Meeting meeting = new Meeting();
        meeting.setLanguage("vi");
        when(meetingService.saveMeeting(eq("sample"), org.mockito.ArgumentMatchers.anyString(), eq(9L), eq("sample.wav"), eq("vi")))
                .thenReturn(meeting);

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[]{1, 2, 3});
        Meeting result = controller.upload("sample", file, "fr", authentication);

        assertEquals("vi", result.getLanguage());
        verify(meetingService).saveMeeting(eq("sample"), org.mockito.ArgumentMatchers.anyString(), eq(9L), eq("sample.wav"), eq("vi"));
    }
}
