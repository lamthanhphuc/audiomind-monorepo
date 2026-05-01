package com.example.processingservice.security;

import com.example.processingservice.client.MeetingServiceClient;
import java.util.Collection;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class RestMeetingChannelAuthorizer implements MeetingChannelAuthorizer {

    private static final Logger log = LoggerFactory.getLogger(RestMeetingChannelAuthorizer.class);

    private final MeetingServiceClient meetingServiceClient;

    @Override
    public boolean canJoin(Long userId, Long meetingId, String authorization) {
        if (userId == null || meetingId == null || authorization == null || authorization.isBlank()) {
            return false;
        }

        try {
            Map<String, Object> meeting = meetingServiceClient.getMeetingById(meetingId, null, authorization);
            if (matchesOwner(meeting, userId)) {
                return true;
            }
            if (matchesParticipant(meeting, userId)) {
                return true;
            }

            Object ownerId = meeting.get("ownerId");
            Object hostId = meeting.get("hostId");
            if (ownerId == null && hostId == null && meeting.containsKey("participants")) {
                log.warn("Meeting membership fields are unavailable; allowing websocket join for meetingId={}", meetingId);
                return true;
            }
        } catch (Exception ex) {
            log.warn("Meeting authorization lookup failed for meetingId={}: {}", meetingId, ex.getMessage());
            return false;
        }

        return false;
    }

    private boolean matchesOwner(Map<String, Object> meeting, Long userId) {
        return matchesNumericValue(meeting.get("ownerUserId"), userId)
                || matchesNumericValue(meeting.get("ownerId"), userId)
                || matchesNumericValue(meeting.get("hostId"), userId);
    }

    private boolean matchesParticipant(Map<String, Object> meeting, Long userId) {
        Object participants = meeting.get("participants");
        if (participants instanceof Collection<?> collection) {
            for (Object item : collection) {
                if (matchesNumericValue(item, userId)) {
                    return true;
                }
                if (item instanceof Map<?, ?> map && (
                        matchesNumericValue(map.get("userId"), userId)
                                || matchesNumericValue(map.get("id"), userId))) {
                    return true;
                }
            }
        }
        return false;
    }

    private boolean matchesNumericValue(Object value, Long userId) {
        if (value == null) {
            return false;
        }
        if (value instanceof Number number) {
            return number.longValue() == userId.longValue();
        }
        try {
            return Long.parseLong(String.valueOf(value)) == userId.longValue();
        } catch (NumberFormatException ignored) {
            return false;
        }
    }
}
