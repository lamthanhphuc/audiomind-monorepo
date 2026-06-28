package com.example.userservice.repository;

import com.example.userservice.entity.UserSpeakerMemory;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserSpeakerMemoryRepository extends JpaRepository<UserSpeakerMemory, Long> {

    Optional<UserSpeakerMemory> findByUserIdAndSpeakerFingerprint(Long userId, String speakerFingerprint);

    List<UserSpeakerMemory> findTop20ByUserIdOrderByUsageCountDescUpdatedAtDesc(Long userId);
}
