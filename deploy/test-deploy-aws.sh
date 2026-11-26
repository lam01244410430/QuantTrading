#!/usr/bin/env bash
set -euo pipefail

# Tests deploy/deploy-aws.sh --render-env-only using a stubbed `aws` binary on PATH.
# Verifies:
# 1. Base64 secrets render byte-identical to a mode-0600 env file with zero secret echoing.
# 2. Values containing $, ', ", `, \, #, or whitespace are rejected by key name without echoing the value.
# 3. Missing required keys are rejected.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="${SCRIPT_DIR}/deploy-aws.sh"

TMPDIR_TEST="$(mktemp -d)"
cleanup() {
  rm -rf "${TMPDIR_TEST}"
}
trap cleanup EXIT

write_stub_aws() {
  local payload="$1"
  cat > "${TMPDIR_TEST}/aws" <<EOF
#!/usr/bin/env bash
printf '%s\n' '${payload}'
EOF
  chmod +x "${TMPDIR_TEST}/aws"
}

echo "Test 1: base64/hex values render byte-identical at mode 600 without logging secrets"
PG_HEX="$(openssl rand -hex 32)"
ADMIN_B64="$(openssl rand -base64 32)"
JWT_B64="$(openssl rand -base64 32)"

PAYLOAD_OK="$(python3 -c '
import json, sys
print(json.dumps({
    "QT_DOMAIN": "quant.example.com",
    "QT_POSTGRES_PASSWORD": sys.argv[1],
    "QT_ADMIN_USERNAME": "admin",
    "QT_ADMIN_PASSWORD": sys.argv[2],
    "QT_JWT_SECRET": sys.argv[3],
    "QT_BACKUP_S3_BUCKET": "qt-backups",
    "QT_BACKUP_KMS_KEY_ID": "arn:aws:kms:ap-southeast-1:111122223333:key/abc",
}))
' "${PG_HEX}" "${ADMIN_B64}" "${JWT_B64}")"

write_stub_aws "${PAYLOAD_OK}"
ENV_OUT="${TMPDIR_TEST}/etc/prod.env"
OUT="$(PATH="${TMPDIR_TEST}:${PATH}" QT_ENV_FILE="${ENV_OUT}" "${DEPLOY_SCRIPT}" --render-env-only 2>&1)"

MODE="$(stat -c '%a' "${ENV_OUT}")"
if [[ "${MODE}" != "600" ]]; then
  echo "FAIL: expected mode 600, got ${MODE}" >&2
  exit 1
fi

for secret in "${PG_HEX}" "${ADMIN_B64}" "${JWT_B64}"; do
  if printf '%s' "${OUT}" | grep -Fq "${secret}"; then
    echo "FAIL: secret value was echoed to stdout/stderr" >&2
    exit 1
  fi
done

python3 -c '
import sys
path, expected_pg, expected_admin, expected_jwt = sys.argv[1:5]
parsed = {}
with open(path, "r", encoding="utf-8") as fh:
    for line in fh:
        k, v = line.rstrip("\n").split("=", 1)
        parsed[k] = v
assert parsed["QT_POSTGRES_PASSWORD"] == expected_pg, "PG password mismatch"
assert parsed["QT_ADMIN_PASSWORD"] == expected_admin, "Admin password mismatch"
assert parsed["QT_JWT_SECRET"] == expected_jwt, "JWT secret mismatch"
assert parsed["QT_DOMAIN"] == "quant.example.com", "Domain mismatch"
' "${ENV_OUT}" "${PG_HEX}" "${ADMIN_B64}" "${JWT_B64}"

echo "Test 2: unsafe Compose env-file characters are rejected without echoing values"
for bad_case in \
  'dollar:bad$secret' \
  'squote:bad'\''secret' \
  'dquote:bad"secret' \
  'backtick:bad`secret' \
  'backslash:bad\secret' \
  'hash:bad#secret' \
  'space:bad secret' \
  $'tab:bad\tsecret'
do
  label="${bad_case%%:*}"
  bad_val="${bad_case#*:}"
  BAD_JSON="$(python3 -c '
import json, sys
print(json.dumps({
    "QT_DOMAIN": "quant.example.com",
    "QT_POSTGRES_PASSWORD": "safeHexPassword0123456789abcdef",
    "QT_ADMIN_USERNAME": "admin",
    "QT_ADMIN_PASSWORD": sys.argv[1],
    "QT_JWT_SECRET": "safeJwtBase64Value+/==",
}))
' "${bad_val}")"
  # Write payload via python so single quotes in bad_val never break the stub script
  python3 -c '
import sys
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    fh.write("#!/usr/bin/env bash\ncat <<'\''__STUB_EOF__'\''\n")
    fh.write(sys.argv[2] + "\n")
    fh.write("__STUB_EOF__\n")
' "${TMPDIR_TEST}/aws" "${BAD_JSON}"
  chmod +x "${TMPDIR_TEST}/aws"

  set +e
  BAD_OUT="$(PATH="${TMPDIR_TEST}:${PATH}" QT_ENV_FILE="${TMPDIR_TEST}/etc/bad-${label}.env" "${DEPLOY_SCRIPT}" --render-env-only 2>&1)"
  BAD_RC=$?
  set -e

  if [[ "${BAD_RC}" -eq 0 ]]; then
    echo "FAIL: case ${label} should have been rejected" >&2
    exit 1
  fi
  if ! printf '%s' "${BAD_OUT}" | grep -Fq "QT_ADMIN_PASSWORD"; then
    echo "FAIL: case ${label} error did not name QT_ADMIN_PASSWORD: ${BAD_OUT}" >&2
    exit 1
  fi
  if printf '%s' "${BAD_OUT}" | grep -Fq "${bad_val}"; then
    echo "FAIL: case ${label} echoed secret value in error output" >&2
    exit 1
  fi
done

echo "Test 3: QT_POSTGRES_PASSWORD rejects URL-reserved characters (@, /, :, ?, %)"
for pg_bad in 'pg@secret' 'pg/secret' 'pg:secret' 'pg?secret' 'pg%secret'; do
  PG_BAD_JSON="$(python3 -c '
import json, sys
print(json.dumps({
    "QT_DOMAIN": "quant.example.com",
    "QT_POSTGRES_PASSWORD": sys.argv[1],
    "QT_ADMIN_USERNAME": "admin",
    "QT_ADMIN_PASSWORD": "safeAdminBase64Value+/==",
    "QT_JWT_SECRET": "safeJwtBase64Value+/==",
}))
' "${pg_bad}")"
  write_stub_aws "${PG_BAD_JSON}"
  set +e
  PG_OUT="$(PATH="${TMPDIR_TEST}:${PATH}" QT_ENV_FILE="${TMPDIR_TEST}/etc/bad-pg.env" "${DEPLOY_SCRIPT}" --render-env-only 2>&1)"
  PG_RC=$?
  set -e
  if [[ "${PG_RC}" -eq 0 ]]; then
    echo "FAIL: QT_POSTGRES_PASSWORD=${pg_bad} should have been rejected" >&2
    exit 1
  fi
  printf '%s' "${PG_OUT}" | grep -Fq "QT_POSTGRES_PASSWORD"
  if printf '%s' "${PG_OUT}" | grep -Fq "${pg_bad}"; then
    echo "FAIL: QT_POSTGRES_PASSWORD value echoed in error output" >&2
    exit 1
  fi
done

echo "Test 4: pre-existing parent directory permissions are preserved"
SHARED_DIR="${TMPDIR_TEST}/shared"
mkdir -m 755 "${SHARED_DIR}"
write_stub_aws "${PAYLOAD_OK}"
PATH="${TMPDIR_TEST}:${PATH}" QT_ENV_FILE="${SHARED_DIR}/prod.env" "${DEPLOY_SCRIPT}" --render-env-only >/dev/null
DIR_MODE="$(stat -c '%a' "${SHARED_DIR}")"
if [[ "${DIR_MODE}" != "755" ]]; then
  echo "FAIL: expected pre-existing dir mode 755, got ${DIR_MODE}" >&2
  exit 1
fi

echo "Test 5: missing required keys are rejected"
write_stub_aws '{"QT_DOMAIN":"quant.example.com"}'
set +e
MISSING_OUT="$(PATH="${TMPDIR_TEST}:${PATH}" QT_ENV_FILE="${TMPDIR_TEST}/etc/missing.env" "${DEPLOY_SCRIPT}" --render-env-only 2>&1)"
MISSING_RC=$?
set -e
if [[ "${MISSING_RC}" -eq 0 ]]; then
  echo "FAIL: missing keys should have been rejected" >&2
  exit 1
fi
printf '%s' "${MISSING_OUT}" | grep -Fq "QT_POSTGRES_PASSWORD"

echo "All deploy-aws.sh tests passed!"
