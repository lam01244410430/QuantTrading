import asyncio
from os import environ

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert

from .auth import admin_username, hash_password, signing_key, verify_password
from .database import admins, candles, create_engine, sessions
from .synthetic import fixture_rows


async def seed():
    username = admin_username()
    signing_key()
    password = environ["QT_ADMIN_PASSWORD"]
    if not 12 <= len(password) <= 1024:
        raise ValueError("QT_ADMIN_PASSWORD must be 12–1024 characters")
    engine = create_engine()
    try:
        async with engine.begin() as connection:
            existing = await connection.scalar(select(admins.c.password_hash).where(admins.c.username == username))
            if existing is None or not verify_password(password, existing):
                admin = insert(admins).values(username=username, password_hash=hash_password(password))
                await connection.execute(admin.on_conflict_do_update(
                    index_elements=[admins.c.username], set_={"password_hash": admin.excluded.password_hash},
                ))
                await connection.execute(delete(sessions).where(sessions.c.username == username))
            await connection.execute(insert(candles).on_conflict_do_nothing(), list(fixture_rows()))
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(seed())
