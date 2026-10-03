"""Export a theme-stratified sample of data/selected.jsonl for the web app.

Each primary theme gets a share proportional to its size in the selected corpus
(largest-remainder rounding, at least one puzzle per theme), sampled with a
fixed seed. Writes a compact JSON array to web/public/puzzles.json.
"""

from __future__ import annotations

import argparse
import collections
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIELDS = ("id", "fen", "moves", "rating", "themes", "primary_theme",
          "player_color", "solution_san", "game_url")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "data" / "selected.jsonl")
    parser.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "puzzles.json")
    parser.add_argument("-n", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    by_theme: dict[str, list[dict]] = collections.defaultdict(list)
    with args.input.open() as fh:
        for line in fh:
            p = json.loads(line)
            by_theme[p["primary_theme"]].append({k: p[k] for k in FIELDS})

    total = sum(len(v) for v in by_theme.values())
    exact = {t: args.n * len(v) / total for t, v in by_theme.items()}
    alloc = {t: max(1, int(x)) for t, x in exact.items()}
    for t in sorted(exact, key=lambda t: exact[t] - int(exact[t]), reverse=True):
        if sum(alloc.values()) >= args.n:
            break
        alloc[t] += 1

    rng = random.Random(args.seed)
    sample = [p for t in sorted(by_theme) for p in rng.sample(by_theme[t], min(alloc[t], len(by_theme[t])))]
    rng.shuffle(sample)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(sample, separators=(",", ":")))
    print(f"Wrote {len(sample)} puzzles across {len(by_theme)} themes -> {args.out}")


if __name__ == "__main__":
    main()
