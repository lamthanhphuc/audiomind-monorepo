package com.example.meetingservice.repository;

import com.example.meetingservice.entity.Subject;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface SubjectRepository extends JpaRepository<Subject, Long> {

    Optional<Subject> findByIdAndOwnerUserId(Long id, Long ownerUserId);

    Optional<Subject> findByIdAndOwnerUserIdAndArchivedAtIsNull(Long id, Long ownerUserId);

    List<Subject> findByOwnerUserIdAndArchivedAtIsNullOrderByNameAscIdAsc(Long ownerUserId);

    List<Subject> findByOwnerUserIdAndArchivedAtIsNotNullOrderByNameAscIdAsc(Long ownerUserId);

    List<Subject> findByOwnerUserIdOrderByNameAscIdAsc(Long ownerUserId);

    List<Subject> findByOwnerUserIdAndFolderIdAndArchivedAtIsNull(Long ownerUserId, Long folderId);

    @Query(
            """
            SELECT COUNT(s) > 0 FROM Subject s
            WHERE s.ownerUserId = :ownerUserId
              AND s.archivedAt IS NULL
              AND lower(trim(s.name)) = lower(trim(:name))
              AND (:excludeId IS NULL OR s.id <> :excludeId)
            """)
    boolean existsActiveDuplicateName(
            @Param("ownerUserId") Long ownerUserId,
            @Param("name") String name,
            @Param("excludeId") Long excludeId);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(
            """
            UPDATE Subject s
            SET s.folderId = NULL, s.updatedAt = CURRENT_TIMESTAMP
            WHERE s.folderId = :folderId
              AND s.ownerUserId = :ownerUserId
            """)
    int detachSubjectsFromFolder(
            @Param("folderId") Long folderId, @Param("ownerUserId") Long ownerUserId);

    long countByFolderIdAndOwnerUserIdAndArchivedAtIsNull(Long folderId, Long ownerUserId);
}
