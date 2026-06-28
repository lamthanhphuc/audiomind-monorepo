package com.example.meetingservice.google;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class GoogleCalendarClientTest {

    @Test
    void toGoogleLocalDateTimeConvertsUtcInstantToWallClockInTimezone() {
        assertThat(GoogleCalendarClient.toGoogleLocalDateTime(
                        "2026-06-27T12:00:00Z", "Asia/Ho_Chi_Minh"))
                .isEqualTo("2026-06-27T19:00:00");
    }

    @Test
    void toGoogleLocalDateTimePreservesOffsetAwareInput() {
        assertThat(GoogleCalendarClient.toGoogleLocalDateTime(
                        "2026-06-27T10:00:00+07:00", "Asia/Ho_Chi_Minh"))
                .isEqualTo("2026-06-27T10:00:00");
    }

    @Test
    void resolveAuthErrorMapsInsufficientPermissionsToScopeMissing() {
        String body = """
                {"error":{"errors":[{"reason":"insufficientPermissions"}],"message":"Insufficient Permission"}}
                """;
        assertThat(GoogleCalendarClient.resolveAuthError(403, body))
                .isEqualTo(GoogleCalendarError.GOOGLE_SCOPE_MISSING);
    }

    @Test
    void resolveAuthErrorMaps401ToRefreshRevoked() {
        assertThat(GoogleCalendarClient.resolveAuthError(401, "{\"error\":\"invalid_grant\"}"))
                .isEqualTo(GoogleCalendarError.GOOGLE_REFRESH_TOKEN_REVOKED);
    }

    @Test
    void resolveAuthErrorKeepsGenericPermissionDenied() {
        assertThat(GoogleCalendarClient.resolveAuthError(403, "{\"error\":\"forbidden\"}"))
                .isEqualTo(GoogleCalendarError.GOOGLE_CALENDAR_PERMISSION_DENIED);
    }
}
