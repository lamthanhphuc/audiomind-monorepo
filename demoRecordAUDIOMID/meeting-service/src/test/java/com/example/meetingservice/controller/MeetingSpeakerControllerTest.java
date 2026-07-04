package com.example.meetingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.MeetingSpeakerProfileService;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.Authentication;

class MeetingSpeakerControllerTest {

    @Test
    void listProfilesUsesAuthenticatedUser() {
        MeetingSpeakerProfileService service = mock(MeetingSpeakerProfileService.class);
        MeetingSpeakerController controller = new MeetingSpeakerController(service);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(7L, "user", "USER", "FREE"));
        when(service.listProfiles(12L, 7L)).thenReturn(List.of(Map.of("speakerKey", "SPEAKER_1")));

        Map<String, Object> response = controller.list(12L, authentication);

        assertEquals(12L, response.get("meetingId"));
        verify(service).listProfiles(12L, 7L);
    }

    @Test
    void upsertProfilesDelegatesToService() {
        MeetingSpeakerProfileService service = mock(MeetingSpeakerProfileService.class);
        MeetingSpeakerController controller = new MeetingSpeakerController(service);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(3L, "user", "USER", "FREE"));
        List<Map<String, Object>> profiles = List.of(Map.of("speakerKey", "SPEAKER_1", "displayName", "Phuc"));
        when(service.upsertProfiles(eq(5L), eq(3L), eq(profiles))).thenReturn(profiles);

        Map<String, Object> response = controller.upsert(
                5L,
                new MeetingSpeakerController.UpsertSpeakerProfilesRequest(profiles),
                authentication
        );

        assertEquals(5L, response.get("meetingId"));
        verify(service).upsertProfiles(5L, 3L, profiles);
    }
}
