package com.example.meetingservice.repository;

import com.example.meetingservice.entity.StudyFolder;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface StudyFolderRepository extends JpaRepository<StudyFolder, Long> {

    Optional<StudyFolder> findByIdAndOwnerUserIdAndDeletedAtIsNull(Long id, Long ownerUserId);

    Optional<StudyFolder> findByIdAndOwnerUserId(Long id, Long ownerUserId);

    List<StudyFolder> findByOwnerUserIdAndDeletedAtIsNullOrderByNameAscIdAsc(Long ownerUserId);

    List<StudyFolder> findByOwnerUserIdAndParentFolderIdAndDeletedAtIsNull(
            Long ownerUserId, Long parentFolderId);

    long countByOwnerUserIdAndParentFolderIdAndDeletedAtIsNull(Long ownerUserId, Long parentFolderId);

    @Query(
            """
            SELECT COUNT(f) > 0 FROM StudyFolder f
            WHERE f.ownerUserId = :ownerUserId
              AND f.deletedAt IS NULL
              AND lower(trim(f.name)) = lower(trim(:name))
              AND (
                    (:parentFolderId IS NULL AND f.parentFolderId IS NULL)
                    OR f.parentFolderId = :parentFolderId
                  )
              AND (:excludeId IS NULL OR f.id <> :excludeId)
            """)
    boolean existsActiveDuplicateName(
            @Param("ownerUserId") Long ownerUserId,
            @Param("parentFolderId") Long parentFolderId,
            @Param("name") String name,
            @Param("excludeId") Long excludeId);
}
