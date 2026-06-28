package com.example.userservice.repository;

import com.example.userservice.entity.TeamsOAuthGrant;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface TeamsOAuthGrantRepository extends JpaRepository<TeamsOAuthGrant, Long> {

    Optional<TeamsOAuthGrant> findByUserIdAndRevokedAtIsNull(Long userId);

    Optional<TeamsOAuthGrant> findByTeamsUserIdAndRevokedAtIsNull(String teamsUserId);
}
