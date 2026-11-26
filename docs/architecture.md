# QuantTrading architecture and rollout

## First PR: local, synthetic vertical slice

Next.js App Router (browser and same-origin BFF) → private FastAPI →
PostgreSQL with the TimescaleDB extension. Durable admin sessions, backtest
runs/results and candles live in PostgreSQL, not SQLite or the frontend
filesystem. The BFF owns its HttpOnly cookie and forwards a bearer JWT.
Charts use TradingView Lightweight Charts to render candles, markers at
simulated fill timestamps and equity/PnL. See the [API contract](api-contract.md).

Local Compose provides FastAPI, TimescaleDB, Redis and the ARQ worker. ARQ
queues backtests rather than running them on API requests; the worker uses
the canonical offline Python engine read-only. Seeded synthetic data only.
The canonical fixture and its standalone Python CLI are unchanged. No
collector/strategy/executor, schedules, external data feeds, account
registration, billing, credential collection, or exchange connections are
part of this slice.

## Later PRs: recoverable data and paper trading first

Three independent processes: market-data collector → strategy worker →
**paper executor**. The collector maintains one multiplexed WebSocket per
exchange for subscribed 15m streams where supported and uses the exchange's
explicit close flag, not an inference from the local clock. It uses REST
gap backfill on startup/reconnect and reconciles missing bars before
resuming strategy processing for an affected series.

Persist candles in PostgreSQL/TimescaleDB with unique identity
`(exchange, market, symbol, timeframe, open_ts)`. In the transaction that
commits the closed candle, insert a unique outbox row for that candle
identity. A relay publishes candle-closed events to Redis **Streams**, not
Pub/Sub. A crash between publish and marking the outbox sent can deliver
duplicates, so consumers persist deduplication alongside their side
effects, then acknowledge. Use consumer groups, pending-message recovery,
and bounded retention/replay; monitor relay lag and missed gaps. Redis can
cache 200 recent closed candles per series; PostgreSQL is authoritative and
repairs cache misses. Do not silently run a strategy on a known gap.

The strategy worker evaluates active bots for the series against closed
candles and emits idempotent paper-order intents (identified by bot, candle
identity, and action). The paper executor persists order/fill outcomes
idempotently; retries cannot simulate duplicate executions. Notifications
can then update the dashboard through an authenticated BFF-mediated event
connection. ARQ's backtest queue is independent of the candle Streams.

Measure candle persistence, outbox and consumer lag, strategy computation,
and time to persisted paper fill with p50/p95/p99 and replay metrics.
Example 15-minute timings or exchange proximity are not guarantees.

## Production gates and hosting (not provisioned)

Later hosting: Next.js on Vercel; private FastAPI, workers, TimescaleDB and
Redis in Docker Compose on one or two owner-provisioned VPSs. Only the BFF
can reach FastAPI through protected connectivity; databases/Redis remain
private. Validate backups/restore, isolation, secret rotation, resource
limits, monitoring and network latency before rollout. No deploy or VPS
purchase without owner provisioning and approval.

Paper first. Exchange testnet is a separate explicitly authorized stage;
only after verification and explicit owner approval could a separate
production live gate be designed and enabled. Keep live disabled by
default; production access should require separate credentials and
infrastructure, audited rollout, limits and an emergency stop. No exchange
keys, orders (including testnet), or Stripe/payment activation now.

Prefer AWS KMS or HashiCorp Vault for exchange credential envelope keys.
An interim design may use versioned AES-256-GCM envelope encryption with
the master key stored outside the database in a separate secret. Isolate
decryption to the authorized executor. Accept only Read + required
Spot/Futures Trade permissions, Withdraw disabled and fixed-IP
allowlisting. Never log or return plaintext credential material.
