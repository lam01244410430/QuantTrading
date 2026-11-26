# Deploying QuantTrading on AWS (Single-Host Docker Compose + Caddy)

This guide covers hosting the current **synthetic/paper-only** QuantTrading
stack on a single AWS EC2 host using Docker Compose and Caddy auto-TLS.

> **Current scope boundary:** synthetic data and paper replay only. No exchange
> testnet or live trading, no Stripe/billing, no exchange API key collection,
> and no LLM integration are enabled in this release.

## Why single EC2 + Compose (no RDS, no Vercel)

- **No RDS:** Amazon RDS does not provide the TimescaleDB extension used by
  this stack. TimescaleDB runs inside Docker Compose on an encrypted EBS volume
  with daily `pg_dump` backups to S3 (SSE-KMS).
- **No Vercel:** The Next.js BFF (`web/server.mjs`) relies on the real TCP
  socket peer (and an explicit `QT_WEB_TRUSTED_PROXY_CIDRS` hop from Caddy) so
  FastAPI's Redis login throttle keys on each client IP rather than collapsing
  all users behind one shared proxy IP.

## Network & proxy trust chain

```text
Internet (HTTPS :443 / HTTP :80)
  -> Caddy (172.30.0.11 on Compose `bff` network, auto-TLS for $QT_DOMAIN)
       sets X-Forwarded-For, X-Forwarded-Host, X-Forwarded-Proto
  -> web BFF (172.30.0.10 on `bff`, no host port, COOKIE_SECURE=true)
       QT_WEB_TRUSTED_PROXY_CIDRS=172.30.0.11/32
       resolves rightmost untrusted XFF hop, verifies CSRF Origin against
       X-Forwarded-Host only from Caddy, overwrites upstream X-Forwarded-For
  -> api FastAPI (default + `bff`, no host port, --no-proxy-headers)
       QT_TRUSTED_PROXY_CIDRS=172.30.0.10/32
       enforces per-client + global login throttle in Redis
  -> postgres (TimescaleDB) + redis + worker (internal `default` network only)
```

Only `caddy` publishes host ports (`80` and `443`). `web`, `api`, `postgres`,
and `redis` have no host ports in `docker-compose.prod.yml`.

## 1. AWS infrastructure checklist

Provision the following in **`ap-northeast-1` (Tokyo) or `ap-southeast-1`
(Singapore)** — Binance.com and Bybit block US-region IPs, so the
exchange-facing host must not be deployed in US regions:

1. **EC2 instance:** Ubuntu 24.04 LTS on `m7i-flex.large` (2 vCPU, 8 GB), the
   owner's host, with an **encrypted gp3 EBS volume** (30+ GB, KMS-encrypted).
2. **Elastic IP:** Associate one Elastic IP with the instance.
3. **DNS A record:** Point your domain (`QT_DOMAIN`, e.g.
   `quant.example.com`) to the Elastic IP so Caddy's ACME HTTP-01/TLS-ALPN-01
   certificate issuance succeeds.
4. **Security Group:** Allow inbound TCP `80` and `443` only (no inbound port
   `22`, `3000`, `8000`, `5432`, or `6379`).
5. **Access via AWS SSM:** Attach `AmazonSSMManagedInstanceCore` to the EC2
   instance role and connect with AWS Systems Manager Session Manager instead
   of opening SSH.
6. **S3 backup bucket + KMS key:** Create a private S3 bucket with default
   encryption (SSE-KMS), Block Public Access enabled, versioning enabled, and a
   lifecycle rule for retention.
7. **IAM instance role policy:** Attach a least-privilege inline policy
   granting access only to the `quanttrading/prod` secret, the backup bucket,
   and the backup KMS key:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadProdSecret",
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:quanttrading/prod-*"
    },
    {
      "Sid": "WritePostgresBackups",
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::<BACKUP_BUCKET>/postgres/*"
    },
    {
      "Sid": "UseBackupAndSecretKmsKey",
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Encrypt", "kms:Decrypt"],
      "Resource": "arn:aws:kms:<REGION>:<ACCOUNT_ID>:key/<KMS_KEY_ID>"
    }
  ]
}
```

## 2. Create the Secrets Manager secret (`quanttrading/prod`)

Create a JSON secret named `quanttrading/prod` in AWS Secrets Manager with
high-entropy values generated via `openssl rand -base64 32` (never commit these
to git):

```sh
openssl rand -base64 32
```

> **Character restrictions:** Docker Compose `--env-file` interpolates `$`,
> strips quotes, and treats `#` as comments. `deploy/deploy-aws.sh` rejects
> any value containing `$`, `'`, `"`, `` ` ``, `\`, `#`, whitespace, or control
> characters (logging only the key name, never the value). Base64 values from
> `openssl rand -base64 32` are safe for `QT_ADMIN_PASSWORD` and
> `QT_JWT_SECRET` and render byte-identical. For `QT_POSTGRES_PASSWORD` (which
> is embedded in `QT_DATABASE_URL`), use `openssl rand -hex 32` (or URL-safe
> base64 without `@`, `/`, `:`, `?`, `%`).

```json
{
  "QT_DOMAIN": "quant.example.com",
  "QT_POSTGRES_PASSWORD": "<random-32-byte-secret>",
  "QT_ADMIN_USERNAME": "admin",
  "QT_ADMIN_PASSWORD": "<strong-admin-password>",
  "QT_JWT_SECRET": "<random-32-byte-hex-secret>",
  "QT_BACKUP_S3_BUCKET": "<your-backup-bucket>",
  "QT_BACKUP_S3_PREFIX": "postgres",
  "QT_BACKUP_KMS_KEY_ID": "<kms-key-id-or-arn>",
  "AWS_REGION": "ap-southeast-1"
}
```

Optional overrides supported in the same JSON object: `QT_LOGIN_LIMIT`,
`QT_LOGIN_WINDOW_SECONDS`, `QT_TRUSTED_PROXY_CIDRS`,
`QT_WEB_TRUSTED_PROXY_CIDRS`, `QT_BFF_SUBNET`, `QT_BFF_IP_RANGE`,
`QT_WEB_BFF_IP`, `QT_CADDY_BFF_IP`.

Whenever you override `QT_BFF_SUBNET`, also set `QT_BFF_IP_RANGE` to a range
inside it that excludes `QT_WEB_BFF_IP` and `QT_CADDY_BFF_IP`, so dynamically
addressed services (`api`) can never take the static proxy addresses.

## 3. Prepare the EC2 host (via SSM Session Manager)

Install Docker Engine, Docker Compose v2 plugin, AWS CLI v2, and Python 3, then
clone the repository to `/opt/quanttrading`:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg python3 gzip unzip
# Install Docker Engine + docker-compose-plugin and AWS CLI v2 per official docs
sudo git clone https://github.com/lam01244410430/QuantTrading.git /opt/quanttrading
```

## 4. Deploy with `deploy/deploy-aws.sh`

`deploy/deploy-aws.sh` reads `quanttrading/prod` from AWS Secrets Manager,
writes `/etc/quanttrading/prod.env` atomically with mode `0600` (never echoing
secret values), and starts the production Compose stack:

```sh
cd /opt/quanttrading
sudo AWS_REGION=ap-southeast-1 ./deploy/deploy-aws.sh
```

Verify that only ports `80` and `443` are published and all services are
healthy:

```sh
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file /etc/quanttrading/prod.env ps
```

## 5. Enable daily `pg_dump` backups to S3 (SSE-KMS)

Install the systemd service and daily timer:

```sh
sudo cp /opt/quanttrading/deploy/systemd/quanttrading-backup.service /etc/systemd/system/
sudo cp /opt/quanttrading/deploy/systemd/quanttrading-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now quanttrading-backup.timer
sudo systemctl list-timers quanttrading-backup.timer
```

Run an immediate smoke backup and verify the object is encrypted with
`aws:kms`:

```sh
sudo systemctl start quanttrading-backup.service
sudo journalctl -u quanttrading-backup.service -n 20 --no-pager
```

### Restore procedure (fresh empty DB / volume only — never restore over a live DB)

TimescaleDB logical restores require an **empty database on the same
TimescaleDB extension version** (`timescale/timescaledb:2.19.3-pg16`) and must
bracket the `psql` load with `timescaledb_pre_restore()` and
`timescaledb_post_restore()`. Always drill into a fresh database or volume,
never over the live production database:

```sh
# 1. Download the encrypted backup from S3
aws s3 cp s3://<BACKUP_BUCKET>/postgres/quanttrading-<TIMESTAMP>.sql.gz /tmp/restore.sql.gz

# 2. Start a fresh TimescaleDB container on the same image version (or recreate an empty DB)
#    and prepare it for restore:
docker exec -i <fresh-postgres-container> sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();"'

# 3. Load the logical dump
gunzip -c /tmp/restore.sql.gz | docker exec -i <fresh-postgres-container> sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# 4. Re-enable TimescaleDB background workers and catalog hooks
docker exec -i <fresh-postgres-container> sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT timescaledb_post_restore();"'

rm -f /tmp/restore.sql.gz
```
