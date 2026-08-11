package com.example.userservice.service;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class AdminWorkflowMetricsServiceTest {

    private JdbcTemplate jdbcTemplate;
    private AdminWorkflowMetricsService service;

    @BeforeEach
    void setUp() {
        DriverManagerDataSource dataSource = new DriverManagerDataSource();
        dataSource.setDriverClassName("org.h2.Driver");
        dataSource.setUrl("jdbc:h2:mem:workflow-" + System.nanoTime() + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        dataSource.setUsername("sa");
        dataSource.setPassword("");
        jdbcTemplate = new JdbcTemplate(dataSource);
        service = new AdminWorkflowMetricsService(jdbcTemplate);

        jdbcTemplate.execute("""
                CREATE TABLE app_users (
                    id BIGINT PRIMARY KEY,
                    username VARCHAR(50),
                    email VARCHAR(255)
                )
                """);
        jdbcTemplate.execute("""
                CREATE TABLE meeting (
                    id BIGINT PRIMARY KEY,
                    title VARCHAR(255),
                    audio_path VARCHAR(500),
                    original_file_name VARCHAR(255),
                    owner_user_id BIGINT,
                    file_size BIGINT,
                    status VARCHAR(32),
                    deleted_at TIMESTAMP
                )
                """);
        jdbcTemplate.execute("""
                CREATE TABLE meeting_analysis_runs (
                    id BIGINT PRIMARY KEY,
                    meeting_id BIGINT NOT NULL,
                    status VARCHAR(32) NOT NULL,
                    completed_at TIMESTAMP
                )
                """);
        jdbcTemplate.execute("""
                CREATE TABLE analysis (
                    id BIGINT PRIMARY KEY,
                    meeting_id BIGINT NOT NULL,
                    summary CLOB,
                    keywords CLOB,
                    technical_terms CLOB,
                    action_items CLOB
                )
                """);
    }

    @Test
    void countsUserWhoCompletedOneUploadFlow() {
        seedUser(1);
        seedUploadMeeting(101, 1, "completed");
        seedAnalysisRun(1001, 101, "COMPLETED", true);

        assertThat(service.countFullWorkflowCompletions()).isEqualTo(1);
    }

    @Test
    void countsOneUserOnceWhenTheyCompletedMultipleFlows() {
        seedUser(1);
        for (long meetingId = 101; meetingId <= 103; meetingId++) {
            seedUploadMeeting(meetingId, 1, "completed");
            seedAnalysisRun(1000 + meetingId, meetingId, "COMPLETED", true);
        }

        assertThat(service.countFullWorkflowCompletions()).isEqualTo(1);
    }

    @Test
    void countsTwoUsersWhenBothCompletedAFlow() {
        seedUser(1);
        seedUser(2);
        seedUploadMeeting(101, 1, "completed");
        seedUploadMeeting(102, 2, "completed");
        seedAnalysisRun(1001, 101, "COMPLETED", true);
        seedAnalysisRun(1002, 102, "COMPLETED", true);

        assertThat(service.countFullWorkflowCompletions()).isEqualTo(2);
    }

    @Test
    void doesNotCountUploadWhenProcessingFailed() {
        seedUser(1);
        seedUploadMeeting(101, 1, "failed");
        seedAnalysisRun(1001, 101, "COMPLETED", true);

        assertThat(service.countFullWorkflowCompletions()).isZero();
    }

    @Test
    void doesNotCountWhenAiAnalysisFailed() {
        seedUser(1);
        seedUploadMeeting(101, 1, "completed");
        seedAnalysisRun(1001, 101, "FAILED", false);

        assertThat(service.countFullWorkflowCompletions()).isZero();
    }

    @Test
    void doesNotCountWhenAiAnalysisIsPending() {
        seedUser(1);
        seedUploadMeeting(101, 1, "completed");
        seedAnalysisRun(1001, 101, "PENDING", false);

        assertThat(service.countFullWorkflowCompletions()).isZero();
    }

    @Test
    void countsRealtimeFlowCompletion() {
        seedUser(1);
        seedRealtimeMeeting(101, 1, "completed");
        seedAnalysisRun(1001, 101, "COMPLETED", true);

        assertThat(service.countFullWorkflowCompletions()).isEqualTo(1);
    }

    @Test
    void countsUploadAndRealtimeForSameUserOnce() {
        seedUser(1);
        seedUploadMeeting(101, 1, "completed");
        seedRealtimeMeeting(102, 1, "completed");
        seedAnalysisRun(1001, 101, "COMPLETED", true);
        seedAnalysisRun(1002, 102, "COMPLETED", true);

        assertThat(service.countFullWorkflowCompletions()).isEqualTo(1);
    }

    @Test
    void countsCompletedLegacyAnalysisResult() {
        seedUser(1);
        seedUploadMeeting(101, 1, "completed");
        jdbcTemplate.update(
                "INSERT INTO analysis (id, meeting_id, summary, action_items) VALUES (?, ?, ?, ?)",
                2001,
                101,
                "AI summary",
                "[]"
        );

        assertThat(service.countFullWorkflowCompletions()).isEqualTo(1);
    }

    private void seedUser(long id) {
        jdbcTemplate.update(
                "INSERT INTO app_users (id, username, email) VALUES (?, ?, ?)",
                id,
                "user" + id,
                "user" + id + "@example.test"
        );
    }

    private void seedUploadMeeting(long id, long ownerUserId, String status) {
        jdbcTemplate.update(
                """
                        INSERT INTO meeting
                            (id, title, audio_path, original_file_name, owner_user_id, file_size, status, deleted_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                        """,
                id,
                "Upload meeting " + id,
                "/uploads/audio-" + id + ".wav",
                "audio-" + id + ".wav",
                ownerUserId,
                1024L,
                status
        );
    }

    private void seedRealtimeMeeting(long id, long ownerUserId, String status) {
        jdbcTemplate.update(
                """
                        INSERT INTO meeting
                            (id, title, audio_path, original_file_name, owner_user_id, file_size, status, deleted_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                        """,
                id,
                "Realtime meeting " + id,
                "",
                "realtime",
                ownerUserId,
                0L,
                status
        );
    }

    private void seedAnalysisRun(long id, long meetingId, String status, boolean completed) {
        jdbcTemplate.update(
                """
                        INSERT INTO meeting_analysis_runs (id, meeting_id, status, completed_at)
                        VALUES (?, ?, ?, ?)
                        """,
                id,
                meetingId,
                status,
                completed ? "2026-08-11 10:00:00" : null
        );
    }
}
