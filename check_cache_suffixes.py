#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


# Legacy query suffix format used by old cache naming logic.
QUERY_SUFFIX_RE = re.compile(r"__q_[0-9a-f]{8}(?=\.|$)")


def find_suffixed_files(cache_dir: Path) -> list[Path]:
    matches: list[Path] = []
    for path in cache_dir.rglob("*"):
        if not path.is_file():
            continue
        if QUERY_SUFFIX_RE.search(path.name):
            matches.append(path)
    return sorted(matches)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check cache tree for legacy query-suffixed files (e.g. __q_deadbeef)."
    )
    parser.add_argument(
        "--cache-dir",
        default="cache",
        help="Cache root to scan (default: ./cache)",
    )
    args = parser.parse_args()

    cache_dir = Path(args.cache_dir)
    if not cache_dir.exists():
        print(f"[ERROR] Cache directory does not exist: {cache_dir}")
        return 2
    if not cache_dir.is_dir():
        print(f"[ERROR] Not a directory: {cache_dir}")
        return 2

    bad_files = find_suffixed_files(cache_dir)
    if not bad_files:
        print(f"[OK] No legacy query-suffixed cache files found under: {cache_dir}")
        return 0

    print(f"[FAIL] Found {len(bad_files)} legacy query-suffixed cache file(s):")
    for file_path in bad_files:
        print(file_path)
    return 1


if __name__ == "__main__":
    sys.exit(main())
