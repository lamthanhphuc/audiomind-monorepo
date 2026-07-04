package com.example.userservice.controller;

import com.example.userservice.controller.dto.GoogleOperationResponse;
import com.example.userservice.controller.dto.GoogleStatusResponse;
import com.example.userservice.google.GoogleGrantService;
import com.example.userservice.security.UserPrincipal;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/users/me/google")
public class GoogleUserIntegrationController {

    private final GoogleGrantService grantService;

    public GoogleUserIntegrationController(GoogleGrantService grantService) {
        this.grantService = grantService;
    }

    @GetMapping("/status")
    public GoogleStatusResponse status(Authentication authentication) {
        return grantService.status(requirePrincipal(authentication).userId());
    }

    @DeleteMapping("/grant")
    public GoogleOperationResponse revokeGrant(Authentication authentication) {
        grantService.revokeGrant(requirePrincipal(authentication).userId());
        return new GoogleOperationResponse(true);
    }

    @DeleteMapping("/identity")
    public GoogleOperationResponse unlinkIdentity(Authentication authentication) {
        grantService.unlinkIdentity(requirePrincipal(authentication).userId());
        return new GoogleOperationResponse(true);
    }

    private UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }
}
