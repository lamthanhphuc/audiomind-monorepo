package com.example.meetingservice.controller;

import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.MeetingTaskService;
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
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/meetings/{meetingId}/tasks")
@RequiredArgsConstructor
public class MeetingTaskController {

    private final MeetingTaskService meetingTaskService;

    @GetMapping
    public Map<String, Object> list(
            @PathVariable Long meetingId,
            Authentication authentication
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        List<Map<String, Object>> items = meetingTaskService.listTasks(meetingId, principal.userId());
        return Map.of("meetingId", meetingId, "items", items);
    }

    @PostMapping
    public Map<String, Object> create(
            @PathVariable Long meetingId,
            @RequestBody Map<String, Object> body,
            Authentication authentication
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return meetingTaskService.createTask(meetingId, principal.userId(), body);
    }

    @PostMapping("/seed-from-action-plan")
    public Map<String, Object> seedFromActionPlan(
            @PathVariable Long meetingId,
            @RequestBody Map<String, Object> body,
            Authentication authentication
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        Object groupedActionPlan = body == null ? null : body.get("groupedActionPlan");
        if (!(groupedActionPlan instanceof Map<?, ?> groupedMap)) {
            groupedActionPlan = body == null ? null : body.get("grouped_action_plan");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> grouped = groupedActionPlan instanceof Map<?, ?> map
                ? (Map<String, Object>) map
                : Map.of();
        List<Map<String, Object>> items = meetingTaskService.seedFromGroupedPlan(
                meetingId,
                principal.userId(),
                grouped
        );
        return Map.of("meetingId", meetingId, "items", items, "seeded", items.size());
    }

    @PatchMapping("/{taskId}")
    public Map<String, Object> update(
            @PathVariable Long meetingId,
            @PathVariable Long taskId,
            @RequestBody Map<String, Object> body,
            Authentication authentication
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return meetingTaskService.updateTask(meetingId, principal.userId(), taskId, body);
    }

    @DeleteMapping("/{taskId}")
    public Map<String, Object> delete(
            @PathVariable Long meetingId,
            @PathVariable Long taskId,
            Authentication authentication
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return meetingTaskService.deleteTask(meetingId, principal.userId(), taskId);
    }
}
