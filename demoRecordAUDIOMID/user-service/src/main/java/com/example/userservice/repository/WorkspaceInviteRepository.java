package com.example.userservice.repository;

import com.example.userservice.entity.WorkspaceInvite;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface WorkspaceInviteRepository extends JpaRepository<WorkspaceInvite, Long> {

    List<WorkspaceInvite> findByWorkspaceIdAndStatusOrderByCreatedAtDesc(Long workspaceId, String status);

    Optional<WorkspaceInvite> findByWorkspaceIdAndEmailIgnoreCaseAndStatus(Long workspaceId, String email, String status);

    Optional<WorkspaceInvite> findByIdAndWorkspaceId(Long id, Long workspaceId);

    List<WorkspaceInvite> findByEmailIgnoreCaseAndStatusOrderByCreatedAtDesc(String email, String status);
}
