#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
CONTAINER="honlib-csp-test-$$"
PORT="${HONLIB_TEST_PORT:-8877}"
BIND_HOST="${HONLIB_TEST_BIND_HOST:-127.0.0.1}"
TEST_HOST="${HONLIB_TEST_HOST:-127.0.0.1}"
BASE_URL="${HONLIB_BASE_URL:-http://${TEST_HOST}:${PORT}}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP/books" "$TMP/config" "$TMP/staging"
python3 "$ROOT/tests/fixtures/make_scripted_epub.py" \
  "$TMP/books/scripted-security-test.epub"

docker build -t honlib-csp-test "$ROOT" >/dev/null
docker run -d --name "$CONTAINER" \
  -p "${BIND_HOST}:${PORT}:8765" \
  -e EBOOK_LIB_CONTAINER=1 \
  -e EBOOK_LIB_CONFIG_DIR=/data/config \
  -e EBOOK_LIB_FOLDER=/data/books \
  -e EBOOK_LIB_STAGING=/data/staging \
  -v "$TMP/books:/data/books:ro" \
  -v "$TMP/config:/data/config" \
  -v "$TMP/staging:/data/staging" \
  honlib-csp-test >/dev/null

for _ in {1..30}; do
  if curl --fail --silent "${BASE_URL}/api/features" >/dev/null; then
    HONLIB_BASE_URL="${BASE_URL}" \
      node "$ROOT/tests/browser/scripted-epub.mjs"
    exit
  fi
  sleep 1
done

docker logs "$CONTAINER"
echo "HonLib test server did not become ready" >&2
exit 1
