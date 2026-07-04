package com.example.userservice.controller;

import com.example.userservice.controller.dto.TeamsLinkStartRequest;
import com.example.userservice.controller.dto.TeamsLinkStartResponse;
import com.example.userservice.security.UserPrincipal;
import com.example.userservice.teams.TeamsOAuthService;
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
@RequestMapping("/auth/teams")
public class TeamsAuthController {

    private final TeamsOAuthService teamsOAuthService;

    public TeamsAuthController(TeamsOAuthService teamsOAuthService) {
        this.teamsOAuthService = teamsOAuthService;
    }

    @PostMapping("/link/start")
    public TeamsLinkStartResponse startLink(
            @RequestBody(required = false) TeamsLinkStartRequest request,
            Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        URI authorizationUri = teamsOAuthService.startLink(
                principal.userId(),
                request == null ? null : request.redirectAfter());
        return new TeamsLinkStartResponse(authorizationUri.toString());
    }

    @GetMapping("/callback")
    public ResponseEntity<Void> callback(
            @RequestParam(required = false) String code,
            @RequestParam(required = false) String state,
            @RequestParam(required = false) String error) {
        URI target = teamsOAuthService.handleCallback(code, state, error);
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
