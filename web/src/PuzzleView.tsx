import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PromotionPicker } from './PromotionPicker';
import type { AnalysisRequest } from './position';
import { lineMoves, PuzzleSession, type Puzzle } from './session';
import { playSound, soundForSan } from './sound';
import type { Result } from './storage';
import { META_THEMES, themeDescription, themeName } from './themes';

type Phase = 'intro' | 'play' | 'good' | 'wrong' | 'solved' | 'failed';

interface Props {
  puzzle: Puzzle;
  /** False while another tab is showing: keyboard shortcuts are disabled. */
  active: boolean;
  pieces: string;
  sound: boolean;
  onFinish: (result: Result, meta: { wrong: number; hints: number; ms: number }) => void;
  onNext: () => void;
  /** Reports the measured board edge (px), or null when the layout is stacked. */
  onBoardSize?: (px: number | null) => void;
  /** The position on screen (changes with each move and while reviewing). */
  onPosition?: (pos: { fen: string; solved: boolean }) => void;
  /** Open the finished puzzle's line in the Board tab. */
  onAnalyze?: (req: Omit<AnalysisRequest, 'id'>) => void;
  children?: ReactNode;
}

// Progressive coaching: wrong attempt #2 -> hint 1, #3 -> hint 2, #4 -> solution.
const HINT_AFTER_WRONG = [0, 0, 1, 2];
const SOLUTION_AFTER_WRONG = 4;
/** Y: fixed height of the slot the hint / solution box pops into. */
const POPUP_HEIGHT = 172;

export function PuzzleView(props: Props) {
  const { puzzle } = props;
  const boardEl = useRef<HTMLDivElement>(null);
  const layoutEl = useRef<HTMLDivElement>(null);
  const sideEl = useRef<HTMLElement>(null);
  const popupEl = useRef<HTMLElement>(null);
  const cg = useRef<Api>();
  const [session] = useState(() => new PuzzleSession(puzzle));
  const timers = useRef<number[]>([]);
  const started = useRef(performance.now());
  const wrongRef = useRef(0);
  const hintRef = useRef(0);
  const finished = useRef(false);
  const introDone = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;

  const [phase, setPhase] = useState<Phase>('intro');
  const [hint, setHint] = useState(0);
  const [line, setLine] = useState<string[]>([]);
  const [promotion, setPromotion] = useState<{ orig: string; dest: string } | null>(null);
  // Snapshot index shown on the board once the puzzle is over (review mode).
  const [viewPly, setViewPly] = useState<number | null>(null);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };
  const sound = (name: Parameters<typeof playSound>[0]) => propsRef.current.sound && playSound(name);

  const sync = (interactive: boolean) => {
    cg.current?.set({
      fen: session.fen(),
      turnColor: session.turn,
      lastMove: session.lastMove as Key[] | undefined,
      check: session.checkColor,
      movable: {
        color: interactive ? puzzle.player_color : undefined,
        dests: interactive ? (session.dests() as Map<Key, Key[]>) : new Map(),
      },
    });
  };

  const playOpponent = () => {
    const san = session.apply();
    sound(soundForSan(san));
    setLine([...session.sans]);
    sync(session.userTurn);
  };

  const finish = (result: Result) => {
    if (finished.current) return;
    finished.current = true;
    sync(false);
    setViewPly(session.snapshots.length - 1);
    cg.current?.setAutoShapes([]);
    setPhase(result === 'failed' ? 'failed' : 'solved');
    if (result !== 'failed') sound(result === 'clean' ? 'Victory' : 'Confirmation');
    propsRef.current.onFinish(result, {
      wrong: wrongRef.current,
      hints: hintRef.current,
      ms: Math.round(performance.now() - started.current),
    });
  };

  const raiseHint = (level: number) => {
    if (level <= hintRef.current || finished.current) return;
    hintRef.current = level;
    setHint(level);
    if (level >= 2 && session.userTurn) {
      cg.current?.setAutoShapes([{ orig: session.expected.slice(0, 2) as Key, brush: 'green' }]);
    }
  };

  const showSolution = () => {
    if (finished.current) return;
    setPhase('failed');
    sync(false);
    const step = () => {
      if (session.done) return finish('failed');
      const san = session.apply();
      sound(soundForSan(san));
      setLine([...session.sans]);
      sync(false);
      cg.current?.setAutoShapes([]);
      later(step, 700);
    };
    later(step, 300);
  };

  const submit = (uci: string) => {
    if (finished.current) return;
    const verdict = session.check(uci);
    if (verdict === 'correct') {
      const san = session.apply(uci);
      sound(soundForSan(san));
      setLine([...session.sans]);
      cg.current?.setAutoShapes([]);
      if (session.done) return finish(wrongRef.current === 0 && hintRef.current === 0 ? 'clean' : 'assisted');
      setPhase('good');
      sync(false);
      later(() => {
        playOpponent();
        if (session.done) finish('assisted');
        else {
          setPhase('play');
          if (hintRef.current >= 2)
            cg.current?.setAutoShapes([{ orig: session.expected.slice(0, 2) as Key, brush: 'green' }]);
        }
      }, 450);
      return;
    }
    // Wrong (or illegal): reject, then snap the board back.
    wrongRef.current++;
    sound('Error');
    setPhase('wrong');
    cg.current?.set({ movable: { color: undefined } });
    const wrong = wrongRef.current;
    if (wrong >= SOLUTION_AFTER_WRONG) {
      later(() => sync(false), 400);
      later(showSolution, 700);
    } else {
      later(() => sync(true), 400);
      raiseHint(HINT_AFTER_WRONG[wrong] ?? 0);
    }
  };

  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    const api = Chessground(boardEl.current!, {
      fen: session.fen(),
      orientation: puzzle.player_color,
      turnColor: session.turn,
      coordinates: true,
      movable: {
        free: false,
        color: undefined,
        showDests: true,
        events: {
          after: (orig, dest) => {
            const piece = session.pieceAt(orig);
            if (piece?.role === 'pawn' && (dest[1] === '8' || dest[1] === '1')) setPromotion({ orig, dest });
            else submitRef.current(orig + dest);
          },
        },
      },
      premovable: { enabled: false },
      animation: { enabled: true, duration: 220 },
      highlight: { lastMove: true, check: true },
      drawable: { enabled: true },
    });
    cg.current = api;
    const ro = new ResizeObserver(() => api.redrawAll());
    ro.observe(boardEl.current!);
    // A hot reload re-runs this effect with the puzzle already under way:
    // rebuild the board where it is instead of replaying the opening move.
    if (introDone.current) sync(session.userTurn && !finished.current);
    else
      later(() => {
        introDone.current = true;
        playOpponent();
        setPhase('play');
        started.current = performance.now();
      }, 700);
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      ro.disconnect();
      api.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Layout: the board is X×X. The side panel's always-visible content is
  // X − Y tall; Y (POPUP_HEIGHT + gap) is reserved for the hint / solution
  // box, so when that pops up the panel reaches exactly X and the board never
  // resizes. X is derived from the static content, capped by available width.
  useLayoutEffect(() => {
    const layout = layoutEl.current!;
    const side = sideEl.current!;
    const stacked = window.matchMedia('(max-width: 900px)');
    const measure = () => {
      if (stacked.matches) {
        layout.style.removeProperty('--board-size');
        return propsRef.current.onBoardSize?.(null);
      }
      if (!layout.clientWidth) return; // not laid out yet
      const colGap = parseFloat(getComputedStyle(layout).columnGap) || 0;
      const rowGap = parseFloat(getComputedStyle(side).rowGap) || 0;
      const popup = popupEl.current;
      const staticHeight = side.offsetHeight - (popup ? popup.offsetHeight + rowGap : 0);
      const x = staticHeight + rowGap + POPUP_HEIGHT;
      const room = layout.clientWidth - side.offsetWidth - colGap;
      const size = Math.floor(Math.min(x, room));
      layout.style.setProperty('--board-size', `${size}px`);
      propsRef.current.onBoardSize?.(size);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(side);
    ro.observe(layout);
    stacked.addEventListener('change', measure);
    return () => {
      ro.disconnect();
      stacked.removeEventListener('change', measure);
    };
  }, []);

  // Review: step through the solution. Index 1 is the puzzle's starting
  // position (after the opponent's setup move); the last index is the end.
  const firstPly = 1;
  const lastPly = session.snapshots.length - 1;
  const goTo = (i: number) => {
    const target = Math.max(firstPly, Math.min(lastPly, i));
    if (target === viewPly) return;
    const snap = session.snapshots[target];
    cg.current?.set({
      fen: snap.fen,
      lastMove: snap.lastMove as Key[] | undefined,
      check: snap.check,
      // Odd snapshots (after the setup move, after each reply) are the player's turn.
      turnColor: target % 2 === 1 ? puzzle.player_color : puzzle.player_color === 'white' ? 'black' : 'white',
      movable: { color: undefined, dests: new Map() },
    });
    cg.current?.setAutoShapes([]);
    if (viewPly !== null && target === viewPly + 1) sound(soundForSan(session.sans[target - 1]));
    setViewPly(target);
  };
  const goToRef = useRef(goTo);
  goToRef.current = goTo;

  // Once finished: ←/→ step through moves, Home/End jump, Enter/Space = next puzzle.
  useEffect(() => {
    if (viewPly === null || !props.active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, select, textarea')) return;
      const actions: Record<string, () => void> = {
        ArrowLeft: () => goToRef.current((viewPly ?? lastPly) - 1),
        ArrowRight: () => goToRef.current((viewPly ?? lastPly) + 1),
        Home: () => goToRef.current(firstPly),
        End: () => goToRef.current(lastPly),
        Enter: () => propsRef.current.onNext(),
        ' ': () => propsRef.current.onNext(),
      };
      const action = actions[e.key];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewPly, lastPly, props.active]);

  // Tell the parent which position is on screen (for the coach chat).
  useEffect(() => {
    const fen = viewPly !== null ? session.snapshots[viewPly].fen : session.fen();
    propsRef.current.onPosition?.({ fen, solved: phase === 'solved' || phase === 'failed' });
  }, [line, viewPly, phase, session]);

  // Hand the whole line (setup move + moves actually played) to the Board tab,
  // positioned where the user is reviewing.
  const analyze = () => {
    props.onAnalyze?.({
      nodes: session.snapshots.map((snap, i) => ({
        fen: snap.fen,
        san: i ? session.sans[i - 1] : undefined,
        lastMove: snap.lastMove,
        check: snap.check,
      })),
      ply: viewPly ?? session.snapshots.length - 1,
      orientation: puzzle.player_color,
    });
  };

  const choosePromotion = (role: string | null) => {
    const p = promotion;
    setPromotion(null);
    if (!p) return;
    if (role) submit(p.orig + p.dest + role);
    else sync(true);
  };

  const done = phase === 'solved' || phase === 'failed';
  const colorName = puzzle.player_color === 'white' ? 'White' : 'Black';
  const motifs = puzzle.themes.filter(t => !META_THEMES.has(t));
  const clean = phase === 'solved' && wrongRef.current === 0 && hintRef.current === 0;

  return (
    <div className="layout" ref={layoutEl}>
      <div className="board-col">
        <div className="board-frame">
          <div ref={boardEl} className="board" />
          {promotion && <PromotionPicker color={puzzle.player_color} pieces={props.pieces} onPick={choosePromotion} />}
        </div>
      </div>

      <aside className="side" ref={sideEl}>
        <section className={`feedback feedback-${phase}`}>
          {phase === 'intro' && <p className="headline">Get ready…</p>}
          {phase === 'play' && (
            <>
              <div className={`turn-dot ${puzzle.player_color}`} />
              <div>
                <p className="headline">Your turn</p>
                <p>Find the best move for {colorName}.</p>
              </div>
            </>
          )}
          {phase === 'good' && (
            <>
              <span className="icon good">✓</span>
              <div>
                <p className="headline">Best move!</p>
                <p>Keep going…</p>
              </div>
            </>
          )}
          {phase === 'wrong' && (
            <>
              <span className="icon bad">✗</span>
              <div>
                <p className="headline">That's not the move!</p>
                <p>Try something else.</p>
              </div>
            </>
          )}
          {phase === 'solved' && (
            <>
              <span className="icon good">✓</span>
              <div>
                <p className="headline">{clean ? 'Success!' : 'Puzzle solved'}</p>
                <p>{clean ? 'Solved on the first try.' : `Solved with ${wrongRef.current} miss(es), ${hintRef.current} hint(s).`}</p>
              </div>
            </>
          )}
          {phase === 'failed' && (
            <>
              <span className="icon bad">✗</span>
              <div>
                <p className="headline">Puzzle failed</p>
                <p>{session.done ? 'Here is the solution.' : 'Showing the solution…'}</p>
              </div>
            </>
          )}
        </section>

        {/* Same height in every phase, so nothing below it moves. */}
        <div className="actions">
          {done ? (
            <>
              <button
                onClick={analyze}
                disabled={viewPly === null || !props.onAnalyze}
                title="Open this position in the Board tab with Stockfish"
              >
                Analyze
              </button>
              <button className="primary" onClick={props.onNext} autoFocus>
                Next puzzle →
              </button>
            </>
          ) : (
            <>
              <button disabled={phase === 'intro' || hint >= 2} onClick={() => raiseHint(hint + 1)}>
                Get a hint
              </button>
              <button disabled={phase === 'intro'} onClick={showSolution}>
                View the solution
              </button>
            </>
          )}
        </div>

        {/* Pop-up slot (height Y): the hint while solving, the solution after. */}
        {!done && hint > 0 && (
          <section className="popup hint" ref={popupEl} style={{ height: POPUP_HEIGHT }}>
            <p className="label">Hint {hint}</p>
            <p>
              <strong>{themeName(puzzle.primary_theme)}.</strong> {themeDescription(puzzle.primary_theme)}
            </p>
            {hint >= 2 && session.userTurn && (
              <p>
                Move the piece on <strong>{session.expected.slice(0, 2)}</strong>.
              </p>
            )}
          </section>
        )}
        {done && (
          <section className="popup summary" ref={popupEl} style={{ height: POPUP_HEIGHT }}>
            <div className="summary-head">
              <p className="label">Solution</p>
              <div className="stepper" role="group" aria-label="Step through the solution">
                <button onClick={() => goTo(firstPly)} disabled={viewPly === null || viewPly <= firstPly} title="Start (Home)">
                  ⏮
                </button>
                <button onClick={() => goTo((viewPly ?? lastPly) - 1)} disabled={viewPly === null || viewPly <= firstPly} title="Previous move (←)">
                  ‹
                </button>
                <button onClick={() => goTo((viewPly ?? lastPly) + 1)} disabled={viewPly === null || viewPly >= lastPly} title="Next move (→)">
                  ›
                </button>
                <button onClick={() => goTo(lastPly)} disabled={viewPly === null || viewPly >= lastPly} title="End (End)">
                  ⏭
                </button>
              </div>
            </div>
            <p className="line">
              {lineMoves(puzzle.fen, line.slice(1), 1).map((m, j) => (
                <span key={j}>
                  {m.number && <span className="move-num">{m.number}</span>}
                  <button
                    className={`move${viewPly === j + 2 ? ' current' : ''}${j % 2 === 0 ? ' player' : ''}`}
                    onClick={() => goTo(j + 2)}
                    disabled={viewPly === null}
                  >
                    {m.san}
                  </button>{' '}
                </span>
              ))}
            </p>
            <div className="chips">
              {motifs.map(t => (
                <span key={t} className="chip" title={themeDescription(t)}>
                  {themeName(t)}
                </span>
              ))}
            </div>
          </section>
        )}

        <section className="meta">
          <span>
            Puzzle <a href={`https://lichess.org/training/${puzzle.id}`} target="_blank" rel="noreferrer">#{puzzle.id}</a>
          </span>
          <span>Rating {done ? <strong>{puzzle.rating}</strong> : <em>hidden</em>}</span>
          <a href={puzzle.game_url} target="_blank" rel="noreferrer">
            Source game
          </a>
        </section>

        {props.children}
      </aside>
    </div>
  );
}
