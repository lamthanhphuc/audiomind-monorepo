package com.example.meetingservice.controller;

import com.example.meetingservice.controller.dto.CreateSubjectRequest;
import com.example.meetingservice.controller.dto.PageResponse;
import com.example.meetingservice.controller.dto.SubjectDetailResponse;
import com.example.meetingservice.controller.dto.SubjectMeetingResponse;
import com.example.meetingservice.controller.dto.SubjectResponse;
import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.SubjectService;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/subjects")
public class SubjectController {

    private final SubjectService subjectService;

    public SubjectController(SubjectService subjectService) {
        this.subjectService = subjectService;
    }

    @PostMapping
    public SubjectResponse create(
            @RequestBody CreateSubjectRequest request, Authentication authentication) {
        return subjectService.create(requirePrincipal(authentication).userId(), request);
    }

    @GetMapping
    public PageResponse<SubjectResponse> list(
            @RequestParam(required = false) Long folderId,
            @RequestParam(required = false) String search,
            @RequestParam(defaultValue = "false") boolean archived,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer pageSize,
            @RequestParam(required = false) String sort,
            Authentication authentication) {
        return subjectService.list(
                requirePrincipal(authentication).userId(),
                folderId,
                search,
                archived,
                page,
                pageSize,
                sort);
    }

    @GetMapping("/{subjectId}")
    public SubjectDetailResponse get(@PathVariable Long subjectId, Authentication authentication) {
        return subjectService.get(subjectId, requirePrincipal(authentication).userId());
    }

    @PatchMapping("/{subjectId}")
    public SubjectResponse update(
            @PathVariable Long subjectId,
            @RequestBody Map<String, Object> payload,
            Authentication authentication) {
        return subjectService.update(subjectId, requirePrincipal(authentication).userId(), payload);
    }

    @DeleteMapping("/{subjectId}")
    public SubjectResponse archive(@PathVariable Long subjectId, Authentication authentication) {
        return subjectService.archive(subjectId, requirePrincipal(authentication).userId());
    }

    @GetMapping("/{subjectId}/meetings")
    public PageResponse<SubjectMeetingResponse> listMeetings(
            @PathVariable Long subjectId,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer pageSize,
            Authentication authentication) {
        return subjectService.listMeetings(
                subjectId, requirePrincipal(authentication).userId(), page, pageSize);
    }

    private UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }
}
