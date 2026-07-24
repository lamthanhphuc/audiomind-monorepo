package com.example.meetingservice.repository;

import com.example.meetingservice.entity.Meeting;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface MeetingRepository extends JpaRepository<Meeting,Long> {
	List<Meeting> findTop20ByOrderByIdDesc();
	List<Meeting> findTop20ByOwnerUserIdOrderByIdDesc(Long ownerUserId);
	Optional<Meeting> findByIdAndOwnerUserId(Long id, Long ownerUserId);
	Optional<Meeting> findByIdAndOwnerUserIdAndDeletedAtIsNull(Long id, Long ownerUserId);
	List<Meeting> findByOwnerUserIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(Long ownerUserId);
	List<Meeting> findByOwnerUserIdAndDeletedAtIsNullOrderByCreatedAtAscIdAsc(Long ownerUserId);
	long countByOwnerUserIdAndDeletedAtIsNull(Long ownerUserId);
	Optional<Meeting> findFirstByOwnerUserIdAndAudioHashAndDeletedAtIsNullOrderByIdDesc(Long ownerUserId, String audioHash);

	long countBySubjectIdAndOwnerUserIdAndDeletedAtIsNull(Long subjectId, Long ownerUserId);

	Page<Meeting> findBySubjectIdAndOwnerUserIdAndDeletedAtIsNullOrderByCreatedAtDescIdDesc(
			Long subjectId, Long ownerUserId, Pageable pageable);

	@Modifying(clearAutomatically = true, flushAutomatically = true)
	@Query("""
			UPDATE Meeting m
			SET m.subjectId = NULL
			WHERE m.subjectId = :subjectId
			  AND m.ownerUserId = :ownerUserId
			""")
	int clearSubjectAssignmentsForOwner(
			@Param("subjectId") Long subjectId, @Param("ownerUserId") Long ownerUserId);

	Page<Meeting> findByOwnerUserIdAndSubjectIdIsNullAndDeletedAtIsNull(
			Long ownerUserId, Pageable pageable);

	/**
	 * Search-only unclassified listing. Callers must pass a non-null {@code pattern}
	 * already wrapped as {@code %term%} — avoids Hibernate/Postgres binding
	 * {@code concat('%', :search, '%')} as bytea when {@code search} is null.
	 */
	@Query("""
			SELECT m FROM Meeting m
			WHERE m.ownerUserId = :ownerUserId
			  AND m.subjectId IS NULL
			  AND m.deletedAt IS NULL
			  AND (
			        lower(m.title) LIKE lower(:pattern)
			        OR (m.originalFileName IS NOT NULL AND lower(m.originalFileName) LIKE lower(:pattern))
			      )
			""")
	Page<Meeting> findUnclassifiedForOwner(
			@Param("ownerUserId") Long ownerUserId,
			@Param("pattern") String pattern,
			Pageable pageable);
}
