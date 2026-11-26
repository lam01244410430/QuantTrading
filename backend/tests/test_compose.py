import asyncio
import json
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from os import environ
from time import monotonic, sleep
from uuid import UUID, uuid4

import httpx
import jwt
import pytest
from arq import create_pool
from sqlalchemy import insert, select, text, update

from backend import auth, runs
from backend.database import admins, backtests, create_engine, sessions
from backend.schemas import BacktestRequest
from backend.synthetic import FIXTURE

pytestmark = pytest.mark.skipif(not environ.get("QT_TEST_API_URL"), reason="requires the Compose backend")


@pytest.fixture
def client():
    with httpx.Client(base_url=environ["QT_TEST_API_URL"] + "/api/v1", timeout=5) as api:
        yield api


def login(api):
    response = api.post("/auth/login", json={
        "username": environ["QT_ADMIN_USERNAME"], "password": environ["QT_ADMIN_PASSWORD"],
    })
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    return response.json()["access_token"]


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def headers(client):
    token = bearer(login(client))
    yield token
    assert client.post("/auth/logout", headers=token).status_code == 204


def database(operation):
    async def execute():
        engine = create_engine()
        try:
            async with engine.begin() as connection:
                return await operation(connection)
        finally:
            await engine.dispose()

    return asyncio.run(execute())


def test_auth_verifies_claims_and_persisted_session(client):
    assert client.get("/auth/me").status_code == 401
    assert client.post("/auth/login", json={"username": auth.admin_username(), "password": "wrong"}).status_code == 401
    token = login(client)
    headers = bearer(token)
    assert client.get("/auth/me", headers=headers).json() == {"username": auth.admin_username(), "role": "admin"}
    claims = jwt.decode(token, auth.signing_key(), algorithms=["HS256"], issuer=auth.ISSUER, audience=auth.AUDIENCE)
    sid = auth.session_digest(UUID(claims["jti"]))

    async def stored_credentials(connection):
        stored = (await connection.execute(select(sessions.c.id, admins.c.password_hash).join(admins).where(
            sessions.c.id == sid,
        ))).one()
        return stored.id, stored.password_hash

    stored_id, password_hash = database(stored_credentials)
    assert stored_id == sid and stored_id not in (claims["jti"], token)
    assert password_hash != environ["QT_ADMIN_PASSWORD"]

    for changed in (
        {"aud": "wrong"}, {"iss": "wrong"}, {"exp": 1}, {"jti": str(uuid4())}, {"aud": [auth.AUDIENCE]},
    ):
        forged = jwt.encode(claims | changed, auth.signing_key(), algorithm="HS256")
        assert client.get("/auth/me", headers=bearer(forged)).status_code == 401
    wrong_algorithm = jwt.encode(claims, auth.signing_key(), algorithm="HS384")
    assert client.get("/auth/me", headers=bearer(wrong_algorithm)).status_code == 401

    expired_token = login(client)
    expired_claims = jwt.decode(
        expired_token, auth.signing_key(), algorithms=["HS256"], issuer=auth.ISSUER, audience=auth.AUDIENCE,
    )
    expired_sid = auth.session_digest(UUID(expired_claims["jti"]))

    async def expire_session(connection):
        await connection.execute(update(sessions).where(sessions.c.id == expired_sid).values(
            expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
        ))

    database(expire_session)
    assert client.get("/auth/me", headers=bearer(expired_token)).status_code == 401
    assert client.post("/auth/logout", headers=headers).status_code == 204
    assert client.get("/auth/me", headers=headers).status_code == 401


def test_timescale_candles(client, headers):
    async def hypertable(connection):
        return await connection.scalar(text(
            "SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_name = 'candles'",
        ))

    assert database(hypertable) == 1
    assert client.get("/candles").status_code == 401
    assert client.get("/candles?symbol=BTCUSDT", headers=headers).status_code == 404
    response = client.get("/candles?limit=2", headers=headers)
    assert response.status_code == 200
    data = response.json()
    assert (data["symbol"], data["interval"]) == ("SYNTH", "15m")
    series = data["candles"]
    assert len(series) == 2
    assert series[1]["time"] - series[0]["time"] == 900
    assert series[-1]["open"] == "103.00"
    assert series[-1]["volume"] == "800"


def terminal_result(client, headers, rid):
    deadline = monotonic() + 15
    while monotonic() < deadline:
        response = client.get(f"/backtests/{rid}", headers=headers)
        assert response.status_code == 200
        data = response.json()
        if data["status"] in ("failed", "succeeded"):
            return data
        sleep(0.1)
    pytest.fail("Backtest did not reach a terminal state")


@pytest.mark.parametrize("interval", ["1d", "15m"])
def test_enqueue_worker_and_chart_result(client, headers, interval):
    assert client.post("/backtests", json={"interval": interval}).status_code == 401
    response = client.post("/backtests", headers=headers, json={"interval": interval})
    assert response.status_code == 202
    run = response.json()
    assert run["status"] == "queued"
    rid = run["id"]
    listing = client.get("/backtests", headers=headers).json()["runs"]
    assert rid in {row["id"] for row in listing}
    result = terminal_result(client, headers, rid)
    assert result["status"] == "succeeded", result["error"]
    assert result["error"] is None
    detail = result["result"]
    assert detail["summary"]["net_pnl"] == "199.77"
    assert detail["summary"]["total_fees"] == "10.23"
    assert detail["summary"]["final_equity"] == "10199.77"
    assert (detail["summary"]["input_sha256"] == sha256(FIXTURE.read_bytes()).hexdigest()) == (interval == "1d")
    series = client.get(f"/candles?interval={interval}", headers=headers).json()["candles"]
    chart_times = [point["time"] for point in series]
    assert chart_times == [point["time"] for point in detail["equity_curve"]]
    for fill in detail["fills"]:
        idx = chart_times.index(fill["fill_time"])
        assert chart_times[idx - 1] == fill["signal_time"]
        assert series[idx]["open"] == fill["price"]

    async def duplicate_enqueue():
        redis = await create_pool(
            runs.redis_settings(), job_serializer=runs.serialize_job, job_deserializer=json.loads,
        )
        try:
            return await runs.enqueue_run(redis, UUID(rid))
        finally:
            await redis.aclose()

    assert asyncio.run(duplicate_enqueue()) is None
    assert client.get(f"/backtests/{rid}", headers=headers).json() == result


def test_failed_simulation_persists_error(client, headers):
    response = client.post("/backtests", headers=headers, json={"starting_capital": "1.00"})
    assert response.status_code == 202
    data = terminal_result(client, headers, response.json()["id"])
    assert (data["status"], data["error"], data["result"]) == ("failed", "E101_INSUFFICIENT_CASH", None)


def test_worker_reconciles_lost_jobs_without_api_read():
    queued, running = uuid4(), uuid4()

    async def insert_stale_runs(connection):
        now = datetime.now(timezone.utc)
        for rid, status, started in (
            (queued, "queued", None),
            (running, "running", now - timedelta(seconds=runs.RUN_TTL + 1)),
        ):
            await connection.execute(insert(backtests).values(
                id=rid, username=auth.admin_username(), status=status, started_at=started,
                created_at=now - timedelta(seconds=runs.QUEUE_TTL + 1),
                request=BacktestRequest().model_dump(mode="json"),
            ))

    async def expired_rows(connection):
        result = await connection.execute(select(backtests.c.status, backtests.c.error).where(
            backtests.c.id.in_([queued, running]),
        ))
        return result.all()

    database(insert_stale_runs)
    deadline = monotonic() + runs.REAP_INTERVAL + 10
    while monotonic() < deadline:
        if database(expired_rows) == [("failed", "job_expired")] * 2:
            return
        sleep(0.5)
    pytest.fail("Worker did not reconcile lost/expired jobs")
