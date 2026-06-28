package com.example.userservice.controller;

import com.example.userservice.controller.dto.ZoomLinkStartRequest;
import com.example.userservice.controller.dto.ZoomLinkStartResponse;
import com.example.userservice.security.UserPrincipal;
import com.example.userservice.zoom.ZoomGrantService;
import java.net.URI;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/auth/zoom")
public class ZoomAuthController {

    private final ZoomGrantService zoomGrantService;

    public ZoomAuthController(ZoomGrantService zoomGrantService) {
        this.zoomGrantService = zoomGrantService;
    }

    @PostMapping("/link/start")
    public ZoomLinkStartResponse startLink(
            @RequestBody(required = false) ZoomLinkStartRequest request,
            Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        URI authorizationUri = zoomGrantService.startLink(
                principal.userId(),
                request == null ? null : request.redirectAfter());
        return new ZoomLinkStartResponse(authorizationUri.toString());
    }

    @GetMapping("/callback")
    public ResponseEntity<Void> callback(
            @RequestParam(required = false) String code,
            @RequestParam(required = false) String state,
            @RequestParam(required = false) String error) {
        URI target = zoomGrantService.handleLinkCallback(code, state, error);
        HttpHeaders headers = new HttpHeaders();
        headers.setLocation(target);
        return new ResponseEntity<>(headers, HttpStatus.FOUND);
    }

    private UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }
}
