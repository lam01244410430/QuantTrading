from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import scrypt, sha256
from hmac import compare_digest
from os import environ, urandom
from uuid import UUID, uuid4

import jwt
from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncEngine
from starlette.concurrency import run_in_threadpool

from .database import admins, sessions
from .schemas import Admin, LoginResponse

ISSUER = "quanttrading-private-api"
AUDIENCE = "quanttrading-next-bff"
ALGORITHM = "HS256"
SESSION_SECONDS = 3600


@dataclass(frozen=True)
class Session:
    id: str
    admin: Admin


def admin_username() -> str:
    username = environ["QT_ADMIN_USERNAME"]
    if not 1 <= len(username) <= 128:
        raise ValueError("QT_ADMIN_USERNAME must be 1–128 characters")
    return username


def signing_key() -> str:
    key = environ["QT_JWT_SECRET"]
    if len(key.encode()) < 32:
        raise ValueError("QT_JWT_SECRET must be at least 32 bytes")
    return key


def _digest(password: str, salt: bytes) -> bytes:
    return scrypt(password.encode(), salt=salt, n=2**15, r=8, p=1, maxmem=64 * 2**20, dklen=32)


def hash_password(password: str) -> str:
    salt = urandom(16)
    return f"{salt.hex()}:{_digest(password, salt).hex()}"


def verify_password(password: str, encoded: str) -> bool:
    salt, digest = encoded.split(":")
    return compare_digest(_digest(password, bytes.fromhex(salt)), bytes.fromhex(digest))


def session_digest(sid: UUID) -> str:
    return sha256(sid.bytes).hexdigest()


async def issue_session(engine: AsyncEngine, username: str, password: str) -> LoginResponse | None:
    configured = admin_username()
    sid = uuid4()
    expires_at = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(seconds=SESSION_SECONDS)
    async with engine.begin() as connection:
        encoded = await connection.scalar(select(admins.c.password_hash).where(admins.c.username == configured))
        if encoded is None or not await run_in_threadpool(verify_password, password, encoded) or username != configured:
            return None
        await connection.execute(delete(sessions).where(sessions.c.expires_at <= datetime.now(timezone.utc)))
        await connection.execute(insert(sessions).values(
            id=session_digest(sid), username=username, expires_at=expires_at,
        ))
    token = jwt.encode(
        {"iss": ISSUER, "aud": AUDIENCE, "sub": username, "jti": str(sid), "exp": expires_at},
        signing_key(),
        algorithm=ALGORITHM,
    )
    return LoginResponse(access_token=token, expires_in=SESSION_SECONDS, user=Admin(username=username))


async def authenticate(engine: AsyncEngine, token: str) -> Session | None:
    try:
        claims = jwt.decode(
            token, signing_key(), algorithms=[ALGORITHM], issuer=ISSUER, audience=AUDIENCE,
            options={"require": ["iss", "aud", "sub", "jti", "exp"], "strict_aud": True},
        )
        username = claims["sub"]
        sid = session_digest(UUID(claims["jti"]))
    except (jwt.InvalidTokenError, ValueError):
        return None
    if username != admin_username():
        return None
    async with engine.connect() as connection:
        found = await connection.scalar(select(sessions.c.id).where(
            sessions.c.id == sid,
            sessions.c.username == username,
            sessions.c.expires_at > datetime.now(timezone.utc),
        ))
    return Session(id=sid, admin=Admin(username=username)) if found else None


async def revoke_session(engine: AsyncEngine, sid: str) -> None:
    async with engine.begin() as connection:
        await connection.execute(delete(sessions).where(sessions.c.id == sid))
