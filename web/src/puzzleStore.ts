// Loads the puzzle set exported by pipeline/export_web.py: a columnar index of
// every puzzle (for filtering and counts) plus shards holding the full puzzles.
// Only the shards of puzzles actually shown are downloaded.
import type { Puzzle } from './session';

export interface PuzzleIndex {
  count: number;
  shard_size: number;
  /** Theme names; `primary` and `tags` hold positions in this list. */
  themes: string[];
  id: string[];
  rating: number[];
  primary: number[];
  tags: number[][];
}

const BASE = '/puzzles';
const shards = new Map<number, Promise<Puzzle[]>>();

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json() as Promise<T>;
}

export function loadIndex(): Promise<PuzzleIndex> {
  return getJson<PuzzleIndex>(`${BASE}/index.json`);
}

function loadShard(n: number): Promise<Puzzle[]> {
  let shard = shards.get(n);
  if (!shard) {
    shard = getJson<Puzzle[]>(`${BASE}/${String(n).padStart(3, '0')}.json`);
    shards.set(n, shard);
    shard.catch(() => shards.delete(n)); // let a failed download be retried
  }
  return shard;
}

/** The full puzzle at position `i` of the index. */
export async function loadPuzzle(index: PuzzleIndex, i: number): Promise<Puzzle> {
  const shard = await loadShard(Math.floor(i / index.shard_size));
  const puzzle = shard[i % index.shard_size];
  if (!puzzle || puzzle.id !== index.id[i]) throw new Error(`puzzle ${index.id[i]} missing from its shard`);
  return puzzle;
}
