package com.example.meetingservice.service;

import com.example.meetingservice.client.InternalUserLookupClient;
import com.example.meetingservice.client.ShareNotificationClient;
import com.example.meetingservice.client.ShareNotificationResponse;
import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.entity.MeetingShare;
import com.example.meetingservice.entity.MeetingShareInvite;
import com.example.meetingservice.repository.MeetingRepository;
import com.example.meetingservice.repository.MeetingShareInviteRepository;
import com.example.meetingservice.repository.MeetingShareRepository;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
@Slf4j
public class MeetingShareService {

    public static final String ROLE_VIEWER = "VIEWER";
    public static final String STATUS_ACTIVE = "ACTIVE";
    public static final String STATUS_PENDING = "PENDING";
    public static final String STATUS_ACCEPTED = "ACCEPTED";

    private final MeetingRepository meetingRepository;
    private final MeetingShareRepository meetingShareRepository;
    private final MeetingShareInviteRepository meetingShareInviteRepository;
    private final InternalUserLookupClient userLookupClient;
    private final ShareNotificationClient shareNotificationClient;

    public List<Map<String, Object>> listShares(Long meetingId, Long ownerUserId) {
        assertOwner(meetingId, ownerUserId);
        List<Map<String, Object>> views = new ArrayList<>();
        meetingShareRepository.findByMeetingIdOrderByCreatedAtAsc(meetingId).stream()
                .map(this::toActiveShareView)
                .forEach(views::add);
        meetingShareInviteRepository.findByMeetingIdAndStatusOrderByCreatedAtAsc(meetingId, STATUS_PENDING).stream()
                .map(this::toPendingInviteView)
                .forEach(views::add);
        return views;
    }

    public Map<String, Object> inviteByEmail(Long meetingId, Long ownerUserId, String email, String role) {
        assertOwner(meetingId, ownerUserId);
        String normalizedEmail = normalizeEmail(email);
        if (normalizedEmail == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Valid email is required");
        }
        assertNotSelfInvite(ownerUserId, normalizedEmail);

        Optional<Map<String, Object>> existingUser = userLookupClient.lookupByEmailOptional(normalizedEmail);
        if (existingUser.isPresent()) {
            return inviteExistingUser(meetingId, ownerUserId, normalizedEmail, role, existingUser.get());
        }
        return invitePendingUser(meetingId, ownerUserId, normalizedEmail, role);
    }

    public void revokeShare(Long meetingId, Long ownerUserId, Long sharedWithUserId) {
        assertOwner(meetingId, ownerUserId);
        if (!meetingShareRepository.existsByMeetingIdAndSharedWithUserId(meetingId, sharedWithUserId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Share not found");
        }
        meetingShareRepository.deleteByMeetingIdAndSharedWithUserId(meetingId, sharedWithUserId);
    }

    @Transactional
    public void revokePendingInvite(Long meetingId, Long ownerUserId, String email) {
        assertOwner(meetingId, ownerUserId);
        String normalizedEmail = normalizeEmail(email);
        if (normalizedEmail == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Valid email is required");
        }
        if (!meetingShareInviteRepository.existsByMeetingIdAndInviteeEmailAndStatus(
                meetingId,
                normalizedEmail,
                STATUS_PENDING
        )) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Pending invite not found");
        }
        meetingShareInviteRepository.deleteByMeetingIdAndInviteeEmailAndStatus(
                meetingId,
                normalizedEmail,
                STATUS_PENDING
        );
    }

    @Transactional
    public Map<String, Object> acceptPendingInvitesForUser(Long userId, String email) {
        String normalizedEmail = normalizeEmail(email);
        if (normalizedEmail == null || userId == null) {
            return Map.of("acceptedCount", 0);
        }

        List<MeetingShareInvite> pendingInvites = meetingShareInviteRepository
                .findByInviteeEmailAndStatusOrderByCreatedAtAsc(normalizedEmail, STATUS_PENDING);
        int acceptedCount = 0;
        for (MeetingShareInvite invite : pendingInvites) {
            if (acceptPendingInvite(invite, userId)) {
                acceptedCount++;
            }
        }
        if (!pendingInvites.isEmpty()) {
            meetingShareInviteRepository.saveAll(pendingInvites);
        }
        log.info(
                "event=MEETING_SHARE_PENDING_ACCEPTED userId={} email={} acceptedCount={}",
                userId,
                normalizedEmail,
                acceptedCount
        );
        return Map.of("acceptedCount", acceptedCount);
    }

    public boolean hasAccess(Long meetingId, Long userId) {
        if (userId == null) {
            return false;
        }
        if (meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(meetingId, userId).isPresent()) {
            return true;
        }
        return meetingShareRepository.existsByMeetingIdAndSharedWithUserId(meetingId, userId)
                && meetingRepository.findById(meetingId)
                .filter(meeting -> meeting.getDeletedAt() == null)
                .isPresent();
    }

    public Meeting requireReadableMeeting(Long meetingId, Long userId) {
        if (meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(meetingId, userId).isPresent()) {
            return meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(meetingId, userId).orElseThrow();
        }
        if (meetingShareRepository.existsByMeetingIdAndSharedWithUserId(meetingId, userId)) {
            return meetingRepository.findById(meetingId)
                    .filter(meeting -> meeting.getDeletedAt() == null)
                    .orElseThrow(() -> new NoSuchElementException("Meeting not found: " + meetingId));
        }
        throw new NoSuchElementException("Meeting not found: " + meetingId);
    }

    private Map<String, Object> inviteExistingUser(
            Long meetingId,
            Long ownerUserId,
            String normalizedEmail,
            String role,
            Map<String, Object> user
    ) {
        Long targetUserId = Long.valueOf(String.valueOf(user.get("userId")));
        if (Objects.equals(targetUserId, ownerUserId)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot share meeting with yourself");
        }
        if (meetingShareRepository.existsByMeetingIdAndSharedWithUserId(meetingId, targetUserId)) {
            Map<String, Object> view = toActiveShareView(
                    meetingShareRepository.findByMeetingIdAndSharedWithUserId(meetingId, targetUserId).orElseThrow()
            );
            view.put("email", user.get("email"));
            return view;
        }

        MeetingShare share = new MeetingShare();
        share.setMeetingId(meetingId);
        share.setSharedWithUserId(targetUserId);
        share.setRole(normalizeRole(role));
        share.setInvitedByUserId(ownerUserId);
        share.setCreatedAt(LocalDateTime.now());
        MeetingShare saved = meetingShareRepository.save(share);

        Map<String, Object> view = toActiveShareView(saved);
        view.put("email", user.get("email"));
        Meeting meeting = meetingRepository.findById(meetingId).orElse(null);
        String meetingTitle = meeting == null ? null : meeting.getTitle();
        shareNotificationClient.notifyMeetingShare(
                targetUserId,
                ownerUserId,
                meetingId,
                meetingTitle,
                share.getRole()
        );
        log.info(
                "event=MEETING_SHARE_INVITED meetingId={} ownerUserId={} inviteeUserId={} inviteeEmail={} role={}",
                meetingId,
                ownerUserId,
                targetUserId,
                user.get("email"),
                share.getRole()
        );
        return view;
    }

    private Map<String, Object> invitePendingUser(
            Long meetingId,
            Long ownerUserId,
            String normalizedEmail,
            String role
    ) {
        Optional<MeetingShareInvite> existingInvite = meetingShareInviteRepository
                .findByMeetingIdAndInviteeEmailAndStatus(meetingId, normalizedEmail, STATUS_PENDING);
        if (existingInvite.isPresent()) {
            Meeting meeting = meetingRepository.findById(meetingId).orElse(null);
            String meetingTitle = meeting == null ? null : meeting.getTitle();
            ShareNotificationResponse notification = shareNotificationClient.notifyPendingMeetingShareInvite(
                    normalizedEmail,
                    ownerUserId,
                    meetingId,
                    meetingTitle,
                    existingInvite.get().getRole()
            );
            log.info(
                    "event=MEETING_SHARE_PENDING_RESENT meetingId={} ownerUserId={} inviteeEmail={} role={} emailSent={} emailChannel={}",
                    meetingId,
                    ownerUserId,
                    normalizedEmail,
                    existingInvite.get().getRole(),
                    notification.sent(),
                    notification.channel()
            );
            Map<String, Object> view = toPendingInviteView(existingInvite.get());
            enrichEmailFields(view, notification);
            return view;
        }

        MeetingShareInvite invite = new MeetingShareInvite();
        invite.setMeetingId(meetingId);
        invite.setInviteeEmail(normalizedEmail);
        invite.setRole(normalizeRole(role));
        invite.setInvitedByUserId(ownerUserId);
        invite.setStatus(STATUS_PENDING);
        invite.setCreatedAt(LocalDateTime.now());
        MeetingShareInvite saved = meetingShareInviteRepository.save(invite);

        Meeting meeting = meetingRepository.findById(meetingId).orElse(null);
        String meetingTitle = meeting == null ? null : meeting.getTitle();
        ShareNotificationResponse notification = shareNotificationClient.notifyPendingMeetingShareInvite(
                normalizedEmail,
                ownerUserId,
                meetingId,
                meetingTitle,
                invite.getRole()
        );
        log.info(
                "event=MEETING_SHARE_PENDING_INVITED meetingId={} ownerUserId={} inviteeEmail={} role={} emailSent={} emailChannel={}",
                meetingId,
                ownerUserId,
                normalizedEmail,
                invite.getRole(),
                notification.sent(),
                notification.channel()
        );
        Map<String, Object> view = toPendingInviteView(saved);
        enrichEmailFields(view, notification);
        return view;
    }

    private void enrichEmailFields(Map<String, Object> view, ShareNotificationResponse notification) {
        view.put("emailSent", notification.sent());
        view.put("emailChannel", notification.channel());
        view.put("requiresGmailScope", notification.requiresGmailScope());
        if (notification.emailFrom() != null) {
            view.put("emailFrom", notification.emailFrom());
        }
    }

    private boolean acceptPendingInvite(MeetingShareInvite invite, Long userId) {
        Optional<Meeting> meetingOptional = meetingRepository.findById(invite.getMeetingId());
        if (meetingOptional.isEmpty() || meetingOptional.get().getDeletedAt() != null) {
            invite.setStatus("EXPIRED");
            return false;
        }
        Meeting meeting = meetingOptional.get();
        if (Objects.equals(meeting.getOwnerUserId(), userId)) {
            invite.setStatus(STATUS_ACCEPTED);
            invite.setAcceptedAt(LocalDateTime.now());
            return false;
        }
        if (meetingShareRepository.existsByMeetingIdAndSharedWithUserId(invite.getMeetingId(), userId)) {
            invite.setStatus(STATUS_ACCEPTED);
            invite.setAcceptedAt(LocalDateTime.now());
            return false;
        }

        MeetingShare share = new MeetingShare();
        share.setMeetingId(invite.getMeetingId());
        share.setSharedWithUserId(userId);
        share.setRole(invite.getRole());
        share.setInvitedByUserId(invite.getInvitedByUserId());
        share.setCreatedAt(LocalDateTime.now());
        meetingShareRepository.save(share);

        invite.setStatus(STATUS_ACCEPTED);
        invite.setAcceptedAt(LocalDateTime.now());

        shareNotificationClient.notifyMeetingShare(
                userId,
                invite.getInvitedByUserId(),
                invite.getMeetingId(),
                meeting.getTitle(),
                invite.getRole()
        );
        return true;
    }

    private void assertNotSelfInvite(Long ownerUserId, String normalizedEmail) {
        userLookupClient.lookupByUserIdOptional(ownerUserId).ifPresent(owner -> {
            String ownerEmail = normalizeEmail(String.valueOf(owner.get("email")));
            if (Objects.equals(ownerEmail, normalizedEmail)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot share meeting with yourself");
            }
        });
    }

    private void assertOwner(Long meetingId, Long ownerUserId) {
        meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(meetingId, ownerUserId)
                .orElseThrow(() -> new NoSuchElementException("Meeting not found: " + meetingId));
    }

    private Map<String, Object> toActiveShareView(MeetingShare share) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", share.getId());
        view.put("meetingId", share.getMeetingId());
        view.put("sharedWithUserId", share.getSharedWithUserId());
        view.put("role", share.getRole());
        view.put("invitedByUserId", share.getInvitedByUserId());
        view.put("createdAt", share.getCreatedAt());
        view.put("status", STATUS_ACTIVE);
        enrichShareViewWithUserProfile(view, share.getSharedWithUserId());
        return view;
    }

    private void enrichShareViewWithUserProfile(Map<String, Object> view, Long userId) {
        userLookupClient.lookupByUserIdOptional(userId).ifPresent(user -> {
            Object email = user.get("email");
            Object username = user.get("username");
            if (email != null && !String.valueOf(email).isBlank()) {
                view.put("email", String.valueOf(email));
            }
            if (username != null && !String.valueOf(username).isBlank()) {
                view.put("username", String.valueOf(username));
            }
        });
    }

    private Map<String, Object> toPendingInviteView(MeetingShareInvite invite) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", invite.getId());
        view.put("meetingId", invite.getMeetingId());
        view.put("email", invite.getInviteeEmail());
        view.put("role", invite.getRole());
        view.put("invitedByUserId", invite.getInvitedByUserId());
        view.put("createdAt", invite.getCreatedAt());
        view.put("status", STATUS_PENDING);
        return view;
    }

    private String normalizeEmail(String email) {
        if (email == null) {
            return null;
        }
        String trimmed = email.trim().toLowerCase(Locale.ROOT);
        return trimmed.isBlank() ? null : trimmed;
    }

    private String normalizeRole(String role) {
        if (role == null || role.isBlank()) {
            return ROLE_VIEWER;
        }
        return role.trim().toUpperCase(Locale.ROOT);
    }
}
