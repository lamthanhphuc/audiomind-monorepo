package com.example.userservice.client.stub;

import com.example.userservice.client.MeetingClient;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class MeetingClientStub implements MeetingClient {

    @Override
    public Map<String, Object> getUserMeetings(Long userId) {
        return Map.of(
                "source", "meeting-service-stub",
                "userId", userId,
                "meetings", List.of(),
                "message", "Not implemented yet");
    }
}
