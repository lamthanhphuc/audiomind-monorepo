package com.example.processingservice.security;

public interface MeetingChannelAuthorizer {
    boolean canJoin(Long userId, Long meetingId, String authorization);
}
