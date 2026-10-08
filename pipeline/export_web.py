"""Export data/selected.jsonl for the web app as a compact index plus shards.

All 100k puzzles don't fit in one static file (Cloudflare serves assets up to
25 MiB, and nobody should download 36 MB to see one puzzle), so the export is:

  web/public/puzzles/index.json   columnar: id, rating, theme tags and primary
                                  theme of every puzzle, for filtering and counts
  web/public/puzzles/NNN.json     the full puzzles, --shard-size per file, in index order

The app filters on the index, then fetches only the shard holding the puzzle
it shows. Puzzles are shuffled with a fixed seed so every shard mixes themes
and ratings. Use -n to export a theme-stratified sample instead of everything.
"""

from __future__ import annotations

import argparse
import collections
import json
import random
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIELDS = ("id", "fen", "moves", "rating", "themes", "primary_theme",
          "player_color", "solution_san", "game_url")


def stratified_sample(by_theme: dict[str, list[dict]], n: int, rng: random.Random) -> list[dict]:
    """Each primary theme gets a share proportional to its size (largest remainder, at least one)."""
    total = sum(len(v) for v in by_theme.values())
    exact = {t: n * len(v) / total for t, v in by_theme.items()}
    alloc = {t: max(1, int(x)) for t, x in exact.items()}
    for t in sorted(exact, key=lambda t: exact[t] - int(exact[t]), reverse=True):
        if sum(alloc.values()) >= n:
            break
        alloc[t] += 1
    return [p for t in sorted(by_theme) for p in rng.sample(by_theme[t], min(alloc[t], len(by_theme[t])))]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", type=Path, default=ROOT / "data" / "selected.jsonl")
    parser.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "puzzles")
    parser.add_argument("-n", type=int, default=0, help="stratified sample size (default: every puzzle)")
    parser.add_argument("--shard-size", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    by_theme: dict[str, list[dict]] = collections.defaultdict(list)
    with args.input.open() as fh:
        for line in fh:
            p = json.loads(line)
            by_theme[p["primary_theme"]].append({k: p[k] for k in FIELDS})

    rng = random.Random(args.seed)
    if args.n:
        puzzles = stratified_sample(by_theme, args.n, rng)
    else:
        puzzles = [p for t in sorted(by_theme) for p in by_theme[t]]
    rng.shuffle(puzzles)

    names = sorted({t for p in puzzles for t in p["themes"]} | {p["primary_theme"] for p in puzzles})
    code = {t: i for i, t in enumerate(names)}
    index = {
        "count": len(puzzles),
        "shard_size": args.shard_size,
        "themes": names,
        "id": [p["id"] for p in puzzles],
        "rating": [p["rating"] for p in puzzles],
        "primary": [code[p["primary_theme"]] for p in puzzles],
        "tags": [[code[t] for t in p["themes"]] for p in puzzles],
    }

    if args.out.exists():
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True)
    compact = {"separators": (",", ":"), "ensure_ascii": False}
    (args.out / "index.json").write_text(json.dumps(index, **compact))
    shards = 0
    for start in range(0, len(puzzles), args.shard_size):
        (args.out / f"{shards:03d}.json").write_text(json.dumps(puzzles[start : start + args.shard_size], **compact))
        shards += 1

    size = (args.out / "index.json").stat().st_size
    print(f"Wrote {len(puzzles)} puzzles across {len(by_theme)} primary themes -> {args.out}")
    print(f"  index.json {size / 1e6:.1f} MB, {shards} shards of up to {args.shard_size}")


if __name__ == "__main__":
    main()
