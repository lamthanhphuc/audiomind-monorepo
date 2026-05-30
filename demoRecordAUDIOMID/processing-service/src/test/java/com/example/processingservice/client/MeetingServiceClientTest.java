package com.example.processingservice.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.jsonPath;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestTemplate;

class MeetingServiceClientTest {

    @Test
    void updateMeetingStatus_shouldCallPatchStatusEndpointWithAuthAndPayload() {
        RestTemplate restTemplate = new RestTemplate();
        MeetingServiceClient client = new MeetingServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "meetingServiceUrl", "http://meeting-api:8081");

        MockRestServiceServer server = MockRestServiceServer.bindTo(restTemplate).build();
        server.expect(requestTo("http://meeting-api:8081/meetings/4/status"))
                .andExpect(method(HttpMethod.PATCH))
                .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer test-token"))
                .andExpect(jsonPath("$.status").value("completed"))
                .andRespond(withSuccess("{\"id\":4,\"status\":\"completed\"}", MediaType.APPLICATION_JSON));

        Map<String, Object> result = client.updateMeetingStatus(4L, "completed", "trace-1", "Bearer test-token");

        assertEquals("completed", result.get("status"));
        server.verify();
    }
}

