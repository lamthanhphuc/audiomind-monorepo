package com.example.userservice.service;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class AdminWorkflowMetricsService {

    private static final String FULL_WORKFLOW_COMPLETION_SQL = """
            SELECT COUNT(DISTINCT m.owner_user_id)
            FROM meeting m
            JOIN app_users u ON u.id = m.owner_user_id
            WHERE m.owner_user_id IS NOT NULL
              AND m.deleted_at IS NULL
              AND lower(m.status) = 'completed'
              AND (
                    NULLIF(TRIM(COALESCE(m.audio_path, '')), '') IS NOT NULL
                    OR NULLIF(TRIM(COALESCE(m.original_file_name, '')), '') IS NOT NULL
                    OR COALESCE(m.file_size, 0) > 0
                  )
              AND (
                    EXISTS (
                        SELECT 1
                        FROM meeting_analysis_runs mar
                        WHERE mar.meeting_id = m.id
                          AND upper(mar.status) = 'COMPLETED'
                          AND mar.completed_at IS NOT NULL
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM analysis a
                        WHERE a.meeting_id = m.id
                          AND (
                                NULLIF(TRIM(COALESCE(a.summary, '')), '') IS NOT NULL
                                OR a.keywords IS NOT NULL
                                OR a.technical_terms IS NOT NULL
                                OR a.action_items IS NOT NULL
                              )
                    )
                  )
            """;

    private final JdbcTemplate jdbcTemplate;

    public AdminWorkflowMetricsService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public long countFullWorkflowCompletions() {
        Long value = jdbcTemplate.queryForObject(FULL_WORKFLOW_COMPLETION_SQL, Long.class);
        return value == null ? 0L : value;
    }

    public String fullWorkflowCompletionSql() {
        return FULL_WORKFLOW_COMPLETION_SQL;
    }
}
