package com.example.userservice.google;

import com.example.userservice.controller.dto.InternalGoogleAccessTokenResponse;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestTemplate;

@Service
@RequiredArgsConstructor
public class GoogleCalendarClient {

    private final GoogleGrantService grantService;
    private final RestTemplate restTemplate;

    public Map<String, Object> listCalendars(Long userId) {
        InternalGoogleAccessTokenResponse token = grantService.accessToken(userId, List.of(GoogleScopes.CALENDAR_EVENTS));
        return googleGet("https://www.googleapis.com/calendar/v3/users/me/calendarList", token.accessToken());
    }

    public Map<String, Object> createMeetEvent(Long userId, String summary) {
        InternalGoogleAccessTokenResponse token = grantService.accessToken(userId, List.of(GoogleScopes.CALENDAR_EVENTS));
        Map<String, Object> body = Map.of(
                "summary", StringUtils.hasText(summary) ? summary : "Audiomind meeting",
                "conferenceData", Map.of(
                        "createRequest", Map.of(
                                "requestId", "audiomind-" + System.currentTimeMillis(),
                                "conferenceSolutionKey", Map.of("type", "hangoutsMeet")
                        )
                )
        );
        return googlePost(
                "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1",
                token.accessToken(),
                body
        );
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> googleGet(String url, String accessToken) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(accessToken);
        ResponseEntity<Map> response = restTemplate.exchange(
                url,
                HttpMethod.GET,
                new HttpEntity<>(headers),
                Map.class
        );
        return response.getBody();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> googlePost(String url, String accessToken, Map<String, Object> body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(accessToken);
        headers.setContentType(MediaType.APPLICATION_JSON);
        ResponseEntity<Map> response = restTemplate.exchange(
                url,
                HttpMethod.POST,
                new HttpEntity<>(body, headers),
                Map.class
        );
        return response.getBody();
    }
}

