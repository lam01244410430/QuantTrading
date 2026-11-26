import asyncio
import json
import logging
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from redis.exceptions import ConnectionError
from sqlalchemy.exc import SQLAlchemyError

from backend import auth, runs, worker
from backend.main import app, create_backtest
from backend.schemas import Admin, BacktestRequest
from backend.synthetic import FIXTURE, fixture_rows, source_bytes


@pytest.mark.parametrize("body", [
    {"username": "admin", "password": {"value": "DO_NOT_REFLECT_THIS_SENTINEL"}},
    {"username": "admin", "password": "test-only", "DO_NOT_REFLECT_THIS_SENTINEL": "invalid"},
    {"username": "admin", "password": "DO_NOT_REFLECT_THIS_SENTINEL" * 100},
])
def test_invalid_login_never_echoes_or_logs_input(body, caplog):
    with caplog.at_level(logging.DEBUG):
        response = TestClient(app).post("/api/v1/auth/login", json=body)
    assert response.status_code == 422
    assert response.json() == {
        "detail": [{"loc": [], "type": "invalid_request", "msg": "Invalid request"}],
    }
    assert "DO_NOT_REFLECT_THIS_SENTINEL" not in response.text
    assert "DO_NOT_REFLECT_THIS_SENTINEL" not in caplog.text


def test_openapi_matches_published_contract():
    schema = Path(__file__).resolve().parents[1] / "openapi.json"
    assert app.openapi() == json.loads(schema.read_text())


def test_canonical_fixture_adapter():
    rows = [SimpleNamespace(**row) for row in fixture_rows() if row["timeframe"] == "1d"]
    raw = source_bytes(rows)
    assert raw == FIXTURE.read_bytes()
    result = worker.simulate_result(raw, BacktestRequest())
    assert result.summary.final_equity == "10199.77"
    assert result.summary.total_fees == "10.23"
    assert [fill.side for fill in result.fills] == ["BUY", "SELL"]
    assert all(fill.signal_time < fill.fill_time for fill in result.fills)


def test_password_hash_is_salted():
    first = auth.hash_password("test-only local credential")
    second = auth.hash_password("test-only local credential")
    assert first != second
    assert auth.verify_password("test-only local credential", first)
    assert not auth.verify_password("incorrect", first)


@pytest.mark.parametrize("fails", ["initial_commit", "enqueue", "mark_failed"])
def test_enqueue_and_commit_order(monkeypatch, fails):
    engine, redis, run_id = object(), object(), object()
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(engine=engine, redis=redis)))
    session = SimpleNamespace(admin=Admin(username="unit_admin"))
    create = AsyncMock(return_value=SimpleNamespace(id=run_id))
    enqueue = AsyncMock(side_effect=ConnectionError)
    fail = AsyncMock()
    monkeypatch.setattr(runs, "create_run", create)
    monkeypatch.setattr(runs, "enqueue_run", enqueue)
    monkeypatch.setattr(runs, "fail_queued", fail)
    if fails == "initial_commit":
        create.side_effect = SQLAlchemyError
        with pytest.raises(SQLAlchemyError):
            asyncio.run(create_backtest(BacktestRequest(), request, session))
        enqueue.assert_not_awaited()
        fail.assert_not_awaited()
    else:
        if fails == "mark_failed":
            fail.side_effect = SQLAlchemyError
        with pytest.raises(HTTPException) as error:
            asyncio.run(create_backtest(BacktestRequest(), request, session))
        assert error.value.status_code == 503
        enqueue.assert_awaited_once_with(redis, run_id)
        fail.assert_awaited_once_with(engine, run_id, "queue_unavailable")


def test_job_computation_timeout(monkeypatch):
    class FakeEngine:
        async def __aenter__(self):
            await asyncio.sleep(1)

        async def __aexit__(self, *_):
            pass

        def connect(self):
            return self

    monkeypatch.setattr(runs, "JOB_TIMEOUT", 0.01)
    monkeypatch.setattr(runs, "claim_run", AsyncMock(return_value=BacktestRequest()))
    finish = AsyncMock()
    monkeypatch.setattr(runs, "finish_run", finish)
    engine = FakeEngine()
    rid = "d6c70b6c-3e53-4eac-8dad-c3f96382b79b"
    asyncio.run(worker.run_backtest({"engine": engine}, rid))
    assert finish.await_args.kwargs == {"error": "job_timeout"}
