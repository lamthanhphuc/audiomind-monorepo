package com.example.meetingservice.controller;

import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.MeetingSpeakerProfileService;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/meetings/{meetingId}/speakers")
@RequiredArgsConstructor
public class MeetingSpeakerController {

    private final MeetingSpeakerProfileService speakerProfileService;

    @GetMapping
    public Map<String, Object> list(
            @PathVariable Long meetingId,
            Authentication authentication
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        List<Map<String, Object>> profiles = speakerProfileService.listProfiles(meetingId, principal.userId());
        return Map.of("meetingId", meetingId, "profiles", profiles);
    }

    @PutMapping
    public Map<String, Object> upsert(
            @PathVariable Long meetingId,
            @RequestBody UpsertSpeakerProfilesRequest request,
            Authentication authentication
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        List<Map<String, Object>> profiles = speakerProfileService.upsertProfiles(
                meetingId,
                principal.userId(),
                request == null ? List.of() : request.profiles()
        );
        return Map.of("meetingId", meetingId, "profiles", profiles);
    }

    @DeleteMapping("/{speakerKey}")
    public Map<String, Object> delete(
            @PathVariable Long meetingId,
            @PathVariable String speakerKey,
            Authentication authentication
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return speakerProfileService.deleteProfile(meetingId, principal.userId(), speakerKey);
    }

    public record UpsertSpeakerProfilesRequest(List<Map<String, Object>> profiles) {}
}
