// Puts lichess's browser Stockfish into public/stockfish/:
//   - sf_19_smallnet{,_relaxed-simd}.{js,wasm} from @lichess-org/stockfish-web
//     (the engine lichess.org marks "preferred": "Stockfish 19 · 1MB")
//   - its NNUE net. lila's lifat clone only holds Git LFS pointers, so the net is
//     downloaded from the official Stockfish net server, then hash-checked
//     (Stockfish nets are named nn-<first 12 hex of sha256>.nnue).
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(webRoot, 'node_modules', '@lichess-org', 'stockfish-web');
const out = join(webRoot, 'public', 'stockfish');
const lifat = join(webRoot, '..', 'lila', 'public', 'lifat', 'nnue');

const ENGINE_FILES = [
  'sf_19_smallnet.js',
  'sf_19_smallnet.wasm',
  'sf_19_smallnet_relaxed-simd.js',
  'sf_19_smallnet_relaxed-simd.wasm',
];
const NETS = ['nn-61e7af4bb97d.nnue'];

mkdirSync(out, { recursive: true });
for (const f of ENGINE_FILES) copyFileSync(join(pkg, f), join(out, f));

const hashOk = (buf, name) => createHash('sha256').update(buf).digest('hex').startsWith(name.slice(3, 15));

for (const name of NETS) {
  const dest = join(out, name);
  if (existsSync(dest) && hashOk(readFileSync(dest), name)) continue;
  const local = join(lifat, name);
  // A real net is ~1MB+; LFS pointer files are ~130 bytes.
  if (existsSync(local) && statSync(local).size > 10_000 && hashOk(readFileSync(local), name)) {
    copyFileSync(local, dest);
    continue;
  }
  const url = `https://tests.stockfishchess.org/api/nn/${name}`;
  console.log(`Downloading ${name} from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!hashOk(buf, name)) throw new Error(`Downloaded ${name} failed its hash check`);
  writeFileSync(dest, buf);
}

console.log(`Stockfish: ${ENGINE_FILES.length} engine files + ${NETS.length} net(s) in public/stockfish/`);
