#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from web_bundle import build_bundle  # noqa: E402


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    build_bundle(root / "static", Path(sys.argv[1]) if len(sys.argv) > 1 else root / "app-bundle")
