package com.example.userservice.controller;

import com.example.userservice.google.GoogleOAuthError;
import com.example.userservice.google.GoogleOAuthException;
import com.example.userservice.google.GoogleOAuthProperties;
import com.example.userservice.service.WorkspaceService;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/workspaces")
@RequiredArgsConstructor
public class InternalWorkspaceController {

    private final WorkspaceService workspaceService;
    private final GoogleOAuthProperties properties;

    @GetMapping("/members")
    public Map<String, Object> membersForUser(
            @RequestHeader(name = "X-Internal-Service-Token", required = false) String serviceToken,
            @RequestParam Long userId
    ) {
        if (!constantTimeEquals(serviceToken, properties.getInternalServiceToken())) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_INTERNAL_CALL_FORBIDDEN);
        }
        return workspaceService.listWorkspaceMembersForUser(userId);
    }

    private static boolean constantTimeEquals(String left, String right) {
        if (left == null || right == null || right.isBlank()) {
            return false;
        }
        return MessageDigest.isEqual(left.getBytes(StandardCharsets.UTF_8), right.getBytes(StandardCharsets.UTF_8));
    }
}
