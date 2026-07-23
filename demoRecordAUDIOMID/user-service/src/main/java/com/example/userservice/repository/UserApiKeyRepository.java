package com.example.userservice.repository;

import com.example.userservice.entity.UserApiKey;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserApiKeyRepository extends JpaRepository<UserApiKey, Long> {

    List<UserApiKey> findTop100ByUserIdOrderByCreatedAtDesc(Long userId);

    Optional<UserApiKey> findByIdAndUserId(Long id, Long userId);

    Optional<UserApiKey> findByKeyHashAndRevokedAtIsNull(String keyHash);
}
