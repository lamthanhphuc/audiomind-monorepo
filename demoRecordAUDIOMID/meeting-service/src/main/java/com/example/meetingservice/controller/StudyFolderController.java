package com.example.meetingservice.controller;

import com.example.meetingservice.controller.dto.CreateStudyFolderRequest;
import com.example.meetingservice.controller.dto.StudyFolderResponse;
import com.example.meetingservice.controller.dto.StudyFolderTreeResponse;
import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.StudyFolderService;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/study-folders")
public class StudyFolderController {

    private final StudyFolderService studyFolderService;

    public StudyFolderController(StudyFolderService studyFolderService) {
        this.studyFolderService = studyFolderService;
    }

    @PostMapping
    public StudyFolderResponse create(
            @RequestBody CreateStudyFolderRequest request, Authentication authentication) {
        return studyFolderService.create(requirePrincipal(authentication).userId(), request);
    }

    @GetMapping
    public List<StudyFolderResponse> list(Authentication authentication) {
        return studyFolderService.list(requirePrincipal(authentication).userId());
    }

    @GetMapping("/tree")
    public StudyFolderTreeResponse tree(Authentication authentication) {
        return studyFolderService.tree(requirePrincipal(authentication).userId());
    }

    @GetMapping("/{folderId}")
    public StudyFolderResponse get(@PathVariable Long folderId, Authentication authentication) {
        return studyFolderService.get(folderId, requirePrincipal(authentication).userId());
    }

    @PatchMapping("/{folderId}")
    public StudyFolderResponse update(
            @PathVariable Long folderId,
            @RequestBody Map<String, Object> payload,
            Authentication authentication) {
        return studyFolderService.update(folderId, requirePrincipal(authentication).userId(), payload);
    }

    @DeleteMapping("/{folderId}")
    public StudyFolderResponse delete(@PathVariable Long folderId, Authentication authentication) {
        return studyFolderService.delete(folderId, requirePrincipal(authentication).userId());
    }

    private UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }
}
