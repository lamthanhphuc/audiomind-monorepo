package com.example.meetingservice.controller;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.service.MeetingService;
import lombok.RequiredArgsConstructor;

import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.util.StringUtils;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Objects;

@CrossOrigin(origins = "http://localhost:5173")
@RestController
@RequestMapping("/meetings")
@RequiredArgsConstructor
public class MeetingController {

    private final MeetingService meetingService;

    private final String uploadDir = "uploads/";

    @PostMapping("/upload")
    public Meeting upload(
            @RequestParam String title,
            @RequestParam MultipartFile file) throws IOException {

        Path uploadPath = Paths.get(System.getProperty("user.dir"), uploadDir).toAbsolutePath().normalize();
        Files.createDirectories(uploadPath);

        String originalName = Objects.requireNonNullElse(file.getOriginalFilename(), "audio-upload.bin");
        String cleanedFileName = StringUtils.cleanPath(originalName);
        Path targetFile = uploadPath.resolve(cleanedFileName).normalize();

        file.transferTo(targetFile.toFile());

        return meetingService.saveMeeting(title, targetFile.toString());
    }

    @GetMapping("/{id}")
    public Meeting getById(@PathVariable Long id) {
        return meetingService.findById(id);
    }

    @GetMapping
    public List<Meeting> getRecentMeetings() {
        return meetingService.findRecentMeetings();
    }
}