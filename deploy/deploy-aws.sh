#!/usr/bin/env bash
set -euo pipefail
umask 077

# Loads production secrets from AWS Secrets Manager into a mode-600 env file
# (never echoed or logged) and deploys the production Docker Compose stack.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SECRET_ID="${QT_AWS_SECRET_ID:-quanttrading/prod}"
ENV_FILE="${QT_ENV_FILE:-/etc/quanttrading/prod.env}"
AWS_REGION_VAL="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
RENDER_ONLY=0

for arg in "$@"; do
  case "${arg}" in
    --render-env-only)
      RENDER_ONLY=1
      ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      exit 2
      ;;
  esac
done

command -v aws >/dev/null 2>&1 || { echo "aws CLI is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
if [[ "${RENDER_ONLY}" -eq 0 ]]; then
  command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
fi

ENV_DIR="$(dirname "${ENV_FILE}")"
if [[ ! -d "${ENV_DIR}" ]]; then
  mkdir -m 700 -p "${ENV_DIR}"
fi

TMP_ENV="$(mktemp "${ENV_DIR}/.prod.env.XXXXXX")"
chmod 600 "${TMP_ENV}"
cleanup() {
  rm -f "${TMP_ENV}"
}
trap cleanup EXIT

AWS_ARGS=(secretsmanager get-secret-value --secret-id "${SECRET_ID}" --query SecretString --output text)
if [[ -n "${AWS_REGION_VAL}" ]]; then
  AWS_ARGS+=(--region "${AWS_REGION_VAL}")
fi

aws "${AWS_ARGS[@]}" | python3 -c '
import json
import os
import sys

REQUIRED_KEYS = (
    "QT_POSTGRES_PASSWORD",
    "QT_ADMIN_USERNAME",
    "QT_ADMIN_PASSWORD",
    "QT_JWT_SECRET",
    "QT_DOMAIN",
)

OPTIONAL_KEYS = (
    "QT_LOGIN_LIMIT",
    "QT_LOGIN_WINDOW_SECONDS",
    "QT_TRUSTED_PROXY_CIDRS",
    "QT_WEB_TRUSTED_PROXY_CIDRS",
    "QT_BFF_SUBNET",
    "QT_BFF_IP_RANGE",
    "QT_WEB_BFF_IP",
    "QT_CADDY_BFF_IP",
    "QT_BACKUP_S3_BUCKET",
    "QT_BACKUP_S3_PREFIX",
    "QT_BACKUP_KMS_KEY_ID",
    "AWS_REGION",
)

FORBIDDEN_CHARS = set("$\x27\"`\\#")
POSTGRES_URL_UNSAFE = set("@/:?%")

out_path = sys.argv[1]
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except json.JSONDecodeError as exc:
    sys.stderr.write("Secrets Manager payload is not valid JSON\n")
    raise SystemExit(1) from exc

if not isinstance(data, dict):
    sys.stderr.write("Secrets Manager payload must be a JSON object\n")
    raise SystemExit(1)

missing = [k for k in REQUIRED_KEYS if not isinstance(data.get(k), str) or not data[k].strip()]
if missing:
    sys.stderr.write("Missing required secret keys: " + ", ".join(missing) + "\n")
    raise SystemExit(1)

lines = []
for key in (*REQUIRED_KEYS, *OPTIONAL_KEYS):
    if key not in data or data[key] is None:
        continue
    val = str(data[key])
    if any(ch in FORBIDDEN_CHARS or ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in val):
        sys.stderr.write(
            f"Secret key {key} contains disallowed characters for Docker Compose env-file "
            "(no $, quotes, backticks, backslashes, #, whitespace, or control chars; "
            "use openssl rand -base64 32)\n"
        )
        raise SystemExit(1)
    if key == "QT_POSTGRES_PASSWORD" and any(ch in POSTGRES_URL_UNSAFE for ch in val):
        sys.stderr.write(
            "Secret key QT_POSTGRES_PASSWORD contains URL-reserved characters (@, /, :, ?, %); "
            "use openssl rand -hex 32 or URL-safe base64\n"
        )
        raise SystemExit(1)
    lines.append(f"{key}={val}\n")

fd = os.open(out_path, os.O_WRONLY | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.writelines(lines)
' "${TMP_ENV}"

chmod 600 "${TMP_ENV}"
mv -f "${TMP_ENV}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
echo "Wrote mode-600 environment file to ${ENV_FILE} from Secrets Manager (${SECRET_ID})."

if [[ "${RENDER_ONLY}" -eq 1 ]]; then
  exit 0
fi

cd "${REPO_ROOT}"
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  --env-file "${ENV_FILE}" \
  up --build -d --wait

echo "Production Compose stack is up and healthy."
