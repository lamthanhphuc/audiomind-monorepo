package com.example.userservice.repository;

import com.example.userservice.entity.WorkspaceMember;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface WorkspaceMemberRepository extends JpaRepository<WorkspaceMember, Long> {

    List<WorkspaceMember> findByWorkspaceIdOrderByCreatedAtAsc(Long workspaceId);

    List<WorkspaceMember> findByUserIdOrderByCreatedAtAsc(Long userId);

    Optional<WorkspaceMember> findByWorkspaceIdAndUserId(Long workspaceId, Long userId);

    void deleteByWorkspaceIdAndUserId(Long workspaceId, Long userId);
}
