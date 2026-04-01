import json
import os
from pathlib import Path

from jsonschema import Draft7Validator


schema_path = Path("packages/contracts/config.schema.json")
with schema_path.open("r", encoding="utf-8") as f:
    schema = json.load(f)

validator = Draft7Validator(schema)
errors = sorted(validator.iter_errors(dict(os.environ)), key=lambda e: e.path)

if errors:
    print("Invalid runtime config:")
    for error in errors:
        print(f"- {error.message}")
    raise SystemExit(1)

print("Runtime config validation passed.")
