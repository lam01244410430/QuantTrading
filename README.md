# QuantTrading

QuantTrading is an offline Python backtester for local OHLC and target-position
signals (`ohlc-signal/v2`, amendment 2.1.1). It requires Python 3.10 or newer and
has no runtime dependencies beyond the standard library.

**Simulated backtest on synthetic or local data. Not trading or investment
advice. No orders were placed.** The backtester uses no network data,
credentials, brokers, exchanges, real orders, or schedules.

## Install and run the demo

From the repository root on macOS or Linux, create and activate a virtual
environment, then install the package:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install .
```

Installation may need access to a package index for the build dependency.
If you are already offline, you can skip the package install when running
from this checkout; the backtester uses only the Python standard library.

```sh
make demo
```

If Make is unavailable, run the same demo directly from the repository root
with Python 3.10+ (on Windows, use your Python launcher in place of `python` if
needed):

```sh
python -m quanttrading.backtest fixtures/fixture_v1_basic.csv --out out --html
```

Open `out/report.html` in your browser (for example, double-click it in your
file manager). It is a standalone file: no server or internet connection is
needed. The demo uses synthetic `SYNTH` data, not actual market history. It
shows two simulated fills, total fees of 10.23, and final equity of 10199.77.

## Run on your own CSV

See the [usage guide](docs/usage.md) for a copyable local CSV example, the
required columns, CLI parameters and bounds, generated files, and error codes.

## Tests

In the activated virtual environment, install the hash-pinned test
requirements, then run the tests:

```sh
python -m pip install -r requirements-dev.txt
python -m pytest
```

## Local synthetic dashboard backend

The optional dashboard stack is separate from the offline CLI. Docker Compose
runs PostgreSQL/TimescaleDB, Redis, private FastAPI, an ARQ backtest worker,
and the Next.js BFF (`web` at `http://127.0.0.1:3000`). The one-shot `migrate`
service applies Alembic migrations and seeds the local admin and synthetic
candle series. No market data, exchange credentials, orders or billing are
enabled.

```sh
cp backend/.env.example backend/.env
chmod 600 backend/.env
# Set QT_POSTGRES_PASSWORD, QT_ADMIN_PASSWORD, and QT_JWT_SECRET.
# Generate separate values with openssl rand -hex 32; keep the file local.
docker compose --env-file backend/.env up --build --wait
docker compose --env-file backend/.env ps --all
docker compose --env-file backend/.env run --build --rm tests
```

Keep the database password URL-safe (hex is recommended); the admin
password must contain at least 12 characters and the JWT secret at least
32 bytes. FastAPI binds to host loopback at `http://127.0.0.1:8000`
for a local Next.js BFF (`QUANTTRADING_API_URL`, server only); use
`http://api:8000` from within the Compose network. PostgreSQL and Redis
have no host ports. See the [API contract](docs/api-contract.md) and
[rollout architecture](docs/architecture.md). Stop with
`docker compose --env-file backend/.env down`; named data volumes persist.

Login is limited to 10 requests per client and 120 total per 60 seconds
by default. Use `QT_LOGIN_LIMIT` and `QT_LOGIN_WINDOW_SECONDS` to change
the client limit and window. Redis unavailability blocks new logins with
`503`. In Compose, `web` (`web/server.mjs`) captures each client's real TCP
socket peer and overwrites `X-Forwarded-For` when calling `api`, never passing
the client's header through. `docker-compose.yml` assigns `web` the static IP
`172.30.0.10` on the `bff` network and defaults `QT_TRUSTED_PROXY_CIDRS` to
`172.30.0.10/32` so only the BFF is trusted (keep Uvicorn's `--no-proxy-headers`
enabled). When hosting the BFF outside Compose, set `QT_TRUSTED_PROXY_CIDRS`
to the BFF's exact backend-facing IP/CIDR.

### Run the synthetic paper replay

With the stack running, run the stages in order. Paper orders use a fixed
quantity of one unit. Fills use the canonical default fee rate (0.001 of
notional), rounded half up to cents. The report uses decimal strings and UTC
Unix seconds; a null fill time means the order has not filled. No orders
are submitted to an exchange.

```sh
for stage in replay relay strategy execute report; do
  docker compose --env-file backend/.env run --rm --no-deps worker python -m backend.paper_cli "$stage"
done
```

Rerunning the stages is safe. After an interrupted strategy run, wait at
least 30 seconds before running `strategy` again to reclaim the pending entry.
