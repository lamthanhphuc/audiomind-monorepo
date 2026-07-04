package com.example.userservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.example.userservice.teams.TeamsOAuthService;
import java.net.URI;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.server.ResponseStatusException;

class TeamsAuthControllerTest {

    @Test
    void callback_shouldRedirectToFrontendLinked() {
        TeamsOAuthService service = mock(TeamsOAuthService.class);
        URI target = URI.create("http://localhost:8080/?teams=linked");
        when(service.handleCallback("code", "state", null)).thenReturn(target);
        TeamsAuthController controller = new TeamsAuthController(service);

        ResponseEntity<Void> response = controller.callback("code", "state", null);

        assertEquals(HttpStatus.FOUND, response.getStatusCode());
        assertEquals(target, response.getHeaders().getLocation());
    }

    @Test
    void startLink_shouldRequirePrincipal() {
        TeamsAuthController controller = new TeamsAuthController(mock(TeamsOAuthService.class));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.startLink(null, null)
        );
        assertEquals(HttpStatus.UNAUTHORIZED, ex.getStatusCode());
    }
}
