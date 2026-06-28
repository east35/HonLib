#!/bin/sh
# Regenerate the app icons (white 本 on black) in a throwaway container that has
# Pillow + Noto Sans CJK. Run from the repo root: sh scripts/make_icons.sh
set -e
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
exec docker run --rm -v "$REPO_DIR":/work -w /work python:3-slim bash -c '
  set -e
  apt-get update -qq >/dev/null
  apt-get install -y -qq fonts-noto-cjk fonts-noto-cjk-extra >/dev/null
  pip install --quiet pillow >/dev/null
  python scripts/make_icons.py
'
