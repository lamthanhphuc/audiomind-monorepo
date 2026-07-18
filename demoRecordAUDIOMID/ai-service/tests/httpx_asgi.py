"""httpx>=0.28 compatible ASGI test client helpers.

httpx 0.28 made ``ASGITransport`` async-only (no sync ``handle_request``).
These helpers bridge sync tests via ``AsyncClient`` + ``asyncio.run``.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from typing import Any, Iterator, Mapping
from urllib.parse import urljoin

import httpx


def _run_async(coro: Any) -> Any:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    # Nested event loop (rare in pytest): run in a fresh loop on a thread.
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


async def _async_request(
    *,
    app: Any,
    method: str,
    url: str,
    base_url: str,
    raise_app_exceptions: bool,
    root_path: str,
    kwargs: Mapping[str, Any],
) -> httpx.Response:
    transport = httpx.ASGITransport(
        app=app,
        raise_app_exceptions=raise_app_exceptions,
        root_path=root_path,
    )
    async with httpx.AsyncClient(
        transport=transport,
        base_url=base_url,
        follow_redirects=kwargs.pop("follow_redirects", True),
    ) as client:
        return await client.request(method, url, **dict(kwargs))


class CompatTestClient:
    """Drop-in sync TestClient compatible with httpx>=0.28."""

    __test__ = False

    def __init__(
        self,
        app: Any,
        base_url: str = "http://testserver",
        raise_server_exceptions: bool = True,
        root_path: str = "",
        backend: str = "asyncio",
        backend_options: Any = None,
        cookies: Any = None,
        headers: Any = None,
        follow_redirects: bool = True,
    ) -> None:
        del backend, backend_options
        self.app = app
        self.base_url = base_url.rstrip("/") + "/"
        self.raise_server_exceptions = raise_server_exceptions
        self.root_path = root_path
        self.follow_redirects = follow_redirects
        self.cookies = cookies
        self.headers = headers

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        if self.cookies is not None and "cookies" not in kwargs:
            kwargs["cookies"] = self.cookies
        if self.headers is not None and "headers" not in kwargs:
            kwargs["headers"] = self.headers
        kwargs.setdefault("follow_redirects", self.follow_redirects)
        return _run_async(
            _async_request(
                app=self.app,
                method=method,
                url=url,
                base_url=self.base_url,
                raise_app_exceptions=self.raise_server_exceptions,
                root_path=self.root_path,
                kwargs=kwargs,
            )
        )

    def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("POST", url, **kwargs)

    def put(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("PUT", url, **kwargs)

    def patch(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("PATCH", url, **kwargs)

    def delete(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("DELETE", url, **kwargs)

    def __enter__(self) -> "CompatTestClient":
        return self

    def __exit__(self, *args: Any) -> None:
        return None


def create_asgi_client(app: Any, *, base_url: str = "http://test") -> CompatTestClient:
    return CompatTestClient(app, base_url=base_url)


@contextmanager
def asgi_client(app: Any, *, base_url: str = "http://test") -> Iterator[CompatTestClient]:
    client = create_asgi_client(app, base_url=base_url)
    try:
        yield client
    finally:
        pass


def patch_starlette_testclient() -> None:
    import fastapi.testclient as fastapi_testclient
    import starlette.testclient as starlette_testclient

    starlette_testclient.TestClient = CompatTestClient  # type: ignore[misc, assignment]
    fastapi_testclient.TestClient = CompatTestClient  # type: ignore[misc, assignment]
