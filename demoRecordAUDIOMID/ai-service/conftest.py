"""Root conftest so top-level modules like ``test_api.py`` get httpx 0.28 TestClient patch."""

from tests.httpx_asgi import patch_starlette_testclient

patch_starlette_testclient()
