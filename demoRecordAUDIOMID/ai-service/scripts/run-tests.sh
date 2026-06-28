#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
pip install -q -c constraints.txt -r requirements.txt -r requirements-dev.txt
python -m pytest tests/ -q "$@"
