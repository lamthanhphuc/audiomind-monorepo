package com.example.userservice.teams;

import java.net.URI;
import org.springframework.stereotype.Service;

@Service
public class TeamsOAuthService {

    private final TeamsGrantService grantService;

    public TeamsOAuthService(TeamsGrantService grantService) {
        this.grantService = grantService;
    }

    public URI startLink(Long userId, String redirectAfter) {
        return grantService.startLink(userId, redirectAfter);
    }

    public URI handleCallback(String code, String state, String error) {
        return grantService.handleLinkCallback(code, state, error);
    }
}
