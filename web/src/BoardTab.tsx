import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Key } from '@lichess-org/chessground/types';
import { Chess, normalizeMove } from 'chessops/chess';
import { chessgroundDests } from 'chessops/compat';
import { makeFen, parseBoardFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import type { Color, Role } from 'chessops/types';
import { parseSquare, parseUci } from 'chessops/util';
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { pieceUrl } from './assets';
import { ENGINE_NAME, formatScore, useEngine, winningChances } from './engine';
import { PromotionPicker } from './PromotionPicker';
import {
  CASTLING,
  castlingPossible,
  EMPTY,
  editorToFen,
  fenToEditor,
  posFromFen,
  pvToSan,
  START,
  validate,
  type AnalysisRequest,
  type EditorState,
} from './position';
import { lineMoves, PuzzleSession, type Puzzle } from './session';
import { SettingsPanel } from './SettingsPanel';
import { playSound, soundForSan } from './sound';
import type { Settings } from './storage';

// ---------------------------------------------------------------------------
// Editor model

type Tool = 'move' | { color: Color; role: Role };

/** One position in play mode; nodes[0] is the starting position. */
interface Node {
  fen: string;
  san?: string;
  lastMove?: [Key, Key];
  check: Color | false;
}

/** Everything undo restores. */
interface Snapshot {
  mode: 'edit' | 'play';
  editor: EditorState;
  nodes: Node[];
  cur: number;
}
const UNDO_DEPTH = 10;

const EDITOR_KEY = 'cpc.editor.v1';

const ROLES: Role[] = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'];
const ROLE_LETTER: Record<Role, 'K' | 'Q' | 'R' | 'B' | 'N' | 'P'> = {
  king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: 'P',
};

function loadEditor(): EditorState {
  try {
    const s = JSON.parse(localStorage.getItem(EDITOR_KEY) ?? 'null');
    if (s && typeof s.board === 'string' && parseBoardFen(s.board).isOk) return s;
  } catch {
    // fall through
  }
  return START;
}

/**
 * Square under a viewport point, measured from the board's current position.
 * (chessground's getKeyAtDomPos uses cached bounds, which go stale if the
 * board moves without resizing, and then clicks silently miss.)
 */
function squareAt(api: Api, x: number, y: number): Key | undefined {
  const r = api.state.dom.elements.board.getBoundingClientRect();
  const file = Math.floor(((x - r.left) / r.width) * 8);
  const row = Math.floor(((y - r.top) / r.height) * 8);
  if (file < 0 || file > 7 || row < 0 || row > 7) return undefined;
  const white = api.state.orientation === 'white';
  return `${'abcdefgh'[white ? file : 7 - file]}${white ? 8 - row : row + 1}` as Key;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function statusText(pos: Chess): string {
  if (pos.isCheckmate()) return `Checkmate — ${pos.turn === 'white' ? 'Black' : 'White'} wins`;
  if (pos.isStalemate()) return 'Stalemate — draw';
  if (pos.isInsufficientMaterial()) return 'Draw — insufficient material';
  return `${capitalize(pos.turn)} to move${pos.isCheck() ? ' · check' : ''}`;
}

// ---------------------------------------------------------------------------

interface Props {
  active: boolean;
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  /** The puzzle currently open in the Puzzles tab, if any. */
  puzzle: Puzzle | null;
  /** The position on screen, for the coach chat (null while it's illegal). */
  onPosition: (fen: string | null) => void;
  /** A line to open in play mode with the engine on (e.g. a finished puzzle). */
  analysisRequest: AnalysisRequest | null;
}

export function BoardTab({ active, settings, setSettings, puzzle, onPosition, analysisRequest }: Props) {
  const boardEl = useRef<HTMLDivElement>(null);
  const trashEl = useRef<HTMLDivElement>(null);
  const cg = useRef<Api>();

  const [mode, setMode] = useState<'edit' | 'play'>('edit');
  const [editor, setEditor] = useState<EditorState>(loadEditor);
  const [tool, setTool] = useState<Tool>('move');
  const [orientation, setOrientation] = useState<Color>('white');
  const [nodes, setNodes] = useState<Node[]>([]);
  const [cur, setCur] = useState(0);
  const [promotion, setPromotion] = useState<{ orig: Key; dest: Key } | null>(null);
  const [fenDraft, setFenDraft] = useState<string | null>(null); // non-null while the FEN field is being edited
  const [fenError, setFenError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Bumped to push the current position back onto the board (e.g. a cancelled promotion).
  const [resync, setResync] = useState(0);
  // Setup-mode drag state for the delete box under the board.
  const [dragging, setDragging] = useState(false);
  const [overTrash, setOverTrash] = useState(false);

  const editorFen = editorToFen(editor);
  const validity = useMemo(() => validate(editorFen), [editorFen]);
  const node = nodes[cur];
  const playPos = useMemo(() => (node ? posFromFen(node.fen) : undefined), [node]);
  const shownFen = mode === 'edit' ? editorFen : node?.fen ?? '';

  // Engine analysis of the shown position (lichess's in-browser Stockfish).
  // Only runs while this tab is showing, and not on finished/illegal positions.
  const [analysis, setAnalysis] = useState(false);
  const analysisFen =
    mode === 'edit'
      ? validity.pos && !validity.pos.isEnd()
        ? editorFen
        : null
      : node && playPos && !playPos.isEnd()
        ? node.fen
        : null;
  const { state: engineState, error: engineError, evaluation } = useEngine(analysisFen, analysis && active);
  const ev = evaluation && evaluation.fen === analysisFen ? evaluation : null;

  useEffect(() => {
    try {
      localStorage.setItem(EDITOR_KEY, JSON.stringify(editor));
    } catch {
      // storage unavailable — the editor just won't persist
    }
  }, [editor]);

  const sound = (name: Parameters<typeof playSound>[0]) => settings.sound && playSound(name);

  // Chessground calls these through refs so they always see current state.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const toolRef = useRef(tool);
  toolRef.current = tool;

  // Undo history: a bounded deque of snapshots taken *before* each change.
  // New snapshots go on the back; past UNDO_DEPTH the oldest drops off the
  // front; undo pops from the back. Stepping through moves isn't a change,
  // so it isn't recorded. (State objects are never mutated in place, so a
  // shallow snapshot is enough.)
  const undoStack = useRef<Snapshot[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const latest = useRef<Snapshot>({ mode, editor, nodes, cur });
  latest.current = { mode, editor, nodes, cur };

  const remember = () => {
    const stack = undoStack.current;
    stack.push({ ...latest.current });
    if (stack.length > UNDO_DEPTH) stack.shift();
    setUndoCount(stack.length);
  };

  const undo = () => {
    const snap = undoStack.current.pop();
    if (!snap) return;
    setUndoCount(undoStack.current.length);
    setPromotion(null);
    setFenDraft(null);
    setFenError(null);
    setEditor(snap.editor);
    setNodes(snap.nodes);
    setCur(snap.cur);
    setMode(snap.mode);
  };

  /** setEditor, recorded for undo. */
  const changeEditor = (update: (e: EditorState) => EditorState) => {
    remember();
    setEditor(update);
  };

  const onBoardChange = () => {
    if (modeRef.current !== 'edit' || !cg.current) return;
    const board = cg.current.getFen();
    if (board === latest.current.editor.board) return;
    changeEditor(e => ({ ...e, board }));
  };

  const commitMove = (uci: string) => {
    if (!node) return;
    const pos = posFromFen(node.fen);
    const move = normalizeMove(pos, parseUci(uci)!);
    if (!pos.isLegal(move)) return setResync(r => r + 1);
    const san = makeSan(pos, move);
    pos.play(move);
    const next: Node = {
      fen: makeFen(pos.toSetup()),
      san,
      lastMove: [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key],
      check: pos.isCheck() ? pos.turn : false,
    };
    sound(soundForSan(san));
    remember();
    // Playing from an earlier position replaces the moves after it.
    setNodes(n => [...n.slice(0, cur + 1), next]);
    setCur(cur + 1);
  };

  const onPlayMove = (orig: Key, dest: Key) => {
    if (modeRef.current !== 'play' || !node) return;
    const piece = posFromFen(node.fen).board.get(parseSquare(orig)!);
    if (piece?.role === 'pawn' && (dest[1] === '8' || dest[1] === '1')) setPromotion({ orig, dest });
    else commitMove(orig + dest);
  };

  // While a piece is dragged in setup mode, show the delete box and highlight
  // it under the pointer. Dropping there (or anywhere off the board) removes
  // the piece; chessground's deleteOnDropOff performs the actual delete.
  const trackDrag = useRef(() => {
    const api = cg.current;
    if (!api?.state.draggable.current || modeRef.current !== 'edit') return;
    const onMove = (e: MouseEvent | TouchEvent) => {
      const drag = api.state.draggable.current;
      if (!drag) return end();
      const point = 'touches' in e ? e.touches[0] : e;
      if (!drag.started || !point) return;
      setDragging(true);
      const r = trashEl.current?.getBoundingClientRect();
      setOverTrash(
        !!r && point.clientX >= r.left && point.clientX <= r.right && point.clientY >= r.top && point.clientY <= r.bottom,
      );
    };
    const end = () => {
      setDragging(false);
      setOverTrash(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', end);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', end);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('mouseup', end);
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
  });

  const handlers = useRef({ onBoardChange, onPlayMove });
  handlers.current = { onBoardChange, onPlayMove };

  // Mount chessground once.
  useEffect(() => {
    const el = boardEl.current!;
    const api = Chessground(el, {
      fen: editor.board,
      orientation,
      coordinates: true,
      movable: { free: true, color: 'both', showDests: true, events: { after: (o, d) => handlers.current.onPlayMove(o, d) } },
      draggable: { deleteOnDropOff: true },
      premovable: { enabled: false },
      animation: { enabled: true, duration: 200 },
      highlight: { lastMove: true, check: true },
      events: { change: () => handlers.current.onBoardChange() },
    });
    cg.current = api;
    const ro = new ResizeObserver(() => api.redrawAll());
    ro.observe(el);

    // Placing a palette piece: intercept presses before chessground sees them.
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = toolRef.current;
      if (modeRef.current !== 'edit' || t === 'move') return;
      const point = 'touches' in e ? e.touches[0] : e;
      if (!point) return;
      const key = squareAt(api, point.clientX, point.clientY);
      if (!key) return;
      e.preventDefault();
      e.stopPropagation();
      api.setPieces(new Map([[key, { role: t.role, color: t.color }]]));
      handlers.current.onBoardChange();
    };
    // Bubble phase: runs after chessground has started its drag (if any).
    const onDragStart = () => trackDrag.current();
    el.addEventListener('mousedown', onDown, { capture: true });
    el.addEventListener('touchstart', onDown, { capture: true, passive: false });
    el.addEventListener('mousedown', onDragStart);
    el.addEventListener('touchstart', onDragStart, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('mousedown', onDown, { capture: true });
      el.removeEventListener('touchstart', onDown, { capture: true });
      el.removeEventListener('mousedown', onDragStart);
      el.removeEventListener('touchstart', onDragStart);
      api.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Edit mode: free placement, no move rules.
  useEffect(() => {
    if (mode !== 'edit') return;
    cg.current?.set({
      fen: editor.board,
      orientation,
      turnColor: editor.turn,
      lastMove: undefined,
      check: false,
      movable: { free: true, color: 'both', dests: new Map() },
      draggable: { deleteOnDropOff: true },
    });
  }, [mode, editor.board, editor.turn, orientation]);

  // Play mode: legal moves for the side to move, from the shown position.
  useEffect(() => {
    if (mode !== 'play' || !node || !playPos) return;
    const over = playPos.isEnd();
    cg.current?.set({
      fen: node.fen,
      orientation,
      turnColor: playPos.turn,
      lastMove: node.lastMove,
      check: node.check,
      movable: {
        free: false,
        color: over ? undefined : playPos.turn,
        dests: over ? new Map() : (chessgroundDests(playPos) as Map<Key, Key[]>),
      },
      draggable: { deleteOnDropOff: false },
    });
  }, [mode, node, playPos, orientation, resync]);

  // Open a line sent from elsewhere (the Puzzles tab's Analyze button): play
  // mode, positioned on the requested move, engine on. Undoable like any change.
  useEffect(() => {
    if (!analysisRequest?.nodes.length) return;
    remember();
    setTool('move');
    setPromotion(null);
    setFenDraft(null);
    setFenError(null);
    setNodes(analysisRequest.nodes.map(n => ({ ...n, lastMove: n.lastMove as [Key, Key] | undefined })));
    setCur(Math.min(analysisRequest.ply, analysisRequest.nodes.length - 1));
    setOrientation(analysisRequest.orientation);
    setMode('play');
    setAnalysis(true);
    // Only a new request (new id) should load; the helpers are stable enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisRequest?.id]);

  const reportedFen = mode === 'edit' ? (validity.pos ? editorFen : null) : node?.fen ?? null;
  useEffect(() => onPosition(reportedFen), [reportedFen, onPosition]);

  // Engine arrows: best move blue, alternatives grey (as on lichess).
  useEffect(() => {
    const lines = analysis && ev ? ev.lines.filter(l => l?.moves.length).slice(0, 3) : [];
    cg.current?.setAutoShapes(
      lines.map((l, i) => ({
        orig: l.moves[0].slice(0, 2) as Key,
        dest: l.moves[0].slice(2, 4) as Key,
        brush: i === 0 ? 'paleBlue' : 'paleGrey',
      })),
    );
  }, [analysis, ev]);

  // ←/→ step through moves in play mode (only while this tab is showing).
  useEffect(() => {
    if (!active || mode !== 'play') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, select, textarea')) return;
      const go: Record<string, number> = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: nodes.length - 1 };
      if (!(e.key in go)) return;
      e.preventDefault();
      goTo(go[e.key]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Cmd/Ctrl+Z = undo while this tab is showing (not while typing in a field).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      if ((e.target as HTMLElement)?.closest?.('input, select, textarea')) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Esc leaves place mode.
  useEffect(() => {
    if (!active || mode !== 'edit' || tool === 'move') return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setTool('move');
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, mode, tool]);

  const goTo = (i: number) => {
    const target = Math.max(0, Math.min(nodes.length - 1, i));
    if (target === cur) return;
    if (target === cur + 1 && nodes[target].san) sound(soundForSan(nodes[target].san!));
    setCur(target);
  };

  const startPlay = () => {
    if (!validity.pos) return;
    remember();
    setTool('move');
    setNodes([{ fen: editorFen, check: validity.pos.isCheck() ? validity.pos.turn : false }]);
    setCur(0);
    setMode('play');
  };

  const editFromHere = () => {
    const e = node && fenToEditor(node.fen);
    remember();
    if (e) setEditor(e);
    setPromotion(null);
    setMode('edit');
  };

  const loadEditorState = (e: EditorState, orient?: Color) => {
    remember();
    setEditor(e);
    if (orient) setOrientation(orient);
    setFenError(null);
    setFenDraft(null);
    setMode('edit');
  };

  const loadPuzzle = () => {
    if (!puzzle) return;
    const s = new PuzzleSession(puzzle);
    s.apply(); // opponent's setup move -> the position the player faces
    const e = fenToEditor(s.fen());
    if (e) loadEditorState(e, puzzle.player_color);
  };

  const submitFen = () => {
    if (fenDraft === null) return;
    const e = fenToEditor(fenDraft);
    if (!e) return setFenError('That doesn’t look like a valid FEN.');
    loadEditorState(e);
  };

  const copyFen = async () => {
    try {
      await navigator.clipboard.writeText(shownFen);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard blocked — the field is still selectable
    }
  };

  const pickPromotion = (role: string | null) => {
    const p = promotion;
    setPromotion(null);
    if (!p) return;
    if (role) commitMove(p.orig + p.dest + role);
    else setResync(r => r + 1); // cancelled: put the pawn back
  };

  const moves = mode === 'play' && nodes[0] ? lineMoves(nodes[0].fen, nodes.slice(1).map(n => n.san!)) : [];
  const isTool = (t: Tool) =>
    typeof t === 'string' ? tool === t : typeof tool !== 'string' && tool.role === t.role && tool.color === t.color;

  // Pressing a palette piece starts dragging a new copy of it. A plain click
  // (released without moving) instead toggles "place mode" for that piece.
  const onPalettePress = (piece: { color: Color; role: Role }, e: MouseEvent | TouchEvent) => {
    const start = 'touches' in e ? e.touches[0] : e;
    cg.current?.state.dom.bounds.clear(); // drop square is computed from these
    cg.current?.dragNewPiece(piece, e, true);
    trackDrag.current();
    const up = (ev: MouseEvent | TouchEvent) => {
      document.removeEventListener('mouseup', up);
      document.removeEventListener('touchend', up);
      const end = 'changedTouches' in ev ? ev.changedTouches[0] : ev;
      const moved = !start || !end || Math.hypot(end.clientX - start.clientX, end.clientY - start.clientY) > 6;
      if (!moved)
        setTool(t => (typeof t !== 'string' && t.role === piece.role && t.color === piece.color ? 'move' : piece));
      else setTool(t => (t === 'move' ? t : piece)); // dragging while placing switches the selected piece
    };
    document.addEventListener('mouseup', up);
    document.addEventListener('touchend', up);
  };

  const paletteRow = (color: Color): ReactNode => (
    <div className="palette-row">
      {ROLES.map(role => (
        <button
          key={role}
          className="palette-piece"
          aria-pressed={isTool({ color, role })}
          title={`${capitalize(color)} ${role} — click to place, or drag onto the board`}
          onMouseDown={e => {
            if (e.button !== 0) return;
            e.preventDefault(); // no text selection / focus ring while dragging
            onPalettePress({ color, role }, e.nativeEvent);
          }}
          onTouchStart={e => onPalettePress({ color, role }, e.nativeEvent)}
        >
          <img src={pieceUrl(settings.pieces, color === 'white' ? 'w' : 'b', ROLE_LETTER[role])} alt="" draggable={false} />
        </button>
      ))}
    </div>
  );

  return (
    <div className="layout">
      <div className="board-col">
        {/* Dynamic classes go on the frame: chessground owns the board element's
            className (cg-wrap, orientation-*), and React re-setting it would wipe them. */}
        <div className={`board-frame${mode === 'edit' && tool !== 'move' ? ' tool-active' : ''}`}>
          <div ref={boardEl} className="board" />
          {mode === 'edit' && (
            <div
              ref={trashEl}
              className={`drop-trash${dragging ? ' visible' : ''}${overTrash ? ' over' : ''}`}
              aria-hidden={!dragging}
            >
              <span className="drop-trash-icon">🗑</span> {overTrash ? 'Release to delete' : 'Drop here to delete'}
            </div>
          )}
          {promotion && playPos && <PromotionPicker color={playPos.turn} pieces={settings.pieces} onPick={pickPromotion} />}
        </div>
      </div>

      <aside className="side">
        <section className={`feedback ${mode === 'edit' && validity.error ? 'feedback-wrong' : ''}`}>
          <div>
            <p className="headline">
              {mode === 'play'
                ? playPos
                  ? statusText(playPos)
                  : ''
                : tool !== 'move'
                  ? `Placing: ${capitalize(tool.color)} ${tool.role}`
                  : 'Set up a position'}
            </p>
            <p>
              {mode === 'play'
                ? 'Make moves for either side. Stepping back and moving starts a new line.'
                : tool !== 'move'
                  ? 'Click squares to add it. Click the piece again or press Esc to stop.'
                  : validity.error ?? 'Drag pieces around, drag new ones in from below, or click one below to place it on several squares.'}
            </p>
          </div>
        </section>

        <div className="actions board-actions">
          <button
            className="undo-button"
            disabled={undoCount === 0}
            onClick={undo}
            title={undoCount ? `Undo (${undoCount} step${undoCount === 1 ? '' : 's'} saved, ⌘/Ctrl+Z)` : 'Nothing to undo'}
          >
            ↶ Undo
          </button>
          {mode === 'edit' ? (
            <button className="primary" disabled={!validity.pos} onClick={startPlay}>
              Play from here
            </button>
          ) : (
            <>
              <button onClick={editFromHere}>Edit position</button>
              <button onClick={() => setOrientation(o => (o === 'white' ? 'black' : 'white'))}>Flip</button>
            </>
          )}
        </div>

        <section className="panel engine-panel">
          <div className="engine-head">
            <label className="switch">
              <input type="checkbox" checked={analysis} onChange={e => setAnalysis(e.target.checked)} />
              <span className="switch-track" aria-hidden="true" />
              <span className="engine-name">{ENGINE_NAME}</span>
            </label>
            <span className="engine-meta">
              {!analysis
                ? 'Runs in your browser'
                : engineState === 'unsupported' || engineState === 'failed'
                  ? 'Unavailable'
                  : ev
                    ? `depth ${ev.depth} · ${ev.millis ? Math.round(ev.nodes / ev.millis) : 0} kn/s`
                    : engineState === 'ready'
                      ? ''
                      : 'Loading…'}
            </span>
          </div>
          {analysis &&
            (engineState === 'unsupported' || engineState === 'failed' ? (
              <p className="fen-error">{engineError}</p>
            ) : !analysisFen ? (
              <p className="muted">
                {mode === 'edit' && validity.error ? 'Fix the position to analyse it.' : 'Game over — nothing to analyse.'}
              </p>
            ) : !ev ? (
              <p className="muted">Thinking…</p>
            ) : (
              <>
                <div className="eval-row">
                  <strong className="eval-score">{formatScore(ev.lines[0])}</strong>
                  <div className="eval-bar" title="White’s winning chances">
                    <div className="eval-bar-white" style={{ width: `${(50 + 50 * winningChances(ev.lines[0])).toFixed(1)}%` }} />
                  </div>
                </div>
                <ol className="pv-lines">
                  {ev.lines.filter(Boolean).map((l, i) => {
                    const numbered = lineMoves(ev.fen, pvToSan(ev.fen, l.moves, 8));
                    return (
                      <li key={i}>
                        <button
                          className="pv"
                          disabled={mode !== 'play'}
                          title={mode === 'play' ? 'Play this move' : undefined}
                          onClick={() => commitMove(l.moves[0])}
                        >
                          <span className="pv-score">{formatScore(l)}</span>
                          <span className="pv-moves">
                            {numbered.map(m => (m.number ? `${m.number} ${m.san}` : m.san)).join(' ')}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </>
            ))}
        </section>

        {mode === 'edit' ? (
          <>
            <section className="panel">
              <p className="label">Pieces</p>
              {paletteRow('white')}
              {paletteRow('black')}
              <p className="muted">To remove a piece, drag it onto the delete box under the board (or anywhere off the board).</p>
            </section>

            <section className="panel">
              <p className="label">Position</p>
              <div className="segmented" role="group" aria-label="Side to move">
                {(['white', 'black'] as const).map(c => (
                  <button key={c} aria-pressed={editor.turn === c} onClick={() => editor.turn !== c && changeEditor(e => ({ ...e, turn: c }))}>
                    {capitalize(c)} to move
                  </button>
                ))}
              </div>
              <div className="castling">
                {(['white', 'black'] as const).map(color => (
                  <div key={color} className="castling-side">
                    <span>{capitalize(color)}</span>
                    {CASTLING.filter(c => c.color === color).map(c => {
                      const possible = castlingPossible(editor.board, c);
                      return (
                        <label key={c.flag} className={possible ? '' : 'disabled'} title={possible ? '' : 'King and rook must be on their starting squares'}>
                          <input
                            type="checkbox"
                            disabled={!possible}
                            checked={possible && editor.castling.includes(c.flag)}
                            onChange={ev =>
                              changeEditor(e => ({
                                ...e,
                                castling: ev.target.checked ? e.castling + c.flag : e.castling.replace(c.flag, ''),
                              }))
                            }
                          />
                          {c.label}
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="button-row">
                <button onClick={() => loadEditorState(START)}>Start position</button>
                <button onClick={() => loadEditorState(EMPTY)}>Clear board</button>
                <button onClick={() => setOrientation(o => (o === 'white' ? 'black' : 'white'))}>Flip</button>
              </div>
              {puzzle && (
                <button className="link-button" onClick={loadPuzzle}>
                  Load the current puzzle’s position
                </button>
              )}
            </section>
          </>
        ) : (
          <section className="panel moves-panel">
            <div className="summary-head">
              <p className="label">Moves</p>
              <div className="stepper" role="group" aria-label="Step through moves">
                <button onClick={() => goTo(0)} disabled={cur === 0} title="Start (Home)">⏮</button>
                <button onClick={() => goTo(cur - 1)} disabled={cur === 0} title="Previous (←)">‹</button>
                <button onClick={() => goTo(cur + 1)} disabled={cur >= nodes.length - 1} title="Next (→)">›</button>
                <button onClick={() => goTo(nodes.length - 1)} disabled={cur >= nodes.length - 1} title="End (End)">⏭</button>
              </div>
            </div>
            {moves.length ? (
              <p className="line">
                {moves.map((m, j) => (
                  <span key={j}>
                    {m.number && <span className="move-num">{m.number}</span>}
                    <button className={`move${cur === j + 1 ? ' current' : ''}`} onClick={() => goTo(j + 1)}>
                      {m.san}
                    </button>{' '}
                  </span>
                ))}
              </p>
            ) : (
              <p className="muted">No moves yet.</p>
            )}
          </section>
        )}

        <section className="panel">
          <p className="label">FEN</p>
          <div className="fen-row">
            <input
              className="fen-input"
              value={fenDraft ?? shownFen}
              readOnly={mode === 'play'}
              spellCheck={false}
              onChange={e => {
                setFenDraft(e.target.value);
                setFenError(null);
              }}
              onKeyDown={e => e.key === 'Enter' && submitFen()}
              onBlur={() => (fenDraft !== null && fenDraft !== shownFen ? submitFen() : setFenDraft(null))}
            />
            <button onClick={copyFen} title="Copy FEN">
              {copied ? '✓' : 'Copy'}
            </button>
          </div>
          {fenError ? <p className="fen-error">{fenError}</p> : mode === 'edit' && <p className="muted">Paste a FEN and press Enter to load it.</p>}
        </section>

        <SettingsPanel settings={settings} setSettings={setSettings} />
      </aside>
    </div>
  );
}
