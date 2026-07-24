package com.example.meetingservice.controller;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.entity.MeetingShare;
import com.example.meetingservice.entity.MeetingShareInvite;
import com.example.meetingservice.repository.MeetingRepository;
import com.example.meetingservice.repository.MeetingShareInviteRepository;
import com.example.meetingservice.repository.MeetingShareRepository;
import com.example.meetingservice.service.MeetingShareService;
import java.util.LinkedHashMap;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/internal/workspace")
@RequiredArgsConstructor
public class InternalWorkspaceController {

    private final MeetingRepository meetingRepository;
    private final MeetingShareRepository meetingShareRepository;
    private final MeetingShareInviteRepository meetingShareInviteRepository;

    @Value("${google.integration.internal-service-token:}")
    private String googleInternalServiceToken;

    @Value("${app.internal.service-token:}")
    private String appInternalServiceToken;

    @PostMapping("/summary")
    public Map<String, Object> summary(
            @RequestHeader(name = "X-Internal-Service-Token", required = false) String token,
            @RequestBody WorkspaceSummaryRequest request
    ) {
        requireInternalToken(token);
        if (request == null || request.userId() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "User id is required");
        }
        Long userId = request.userId();
        return Map.of(
                "ownedMeetingCount", meetingRepository.countByOwnerUserIdAndDeletedAtIsNull(userId),
                "sharedWithMeCount", meetingShareRepository.countBySharedWithUserId(userId),
                "members", meetingShareRepository.findByInvitedByUserIdOrderByCreatedAtDesc(userId).stream()
                        .map(this::memberView)
                        .toList(),
                "pendingInvites", meetingShareInviteRepository
                        .findByInvitedByUserIdAndStatusOrderByCreatedAtDesc(userId, MeetingShareService.STATUS_PENDING)
                        .stream()
                        .map(this::pendingView)
                        .toList(),
                "sharedMeetings", meetingRepository.findByOwnerUserIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(userId)
                        .stream()
                        .filter(meeting -> !meetingShareRepository.findByMeetingIdOrderByCreatedAtAsc(meeting.getId()).isEmpty())
                        .limit(100)
                        .map(this::meetingView)
                        .toList()
        );
    }

    private Map<String, Object> memberView(MeetingShare share) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("userId", share.getSharedWithUserId());
        view.put("role", share.getRole());
        view.put("meetingId", share.getMeetingId());
        view.put("createdAt", share.getCreatedAt() == null ? null : share.getCreatedAt().toString());
        return view;
    }

    private Map<String, Object> pendingView(MeetingShareInvite invite) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("email", invite.getInviteeEmail());
        view.put("role", invite.getRole());
        view.put("meetingId", invite.getMeetingId());
        view.put("createdAt", invite.getCreatedAt() == null ? null : invite.getCreatedAt().toString());
        return view;
    }

    private Map<String, Object> meetingView(Meeting meeting) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("meetingId", meeting.getId());
        view.put("title", meeting.getTitle());
        view.put("createdAt", meeting.getCreatedAt() == null ? null : meeting.getCreatedAt().toString());
        view.put("shareCount", meetingShareRepository.findByMeetingIdOrderByCreatedAtAsc(meeting.getId()).size());
        return view;
    }

    private void requireInternalToken(String token) {
        String expected = appInternalServiceToken != null && !appInternalServiceToken.isBlank()
                ? appInternalServiceToken
                : googleInternalServiceToken;
        if (expected == null || expected.isBlank()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Internal token not configured");
        }
        if (token == null || token.isBlank() || !expected.equals(token)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
    }

    public record WorkspaceSummaryRequest(Long userId, String email) {
    }
}
