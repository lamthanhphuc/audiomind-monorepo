$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
python -m pip install -q -c constraints.txt -r requirements.txt -r requirements-dev.txt
python -m pytest tests/ -q @args
