"""Prove offline network guard blocks real outbound hosts."""

import httpx
import pytest


def test_offline_network_guard_blocks_generativelanguage_host():
    with pytest.raises(AssertionError, match="forbidden in offline Gemini tests"):
        with httpx.Client() as client:
            client.get("https://generativelanguage.googleapis.com/v1beta/models")
