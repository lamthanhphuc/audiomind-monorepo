package com.example.meetingservice.migration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.HashSet;
import java.util.Set;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.postgresql.util.PSQLException;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Real PostgreSQL + Flyway smoke coverage for V16 study_folder / subject / meeting.subject_id.
 */
@Testcontainers(disabledWithoutDocker = true)
class StudyFolderSubjectMigrationTest {

    private static final String OWNER_USERNAME = "migration-owner";
    private static final String OWNER_EMAIL = "migration-owner@example.com";
    private static final String OWNER_PASSWORD = "unused-hash";

    @Container
    @SuppressWarnings("resource")
    static final PostgreSQLContainer<?> POSTGRES =
            new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"))
                    .withDatabaseName("meeting_migration")
                    .withUsername("test")
                    .withPassword("test");

    @BeforeEach
    void resetDatabase() throws Exception {
        try (Connection connection = openConnection();
                Statement statement = connection.createStatement()) {
            statement.execute(
                    """
                    DROP SCHEMA public CASCADE;
                    CREATE SCHEMA public;
                    GRANT ALL ON SCHEMA public TO public;
                    """);
        }
        ensureSharedUserTable();
    }

    @Test
    void emptyDatabaseMigratesToV16WithRequiredSchema() throws Exception {
        migrateToLatest();

        try (Connection connection = openConnection()) {
            assertTrue(tableExists(connection, "study_folder"));
            assertTrue(tableExists(connection, "subject"));
            assertTrue(columnExists(connection, "meeting", "subject_id"));
            assertTrue(constraintExists(connection, "fk_meeting_subject"));
            assertEquals(
                    Set.of(
                            "idx_study_folder_owner",
                            "idx_study_folder_parent",
                            "idx_subject_owner",
                            "idx_subject_folder",
                            "idx_meeting_subject",
                            "idx_meeting_owner_unclassified",
                            "uq_study_folder_owner_parent_name_active",
                            "uq_subject_owner_name_active"),
                    requiredIndexesPresent(connection));
        }
    }

    @Test
    void upgradeFromV15PreservesLegacyMeetingAsUnclassified() throws Exception {
        migrateTo(MigrationVersion.fromVersion("15"));
        long ownerId = insertAppUser("legacy-owner", "legacy-owner@example.com");
        LocalDateTime createdAt = LocalDateTime.of(2025, 1, 15, 10, 30);
        long meetingId =
                insertLegacyMeeting(
                        ownerId,
                        "Legacy title",
                        "completed",
                        createdAt,
                        null);

        try (Connection connection = openConnection()) {
            assertFalse(columnExists(connection, "meeting", "subject_id"));
        }

        migrateToLatest();

        try (Connection connection = openConnection();
                PreparedStatement statement =
                        connection.prepareStatement(
                                """
                                SELECT id, title, owner_user_id, status, deleted_at, subject_id, created_at
                                FROM meeting
                                WHERE id = ?
                                """)) {
            statement.setLong(1, meetingId);
            try (ResultSet rs = statement.executeQuery()) {
                assertTrue(rs.next());
                assertEquals(meetingId, rs.getLong("id"));
                assertEquals("Legacy title", rs.getString("title"));
                assertEquals(ownerId, rs.getLong("owner_user_id"));
                assertEquals("completed", rs.getString("status"));
                assertNull(rs.getTimestamp("deleted_at"));
                assertNull(rs.getObject("subject_id"));
                assertEquals(Timestamp.valueOf(createdAt), rs.getTimestamp("created_at"));
                assertFalse(rs.next());
            }
        }
    }

    @Test
    void meetingSubjectForeignKeySetsNullOnSubjectHardDelete() throws Exception {
        migrateToLatest();
        long ownerId = insertAppUser(OWNER_USERNAME, OWNER_EMAIL);
        long folderId = insertFolder(ownerId, null, "Kỳ 1");
        long subjectId = insertSubject(ownerId, folderId, "SWP391");
        long meetingId =
                insertLegacyMeeting(
                        ownerId,
                        "Assigned meeting",
                        "completed",
                        LocalDateTime.of(2025, 2, 1, 9, 0),
                        null);

        assignMeetingSubject(meetingId, subjectId);
        assertEquals(subjectId, fetchMeetingSubjectId(meetingId));

        try (Connection connection = openConnection();
                PreparedStatement statement =
                        connection.prepareStatement("DELETE FROM subject WHERE id = ?")) {
            statement.setLong(1, subjectId);
            assertEquals(1, statement.executeUpdate());
        }

        try (Connection connection = openConnection();
                PreparedStatement statement =
                        connection.prepareStatement(
                                """
                                SELECT id, title, owner_user_id, subject_id
                                FROM meeting
                                WHERE id = ?
                                """)) {
            statement.setLong(1, meetingId);
            try (ResultSet rs = statement.executeQuery()) {
                assertTrue(rs.next());
                assertEquals(meetingId, rs.getLong("id"));
                assertEquals("Assigned meeting", rs.getString("title"));
                assertEquals(ownerId, rs.getLong("owner_user_id"));
                assertNull(rs.getObject("subject_id"));
            }
        }
    }

    @Test
    void subjectOwnerNameActiveUniqueIndexIsCaseAndTrimInsensitive() throws Exception {
        migrateToLatest();
        long ownerId = insertAppUser(OWNER_USERNAME, OWNER_EMAIL);
        long firstSubjectId = insertSubject(ownerId, null, "SWP391");

        PSQLException conflict =
                assertThrows(
                        PSQLException.class,
                        () -> insertSubject(ownerId, null, "  swp391  "));
        assertEquals("23505", conflict.getSQLState());

        try (Connection connection = openConnection();
                PreparedStatement statement =
                        connection.prepareStatement(
                                "UPDATE subject SET archived_at = CURRENT_TIMESTAMP WHERE id = ?")) {
            statement.setLong(1, firstSubjectId);
            assertEquals(1, statement.executeUpdate());
        }

        long recycledId = insertSubject(ownerId, null, "  swp391  ");
        assertNotNull(recycledId);
        assertTrue(recycledId > 0);
    }

    @Test
    void folderOwnerParentNameActiveUniqueIndexAllowsDifferentParentsAndSoftDeleteReuse()
            throws Exception {
        migrateToLatest();
        long ownerId = insertAppUser(OWNER_USERNAME, OWNER_EMAIL);
        long parentA = insertFolder(ownerId, null, "Parent A");
        long parentB = insertFolder(ownerId, null, "Parent B");
        long firstFolderId = insertFolder(ownerId, parentA, "Kỳ 1");

        PSQLException conflict =
                assertThrows(
                        PSQLException.class,
                        () -> insertFolder(ownerId, parentA, " kỳ 1 "));
        assertEquals("23505", conflict.getSQLState());

        long sameNameOtherParent = insertFolder(ownerId, parentB, "Kỳ 1");
        assertTrue(sameNameOtherParent > 0);

        try (Connection connection = openConnection();
                PreparedStatement statement =
                        connection.prepareStatement(
                                "UPDATE study_folder SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?")) {
            statement.setLong(1, firstFolderId);
            assertEquals(1, statement.executeUpdate());
        }

        long recycled = insertFolder(ownerId, parentA, " kỳ 1 ");
        assertTrue(recycled > 0);
    }

    @Test
    void v16DoesNotMutateExistingMeetingOwnershipOrDeletedAt() throws Exception {
        migrateTo(MigrationVersion.fromVersion("15"));
        long ownerId = insertAppUser("safety-owner", "safety-owner@example.com");
        LocalDateTime createdAt = LocalDateTime.of(2024, 11, 3, 8, 15);
        LocalDateTime deletedAt = LocalDateTime.of(2024, 12, 1, 12, 0);
        long activeId =
                insertLegacyMeeting(ownerId, "Active meeting", "completed", createdAt, null);
        long deletedId =
                insertLegacyMeeting(ownerId, "Deleted meeting", "completed", createdAt, deletedAt);

        int meetingCountBefore = countMeetings();
        migrateToLatest();
        assertEquals(meetingCountBefore, countMeetings());

        try (Connection connection = openConnection();
                PreparedStatement statement =
                        connection.prepareStatement(
                                """
                                SELECT id, owner_user_id, deleted_at, subject_id
                                FROM meeting
                                WHERE id = ?
                                """)) {
            statement.setLong(1, activeId);
            try (ResultSet rs = statement.executeQuery()) {
                assertTrue(rs.next());
                assertEquals(ownerId, rs.getLong("owner_user_id"));
                assertNull(rs.getTimestamp("deleted_at"));
                assertNull(rs.getObject("subject_id"));
            }

            statement.setLong(1, deletedId);
            try (ResultSet rs = statement.executeQuery()) {
                assertTrue(rs.next());
                assertEquals(ownerId, rs.getLong("owner_user_id"));
                assertEquals(Timestamp.valueOf(deletedAt), rs.getTimestamp("deleted_at"));
                assertNull(rs.getObject("subject_id"));
            }
        }
    }

    private void ensureSharedUserTable() throws Exception {
        try (Connection connection = openConnection();
                Statement statement = connection.createStatement()) {
            statement.execute(
                    """
                    CREATE TABLE IF NOT EXISTS app_users (
                        id BIGSERIAL PRIMARY KEY,
                        username VARCHAR(50) NOT NULL UNIQUE,
                        email VARCHAR(255) NOT NULL UNIQUE,
                        password_hash VARCHAR(255) NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """);
        }
    }

    private void migrateToLatest() {
        configureFlyway(null).migrate();
    }

    private void migrateTo(MigrationVersion target) {
        configureFlyway(target).migrate();
    }

    private Flyway configureFlyway(MigrationVersion target) {
        var configuration =
                Flyway.configure()
                        .dataSource(
                                POSTGRES.getJdbcUrl(),
                                POSTGRES.getUsername(),
                                POSTGRES.getPassword())
                        .locations("classpath:db/migration")
                        // app_users is owned by user-service in shared DBs; seed it before
                        // meeting migrations and baseline at 0 so V1..V16 still execute.
                        .baselineOnMigrate(true)
                        .baselineVersion("0");
        if (target != null) {
            configuration = configuration.target(target);
        }
        return configuration.load();
    }

    private Connection openConnection() throws SQLException {
        return DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private long insertAppUser(String username, String email) throws Exception {
        try (Connection connection = openConnection();
                PreparedStatement statement =
                        connection.prepareStatement(
                                """
                                INSERT INTO app_users (username, email, password_hash)
                                VALUES (?, ?, ?)
                                RETURNING id
                                """)) {
            statement.setString(1, username);
            statement.setString(2, email);
            statement.setString(3, OWNER_PASSWORD);
            try (ResultSet rs = statement.executeQuery()) {
                assertTrue(rs.next());
                return rs.getLong(1);
            }
        }
    }

    private long insertLegacyMeeting(
            long ownerUserId,
            String title,
            String status,
            LocalDateTime createdAt,
            LocalDateTime deletedAt)
            throws Exception {
        try (Connection connection = openConnection();
                PreparedStatement statement =
                        connection.prepareStatement(
                                """
                                INSERT INTO meeting (
                                    title,
                                    audio_path,
                                    owner_user_id,
                                    created_at,
                                    original_file_name,
                                    language,
                                    audio_hash,
                                    file_size,
                                    status,
                                    deleted_at
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                RETURNING id
                                """)) {
            statement.setString(1, title);
            statement.setString(2, "legacy/path.wav");
            statement.setLong(3, ownerUserId);
            statement.setTimestamp(4, Timestamp.valueOf(createdAt));
            statement.setString(5, "legacy.wav");
            statement.setString(6, "vi");
            statement.setString(7, "abc123hash");
            statement.setLong(8, 1024L);
            statement.setString(9, status);
            if (deletedAt == null) {
                statement.setTimestamp(10, null);
            } else {
                statement.setTimestamp(10, Timestamp.valueOf(deletedAt));
            }
            try (ResultSet rs = statement.executeQuery()) {
                assertTrue(rs.next());
                return rs.getLong(1);
            }
        }
    }

    private long insertFolder(long ownerUserId, Long parentFolderId, String name) throws Exception {
        try (Connection connection = openConnection();
                PreparedStatement statement =
                        connection.prepareStatement(
                                """
                                INSERT INTO study_folder (
                                    owner_user_id, parent_folder_id, name, created_at, updated_at
                                ) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                                RETURNING id
                                """)) {
            statement.setLong(1, ownerUserId);
            if (parentFolderId == null) {
                statement.setObject(2, null);
            } else {
                statement.setLong(2, parentFolderId);
            }
            statement.setString(3, name);
            try (ResultSet rs = statement.executeQuery()) {
                assertTrue(rs.next());
                return rs.getLong(1);
            }
        }
    }

    private long insertSubject(long ownerUserId, Long folderId, String name) throws Exception {
        try (Connection connection = openConnection();
                PreparedStatement statement =
                        connection.prepareStatement(
                                """
                                INSERT INTO subject (
                                    owner_user_id, folder_id, name, created_at, updated_at
                                ) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                                RETURNING id
                                """)) {
            statement.setLong(1, ownerUserId);
            if (folderId == null) {
                statement.setObject(2, null);
            } else {
                statement.setLong(2, folderId);
            }
            statement.setString(3, name);
            try (ResultSet rs = statement.executeQuery()) {
                assertTrue(rs.next());
                return rs.getLong(1);
            }
        }
    }

    private void assignMeetingSubject(long meetingId, long subjectId) throws Exception {
        try (Connection connection = openConnection();
                PreparedStatement statement =
                        connection.prepareStatement(
                                "UPDATE meeting SET subject_id = ? WHERE id = ?")) {
            statement.setLong(1, subjectId);
            statement.setLong(2, meetingId);
            assertEquals(1, statement.executeUpdate());
        }
    }

    private Long fetchMeetingSubjectId(long meetingId) throws Exception {
        try (Connection connection = openConnection();
                PreparedStatement statement =
                        connection.prepareStatement(
                                "SELECT subject_id FROM meeting WHERE id = ?")) {
            statement.setLong(1, meetingId);
            try (ResultSet rs = statement.executeQuery()) {
                assertTrue(rs.next());
                Object value = rs.getObject("subject_id");
                return value == null ? null : ((Number) value).longValue();
            }
        }
    }

    private int countMeetings() throws Exception {
        try (Connection connection = openConnection();
                Statement statement = connection.createStatement();
                ResultSet rs = statement.executeQuery("SELECT COUNT(*) FROM meeting")) {
            assertTrue(rs.next());
            return rs.getInt(1);
        }
    }

    private boolean tableExists(Connection connection, String tableName) throws SQLException {
        try (PreparedStatement statement =
                connection.prepareStatement(
                        """
                        SELECT 1
                        FROM information_schema.tables
                        WHERE table_schema = 'public'
                          AND table_name = ?
                        """)) {
            statement.setString(1, tableName);
            try (ResultSet rs = statement.executeQuery()) {
                return rs.next();
            }
        }
    }

    private boolean columnExists(Connection connection, String tableName, String columnName)
            throws SQLException {
        try (PreparedStatement statement =
                connection.prepareStatement(
                        """
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name = ?
                          AND column_name = ?
                        """)) {
            statement.setString(1, tableName);
            statement.setString(2, columnName);
            try (ResultSet rs = statement.executeQuery()) {
                return rs.next();
            }
        }
    }

    private boolean constraintExists(Connection connection, String constraintName)
            throws SQLException {
        try (PreparedStatement statement =
                connection.prepareStatement(
                        """
                        SELECT 1
                        FROM pg_constraint c
                        JOIN pg_namespace n ON n.oid = c.connamespace
                        WHERE n.nspname = 'public'
                          AND c.conname = ?
                        """)) {
            statement.setString(1, constraintName);
            try (ResultSet rs = statement.executeQuery()) {
                return rs.next();
            }
        }
    }

    private Set<String> requiredIndexesPresent(Connection connection) throws SQLException {
        Set<String> expected =
                Set.of(
                        "idx_study_folder_owner",
                        "idx_study_folder_parent",
                        "idx_subject_owner",
                        "idx_subject_folder",
                        "idx_meeting_subject",
                        "idx_meeting_owner_unclassified",
                        "uq_study_folder_owner_parent_name_active",
                        "uq_subject_owner_name_active");
        Set<String> found = new HashSet<>();
        try (PreparedStatement statement =
                connection.prepareStatement(
                        """
                        SELECT indexname
                        FROM pg_indexes
                        WHERE schemaname = 'public'
                          AND indexname = ANY (?)
                        """)) {
            statement.setArray(1, connection.createArrayOf("text", expected.toArray()));
            try (ResultSet rs = statement.executeQuery()) {
                while (rs.next()) {
                    found.add(rs.getString(1));
                }
            }
        }
        return found;
    }
}
