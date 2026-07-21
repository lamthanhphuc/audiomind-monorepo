# Gemini key rotation and billing recovery

Gemini secrets must be stored in the deployment secret manager or VPS environment,
never in source, test fixtures, startup probes, or support logs.

1. Set `GEMINI_API_KEY=<set-in-secret-manager>` for one key, or set
   `GEMINI_API_KEYS=<configured-in-secret-manager>` plus a complete
   `GEMINI_KEY_PROJECT_GROUPS` alias mapping.
2. Keep `GEMINI_CROSS_PROJECT_FAILOVER_ENABLED=false` unless an operator has
   explicitly approved cross-project spend.
   Set `GEMINI_COST_GUARD_NAMESPACE` to a short environment-specific value such
   as `production-audiomind`; staging and production must not share counters.
3. Reload or restart only the AI API/worker processes using the existing deployment
   procedure. Startup validates configuration but never probes Gemini.
4. Shared key state is fingerprint-scoped. Rotating the secret creates a new scope;
   old billing cooldown state expires by TTL and cannot block the new fingerprint.
   Do not flush Redis or delete unrelated job state.
5. Confirm logs show only configured aliases/project groups. API key values and
   Authorization headers must never be printed.

A replacement key does not require an embeddings migration and must not be tested by
calling `generateContent` during deployment validation.
