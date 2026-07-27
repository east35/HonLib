#!/usr/bin/env bash
# Reader-side browser tests. No container needed (nothing here depends on the
# response headers the Dockerfile adds), so run the app directly and keep it
# quick. Takes one or more test file names from tests/browser/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
PORT="${HONLIB_TEST_PORT:-8878}"
BASE_URL="${HONLIB_BASE_URL:-http://127.0.0.1:${PORT}}"
PYTHON="${PYTHON:-python3}"
SERVER_PID=""

[ "$#" -gt 0 ] || { echo "usage: $(basename "$0") TEST.mjs [TEST.mjs...]" >&2; exit 2; }

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP/books" "$TMP/config" "$TMP/staging"
"$PYTHON" "$ROOT/tests/fixtures/make_split_chapter_epub.py" \
  "$TMP/books/split-chapter-test.epub"

PYTHONPATH="$ROOT" \
EBOOK_LIB_CONFIG_DIR="$TMP/config" \
EBOOK_LIB_FOLDER="$TMP/books" \
EBOOK_LIB_STAGING="$TMP/staging" \
  "$PYTHON" -c "
import app
app.app.run(host='127.0.0.1', port=${PORT}, use_reloader=False)
" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

for _ in {1..30}; do
  if curl --fail --silent "${BASE_URL}/api/features" >/dev/null; then
    for test in "$@"; do
      HONLIB_BASE_URL="${BASE_URL}" node "$ROOT/tests/browser/$test"
    done
    exit
  fi
  sleep 1
done

cat "$TMP/server.log"
echo "HonLib test server did not become ready" >&2
exit 1
