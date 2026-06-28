package com.example.userservice.controller;

import com.example.userservice.controller.dto.GoogleTicketExchangeRequest;
import com.example.userservice.controller.dto.GoogleTicketExchangeResponse;
import com.example.userservice.controller.dto.GoogleLinkStartRequest;
import com.example.userservice.controller.dto.GoogleLinkStartResponse;
import com.example.userservice.google.GoogleGrantService;
import com.example.userservice.google.GoogleLoginService;
import com.example.userservice.security.UserPrincipal;
import jakarta.validation.Valid;
import java.net.URI;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.security.core.Authentication;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/auth/google")
public class GoogleAuthController {

    private final GoogleLoginService googleLoginService;
    private final GoogleGrantService googleGrantService;

    public GoogleAuthController(
            GoogleLoginService googleLoginService,
            GoogleGrantService googleGrantService) {
        this.googleLoginService = googleLoginService;
        this.googleGrantService = googleGrantService;
    }

    @GetMapping("/start")
    public ResponseEntity<Void> start(
            @RequestParam(name = "redirect_after", required = false) String redirectAfter) {
        return redirect(googleLoginService.startLogin(redirectAfter));
    }

    @GetMapping("/callback")
    public ResponseEntity<Void> callback(
            @RequestParam(required = false) String code,
            @RequestParam(required = false) String state,
            @RequestParam(required = false) String error) {
        return redirect(googleLoginService.handleCallback(code, state, error));
    }

    @PostMapping("/exchange-ticket")
    public GoogleTicketExchangeResponse exchangeTicket(
            @Valid @RequestBody GoogleTicketExchangeRequest request) {
        return googleLoginService.exchangeTicket(request.ticket());
    }

    @PostMapping("/link/start")
    public GoogleLinkStartResponse startLink(
            @RequestBody(required = false) GoogleLinkStartRequest request,
            Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        URI authorizationUri = googleGrantService.startLink(
                principal.userId(),
                request == null ? null : request.additionalScopes(),
                request == null ? null : request.redirectAfter());
        return new GoogleLinkStartResponse(authorizationUri.toString());
    }

    @GetMapping("/link/callback")
    public ResponseEntity<Void> linkCallback(
            @RequestParam(required = false) String code,
            @RequestParam(required = false) String state,
            @RequestParam(required = false) String error) {
        return redirect(googleGrantService.handleLinkCallback(code, state, error));
    }

    private UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }

    private ResponseEntity<Void> redirect(URI location) {
        return ResponseEntity.status(HttpStatus.FOUND)
                .header(HttpHeaders.LOCATION, location.toString())
                .build();
    }
}
