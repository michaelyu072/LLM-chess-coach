"""Select a curated, theme-balanced puzzle corpus from the Lichess puzzle dump.

Pipeline:
  1. Pass 1 streams the .csv.zst and indexes every puzzle that survives the hard
     quality filters (compact records only: seeded hash, id, band, game, tags).
  2. Themes are allocated a share of the target by weight, scarcest-first. A theme
     whose pool is smaller than its share contributes everything it has and the
     remainder flows to the other themes. The same rule spreads each theme across
     rating bands. One puzzle per source game.
  3. Pass 2 re-streams the file, materializes the chosen rows, and replays every
     line with python-chess.
  4. Writes data/selected.jsonl and data/filter_report.md.

Lichess convention: FEN is the position *before* the opponent's move. moves[0]
is the opponent's setup move; the player solves with moves[1], moves[3], ...
"""

from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import io
import json
from pathlib import Path
from typing import Iterator

import chess
import zstandard

ROOT = Path(__file__).resolve().parent.parent

# --- Hard filters -----------------------------------------------------------
MIN_RATING = 1200           # no upper bound
MAX_RATING_DEVIATION = 80   # rating has converged
MIN_POPULARITY = 80         # players liked it (-100..100 scale)
MIN_PLAYS = 1000
MIN_PLIES, MAX_PLIES = 4, 16  # 2-8 player moves
EXCLUDED_THEMES = {"mateIn1", "oneMove"}

RATING_BANDS = [(1200, 1400), (1400, 1600), (1600, 1800), (1800, 2000), (2000, 2200), (2200, 10_000)]

# --- Theme weights -----------------------------------------------------------
# Roughly "percent of the corpus"; 0 = listed in INCLUDE_ALL. Each puzzle counts toward exactly one theme
# (its primary_theme) but keeps all its Lichess tags, so theme practice can
# match on any tag. Themes whose pool is smaller than their share are taken in
# full, so small weights on rare themes effectively mean "include everything".
THEME_GROUPS: dict[str, dict[str, float]] = {
    "core tactics": {
        "fork": 8, "pin": 6, "sacrifice": 6, "discoveredAttack": 5, "skewer": 4,
        "discoveredCheck": 2,
    },
    "secondary tactics": {
        "deflection": 4, "attraction": 4, "trappedPiece": 3, "intermezzo": 3,
        "clearance": 3, "capturingDefender": 2.5, "hangingPiece": 2,
        "interference": 2, "xRayAttack": 2, "doubleCheck": 2, "attackingF2F7": 1,
    },
    "subtle moves": {
        "quietMove": 5, "defensiveMove": 4, "zugzwang": 3,
        "collinearMove": 0, "enPassant": 0, "castling": 0, "underPromotion": 0,
    },
    "attack & pawns": {
        "kingsideAttack": 2, "queensideAttack": 1, "exposedKing": 1.5,
        "advancedPawn": 2, "promotion": 2,
    },
    "mates": {
        "mateIn2": 3, "mateIn3": 3, "mateIn4": 1.5, "mateIn5": 0.6,
        "backRankMate": 1.5, "operaMate": 0.5, "pillsburysMate": 0.5, "epauletteMate": 0.4,
        **{m: 0 for m in (
            "smotheredMate", "cornerMate", "triangleMate", "hookMate", "anastasiaMate",
            "killBoxMate", "morphysMate", "swallowstailMate", "arabianMate", "blindSwineMate",
            "vukovicMate", "dovetailMate", "balestraMate", "bodenMate", "doubleBishopMate",
        )},
    },
    "endgames": {
        "rookEndgame": 2, "pawnEndgame": 2, "bishopEndgame": 1, "knightEndgame": 1,
        "queenEndgame": 1, "queenRookEndgame": 0.5,
    },
    # Puzzles Lichess tagged with no motif (only crushing/advantage/mate/phase).
    "untagged": {"mixed": 2},
}
# Rare, high-interest themes: take every eligible puzzle, before weighting the rest.
INCLUDE_ALL = {
    "castling", "underPromotion", "enPassant", "collinearMove", "smotheredMate",
    "anastasiaMate", "arabianMate", "balestraMate", "blindSwineMate", "bodenMate",
    "cornerMate", "doubleBishopMate", "dovetailMate", "hookMate", "killBoxMate",
    "morphysMate", "swallowstailMate", "triangleMate", "vukovicMate",
}
THEME_WEIGHTS = {t: w for group in THEME_GROUPS.values() for t, w in group.items()}
FALLBACK_THEME = "mixed"
assert INCLUDE_ALL <= THEME_WEIGHTS.keys()


def rating_band(rating: int) -> int:
    for i, (lo, hi) in enumerate(RATING_BANDS):
        if lo <= rating < hi:
            return i
    raise ValueError(rating)


def band_label(i: int) -> str:
    lo, hi = RATING_BANDS[i]
    return f"{lo}+" if hi >= 10_000 else f"{lo}-{hi - 1}"


def sort_key(seed: int, puzzle_id: str) -> int:
    digest = hashlib.blake2b(f"{seed}:{puzzle_id}".encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big")


def game_id(game_url: str) -> str:
    return game_url.split("lichess.org/")[-1].split("/")[0].split("#")[0]


def stream_rows(path: Path) -> Iterator[dict]:
    with path.open("rb") as fh:
        text = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh), encoding="utf-8")
        yield from csv.DictReader(text)


def passes_hard_filters(row: dict, stats: collections.Counter) -> bool:
    stats["total"] += 1
    if int(row["Rating"]) < MIN_RATING:
        return False
    stats["rating"] += 1
    if int(row["RatingDeviation"]) > MAX_RATING_DEVIATION:
        return False
    stats["rating_deviation"] += 1
    if int(row["Popularity"]) < MIN_POPULARITY:
        return False
    stats["popularity"] += 1
    if int(row["NbPlays"]) < MIN_PLAYS:
        return False
    stats["nb_plays"] += 1
    if not MIN_PLIES <= len(row["Moves"].split()) <= MAX_PLIES:
        return False
    stats["length"] += 1
    if EXCLUDED_THEMES & set(row["Themes"].split()):
        return False
    stats["not_trivial"] += 1
    return True


def index_candidates(path: Path, seed: int):
    """Pass 1: compact index of eligible puzzles, grouped by (theme, band)."""
    stats: collections.Counter = collections.Counter()
    # (theme, band) -> list of (hash_key, puzzle_id, game_id)
    pools: dict[tuple[str, int], list[tuple[int, str, str]]] = collections.defaultdict(list)
    for row in stream_rows(path):
        if not passes_hard_filters(row, stats):
            continue
        themes = [t for t in row["Themes"].split() if t in THEME_WEIGHTS] or [FALLBACK_THEME]
        entry = (sort_key(seed, row["PuzzleId"]), row["PuzzleId"], game_id(row["GameUrl"]))
        band = rating_band(int(row["Rating"]))
        for theme in themes:
            pools[(theme, band)].append(entry)
    for entries in pools.values():
        entries.sort()
    return pools, stats


def allocate(total: int, weights: dict, available: dict) -> dict:
    """Split `total` by weight, capping each key at its availability and
    redistributing the excess. Scarcest (available / weight) first."""
    alloc = {}
    remaining, remaining_w = total, sum(weights.values())
    for k in sorted(weights, key=lambda k: available[k] / weights[k] if weights[k] else float("inf")):
        share = round(remaining * weights[k] / remaining_w) if remaining_w else 0
        alloc[k] = min(share, available[k])
        remaining -= alloc[k]
        remaining_w -= weights[k]
    return alloc


def select(pools, target: int):
    """Choose puzzle ids -> (primary_theme). Returns chosen map and planning info."""
    chosen: dict[str, str] = {}
    used_games: set[str] = set()
    n_bands = len(RATING_BANDS)

    def free(theme: str, band: int) -> list[tuple[int, str, str]]:
        return [e for e in pools.get((theme, band), []) if e[1] not in chosen and e[2] not in used_games]

    raw_pool = {t: sum(len(pools.get((t, b), [])) for b in range(n_bands)) for t in THEME_WEIGHTS}
    weighted = [t for t in THEME_WEIGHTS if t not in INCLUDE_ALL]
    order = sorted(INCLUDE_ALL, key=lambda t: raw_pool[t]) + sorted(
        weighted, key=lambda t: raw_pool[t] / THEME_WEIGHTS[t])
    remaining, remaining_w = target, sum(THEME_WEIGHTS[t] for t in weighted)
    plan = {}

    for theme in order:
        w = THEME_WEIGHTS[theme]
        free_by_band = {b: free(theme, b) for b in range(n_bands)}
        # A puzzle can sit in only one band, but dedupe by game within the theme
        # can still shrink the pool; allocate against the free counts.
        available = sum(len(v) for v in free_by_band.values())
        if theme in INCLUDE_ALL:
            quota = available
        else:
            quota = min(round(remaining * w / remaining_w), available)
            remaining_w -= w

        band_alloc = allocate(quota, {b: 1 for b in range(n_bands)},
                              {b: len(v) for b, v in free_by_band.items()})
        taken = 0
        for b in sorted(band_alloc, key=lambda b: len(free_by_band[b])):
            want = band_alloc[b]
            for _, pid, gid in free_by_band[b]:
                if want == 0:
                    break
                if pid in chosen or gid in used_games:
                    continue  # same game appeared twice in this band
                chosen[pid] = theme
                used_games.add(gid)
                want -= 1
                taken += 1
        remaining -= taken
        plan[theme] = {"weight": w, "pool": raw_pool[theme], "free": available, "selected": taken}

    return chosen, plan


def replay(fen: str, moves: list[str], themes: list[str]) -> dict | None:
    """Validate the full line with python-chess; return derived fields or None."""
    try:
        board = chess.Board(fen)
    except ValueError:
        return None
    player = not board.turn  # the player moves after the opponent's setup move
    sans = []
    for uci in moves:
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            return None
        if move not in board.legal_moves:
            return None
        sans.append(board.san(move))
        board.push(move)
    if any(t.startswith("mate") for t in themes) and not board.is_checkmate():
        return None
    return {
        "player_color": "white" if player == chess.WHITE else "black",
        "setup_move_san": sans[0],
        "solution_san": sans[1:],
    }


def materialize(path: Path, chosen: dict[str, str]):
    """Pass 2: build full records for the chosen ids and validate each line."""
    selected, invalid = [], []
    for row in stream_rows(path):
        theme = chosen.get(row["PuzzleId"])
        if theme is None:
            continue
        moves, themes = row["Moves"].split(), row["Themes"].split()
        derived = replay(row["FEN"], moves, themes)
        if derived is None:
            invalid.append(row["PuzzleId"])
            continue
        selected.append({
            "id": row["PuzzleId"],
            "fen": row["FEN"],
            "moves": moves,
            "rating": int(row["Rating"]),
            "rating_deviation": int(row["RatingDeviation"]),
            "popularity": int(row["Popularity"]),
            "nb_plays": int(row["NbPlays"]),
            "themes": themes,
            "primary_theme": theme,
            "game_url": row["GameUrl"],
            "opening_tags": row["OpeningTags"].split(),
            **derived,
        })
    return selected, invalid


def write_report(path: Path, stats, plan, selected, invalid, args) -> None:
    by_band = collections.Counter(rating_band(p["rating"]) for p in selected)
    by_plies = collections.Counter(len(p["moves"]) for p in selected)
    by_phase = collections.Counter(
        next((t for t in p["themes"] if t in ("opening", "middlegame", "endgame")), "unknown")
        for p in selected
    )
    tag_coverage = collections.Counter(t for p in selected for t in p["themes"])
    lines = [
        "# Filter report",
        "",
        f"Input: `{args.input.name}` | seed: {args.seed} | target: {args.target:,} | "
        f"selected: **{len(selected):,}** | invalid lines dropped: {len(invalid)}",
        "",
        "## Hard-filter funnel",
        "",
        "| Stage | Remaining |",
        "|---|---:|",
    ]
    labels = [
        ("total", "All puzzles"),
        ("rating", f"Rating >= {MIN_RATING}"),
        ("rating_deviation", f"RatingDeviation <= {MAX_RATING_DEVIATION}"),
        ("popularity", f"Popularity >= {MIN_POPULARITY}"),
        ("nb_plays", f"NbPlays >= {MIN_PLAYS}"),
        ("length", f"{MIN_PLIES}-{MAX_PLIES} plies"),
        ("not_trivial", "Not mateIn1 / oneMove"),
    ]
    lines += [f"| {label} | {stats[key]:,} |" for key, label in labels]

    lines += ["", "## Primary theme allocation", "",
              "`pool` = eligible puzzles carrying the tag; `selected` = puzzles whose primary theme it is; "
              "`all` = the theme's whole remaining pool was taken.", ""]
    for group, weights in THEME_GROUPS.items():
        group_total = sum(plan[t]["selected"] for t in weights)
        lines += [f"### {group} ({group_total:,})", "", "| Theme | Weight | Pool | Selected | |",
                  "|---|---:|---:|---:|---|"]
        for t in weights:
            p = plan[t]
            flag = "all" if p["selected"] >= p["free"] else ""
            weight = "all" if t in INCLUDE_ALL else p["weight"]
            lines.append(f"| {t} | {weight} | {p['pool']:,} | {p['selected']:,} | {flag} |")
        lines.append("")

    lines += ["## Rating bands", "", "| Band | Count |", "|---|---:|"]
    lines += [f"| {band_label(i)} | {by_band[i]:,} |" for i in range(len(RATING_BANDS))]
    lines += ["", "## Solution length", "", "| Plies (incl. setup) | Player moves | Count |", "|---:|---:|---:|"]
    lines += [f"| {n} | {n // 2} | {by_plies[n]:,} |" for n in sorted(by_plies)]
    lines += ["", "## Game phase", "", "| Phase | Count |", "|---|---:|"]
    lines += [f"| {k} | {v:,} |" for k, v in by_phase.most_common()]
    lines += ["", "## Tag coverage (any tag)", "", "| Tag | Puzzles |", "|---|---:|"]
    lines += [f"| {k} | {v:,} |" for k, v in tag_coverage.most_common()]
    if invalid:
        lines += ["", "## Invalid lines dropped", "", ", ".join(invalid)]
    path.write_text("\n".join(lines) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", type=Path, default=ROOT / "lichess_db_puzzle.csv.zst")
    parser.add_argument("--out", type=Path, default=ROOT / "data" / "selected.jsonl")
    parser.add_argument("--report", type=Path, default=ROOT / "data" / "filter_report.md")
    parser.add_argument("--target", type=int, default=100_000)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    pools, stats = index_candidates(args.input, args.seed)
    print(f"Pass 1: {stats['not_trivial']:,} eligible puzzles indexed")
    chosen, plan = select(pools, args.target)
    del pools
    print(f"Selected {len(chosen):,} ids; pass 2: materializing + validating")
    selected, invalid = materialize(args.input, chosen)
    selected.sort(key=lambda p: (p["primary_theme"], p["rating"], p["id"]))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as fh:
        for p in selected:
            fh.write(json.dumps(p) + "\n")
    write_report(args.report, stats, plan, selected, invalid, args)
    print(f"Wrote {len(selected):,} puzzles -> {args.out} ({len(invalid)} invalid dropped)")
    print(f"Report -> {args.report}")


if __name__ == "__main__":
    main()
