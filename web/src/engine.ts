// Browser Stockfish, the way lichess.org runs it: @lichess-org/stockfish-web's
// "Stockfish 19 · 1MB" (sf_19_smallnet) build, multi-threaded over shared
// WebAssembly memory, NNUE net loaded as a buffer. Boot sequence and UCI
// handling follow lila's ui/lib/src/ceval (StockfishWebEngine + Protocol),
// reduced to standard chess.
import type StockfishWeb from '@lichess-org/stockfish-web';
import { useEffect, useState } from 'react';

const ROOT = '/stockfish';
export const ENGINE_NAME = 'Stockfish 19 · 1MB';
const MIN_MEMORY_PAGES = 1536; // lila's minMem for sf_19_smallnet (64 KiB pages)
const HASH_MB = 32;
const MAX_DEPTH = 24;

export type EngineState = 'off' | 'loading' | 'ready' | 'failed' | 'unsupported';

/** One principal variation. Scores are from White's point of view. */
export interface PvLine {
  moves: string[]; // UCI
  cp?: number;
  mate?: number;
  depth: number;
}
export interface Evaluation {
  fen: string;
  depth: number;
  nodes: number;
  millis: number;
  lines: PvLine[];
}

interface Work {
  fen: string;
  multiPv: number;
  /** Search limits; defaults to MAX_DEPTH with no time limit. */
  depth?: number;
  movetime?: number;
  onEval: (ev: Evaluation) => void;
  /** Called when the search ends (finished or stopped) with its last evaluation. */
  onDone?: (last: Evaluation | undefined) => void;
  stopRequested?: boolean;
}

// ---------------------------------------------------------------------------
// Feature detection (same probes as lila's ui/lib/src/device.ts)

function supports(): { ok: true; relaxedSimd: boolean } | { ok: false; reason: string } {
  if (typeof WebAssembly !== 'object') return { ok: false, reason: 'This browser has no WebAssembly.' };
  // i32x4.dot_i16x8_s, i32x4.trunc_sat_f64x2_u_zero
  const simd = Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 12, 2, 96, 2, 123, 123, 1, 123, 96, 1, 123, 1, 123, 3, 3, 2, 0, 1, 7, 9, 2, 1,
    97, 0, 0, 1, 98, 0, 1, 10, 19, 2, 9, 0, 32, 0, 32, 1, 253, 186, 1, 11, 7, 0, 32, 0, 253, 253, 1, 11,
  ]);
  if (!WebAssembly.validate(simd)) return { ok: false, reason: 'This browser lacks WebAssembly SIMD.' };
  // i32x4.dot_i8x16_i7x16_add_s
  const relaxed = Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 8, 1, 96, 3, 123, 123, 123, 1, 123, 3, 2, 1, 0, 7, 5, 1, 1, 99, 0, 0, 10, 13, 1,
    11, 0, 32, 0, 32, 1, 32, 2, 253, 147, 2, 11,
  ]);
  if (!sharedMemory())
    return {
      ok: false,
      reason: 'Shared memory is unavailable (the page must be cross-origin isolated).',
    };
  return { ok: true, relaxedSimd: WebAssembly.validate(relaxed) };
}

function sharedMemory(): boolean {
  // WebKit crash: https://bugs.webkit.org/show_bug.cgi?id=303387 (lila excludes it too)
  if (navigator.userAgent.toLowerCase().includes('version/26.2')) return false;
  if (typeof Atomics !== 'object' || typeof SharedArrayBuffer !== 'function' || !crossOriginIsolated) return false;
  try {
    const mem = new WebAssembly.Memory({ shared: true, initial: 1, maximum: 2 });
    return mem.buffer instanceof SharedArrayBuffer;
  } catch {
    return false;
  }
}

/** Largest shared memory the browser will grant, from lila's ceval/util.ts. */
function sharedWasmMemory(lo: number, hi = 32767): WebAssembly.Memory {
  let shrink = 4;
  for (;;) {
    try {
      return new WebAssembly.Memory({ shared: true, initial: lo, maximum: hi });
    } catch (e) {
      if (hi <= lo || !(e instanceof RangeError)) throw e;
      hi = Math.max(lo, Math.ceil(hi - hi / shrink));
      shrink = shrink === 4 ? 3 : 4;
    }
  }
}

// ---------------------------------------------------------------------------

class Engine {
  state: EngineState = 'off';
  error?: string;
  private module?: StockfishWeb;
  private booting?: Promise<void>;
  private ready = false;
  private work?: Work;
  private next?: Work;
  /** Live analysis to resume after a one-off evaluate() borrows the engine. */
  private background?: Work;
  private current?: Evaluation;
  private expectedPvs = 1;
  private options = new Map<string, string>();
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private setState(state: EngineState, error?: string) {
    this.state = state;
    this.error = error;
    this.listeners.forEach(fn => fn());
  }

  boot(): Promise<void> {
    this.booting ??= this.load().catch(e => {
      const unsupported = e instanceof UnsupportedError;
      this.setState(unsupported ? 'unsupported' : 'failed', String(e.message ?? e));
      throw e;
    });
    return this.booting;
  }

  private async load(): Promise<void> {
    const support = supports();
    if (!support.ok) throw new UnsupportedError(support.reason);
    this.setState('loading');
    const scriptUrl = new URL(`${ROOT}/sf_19_smallnet${support.relaxedSimd ? '_relaxed-simd' : ''}.js`, location.href)
      .href;
    const makeModule = (await import(/* @vite-ignore */ scriptUrl)).default;
    const module: StockfishWeb = await makeModule({
      wasmMemory: sharedWasmMemory(MIN_MEMORY_PAGES),
      locateFile: (file: string) => `${ROOT}/${file}`,
      mainScriptUrlOrBlob: scriptUrl,
    });
    module.onError = (msg: string) => this.setState('failed', msg);
    // The build names the net(s) it expects; index 0 = big, 1 = small (dual-net builds).
    for (let i = 0; ; i++) {
      const name = module.getRecommendedNnue(i);
      if (!name) break;
      const res = await fetch(`${ROOT}/${name}`);
      if (!res.ok) throw new Error(`Could not load NNUE ${name} (HTTP ${res.status})`);
      module.setNnueBuffer(new Uint8Array(await res.arrayBuffer()), i);
    }
    module.listen = (line: string) => this.received(line);
    this.module = module;
    this.send('uci');
  }

  /** Continuously analyse `fen` (replacing any running search). */
  analyze(work: Work): void {
    this.background = work;
    this.next = work;
    this.stopCurrent();
    this.swapWork();
  }

  /** Stop searching (engine stays loaded). */
  stop(): void {
    this.background = undefined;
    this.next = undefined;
    this.stopCurrent();
  }

  /**
   * One-off search that resolves with its final evaluation (e.g. for the coach
   * chat). Pre-empts live analysis and resumes it afterwards. Resolves null if
   * the engine is unavailable or the search was cut short before any result.
   */
  async evaluate(
    fen: string,
    { multiPv = 3, depth = 18, movetime = 3000 }: { multiPv?: number; depth?: number; movetime?: number } = {},
  ): Promise<Evaluation | null> {
    try {
      await this.boot();
    } catch {
      return null;
    }
    return new Promise(resolve => {
      this.next = {
        fen,
        multiPv,
        depth,
        movetime,
        onEval: () => {},
        onDone: last => {
          resolve(last ?? null);
          if (this.background && !this.next) {
            this.next = { ...this.background, stopRequested: false };
            this.swapWork();
          }
        },
      };
      this.stopCurrent();
      this.swapWork();
    });
  }

  private send(cmd: string) {
    this.module?.uci(cmd);
  }

  private setOption(name: string, value: string | number) {
    const v = String(value);
    if (this.options.get(name) === v) return;
    this.send(`setoption name ${name} value ${v}`);
    this.options.set(name, v);
  }

  private stopCurrent() {
    if (this.work && !this.work.stopRequested) {
      this.work.stopRequested = true;
      this.send('stop');
    }
  }

  private swapWork() {
    if (!this.ready || this.work) return;
    this.work = this.next;
    this.next = undefined;
    if (!this.work) return;
    this.current = undefined;
    this.expectedPvs = 1;
    const threads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
    this.setOption('Threads', threads);
    this.setOption('Hash', HASH_MB);
    this.setOption('MultiPV', Math.max(1, this.work.multiPv));
    this.send(`position fen ${this.work.fen}`);
    const { depth = MAX_DEPTH, movetime } = this.work;
    this.send(`go depth ${depth}${movetime ? ` movetime ${movetime}` : ''}`);
  }

  private received(line: string) {
    const parts = line.trim().split(/\s+/g);
    if (parts[0] === 'uciok') {
      this.setOption('UCI_AnalyseMode', 'true');
      this.send('ucinewgame');
      this.send('isready');
    } else if (parts[0] === 'readyok') {
      if (!this.ready) {
        this.ready = true;
        this.setState('ready');
      }
      this.swapWork();
    } else if (parts[0] === 'bestmove') {
      const done = this.work;
      const last = this.current;
      this.work = undefined;
      done?.onDone?.(last && last.fen === done.fen ? structuredClone(last) : undefined);
      this.swapWork();
    } else if (parts[0] === 'info' && this.work && !this.work.stopRequested) {
      this.parseInfo(parts, this.work);
    }
  }

  private parseInfo(parts: string[], work: Work) {
    let depth = 0;
    let nodes: number | undefined;
    let millis: number | undefined;
    let multiPv = 1;
    let isMate = false;
    let povEv: number | undefined;
    let bound = false;
    let moves: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      switch (parts[i]) {
        case 'depth':
          depth = parseInt(parts[++i]);
          break;
        case 'nodes':
          nodes = parseInt(parts[++i]);
          break;
        case 'multipv':
          multiPv = parseInt(parts[++i]);
          break;
        case 'time':
          millis = parseInt(parts[++i]);
          break;
        case 'score':
          isMate = parts[++i] === 'mate';
          povEv = parseInt(parts[++i]);
          if (parts[i + 1] === 'lowerbound' || parts[i + 1] === 'upperbound') {
            bound = true;
            i++;
          }
          break;
        case 'pv':
          moves = parts.slice(++i);
          i = parts.length;
          break;
      }
    }
    if (isMate && !povEv) return; // "#0": the side to move is already mated
    if (nodes === undefined || millis === undefined || povEv === undefined) return;
    if (bound && multiPv === 1) return;
    if (this.expectedPvs < multiPv) this.expectedPvs = multiPv;

    // Engine scores are from the side to move; report from White's view.
    const ev = work.fen.split(' ')[1] === 'b' ? -povEv : povEv;
    const pv: PvLine = { moves, cp: isMate ? undefined : ev, mate: isMate ? ev : undefined, depth };

    if (multiPv === 1) {
      // Skip out-of-order depth lines, as lila does.
      if (depth !== (this.current?.depth ?? 0) + 1) return;
      this.current = { fen: work.fen, depth, nodes, millis, lines: [pv] };
    } else if (this.current) {
      this.current.lines[multiPv - 1] = pv;
    } else return;

    if (multiPv === this.expectedPvs) work.onEval(structuredClone(this.current));
  }
}

class UnsupportedError extends Error {}

export const engine = new Engine();

/**
 * Analyse `fen` while `enabled`. Boots the engine on first use; stops the
 * search when disabled or when the position changes.
 */
export function useEngine(fen: string | null, enabled: boolean, multiPv = 3) {
  const [state, setState] = useState<EngineState>(engine.state);
  const [error, setError] = useState<string | undefined>(engine.error);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);

  useEffect(
    () =>
      engine.subscribe(() => {
        setState(engine.state);
        setError(engine.error);
      }),
    [],
  );

  useEffect(() => {
    setEvaluation(null);
    if (!enabled || !fen) {
      engine.stop();
      return;
    }
    let live = true;
    engine
      .boot()
      .then(() => live && engine.analyze({ fen, multiPv, onEval: ev => live && setEvaluation(ev) }))
      .catch(() => {}); // surfaced through engine state
    return () => {
      live = false;
    };
  }, [fen, enabled, multiPv]);

  useEffect(() => () => engine.stop(), []);

  return { state, error, evaluation };
}

/** lila's winning-chances curve: centipawns -> [-1, 1]. */
export function winningChances(line: Pick<PvLine, 'cp' | 'mate'>): number {
  if (line.mate !== undefined) return line.mate > 0 ? 1 : -1;
  const cp = Math.max(-1000, Math.min(1000, line.cp ?? 0));
  return 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
}

export function formatScore(line: Pick<PvLine, 'cp' | 'mate'>): string {
  if (line.mate !== undefined) return `#${line.mate}`;
  const pawns = (line.cp ?? 0) / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`;
}
