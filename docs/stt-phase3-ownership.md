# STT Phase 3 Ownership

Phase 3 adds distributed ownership for realtime STT sessions so a meeting stream is processed by one ai-service replica at a time. This protects the Deepgram session, transcript persistence, and finalization path when ai-service is scaled horizontally.

## Why Sticky Routing Is Still Recommended

Sticky routing is still recommended because realtime STT streams are stateful and latency-sensitive. Keeping a meeting on the same ai-service replica avoids unnecessary Redis lease checks on every chunk, reduces cross-replica conflict responses, and keeps in-memory sequence caches, retry guards, and finalization state hot on the owning process.

Distributed ownership is a safety guard for scale-out and routing failures, not a replacement for routing affinity. If a load balancer sends chunk `N` to a different replica, that replica should reject the request instead of opening a second Deepgram stream or writing competing transcript fragments.

## Redis Distributed Ownership

Each active meeting STT stream acquires a Redis lease before creating a `MeetingSessionActor`. The lease stores:

- meeting key
- owner replica id
- random owner token
- fencing token

Only the owner with the matching lease can enqueue audio, receive transcript events, persist fragments, finalize, and close the upstream STT session. Actor watchdog and processing paths refresh the lease. If refresh or validation fails, the actor marks ownership as lost, fails pending chunk/finalization waiters, and avoids closing a session it no longer owns.

When another replica receives a chunk for an already-owned meeting, it returns a conflict instead of processing the stream. Shared Redis cooldown state also prevents rapid reconnect loops from moving between replicas and bypassing the local retry guard.

## Environment Variables

- `STT_ENABLE_DISTRIBUTED_OWNERSHIP`: primary rollout and rollback flag. Set `false` to disable Redis ownership checks.
- `STT_OWNERSHIP_ENABLED`: legacy compatibility flag. `STT_ENABLE_DISTRIBUTED_OWNERSHIP` takes precedence when both are set.
- `STT_OWNERSHIP_REDIS_URL`: Redis URL for ownership leases and shared cooldowns. Defaults to `JOB_STATE_REDIS_URL` when empty.
- `STT_REPLICA_ID`: optional stable replica identity. Leave blank to generate a process-local UUID.
- `STT_OWNERSHIP_LEASE_TTL_SECONDS`: Redis lease TTL.
- `STT_OWNERSHIP_COOLDOWN_TTL_SECONDS`: Redis TTL for shared reconnect cooldown markers.

## Rollout Plan

1. Deploy with sticky routing enabled and `STT_ENABLE_DISTRIBUTED_OWNERSHIP=true`.
2. Confirm Redis connectivity from every ai-service replica.
3. Watch ownership metrics and logs for acquire conflicts, lease loss, release skips, and cooldown hits.
4. Scale ai-service gradually while sending one meeting stream through the load balancer.
5. Confirm duplicate chunks are rejected by non-owning replicas and that final `seq=-1` still finalizes on the owner.

## Rollback

Set:

```text
STT_ENABLE_DISTRIBUTED_OWNERSHIP=false
```

Then restart ai-service replicas. Sticky routing should remain enabled during rollback because disabling distributed ownership removes the wrong-replica protection.

## Redis Availability Risk

With distributed ownership enabled, Redis availability is on the realtime STT write path. If Redis is unavailable during lease acquire or cooldown read, ai-service returns a service-unavailable response instead of risking duplicate owners. Existing owners that cannot refresh their lease mark ownership as lost and fail pending waiters. This favors transcript correctness over accepting ambiguous writes.

Mitigations:

- run Redis with the same availability target as the realtime STT path
- keep sticky routing enabled to reduce ownership conflicts
- monitor Redis latency and ownership failure metrics
- use the rollback flag only if Redis instability is worse than the risk of duplicate STT owners
