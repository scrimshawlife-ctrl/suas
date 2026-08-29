#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "LOCAL startup refused: .env is missing. Copy .env.example and generate SUAS_SESSION_SECRET." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

[[ "${SUAS_ENV:-}" == "LOCAL" ]] || { echo 'LOCAL startup refused: SUAS_ENV must be LOCAL.' >&2; exit 1; }
[[ "${SUAS_ALLOW_REAL_EXTERNAL_EFFECTS:-}" == "false" ]] || { echo 'LOCAL startup refused: real external effects must be false.' >&2; exit 1; }
[[ "${DATABASE_URL:-}" == 'postgresql://suas:suas@localhost:5432/suas_local' ]] || { echo 'LOCAL startup refused: DATABASE_URL must target local suas_local.' >&2; exit 1; }
[[ "${SUAS_HTTP_HOST:-127.0.0.1}" == '127.0.0.1' ]] || { echo 'LOCAL startup refused: SUAS_HTTP_HOST must be 127.0.0.1.' >&2; exit 1; }
[[ "${SUAS_HTTP_PORT:-3000}" == '3000' ]] || { echo 'LOCAL startup refused: SUAS_HTTP_PORT must be 3000.' >&2; exit 1; }

CONTAINER=suas-postgres17-local
if ! docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "LOCAL startup refused: Docker container $CONTAINER is missing." >&2
  echo 'Provision it with the documented postgres:17 command before retrying.' >&2
  exit 1
fi
if [[ "$(docker inspect -f '{{.State.Status}}' "$CONTAINER")" != 'running' ]]; then
  docker start "$CONTAINER" >/dev/null
fi
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U suas -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! docker exec "$CONTAINER" pg_isready -U suas -d postgres >/dev/null 2>&1; then
  echo 'PostgreSQL 17 did not become ready.' >&2
  exit 1
fi

umask 077
mkdir -p .local-secrets
npm run migrate -- apply
npm run migrate -- validate
npm run seed > .local-secrets/seed-output.json
chmod 600 .local-secrets/seed-output.json

ROLE=${1:-}
if [[ -z "$ROLE" ]]; then
  exec npm run dev
fi
case "$ROLE" in
  veteran|responder|admin) ;;
  *) echo 'Usage: scripts/start-local.sh [veteran|responder|admin]' >&2; exit 2 ;;
esac

npm run dev > .local-secrets/server.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
for _ in $(seq 1 60); do
  if curl --silent --fail http://127.0.0.1:3000/api/v0/health >/dev/null; then break; fi
  sleep 1
done
curl --silent --fail http://127.0.0.1:3000/api/v0/health >/dev/null
node --env-file=.env --import tsx/esm scripts/local-demo-browser.ts "$ROLE"
