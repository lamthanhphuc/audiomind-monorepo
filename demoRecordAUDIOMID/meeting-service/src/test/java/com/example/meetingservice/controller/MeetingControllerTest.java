package com.example.meetingservice.controller;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.controller.dto.CreateScheduledMeetingRequest;
import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.config.Epic2FeatureFlags;
import com.example.meetingservice.config.UploadValidationPolicy;
import com.example.meetingservice.service.MeetingService;
import com.example.meetingservice.service.MimeSniffRequestCache;
import com.example.meetingservice.service.MimeSniffer;
import com.example.meetingservice.service.NoOpScanner;
import com.example.meetingservice.service.ScanCircuitBreaker;
import com.example.meetingservice.service.UploadValidator;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.core.Authentication;
import org.springframework.http.ResponseEntity;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.Files;
import java.util.Map;
import java.util.Optional;
import java.time.OffsetDateTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
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

    private MeetingController newController(MeetingService meetingService) {
        UploadValidationPolicy policy = new UploadValidationPolicy(new com.fasterxml.jackson.databind.ObjectMapper());
        Epic2FeatureFlags flags = mock(Epic2FeatureFlags.class);
        when(flags.isMimeSniffEnabled()).thenReturn(false);
        when(flags.isUploadValidationStrict()).thenReturn(false);
        UploadValidator uploadValidator = new UploadValidator(
                policy,
                flags,
                new MimeSniffer(policy, new MimeSniffRequestCache()),
                new NoOpScanner(),
                new ScanCircuitBreaker()
        );
        return new MeetingController(meetingService, uploadValidator);
    }

    @Test
    void createScheduledMeetingUsesAuthenticatedOwner() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(9L, "user", "USER", "FREE"));
        OffsetDateTime start = OffsetDateTime.now().plusHours(2);
        OffsetDateTime end = start.plusHours(1);
        Meeting saved = new Meeting();
        saved.setId(91L);
        saved.setStatus(MeetingService.MEETING_STATUS_SCHEDULED);
        when(meetingService.saveScheduledMeeting(
                "Future sync", 9L, "vi", start, end, "Asia/Ho_Chi_Minh"))
                .thenReturn(saved);

        Meeting result = controller.createScheduledMeeting(
                new CreateScheduledMeetingRequest(
                        "Future sync", start.toString(), end.toString(), "Asia/Ho_Chi_Minh", "vi"),
                authentication);

        assertEquals(91L, result.getId());
        verify(meetingService).saveScheduledMeeting(
                "Future sync", 9L, "vi", start, end, "Asia/Ho_Chi_Minh");
    }

    @Test
    void upload_shouldForwardAcceptedLanguage() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(9L, "user", "USER", "FREE"));
        when(meetingService.findActiveDuplicateForOwner(eq(9L), anyString())).thenReturn(Optional.empty());
        when(meetingService.normalizeMeetingStatus(anyString())).thenAnswer((invocation) -> invocation.getArgument(0));

        Meeting meeting = new Meeting();
        meeting.setId(10L);
        meeting.setLanguage("en");
        when(meetingService.saveMeeting(eq("sample"), anyString(), eq(9L), eq("sample.wav"), eq("en"), anyString(), eq(3L), eq(MeetingService.MEETING_STATUS_PROCESSING), eq(null)))
                .thenReturn(meeting);

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[]{1, 2, 3});
        controller.upload("sample", file, "en", null, authentication);

        verify(meetingService).saveMeeting(eq("sample"), anyString(), eq(9L), eq("sample.wav"), eq("en"), anyString(), eq(3L), eq(MeetingService.MEETING_STATUS_PROCESSING), eq(null));
    }

    @Test
    void upload_shouldFallbackToViForInvalidLanguage() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(9L, "user", "USER", "FREE"));
        when(meetingService.findActiveDuplicateForOwner(eq(9L), anyString())).thenReturn(Optional.empty());
        when(meetingService.normalizeMeetingStatus(anyString())).thenAnswer((invocation) -> invocation.getArgument(0));

        Meeting meeting = new Meeting();
        meeting.setLanguage("vi");
        when(meetingService.saveMeeting(eq("sample"), anyString(), eq(9L), eq("sample.wav"), eq("vi"), anyString(), eq(3L), eq(MeetingService.MEETING_STATUS_PROCESSING), eq(null)))
                .thenReturn(meeting);

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[]{1, 2, 3});
        Map<String, Object> result = controller.upload("sample", file, "fr", null, authentication);

        assertEquals("vi", result.get("language"));
        verify(meetingService).saveMeeting(eq("sample"), anyString(), eq(9L), eq("sample.wav"), eq("vi"), anyString(), eq(3L), eq(MeetingService.MEETING_STATUS_PROCESSING), eq(null));
    }

    @Test
    void upload_shouldReuseExistingMeetingWhenDuplicateDetected() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(9L, "user", "USER", "FREE"));
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
        Map<String, Object> result = controller.upload("sample", file, "vi", null, authentication);

        assertEquals(true, result.get("duplicate"));
        assertEquals(true, result.get("reused"));
        assertEquals(77L, result.get("existingMeetingId"));
        assertEquals("completed", result.get("status"));
        assertTrue(result.containsKey("id"));
        assertTrue(result.containsKey("subjectId"));
        verify(meetingService, never()).saveMeeting(anyString(), anyString(), anyLong(), anyString(), anyString(), anyString(), anyLong(), anyString(), any());
    }

    @Test
    void createRealtimeMeeting_shouldAlwaysCreateFreshMeetingWithoutDuplicateLookup() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(9L, "user", "USER", "FREE"));
        when(meetingService.normalizeMeetingStatus(anyString())).thenAnswer((invocation) -> invocation.getArgument(0));

        Meeting meeting = new Meeting();
        meeting.setId(88L);
        meeting.setTitle("Live recording session");
        meeting.setAudioPath("");
        meeting.setOriginalFileName("realtime");
        meeting.setLanguage("en");
        meeting.setStatus(MeetingService.MEETING_STATUS_PROCESSING);

        when(meetingService.saveMeeting(
                eq("Live recording session"),
                eq(""),
                eq(9L),
                eq("realtime"),
                eq("en"),
                eq((String) null),
                eq(0L),
                eq(MeetingService.MEETING_STATUS_PROCESSING),
                eq(null)
        )).thenReturn(meeting);

        Map<String, Object> result = controller.createRealtimeMeeting(
                new MeetingController.CreateRealtimeMeetingRequest("Live recording session", "en"),
                authentication
        );

        assertEquals(88L, result.get("id"));
        assertEquals(false, result.get("duplicate"));
        assertEquals(false, result.get("reused"));
        assertEquals("realtime", result.get("source"));
        verify(meetingService, never()).findActiveDuplicateForOwner(anyLong(), anyString());
        verify(meetingService).saveMeeting(
                eq("Live recording session"),
                eq(""),
                eq(9L),
                eq("realtime"),
                eq("en"),
                eq((String) null),
                eq(0L),
                eq(MeetingService.MEETING_STATUS_PROCESSING),
                eq(null)
        );
    }

    @Test
    void streamMeetingAudio_shouldReturnInlineFileWhenPresent() throws Exception {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(9L, "user", "USER", "FREE"));

        Path uploadRoot = Paths.get(System.getProperty("user.dir"), "uploads").toAbsolutePath().normalize();
        Files.createDirectories(uploadRoot);
        Path audioFile = uploadRoot.resolve("controller-test-audio.wav");
        Files.write(audioFile, new byte[] {1, 2, 3, 4});

        Meeting meeting = new Meeting();
        meeting.setId(5L);
        meeting.setAudioPath(audioFile.toString());
        meeting.setOriginalFileName("demo.wav");
        when(meetingService.findByIdForUser(5L, 9L)).thenReturn(meeting);

        ResponseEntity<org.springframework.core.io.Resource> response = controller.streamMeetingAudio(5L, authentication);

        assertEquals(200, response.getStatusCode().value());
        assertEquals("inline; filename=\"demo.wav\"", response.getHeaders().getFirst("Content-Disposition"));
    }
}
