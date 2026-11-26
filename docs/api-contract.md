# QuantTrading API contract — 0.1.0

The versioned machine-readable contract is [backend/openapi.json](../backend/openapi.json).
Regenerate it with `python -m backend.export_openapi` from the repository root.
Only the routes in OpenAPI are in the first slice. See [architecture](architecture.md) for all later stages.

## Network and authentication

The browser talks only to the Next.js BFF (same origin). The BFF calls FastAPI
at a server-only origin (`QUANTTRADING_API_URL`, e.g. `http://api:8000` when on
the Compose network) and adds `Authorization: Bearer <access_token>` to
authenticated requests. Do not expose this origin or bearer token via
`NEXT_PUBLIC_*`, client bundles, or browser JSON responses.

1. The BFF sends `POST /api/v1/auth/login` with `{ "username": "…", "password": "…" }`.
   FastAPI returns `{ "access_token": "…", "token_type": "bearer", "expires_in": 3600,
   "user": { "username": "…", "role": "admin" } }`. Use the returned
   `expires_in` as the cookie TTL; there is no refresh endpoint.
2. The BFF sets an HttpOnly, SameSite session cookie (Secure under HTTPS);
   protection against cross-origin writes is the BFF's responsibility.
   `GET /api/v1/auth/me` returns only the current admin identity.
3. On logout, the BFF calls `POST /api/v1/auth/logout` with the bearer, then
   clears its cookie. FastAPI revokes the session and returns `204`. Clear the
   local cookie on `401` as well (expired/revoked/missing session). Protected
   requests require HS256, issuer `quanttrading-private-api`, audience
   `quanttrading-next-bff`, valid expiry and a live PostgreSQL session.

This slice has a single environment-seeded administrator; no registration,
public accounts or user-supplied exchange credentials. PostgreSQL stores
only a salted scrypt password hash and a SHA-256 digest of the random JWT
session ID, never the raw password or bearer.

Validly shaped login requests (including successful logins) count toward
the Redis fixed window. By default the limit is 10 per client and 120
across clients per 60 seconds. Once limited, the API returns `429` with
`{"detail":"Too many login attempts"}` and a `Retry-After` header in whole
seconds. The BFF may relay those to the browser. If the rate-limit store is
unavailable, or the process already has two login attempts in progress,
login fails closed with `503` and
`{"detail":"Login temporarily unavailable"}`. Requests rejected by either
guard do not run the password hash.

Client identity is the connection peer by default. With explicitly
configured trusted proxy CIDRs, the API uses the rightmost untrusted IP
in the trusted peer's `X-Forwarded-For` chain, parsing at most the last
2048 header bytes. If no client can be determined, requests from trusted
peers share one invalid-forwarding bucket. Proxies must append the actual
connecting address or replace the incoming header. With no trusted
proxies configured, all forwarded headers are ignored; requests from one
BFF peer share that peer's limit.

## Candles and backtest runs

| Method and path (under `/api/v1`) | Contract |
| --- | --- |
| `GET /candles?symbol=SYNTH&interval=15m&limit=200` | Closed synthetic candles only; returns `{ symbol, interval, candles: [{time, open, high, low, close, volume}] }`. The most recent `limit` candles are returned oldest first. Limit 1–1000. Symbol defaults to `SYNTH`; interval defaults to `15m`. Unknown series returns `404`. |
| `POST /backtests` | JSON object; defaults are `{"symbol":"SYNTH","interval":"1d","starting_capital":"10000.00","position_size":"50","fee_rate":"0.001"}`. Empty object uses defaults. Returns `202` and `{id,status,created_at,request}`; `id` is the run ID used to poll. Returns `503` if enqueue fails. |
| `GET /backtests?limit=20` | `{runs:[...]}`, newest first, same run metadata as POST; limit 1–100. |
| `GET /backtests/{id}` | Run metadata plus `result` and `error`, each nullable; `404` for an unknown run. |

Run status is `queued`, `running`, `succeeded` or `failed`. Poll detail
until terminal. A succeeded run contains `result.summary`,
`result.equity_curve` (oldest first), and `result.fills` (execution order).
A failed run has a non-null `error` code and no result. Request bounds:
capital 0 < value ≤ 1,000,000,000 with up to two decimal places, position
size 1–1,000,000 whole units, fee rate 0–0.01 with up to eight decimal
places. API request validation returns a sanitized `422`:
`{"detail":[{"loc":[],"msg":"Invalid request","type":"invalid_request"}]}`.
Rejected fields and values are neither reflected nor logged.

PostgreSQL commits the run before enqueue; ARQ uses the run ID as the job
ID. The worker bounds computation at 20 seconds (25-second ARQ outer
timeout). An enqueue failure returns `503` and attempts to mark the run
`queue_unavailable`; if Redis accepted the job before the failure, the first
DB state transition wins. Unclaimed jobs after 120 seconds and abandoned
running jobs after 60 seconds become `failed` with `job_expired` on worker
reconciliation (every 15 seconds) or API reads. This is queue maintenance,
not a backtest or market-data schedule.

For the run chart, fetch candles with the run's `request.symbol` and
`request.interval`. The `1d` series uses the canonical fixture unchanged;
the `15m` series reuses its OHLCV and signal rows on a deterministic
15-minute synthetic grid. Neither series represents market data.

Chart timestamps (`time`, `signal_time`, `fill_time`, drawdown peak/trough)
are UTC Unix **seconds**, not milliseconds; `created_at` is ISO 8601.
Prices, fees, volumes, position sizes, cash, equity, drawdown fractions and
PnL are **decimal strings**. Convert only at the chart display boundary;
e.g. Lightweight Charts uses `{time, open: Number(open), ...}` for candles
and `{time, value: Number(equity)}` for equity. Put BUY/SELL markers on
`fill.fill_time` (execution at the next bar's open), not `fill.signal_time`
(the signal bar). Unfilled signals produce no marker; no real orders are placed.

## Planned, not implemented

Drafts only; these are not routes in 0.1.0. Do not wire UI calls to them yet.
The synthetic paper replay stores orders and fills internally and provides a
local CLI report; it does not change this HTTP contract.

| Surface | Draft shape |
| --- | --- |
| `GET/POST /api/v1/bots`, `GET/PATCH/DELETE /api/v1/bots/{id}` | `{id, symbol, interval, strategy, params, enabled, mode:"paper"}`; patch `enabled` to start/stop. |
| `GET /api/v1/orders`, `GET /api/v1/fills` | Order: `{id, bot_id, symbol, side, status, quantity, mode, created_at}`; fill: `{id, order_id, fill_time, price, quantity, fee}`. |
| `GET /api/v1/pnl` | `{currency, realized, unrealized, total, as_of}` (separate from backtest summaries). |
| `WS /ws/events` | Draft BFF-mediated envelope `{id, type, occurred_at, data}` with types `order.updated`, `fill.created`, `pnl.updated`; data uses the matching shape above. |
| `GET/POST /api/v1/exchange-keys`, `DELETE /api/v1/exchange-keys/{id}` | Future write-only secret; return metadata only: `{id, exchange, label, masked_key, environment, created_at}`. Require Read + applicable Spot/Futures Trade, Withdraw disabled, fixed VPS IP allowlisted. |
| `GET /api/v1/billing/plans`, `POST /api/v1/billing/checkout`, `POST /api/v1/billing/webhook` | Plan `{id, name, price, currency, interval}`; checkout `{plan_id}` → `{checkout_url}`; provider-signed webhook. No payment integration active. |

## Internal synthetic candle stream (not a BFF API)

`qt:synthetic:candles` uses Redis Stream fields (all strings), for example:

```json
{"type":"candle.closed","event_id":"<outbox UUID>","exchange":"synthetic","market":"fixture","symbol":"SYNTH","timeframe":"15m","open_ts":"2026-01-05T00:00:00+00:00"}
```

Deduplicate using `event_id`, not the Redis-generated entry ID. The
`paper-strategy` consumer group acknowledges only after the associated
PostgreSQL transaction commits.
