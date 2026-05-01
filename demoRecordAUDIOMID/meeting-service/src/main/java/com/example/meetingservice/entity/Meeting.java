package com.example.meetingservice.entity;


import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Column;
import lombok.Data;

import java.time.LocalDateTime;

@Entity
@Data
public class Meeting {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String title;

    @Column(name = "audio_path")
    private String audioPath;

    @Column(name = "original_file_name")
    private String originalFileName;

    @Column(name = "owner_user_id")
    private Long ownerUserId;

    @Column(name = "created_at")
    private LocalDateTime createdAt;
}
