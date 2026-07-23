package com.example.userservice.repository;

import com.example.userservice.entity.Workspace;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface WorkspaceRepository extends JpaRepository<Workspace, Long> {

    List<Workspace> findByOwnerUserIdOrderByCreatedAtAsc(Long ownerUserId);
}
