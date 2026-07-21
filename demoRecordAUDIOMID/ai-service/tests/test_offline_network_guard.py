"""Prove offline network guard blocks real outbound hosts."""

import httpx
import pytest


def test_offline_network_guard_blocks_generativelanguage_host():
    with pytest.raises(AssertionError, match="forbidden in offline provider tests"):
        with httpx.Client() as client:
            client.get("https://generativelanguage.googleapis.com/v1beta/models")


def test_offline_network_guard_blocks_example_com():
    with pytest.raises(AssertionError, match="forbidden in offline provider tests"):
        with httpx.Client() as client:
            client.get("https://example.com/")


def test_offline_network_guard_allows_injected_transport():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True})

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        response = client.get("https://example.com/safe-via-mock")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
