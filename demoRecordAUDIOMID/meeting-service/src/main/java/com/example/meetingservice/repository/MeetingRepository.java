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

	@Query("""
			SELECT m FROM Meeting m
			WHERE m.ownerUserId = :ownerUserId
			  AND m.subjectId IS NULL
			  AND m.deletedAt IS NULL
			  AND (
			        :search IS NULL
			        OR lower(m.title) LIKE lower(concat('%', :search, '%'))
			        OR lower(coalesce(m.originalFileName, '')) LIKE lower(concat('%', :search, '%'))
			      )
			""")
	Page<Meeting> findUnclassifiedForOwner(
			@Param("ownerUserId") Long ownerUserId,
			@Param("search") String search,
			Pageable pageable);
}
