import asyncio
from ipaddress import ip_network
from os import environ
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from anyio import CapacityLimiter
from fastapi import Request
from fastapi.testclient import TestClient
from redis.exceptions import ConnectionError

from backend import auth
from backend.login_throttle import LoginThrottle
from backend.main import app

PATH = "/api/v1/auth/login"
INVALID_LOGIN = {"username": "sentinel-user", "password": "sentinel-password"}


@pytest.mark.parametrize(("peer", "headers", "proxy_cidrs", "expected"), [
    ("127.0.0.1", ["192.0.2.3"], (), "127.0.0.1"),
    ("10.0.0.3", ["192.0.2.3, 198.51.100.9, 10.1.0.2"], ("10.0.0.0/8",), "198.51.100.9"),
    ("10.0.0.3", ["192.0.2.3", "198.51.100.9, 10.1.0.2"], ("10.0.0.0/8",), "198.51.100.9"),
    ("10.0.0.3", ["198.51.100.9, not-an-ip"], ("10.0.0.0/8",), "invalid-forwarded"),
    ("10.0.0.3", ["10.1.0.2"], ("10.0.0.0/8",), "invalid-forwarded"),
    ("10.0.0.3", ["x" * 3000 + ", 198.51.100.9, 10.1.0.2"], ("10.0.0.0/8",), "198.51.100.9"),
    ("10.0.0.3", ["x" * 3000, "198.51.100.9, 10.1.0.2"], ("10.0.0.0/8",), "198.51.100.9"),
    ("10.0.0.3", ["x" * 3000 + ", 10.1.0.2"], ("10.0.0.0/8",), "invalid-forwarded"),
    ("::ffff:192.0.2.1", [], (), "192.0.2.1"),
])
def test_throttle_key_uses_rightmost_untrusted_hop_only(peer, headers, proxy_cidrs, expected):
    request = Request({
        "type": "http", "client": (peer, 12345), "headers": [(b"x-forwarded-for", value.encode()) for value in headers],
    })
    throttle = LoginThrottle(2, 60, tuple(map(ip_network, proxy_cidrs)))
    assert throttle.client_key(request) == expected


@pytest.mark.parametrize("failure", [None, ConnectionError(), TimeoutError()])
def test_throttle_rejection_or_outage_does_not_hash(monkeypatch, failure):
    issue = AsyncMock()
    monkeypatch.setattr(auth, "issue_session", issue)
    monkeypatch.setattr(app.state, "redis", object(), raising=False)
    throttle = LoginThrottle(2, 60)
    monkeypatch.setattr(app.state, "login_throttle", throttle, raising=False)
    eval_result = AsyncMock(return_value=12, side_effect=failure)
    monkeypatch.setattr(LoginThrottle, "retry_after", eval_result)

    response = TestClient(app).post(PATH, json=INVALID_LOGIN)
    if failure is None:
        assert response.status_code == 429
        assert response.headers["Retry-After"] == "12"
        assert response.json() == {"detail": "Too many login attempts"}
    else:
        assert response.status_code == 503
        assert response.json() == {"detail": "Login temporarily unavailable"}
    issue.assert_not_awaited()


def test_scrypt_capacity_rejects_excess_requests_without_hashing(monkeypatch):
    issue = AsyncMock()
    monkeypatch.setattr(auth, "issue_session", issue)
    monkeypatch.setattr(app.state, "redis", object(), raising=False)
    monkeypatch.setattr(app.state, "login_throttle", LoginThrottle(2, 60), raising=False)
    monkeypatch.setattr(LoginThrottle, "retry_after", AsyncMock(return_value=0))

    async def test():
        capacity = CapacityLimiter(1)
        monkeypatch.setattr(app.state, "login_capacity", capacity, raising=False)
        capacity.acquire_on_behalf_of_nowait(object())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://api") as client:
            response = await client.post(PATH, json=INVALID_LOGIN)
        assert response.status_code == 503
        issue.assert_not_awaited()

    asyncio.run(test())


@pytest.mark.skipif(not environ.get("QT_TEST_API_URL"), reason="requires the Compose database and Redis")
@pytest.mark.parametrize("trusted", [False, True])
def test_compose_login_throttle_and_window_reset(monkeypatch, trusted):
    monkeypatch.setenv("QT_LOGIN_LIMIT", "2")
    monkeypatch.setenv("QT_LOGIN_WINDOW_SECONDS", "3")
    monkeypatch.setenv("QT_TRUSTED_PROXY_CIDRS", "10.0.0.0/8" if trusted else "")
    monkeypatch.setenv("QT_REDIS_URL", environ["QT_REDIS_URL"].rsplit("/", 1)[0] + "/15")
    suffix = ":".join(uuid4().hex[i:i + 4] for i in range(0, 16, 4))

    async def test():
        peer = "10.0.0.2" if trusted else f"2001:db8:1:1:{suffix}"
        same_client = f"2001:db8:2:2:{suffix}"

        def proxy_header(spoof):
            chain = f"{spoof}, {same_client}, 10.0.0.3" if trusted else spoof
            return {"X-Forwarded-For": chain}

        transport = httpx.ASGITransport(app=app, client=(peer, 12345))
        async with app.router.lifespan_context(app), httpx.AsyncClient(transport=transport, base_url="http://api") as api:
            for spoof in ("192.0.2.1", "192.0.2.2"):
                response = await api.post(PATH, json=INVALID_LOGIN, headers=proxy_header(spoof))
                assert response.status_code == 401
            blocked = await api.post(PATH, json=INVALID_LOGIN, headers=proxy_header("x" * 3000))
            assert blocked.status_code == 429
            assert blocked.json() == {"detail": "Too many login attempts"}
            assert 1 <= int(blocked.headers["Retry-After"]) <= 3

            if trusted:
                other_client = f"2001:db8:3:3:{suffix}"
                other = await api.post(PATH, json=INVALID_LOGIN, headers={"X-Forwarded-For": other_client})
                assert other.status_code == 401
            await asyncio.sleep(int(blocked.headers["Retry-After"]) + 0.1)
            logged_in = await api.post(PATH, json={
                "username": environ["QT_ADMIN_USERNAME"], "password": environ["QT_ADMIN_PASSWORD"],
            }, headers=proxy_header("192.0.2.4"))
            assert logged_in.status_code == 200
            token = logged_in.json()["access_token"]
            assert (await api.post("/api/v1/auth/logout", headers={"Authorization": f"Bearer {token}"})).status_code == 204

    asyncio.run(test())
