#!/bin/sh
# Pull latest HonLib (incl. submodules) and rebuild on this box.
set -e
cd "$(dirname "$0")"
git pull --ff-only
git submodule update --init --recursive
docker compose -f compose.box.yml up -d --build
docker image prune -f >/dev/null 2>&1 || true
echo "honlib updated -> https://honlib.razerblade.dev"
