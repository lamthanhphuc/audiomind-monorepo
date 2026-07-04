package com.example.userservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.example.userservice.security.UserPrincipal;
import com.example.userservice.zoom.ZoomGrantService;
import java.net.URI;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.server.ResponseStatusException;

class ZoomAuthControllerTest {

    @AfterEach
    void clearContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void callback_shouldRedirectToFrontend() {
        ZoomGrantService service = mock(ZoomGrantService.class);
        URI target = URI.create("http://localhost:8080/upload?zoom=linked");
        when(service.handleLinkCallback("code", "state", null)).thenReturn(target);
        ZoomAuthController controller = new ZoomAuthController(service);

        ResponseEntity<Void> response = controller.callback("code", "state", null);

        assertEquals(HttpStatus.FOUND, response.getStatusCode());
        assertEquals(target, response.getHeaders().getLocation());
    }

    @Test
    void startLink_shouldRequirePrincipal() {
        ZoomAuthController controller = new ZoomAuthController(mock(ZoomGrantService.class));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.startLink(null, null)
        );
        assertEquals(HttpStatus.UNAUTHORIZED, ex.getStatusCode());
    }

    @Test
    void startLink_shouldReturnAuthorizationUri() {
        ZoomGrantService service = mock(ZoomGrantService.class);
        URI target = URI.create("https://zoom.us/oauth/authorize?client_id=test");
        when(service.startLink(7L, "/upload")).thenReturn(target);
        ZoomAuthController controller = new ZoomAuthController(service);
        authenticate();

        var response = controller.startLink(
                new com.example.userservice.controller.dto.ZoomLinkStartRequest("/upload"),
                SecurityContextHolder.getContext().getAuthentication());

        assertEquals(target.toString(), response.authorizationUri());
    }

    private void authenticate() {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(new UserPrincipal(7L, "tester", "USER", "FREE"), null)
        );
    }
}
