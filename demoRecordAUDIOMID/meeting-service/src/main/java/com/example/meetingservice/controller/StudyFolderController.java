package com.example.meetingservice.controller;

import com.example.meetingservice.client.PlanEntitlementClient;
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
    private final PlanEntitlementClient planEntitlementClient;

    public StudyFolderController(
            StudyFolderService studyFolderService,
            PlanEntitlementClient planEntitlementClient) {
        this.studyFolderService = studyFolderService;
        this.planEntitlementClient = planEntitlementClient;
    }

    @PostMapping
    public StudyFolderResponse create(
            @RequestBody CreateStudyFolderRequest request, Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        requireStudyFolders(principal);
        return studyFolderService.create(principal.userId(), request);
    }

    @GetMapping
    public List<StudyFolderResponse> list(Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        requireStudyFolders(principal);
        return studyFolderService.list(principal.userId());
    }

    @GetMapping("/tree")
    public StudyFolderTreeResponse tree(Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        requireStudyFolders(principal);
        return studyFolderService.tree(principal.userId());
    }

    @GetMapping("/{folderId}")
    public StudyFolderResponse get(@PathVariable Long folderId, Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        requireStudyFolders(principal);
        return studyFolderService.get(folderId, principal.userId());
    }

    @PatchMapping("/{folderId}")
    public StudyFolderResponse update(
            @PathVariable Long folderId,
            @RequestBody Map<String, Object> payload,
            Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        requireStudyFolders(principal);
        return studyFolderService.update(folderId, principal.userId(), payload);
    }

    @DeleteMapping("/{folderId}")
    public StudyFolderResponse delete(@PathVariable Long folderId, Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        requireStudyFolders(principal);
        return studyFolderService.delete(folderId, principal.userId());
    }

    private void requireStudyFolders(UserPrincipal principal) {
        planEntitlementClient.requireFeature(principal.userId(), "studyFolders");
    }

    private UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }
}
