# Config Validation Runtime (Fail-Fast)

## Node example

Use the runtime validator at:
- packages/tooling/config-validation/validate-config.mjs

Behavior:
1. Load config schema from packages/contracts/config.schema.json
2. Validate process environment against schema
3. Exit with code 1 when invalid

## Python example (ai-api)

Use the runtime validator at:
- packages/tooling/config-validation/validate_config.py

Behavior:
1. Load config schema from packages/contracts/config.schema.json
2. Validate os.environ against schema
3. Exit with code 1 when invalid
