#!/usr/bin/env bash
set -euo pipefail
umask 077

# Daily PostgreSQL/TimescaleDB logical backup via pg_dump, compressed with gzip
# and uploaded to Amazon S3 using SSE-KMS. Never logs database credentials.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${QT_ENV_FILE:-/etc/quanttrading/prod.env}"

if [[ ! -r "${ENV_FILE}" ]]; then
  echo "Environment file not readable: ${ENV_FILE}" >&2
  exit 1
fi

read_env_var() {
  local key="$1"
  python3 - "${ENV_FILE}" "${key}" <<'PY'
import sys
path, target = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as fh:
    for line in fh:
        line = line.rstrip("\r\n")
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k == target:
            print(v, end="")
            break
PY
}

BUCKET="${QT_BACKUP_S3_BUCKET:-$(read_env_var QT_BACKUP_S3_BUCKET)}"
PREFIX="${QT_BACKUP_S3_PREFIX:-$(read_env_var QT_BACKUP_S3_PREFIX)}"
PREFIX="${PREFIX:-postgres}"
PREFIX="${PREFIX#/}"
PREFIX="${PREFIX%/}"
KMS_KEY_ID="${QT_BACKUP_KMS_KEY_ID:-$(read_env_var QT_BACKUP_KMS_KEY_ID)}"
AWS_REGION_VAL="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(read_env_var AWS_REGION)}}"

if [[ -z "${BUCKET}" ]]; then
  echo "QT_BACKUP_S3_BUCKET must be set" >&2
  exit 1
fi
if [[ -z "${KMS_KEY_ID}" ]]; then
  echo "QT_BACKUP_KMS_KEY_ID must be set for SSE-KMS encryption" >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }
command -v gzip >/dev/null 2>&1 || { echo "gzip is required" >&2; exit 1; }

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP_DUMP="$(mktemp "/tmp/quanttrading-pgdump-${TIMESTAMP}.XXXXXX.sql.gz")"
chmod 600 "${TMP_DUMP}"
cleanup() {
  rm -f "${TMP_DUMP}"
}
trap cleanup EXIT

cd "${REPO_ROOT}"
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file "${ENV_FILE}" \
  exec -T postgres sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' \
  | gzip -9 > "${TMP_DUMP}"

gzip -t "${TMP_DUMP}"
SIZE_BYTES="$(wc -c < "${TMP_DUMP}" | tr -d '[:space:]')"
if [[ "${SIZE_BYTES}" -le 20 ]]; then
  echo "pg_dump output is unexpectedly empty (${SIZE_BYTES} bytes)" >&2
  exit 1
fi

S3_URI="s3://${BUCKET}/${PREFIX}/quanttrading-${TIMESTAMP}.sql.gz"
AWS_ARGS=(
  s3 cp "${TMP_DUMP}" "${S3_URI}"
  --sse aws:kms
  --sse-kms-key-id "${KMS_KEY_ID}"
  --only-show-errors
)
if [[ -n "${AWS_REGION_VAL}" ]]; then
  AWS_ARGS+=(--region "${AWS_REGION_VAL}")
fi

aws "${AWS_ARGS[@]}"
echo "Uploaded encrypted PostgreSQL backup (${SIZE_BYTES} bytes) to ${S3_URI}."
