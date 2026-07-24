package com.example.userservice.workspace;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.example.userservice.client.MeetingClient;
import com.example.userservice.entity.AuditEvent;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.WorkspaceInvite;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.WorkspaceInviteRepository;
import com.example.userservice.repository.WorkspaceMemberRepository;
import com.example.userservice.service.AuditEventService;
import com.example.userservice.service.WorkspaceService;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.flyway.autoconfigure.FlywayAutoConfiguration;
import org.springframework.boot.jdbc.test.autoconfigure.AutoConfigureTestDatabase;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@DataJpaTest(
        properties = {
                "spring.jpa.hibernate.ddl-auto=validate",
                "spring.flyway.enabled=true",
                "spring.flyway.table=flyway_schema_history_user"
        })
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@ImportAutoConfiguration(FlywayAutoConfiguration.class)
@Import({WorkspaceService.class, WorkspacePostgresIntegrationTest.TestBeans.class})
class WorkspacePostgresIntegrationTest {

    @SuppressWarnings("resource")
    static PostgreSQLContainer<?> POSTGRES;

    @BeforeAll
    static void startPostgres() {
        boolean required = Boolean.parseBoolean(System.getenv().getOrDefault("REQUIRE_WORKSPACE_POSTGRES_TESTS", "false"));
        boolean docker = DockerClientFactory.instance().isDockerAvailable();
        if (required && !docker) {
            throw new IllegalStateException("REQUIRE_WORKSPACE_POSTGRES_TESTS=true but Docker is unavailable");
        }
        Assumptions.assumeTrue(docker, "Docker required for WorkspacePostgresIntegrationTest");
        POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"))
                .withDatabaseName("user_workspace_it")
                .withUsername("test")
                .withPassword("test");
        POSTGRES.start();
    }

    @AfterAll
    static void stopPostgres() {
        if (POSTGRES != null) {
            POSTGRES.stop();
        }
    }

    @DynamicPropertySource
    static void registerDatasource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", () -> POSTGRES.getJdbcUrl());
        registry.add("spring.datasource.username", () -> POSTGRES.getUsername());
        registry.add("spring.datasource.password", () -> POSTGRES.getPassword());
        registry.add("spring.datasource.driver-class-name", () -> "org.postgresql.Driver");
        registry.add("spring.jpa.properties.hibernate.dialect", () -> "org.hibernate.dialect.PostgreSQLDialect");
    }

    @Autowired
    WorkspaceService workspaceService;

    @Autowired
    UserAccountRepository userRepository;

    @Autowired
    WorkspaceInviteRepository inviteRepository;

    @Autowired
    WorkspaceMemberRepository memberRepository;

    @Test
    void inviteAcceptRoleChangeRemoveAndTransferOwnershipUseRealPostgres() {
        UserAccount owner = saveUser("owner", "owner@example.com");
        UserAccount member = saveUser("member", "member@example.com");
        UserAccount nextOwner = saveUser("next", "next@example.com");

        @SuppressWarnings("unchecked")
        Map<String, Object> workspace = (Map<String, Object>) workspaceService.getMyWorkspace(owner).get("workspace");
        Long workspaceId = ((Number) workspace.get("id")).longValue();

        workspaceService.inviteOrAddMember(owner.getId(), workspaceId, "member@example.com", "editor");
        workspaceService.inviteOrAddMember(owner.getId(), workspaceId, "next@example.com", "admin");
        workspaceService.inviteOrAddMember(owner.getId(), workspaceId, "new@example.com", "viewer");

        List<WorkspaceInvite> pending = inviteRepository.findByWorkspaceIdAndStatusOrderByCreatedAtDesc(workspaceId, "PENDING");
        assertEquals(1, pending.size());

        workspaceService.updateMemberRole(owner.getId(), workspaceId, member.getId(), "VIEWER");
        assertEquals("VIEWER", memberRepository.findByWorkspaceIdAndUserId(workspaceId, member.getId()).orElseThrow().getRole());

        workspaceService.removeMember(owner.getId(), workspaceId, member.getId());
        assertTrue(memberRepository.findByWorkspaceIdAndUserId(workspaceId, member.getId()).isEmpty());

        workspaceService.transferOwnership(owner.getId(), workspaceId, nextOwner.getId());
        assertEquals("OWNER", memberRepository.findByWorkspaceIdAndUserId(workspaceId, nextOwner.getId()).orElseThrow().getRole());
    }

    private UserAccount saveUser(String username, String email) {
        UserAccount user = new UserAccount();
        user.setUsername(username);
        user.setEmail(email);
        user.setPasswordHash("hash");
        return userRepository.save(user);
    }

    static class TestBeans {
        @Bean
        MeetingClient meetingClient() {
            return new MeetingClient() {
                @Override
                public Map<String, Object> getWorkspaceSummary(Long userId, String email) {
                    return Map.of("ownedMeetingCount", 0, "sharedWithMeCount", 0, "sharedMeetings", List.of());
                }

                @Override
                public Map<String, Object> getUserMeetings(Long userId, String authorization) {
                    return Map.of();
                }

                @Override
                public Map<String, Object> uploadMeeting(String title, byte[] fileBytes, String filename, String language, String authorization) {
                    return Map.of();
                }
            };
        }

        @Bean
        AuditEventService auditEventService() {
            return new AuditEventService(null, null) {
                @Override
                public AuditEvent record(Long actorUserId, String eventType, String targetType, String targetId, String summary, Map<String, Object> metadata) {
                    AuditEvent event = new AuditEvent();
                    event.setActorUserId(actorUserId);
                    event.setEventType(eventType);
                    return event;
                }
            };
        }
    }
}
