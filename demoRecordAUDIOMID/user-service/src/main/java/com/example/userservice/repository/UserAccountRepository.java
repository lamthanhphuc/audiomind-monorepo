package com.example.userservice.repository;

import com.example.userservice.entity.UserAccount;
import java.time.Instant;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserAccountRepository extends JpaRepository<UserAccount, Long> {
    Optional<UserAccount> findByUsername(String username);
    Optional<UserAccount> findByEmailIgnoreCase(String email);
    boolean existsByUsername(String username);
    boolean existsByEmail(String email);
    long countByPlanIgnoreCase(String plan);
    long countByUpdatedAtAfter(Instant cutoff);
}
