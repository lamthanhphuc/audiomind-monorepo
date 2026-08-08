package com.example.userservice.security;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.plan.UserPlanService;
import com.example.userservice.repository.UserAccountRepository;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import java.io.IOException;
import java.lang.reflect.Proxy;
import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;

class JwtAuthenticationFilterTest {

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void doFilter_usesDatabasePlanAfterExpiredTrialRefresh() throws ServletException, IOException {
        JwtUtil jwtUtil = new JwtUtil("0123456789abcdef0123456789abcdef", 3600);
        String tokenWithStaleProClaim = jwtUtil.createAccessToken(7L, "student", "USER", "PRO");
        UserAccount expiredTrialUser = user("student", "PRO", Instant.now().minusSeconds(60));
        UserAccount downgradedUser = user("student", "FREE", null);
        TokenBlacklistStore tokenBlacklistStore = new TokenBlacklistStore() {
            @Override
            public void blacklist(String token, long ttlSeconds) {
            }

            @Override
            public boolean isBlacklisted(String token) {
                return false;
            }
        };
        UserAccountRepository userAccountRepository = repositoryReturning(expiredTrialUser);
        UserPlanService userPlanService = new UserPlanService(null) {
            @Override
            public UserAccount refreshExpiredPlan(UserAccount user) {
                return downgradedUser;
            }

            @Override
            public String resolveEffectivePlan(UserAccount user) {
                return user.getPlan();
            }
        };

        JwtAuthenticationFilter filter = new JwtAuthenticationFilter(
                jwtUtil,
                tokenBlacklistStore,
                userAccountRepository,
                userPlanService);
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/users/me");
        request.addHeader("Authorization", "Bearer " + tokenWithStaleProClaim);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicReference<Authentication> authentication = new AtomicReference<>();
        FilterChain chain = (req, res) ->
                authentication.set(SecurityContextHolder.getContext().getAuthentication());

        filter.doFilter(request, response, chain);

        UserPrincipal principal = assertInstanceOf(UserPrincipal.class, authentication.get().getPrincipal());
        assertEquals("FREE", principal.plan());
    }

    private static UserAccount user(String username, String plan, Instant expiresAt) {
        UserAccount user = new UserAccount();
        user.setId(7L);
        user.setUsername(username);
        user.setRole("USER");
        user.setPlan(plan);
        user.setPlanExpiresAt(expiresAt);
        return user;
    }

    private static UserAccountRepository repositoryReturning(UserAccount user) {
        return (UserAccountRepository) Proxy.newProxyInstance(
                UserAccountRepository.class.getClassLoader(),
                new Class<?>[]{UserAccountRepository.class},
                (proxy, method, args) -> {
                    if ("findById".equals(method.getName())) {
                        return Optional.of(user);
                    }
                    throw new UnsupportedOperationException(method.getName());
                });
    }
}
