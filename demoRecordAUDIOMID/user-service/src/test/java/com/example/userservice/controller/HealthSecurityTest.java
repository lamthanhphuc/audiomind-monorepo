package com.example.userservice.controller;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.example.userservice.client.MeetingClient;
import com.example.userservice.client.ProcessingClient;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.security.JwtAuthenticationFilter;
import com.example.userservice.security.JwtUtil;
import com.example.userservice.security.TokenBlacklistStore;
import com.example.userservice.service.UserService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.RedisConnection;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class HealthSecurityTest {

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        UserAccountRepository userAccountRepository = mock(UserAccountRepository.class);
        StringRedisTemplate redisTemplate = mock(StringRedisTemplate.class);
        RedisConnectionFactory redisConnectionFactory = mock(RedisConnectionFactory.class);
        RedisConnection redisConnection = mock(RedisConnection.class);

        when(userAccountRepository.count()).thenReturn(1L);
        when(redisTemplate.getConnectionFactory()).thenReturn(redisConnectionFactory);
        when(redisConnectionFactory.getConnection()).thenReturn(redisConnection);
        when(redisConnection.ping()).thenReturn("PONG");

        HealthController healthController = new HealthController(userAccountRepository, redisTemplate);
        UserController userController = new UserController(
            mock(UserService.class),
            mock(ProcessingClient.class),
            mock(MeetingClient.class)
        );

        JwtAuthenticationFilter jwtAuthenticationFilter = new JwtAuthenticationFilter(
            mock(JwtUtil.class),
            mock(TokenBlacklistStore.class)
        );

        mockMvc = MockMvcBuilders.standaloneSetup(healthController, userController)
            .addFilter(jwtAuthenticationFilter)
            .build();
    }

    @Test
    void health_shouldReturn200WithoutAuth() throws Exception {
        mockMvc.perform(get("/health"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("UP"));
    }

    @Test
    void ready_shouldReturn200WithoutAuthWhenDependenciesHealthy() throws Exception {
        mockMvc.perform(get("/ready"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("UP"))
            .andExpect(jsonPath("$.dependencies.database").value("UP"))
            .andExpect(jsonPath("$.dependencies.redis").value("UP"));
    }

    @Test
    void protectedEndpoint_shouldStillRequireAuth() throws Exception {
        mockMvc.perform(get("/api/users/me"))
            .andExpect(status().isUnauthorized());
    }
}
