package com.example.userservice.controller;

import com.example.userservice.knowledge.KnowledgeNoteService;
import com.example.userservice.security.UserPrincipal;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
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

@RestController
@RequestMapping("/api/users/me/knowledge-notes")
@RequiredArgsConstructor
public class KnowledgeNoteController {

    private final KnowledgeNoteService knowledgeNoteService;

    @GetMapping
    public Map<String, Object> list(
            Authentication authentication,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) Long meetingId
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        List<Map<String, Object>> items = meetingId != null
                ? knowledgeNoteService.listForMeeting(principal.userId(), meetingId)
                : knowledgeNoteService.list(principal.userId(), q);
        return Map.of("items", items);
    }

    @PostMapping
    public Map<String, Object> create(
            Authentication authentication,
            @RequestBody Map<String, Object> body
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return knowledgeNoteService.create(principal.userId(), body);
    }

    @PatchMapping("/{id}")
    public Map<String, Object> update(
            Authentication authentication,
            @PathVariable Long id,
            @RequestBody Map<String, Object> body
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return knowledgeNoteService.update(principal.userId(), id, body);
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(
            Authentication authentication,
            @PathVariable Long id
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return knowledgeNoteService.delete(principal.userId(), id);
    }
}
