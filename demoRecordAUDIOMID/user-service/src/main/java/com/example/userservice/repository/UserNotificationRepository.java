package com.example.userservice.repository;

import com.example.userservice.entity.UserNotification;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface UserNotificationRepository extends JpaRepository<UserNotification, Long> {

    List<UserNotification> findTop50ByUserIdOrderByCreatedAtDesc(Long userId);

    @Query("""
            select n from UserNotification n
            where n.userId = :userId
              and (:unreadOnly = false or n.readAt is null)
            order by n.createdAt desc
            """)
    List<UserNotification> findForUser(
            @Param("userId") Long userId,
            @Param("unreadOnly") boolean unreadOnly
    );

    long countByUserIdAndReadAtIsNull(Long userId);

    Optional<UserNotification> findByIdAndUserId(Long id, Long userId);

    @Modifying
    @Query("""
            update UserNotification n
            set n.readAt = :readAt
            where n.userId = :userId and n.readAt is null
            """)
    int markAllRead(@Param("userId") Long userId, @Param("readAt") java.time.Instant readAt);

    @Query(value = """
            SELECT COUNT(*) > 0
            FROM user_notifications n
            WHERE n.user_id = :userId
              AND n.type = :type
              AND n.payload_json LIKE :meetingIdPattern
            """, nativeQuery = true)
    boolean existsByUserIdAndTypeAndMeetingId(
            @Param("userId") Long userId,
            @Param("type") String type,
            @Param("meetingIdPattern") String meetingIdPattern
    );
}
