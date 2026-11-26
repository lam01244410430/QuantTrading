from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .schemas import (
    Admin, BacktestDetail, BacktestList, BacktestRequest, BacktestRun,
    CandleList, Interval, LoginRequest, LoginResponse,
)

app = FastAPI(
    title="QuantTrading Private API",
    version="0.1.0",
    description="Server-only API for the Next.js BFF. Synthetic data and simulated fills only.",
)
router = APIRouter(prefix="/api/v1")
bearer = HTTPBearer(bearerFormat="JWT")
UNAUTHORIZED = {401: {"description": "Invalid credentials or expired, revoked, or missing session"}}
NOT_FOUND = {404: {"description": "Resource not found"}}


async def session(_: Annotated[HTTPAuthorizationCredentials, Depends(bearer)]) -> Admin:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED)


CurrentAdmin = Annotated[Admin, Depends(session)]


@router.post("/auth/login", tags=["auth"], responses=UNAUTHORIZED)
async def login(body: LoginRequest) -> LoginResponse:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED)


@router.post("/auth/logout", tags=["auth"], status_code=204, responses=UNAUTHORIZED)
async def logout(admin: CurrentAdmin) -> Response:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED)


@router.get("/auth/me", tags=["auth"], responses=UNAUTHORIZED)
async def me(admin: CurrentAdmin) -> Admin:
    return admin


@router.get("/candles", tags=["candles"], responses=UNAUTHORIZED | NOT_FOUND)
async def candles(
    admin: CurrentAdmin,
    symbol: Annotated[str, Query(pattern=r"^[A-Z0-9._-]{1,16}$")] = "SYNTH",
    interval: Interval = "15m",
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
) -> CandleList:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED)


@router.post(
    "/backtests",
    tags=["backtests"],
    status_code=202,
    responses=UNAUTHORIZED | {503: {"description": "Backtest queue unavailable"}},
)
async def create_backtest(body: BacktestRequest, admin: CurrentAdmin) -> BacktestRun:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED)


@router.get("/backtests", tags=["backtests"], responses=UNAUTHORIZED)
async def list_backtests(
    admin: CurrentAdmin,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> BacktestList:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED)


@router.get("/backtests/{id}", tags=["backtests"], responses=UNAUTHORIZED | NOT_FOUND)
async def get_backtest(id: UUID, admin: CurrentAdmin) -> BacktestDetail:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED)


app.include_router(router)
