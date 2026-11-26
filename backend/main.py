import json
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID, uuid4

from arq import create_pool
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from redis.exceptions import RedisError
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from . import auth, runs
from .database import candles as candle_table, create_engine
from .schemas import (
    Admin, BacktestDetail, BacktestList, BacktestRequest, BacktestRun,
    Candle, CandleList, Interval, LoginRequest, LoginResponse,
)
from .synthetic import closed_series, decimal_text


@asynccontextmanager
async def lifespan(app: FastAPI):
    auth.admin_username()
    auth.signing_key()
    engine = app.state.engine = create_engine()
    try:
        redis = app.state.redis = await create_pool(
            runs.redis_settings(), job_serializer=runs.serialize_job, job_deserializer=json.loads,
        )
        try:
            yield
        finally:
            await redis.aclose()
    finally:
        await engine.dispose()


app = FastAPI(
    title="QuantTrading Private API",
    version="0.1.0",
    description="Server-only API for the Next.js BFF. Synthetic data and simulated fills only.",
    lifespan=lifespan,
)
router = APIRouter(prefix="/api/v1")
bearer = HTTPBearer(bearerFormat="JWT", auto_error=False)
UNAUTHORIZED = {401: {"description": "Invalid credentials or expired, revoked, or missing session"}}
NOT_FOUND = {404: {"description": "Resource not found"}}


@app.exception_handler(RequestValidationError)
async def invalid_request(_request: Request, _error: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"detail": [{"loc": [], "msg": "Invalid request", "type": "invalid_request"}]},
    )


@app.get("/healthz", include_in_schema=False)
async def health(request: Request):
    async with request.app.state.engine.connect() as connection:
        await connection.execute(text("SELECT 1 FROM admins LIMIT 1"))
    await request.app.state.redis.ping()
    return {"status": "ok"}


def unauthorized():
    return HTTPException(401, detail="Invalid credentials or session", headers={"WWW-Authenticate": "Bearer"})


async def session(
    request: Request, credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> auth.Session:
    current = await auth.authenticate(request.app.state.engine, credentials.credentials) if credentials else None
    if current is None:
        raise unauthorized()
    return current


CurrentAdmin = Annotated[auth.Session, Depends(session)]


@router.post("/auth/login", tags=["auth"], responses=UNAUTHORIZED)
async def login(body: LoginRequest, request: Request, response: Response) -> LoginResponse:
    issued = await auth.issue_session(request.app.state.engine, body.username, body.password.get_secret_value())
    if issued is None:
        raise unauthorized()
    response.headers["Cache-Control"] = "no-store"
    return issued


@router.post("/auth/logout", tags=["auth"], status_code=204, responses=UNAUTHORIZED)
async def logout(request: Request, admin: CurrentAdmin) -> Response:
    await auth.revoke_session(request.app.state.engine, admin.id)
    return Response(status_code=204)


@router.get("/auth/me", tags=["auth"], responses=UNAUTHORIZED)
async def me(admin: CurrentAdmin) -> Admin:
    return admin.admin


@router.get("/candles", tags=["candles"], responses=UNAUTHORIZED | NOT_FOUND)
async def candles(
    request: Request,
    _admin: CurrentAdmin,
    symbol: Annotated[str, Query(pattern=r"^[A-Z0-9._-]{1,16}$")] = "SYNTH",
    interval: Interval = "15m",
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
) -> CandleList:
    query = closed_series(symbol, interval).order_by(candle_table.c.open_ts.desc()).limit(limit)
    async with request.app.state.engine.connect() as connection:
        rows = (await connection.execute(query)).all()
    if not rows:
        raise HTTPException(404, detail="Candle series not found")
    return CandleList(symbol=symbol, interval=interval, candles=[
        Candle(
            time=int(row.open_ts.timestamp()), open=decimal_text(row.open), high=decimal_text(row.high),
            low=decimal_text(row.low), close=decimal_text(row.close), volume=decimal_text(row.volume),
        )
        for row in reversed(rows)
    ])


@router.post(
    "/backtests",
    tags=["backtests"],
    status_code=202,
    responses=UNAUTHORIZED | {503: {"description": "Backtest queue unavailable"}},
)
async def create_backtest(body: BacktestRequest, request: Request, admin: CurrentAdmin) -> BacktestRun:
    engine = request.app.state.engine
    run = await runs.create_run(engine, uuid4(), admin.admin.username, body)
    try:
        await runs.enqueue_run(request.app.state.redis, run.id)
    except (RedisError, OSError):
        try:
            await runs.fail_queued(engine, run.id, "queue_unavailable")
        except SQLAlchemyError:
            pass
        raise HTTPException(503, detail="Backtest queue unavailable") from None
    return run


@router.get("/backtests", tags=["backtests"], responses=UNAUTHORIZED)
async def list_backtests(
    request: Request,
    admin: CurrentAdmin,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> BacktestList:
    return await runs.list_runs(request.app.state.engine, admin.admin.username, limit)


@router.get("/backtests/{id}", tags=["backtests"], responses=UNAUTHORIZED | NOT_FOUND)
async def get_backtest(id: UUID, request: Request, admin: CurrentAdmin) -> BacktestDetail:
    result = await runs.get_run(request.app.state.engine, admin.admin.username, id)
    if result is None:
        raise HTTPException(404, detail="Backtest run not found")
    return result


app.include_router(router)
