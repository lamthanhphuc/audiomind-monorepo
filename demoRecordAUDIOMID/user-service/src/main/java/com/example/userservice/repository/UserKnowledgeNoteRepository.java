package com.example.userservice.repository;

import com.example.userservice.entity.UserKnowledgeNote;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface UserKnowledgeNoteRepository extends JpaRepository<UserKnowledgeNote, Long> {

    List<UserKnowledgeNote> findTop100ByUserIdOrderByUpdatedAtDesc(Long userId);

    @Query("""
            SELECT n FROM UserKnowledgeNote n
            WHERE n.userId = :userId
              AND (:query IS NULL OR :query = '' OR LOWER(n.term) LIKE LOWER(CONCAT('%', :query, '%'))
                   OR LOWER(n.title) LIKE LOWER(CONCAT('%', :query, '%'))
                   OR LOWER(n.body) LIKE LOWER(CONCAT('%', :query, '%')))
            ORDER BY n.updatedAt DESC
            """)
    List<UserKnowledgeNote> search(@Param("userId") Long userId, @Param("query") String query);

    List<UserKnowledgeNote> findByUserIdAndMeetingIdOrderByUpdatedAtDesc(Long userId, Long meetingId);
}
