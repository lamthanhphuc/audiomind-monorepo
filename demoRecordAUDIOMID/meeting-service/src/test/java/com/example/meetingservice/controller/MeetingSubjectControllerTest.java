package com.example.meetingservice.controller;

import com.example.meetingservice.config.Epic2FeatureFlags;
import com.example.meetingservice.config.UploadValidationPolicy;
import com.example.meetingservice.controller.dto.AssignMeetingSubjectRequest;
import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.MeetingPageResult;
import com.example.meetingservice.service.MeetingService;
import com.example.meetingservice.service.MimeSniffRequestCache;
import com.example.meetingservice.service.MimeSniffer;
import com.example.meetingservice.service.NoOpScanner;
import com.example.meetingservice.service.ScanCircuitBreaker;
import com.example.meetingservice.service.UploadValidator;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.core.Authentication;
import org.springframework.web.server.ResponseStatusException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class MeetingSubjectControllerTest {

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

    private Authentication auth(long userId) {
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(userId, "user", "USER", "FREE"));
        return authentication;
    }

    @Test
    void assignSubject_delegatesToOwnerScopedService() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        Meeting meeting = new Meeting();
        meeting.setId(10L);
        meeting.setSubjectId(12L);
        when(meetingService.assignSubject(10L, 9L, 12L)).thenReturn(meeting);

        Meeting result = controller.assignMeetingSubject(10L, new AssignMeetingSubjectRequest(12L), auth(9L));

        assertEquals(12L, result.getSubjectId());
        verify(meetingService).assignSubject(10L, 9L, 12L);
    }

    @Test
    void assignSubject_nullClearsSubject() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        Meeting meeting = new Meeting();
        meeting.setId(10L);
        meeting.setSubjectId(null);
        when(meetingService.assignSubject(10L, 9L, null)).thenReturn(meeting);

        Meeting result = controller.assignMeetingSubject(10L, new AssignMeetingSubjectRequest(null), auth(9L));

        assertNull(result.getSubjectId());
    }

    @Test
    void getUnclassified_returnsPageShapeWithSharedWithMeFalse() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        Meeting meeting = new Meeting();
        meeting.setId(1L);
        meeting.setSubjectId(null);
        when(meetingService.findUnclassifiedForOwnerPage(9L, "swp", "createdAt_desc", 1, 20))
                .thenReturn(new MeetingPageResult(List.of(meeting), 1, 1, 20, 1));

        Map<String, Object> result = controller.getUnclassifiedMeetings("swp", "createdAt_desc", 1, 20, auth(9L));

        assertEquals(1L, ((Number) result.get("total")).longValue());
        assertEquals(1, result.get("page"));
        assertEquals(20, result.get("pageSize"));
        @SuppressWarnings("unchecked")
        List<Meeting> items = (List<Meeting>) result.get("items");
        assertEquals(Boolean.FALSE, items.getFirst().getSharedWithMe());
        assertNull(items.getFirst().getSubjectId());
    }

    @Test
    void createRealtimeMeeting_withSubjectPersistsViaNineArgSave() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        when(meetingService.normalizeMeetingStatus(anyString())).thenAnswer(invocation -> invocation.getArgument(0));
        Meeting meeting = new Meeting();
        meeting.setId(88L);
        meeting.setSubjectId(12L);
        meeting.setLanguage("vi");
        meeting.setStatus(MeetingService.MEETING_STATUS_PROCESSING);
        when(meetingService.saveMeeting(
                        eq("Lecture"),
                        eq(""),
                        eq(9L),
                        eq("realtime"),
                        eq("vi"),
                        eq((String) null),
                        eq(0L),
                        eq(MeetingService.MEETING_STATUS_PROCESSING),
                        eq(12L)))
                .thenReturn(meeting);

        Map<String, Object> result = controller.createRealtimeMeeting(
                new MeetingController.CreateRealtimeMeetingRequest("Lecture", "vi", 12L), auth(9L));

        assertEquals(12L, result.get("subjectId"));
        verify(meetingService)
                .saveMeeting(
                        eq("Lecture"),
                        eq(""),
                        eq(9L),
                        eq("realtime"),
                        eq("vi"),
                        eq((String) null),
                        eq(0L),
                        eq(MeetingService.MEETING_STATUS_PROCESSING),
                        eq(12L));
    }

    @Test
    void createRealtimeMeeting_legacyRequestWithoutSubjectUsesNull() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        when(meetingService.normalizeMeetingStatus(anyString())).thenAnswer(invocation -> invocation.getArgument(0));
        Meeting meeting = new Meeting();
        meeting.setId(88L);
        meeting.setStatus(MeetingService.MEETING_STATUS_PROCESSING);
        when(meetingService.saveMeeting(
                        anyString(),
                        eq(""),
                        eq(9L),
                        eq("realtime"),
                        eq("en"),
                        eq((String) null),
                        eq(0L),
                        eq(MeetingService.MEETING_STATUS_PROCESSING),
                        isNull()))
                .thenReturn(meeting);

        Map<String, Object> result = controller.createRealtimeMeeting(
                new MeetingController.CreateRealtimeMeetingRequest("Live recording session", "en"), auth(9L));

        assertNull(result.get("subjectId"));
        verify(meetingService)
                .saveMeeting(
                        eq("Live recording session"),
                        eq(""),
                        eq(9L),
                        eq("realtime"),
                        eq("en"),
                        eq((String) null),
                        eq(0L),
                        eq(MeetingService.MEETING_STATUS_PROCESSING),
                        isNull());
    }

    @Test
    void upload_validSubjectPassesNineArgSave() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        when(meetingService.findActiveDuplicateForOwner(eq(9L), anyString())).thenReturn(Optional.empty());
        when(meetingService.normalizeMeetingStatus(anyString())).thenAnswer(invocation -> invocation.getArgument(0));
        Meeting meeting = new Meeting();
        meeting.setId(10L);
        meeting.setSubjectId(12L);
        meeting.setLanguage("vi");
        when(meetingService.saveMeeting(
                        eq("sample"),
                        anyString(),
                        eq(9L),
                        eq("sample.wav"),
                        eq("vi"),
                        anyString(),
                        eq(3L),
                        eq(MeetingService.MEETING_STATUS_PROCESSING),
                        eq(12L)))
                .thenReturn(meeting);

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[] {1, 2, 3});
        Map<String, Object> result = controller.upload("sample", file, "vi", "12", auth(9L));

        assertEquals(12L, result.get("subjectId"));
        verify(meetingService).requireActiveOwnedSubject(12L, 9L);
        verify(meetingService)
                .saveMeeting(
                        eq("sample"),
                        anyString(),
                        eq(9L),
                        eq("sample.wav"),
                        eq("vi"),
                        anyString(),
                        eq(3L),
                        eq(MeetingService.MEETING_STATUS_PROCESSING),
                        eq(12L));
    }

    @Test
    void upload_invalidSubjectFailsBeforeDuplicateLookup() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        doThrow(new NoSuchElementException("Subject not found"))
                .when(meetingService)
                .requireActiveOwnedSubject(99L, 9L);

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[] {1, 2, 3});

        assertThrows(NoSuchElementException.class, () -> controller.upload("sample", file, "vi", "99", auth(9L)));
        verify(meetingService, never()).findActiveDuplicateForOwner(anyLong(), anyString());
        verify(meetingService, never())
                .saveMeeting(anyString(), anyString(), anyLong(), anyString(), anyString(), anyString(), anyLong(), anyString(), any());
    }

    @Test
    void upload_duplicateDifferentSubjectKeepsExistingSubject() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        when(meetingService.normalizeMeetingStatus(anyString())).thenAnswer(invocation -> invocation.getArgument(0));

        Meeting existing = new Meeting();
        existing.setId(77L);
        existing.setSubjectId(11L);
        existing.setTitle("existing");
        existing.setLanguage("vi");
        existing.setStatus(MeetingService.MEETING_STATUS_COMPLETED);
        when(meetingService.findActiveDuplicateForOwner(eq(9L), anyString()))
                .thenReturn(Optional.of(new MeetingService.DuplicateMatch(
                        existing, true, MeetingService.MEETING_STATUS_COMPLETED)));

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[] {1, 2, 3});
        Map<String, Object> result = controller.upload("sample", file, "vi", "12", auth(9L));

        assertEquals(true, result.get("duplicate"));
        assertEquals(11L, result.get("subjectId"));
        verify(meetingService).requireActiveOwnedSubject(12L, 9L);
        verify(meetingService, never())
                .saveMeeting(anyString(), anyString(), anyLong(), anyString(), anyString(), anyString(), anyLong(), anyString(), any());
        verify(meetingService, never()).assignSubject(anyLong(), anyLong(), any());
    }

    @Test
    void upload_duplicateExistingNullRemainsNull() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        when(meetingService.normalizeMeetingStatus(anyString())).thenAnswer(invocation -> invocation.getArgument(0));

        Meeting existing = new Meeting();
        existing.setId(77L);
        existing.setSubjectId(null);
        existing.setStatus(MeetingService.MEETING_STATUS_COMPLETED);
        when(meetingService.findActiveDuplicateForOwner(eq(9L), anyString()))
                .thenReturn(Optional.of(new MeetingService.DuplicateMatch(
                        existing, true, MeetingService.MEETING_STATUS_COMPLETED)));

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[] {1, 2, 3});
        Map<String, Object> result = controller.upload("sample", file, "vi", "12", auth(9L));

        assertNull(result.get("subjectId"));
        assertEquals(true, result.get("duplicate"));
    }

    @Test
    void upload_malformedSubjectId_validationError() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[] {1, 2, 3});

        IllegalArgumentException ex =
                assertThrows(IllegalArgumentException.class, () -> controller.upload("sample", file, "vi", "abc", auth(9L)));
        assertTrue(ex.getMessage().contains("subjectId"));
        verify(meetingService, never()).requireActiveOwnedSubject(anyLong(), anyLong());
        verify(meetingService, never()).findActiveDuplicateForOwner(anyLong(), anyString());
    }

    @Test
    void upload_blankSubjectIdTreatedAsNull() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        when(meetingService.findActiveDuplicateForOwner(eq(9L), anyString())).thenReturn(Optional.empty());
        when(meetingService.normalizeMeetingStatus(anyString())).thenAnswer(invocation -> invocation.getArgument(0));
        Meeting meeting = new Meeting();
        meeting.setId(10L);
        when(meetingService.saveMeeting(
                        eq("sample"),
                        anyString(),
                        eq(9L),
                        eq("sample.wav"),
                        eq("vi"),
                        anyString(),
                        eq(3L),
                        eq(MeetingService.MEETING_STATUS_PROCESSING),
                        isNull()))
                .thenReturn(meeting);

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[] {1, 2, 3});
        controller.upload("sample", file, "vi", "  ", auth(9L));

        verify(meetingService, never()).requireActiveOwnedSubject(anyLong(), anyLong());
        verify(meetingService)
                .saveMeeting(
                        eq("sample"),
                        anyString(),
                        eq(9L),
                        eq("sample.wav"),
                        eq("vi"),
                        anyString(),
                        eq(3L),
                        eq(MeetingService.MEETING_STATUS_PROCESSING),
                        isNull());
    }

    @Test
    void upload_otherUsersSubjectFailsBeforeDuplicateReuse() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        doThrow(new NoSuchElementException("Subject not found"))
                .when(meetingService)
                .requireActiveOwnedSubject(55L, 9L);

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[] {1, 2, 3});

        assertThrows(NoSuchElementException.class, () -> controller.upload("sample", file, "vi", "55", auth(9L)));
        verify(meetingService, never()).findActiveDuplicateForOwner(anyLong(), anyString());
    }

    @Test
    void upload_archivedSubjectFailsBeforeDuplicateReuse() {
        MeetingService meetingService = mock(MeetingService.class);
        MeetingController controller = newController(meetingService);
        doThrow(new ResponseStatusException(org.springframework.http.HttpStatus.CONFLICT, "Archived"))
                .when(meetingService)
                .requireActiveOwnedSubject(12L, 9L);

        MockMultipartFile file = new MockMultipartFile("file", "sample.wav", "audio/wav", new byte[] {1, 2, 3});

        assertThrows(ResponseStatusException.class, () -> controller.upload("sample", file, "vi", "12", auth(9L)));
        verify(meetingService, never()).findActiveDuplicateForOwner(anyLong(), anyString());
    }
}
