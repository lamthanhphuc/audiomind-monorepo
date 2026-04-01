# Config Loader Pattern

## Goal
Load env -> validate against schema -> fail if invalid -> inject to app.

## Flow
1. Load environment variables from process and optional env file.
2. Parse to typed config object.
3. Validate with `packages/contracts/config.schema.json`.
4. If validation fails, log clear errors and stop startup.
5. If validation passes, expose immutable config to app layers.

## Notes
- Validation should run before DB/network initialization.
- Do not allow default values for critical secrets unless explicitly approved.
- Keep schema versioned and reviewed in PR.
