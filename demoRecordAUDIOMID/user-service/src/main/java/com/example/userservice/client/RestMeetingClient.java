package com.example.userservice.client;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestTemplate;

@Service
@RequiredArgsConstructor
@Slf4j
public class RestMeetingClient implements MeetingClient {

    private final RestTemplate restTemplate;

    @Value("${audiomind.meeting-api.base-url:http://localhost:8081}")
    private String meetingApiBaseUrl;

    @Override
    public Map<String, Object> getUserMeetings(Long userId, String authorization) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("source", "meeting-service");
        response.put("userId", userId);
        if (!StringUtils.hasText(authorization)) {
            response.put("meetings", List.of());
            response.put("error", "missing_authorization");
            return response;
        }
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.add(HttpHeaders.AUTHORIZATION, authorization);
            ResponseEntity<List<Map<String, Object>>> entity = restTemplate.exchange(
                    normalizeBaseUrl(meetingApiBaseUrl) + "/meetings?sort=recent",
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    new ParameterizedTypeReference<>() {
                    }
            );
            response.put("meetings", entity.getBody() == null ? List.of() : entity.getBody());
        } catch (Exception ex) {
            log.warn(
                    "event=MEETING_CLIENT_LIST_FAILED userId={} errorCode={}",
                    userId,
                    ex.getClass().getSimpleName()
            );
            response.put("meetings", List.of());
            response.put("error", "upstream_unavailable");
        }
        return response;
    }

    @Override
    public Map<String, Object> uploadMeeting(
            String title,
            byte[] fileBytes,
            String filename,
            String language,
            String authorization
    ) {
        if (!StringUtils.hasText(authorization)) {
            throw new IllegalArgumentException("missing_authorization");
        }
        String safeFilename = StringUtils.hasText(filename) ? filename : "zoom-recording.m4a";
        ByteArrayResource resource = new ByteArrayResource(fileBytes) {
            @Override
            public String getFilename() {
                return safeFilename;
            }
        };
        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("title", title);
        body.add("file", resource);
        if (StringUtils.hasText(language)) {
            body.add("language", language);
        }
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        headers.add(HttpHeaders.AUTHORIZATION, authorization);
        ResponseEntity<Map<String, Object>> entity = restTemplate.exchange(
                normalizeBaseUrl(meetingApiBaseUrl) + "/meetings/upload",
                HttpMethod.POST,
                new HttpEntity<>(body, headers),
                new ParameterizedTypeReference<>() {
                }
        );
        return entity.getBody() == null ? Map.of() : entity.getBody();
    }

    private static String normalizeBaseUrl(String baseUrl) {
        if (baseUrl == null) {
            return "";
        }
        return baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }
}
