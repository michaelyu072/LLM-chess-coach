// Pure position helpers for the Board tab: editor state <-> FEN, legality,
// and engine lines in SAN. Kept out of BoardTab.tsx so it only exports a
// component (React Fast Refresh requires that).
import { Chess, normalizeMove } from 'chessops/chess';
import { INITIAL_BOARD_FEN, parseBoardFen, parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import type { Color } from 'chessops/types';
import { parseSquare, parseUci } from 'chessops/util';

export interface EditorState {
  board: string; // FEN board part
  turn: Color;
  castling: string; // requested rights, subset of "KQkq"
}

export const START: EditorState = { board: INITIAL_BOARD_FEN, turn: 'white', castling: 'KQkq' };
export const EMPTY: EditorState = { board: '8/8/8/8/8/8/8/8', turn: 'white', castling: '' };

export const CASTLING = [
  { flag: 'K', label: 'O-O', color: 'white', king: 'e1', rook: 'h1' },
  { flag: 'Q', label: 'O-O-O', color: 'white', king: 'e1', rook: 'a1' },
  { flag: 'k', label: 'O-O', color: 'black', king: 'e8', rook: 'h8' },
  { flag: 'q', label: 'O-O-O', color: 'black', king: 'e8', rook: 'a8' },
] as const;

const SETUP_ERRORS: Record<string, string> = {
  ERR_EMPTY: 'The board is empty.',
  ERR_KINGS: 'Each side needs exactly one king.',
  ERR_PAWNS_ON_BACKRANK: 'Pawns can’t stand on the first or last rank.',
  ERR_OPPOSITE_CHECK: 'The side not to move is in check.',
  ERR_VARIANT: 'Not a legal standard chess position.',
};

export function castlingPossible(board: string, c: (typeof CASTLING)[number]): boolean {
  const parsed = parseBoardFen(board);
  if (parsed.isErr) return false;
  const king = parsed.value.get(parseSquare(c.king)!);
  const rook = parsed.value.get(parseSquare(c.rook)!);
  return king?.role === 'king' && king.color === c.color && rook?.role === 'rook' && rook.color === c.color;
}

export function editorToFen(e: EditorState): string {
  const rights = CASTLING.filter(c => e.castling.includes(c.flag) && castlingPossible(e.board, c))
    .map(c => c.flag)
    .join('');
  return `${e.board} ${e.turn === 'white' ? 'w' : 'b'} ${rights || '-'} - 0 1`;
}

/** Parse a full FEN into editor state (syntax only; legality is checked separately). */
export function fenToEditor(fen: string): EditorState | null {
  const parts = fen.trim().split(/\s+/);
  if (parseFen(parts.join(' ')).isErr) return null;
  return { board: parts[0], turn: parts[1] === 'b' ? 'black' : 'white', castling: parts[2] && parts[2] !== '-' ? parts[2] : '' };
}

export function validate(fen: string): { pos?: Chess; error?: string } {
  const setup = parseFen(fen);
  if (setup.isErr) return { error: 'Invalid FEN.' };
  const pos = Chess.fromSetup(setup.value);
  if (pos.isErr) return { error: SETUP_ERRORS[pos.error.message] ?? pos.error.message };
  return { pos: pos.value };
}

export const posFromFen = (fen: string) => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();

/** SAN for an engine line (UCI moves) from `fen`, stopping at the first illegal move. */
export function pvToSan(fen: string, uci: string[], max = 10): string[] {
  const pos = posFromFen(fen);
  const out: string[] = [];
  for (const u of uci.slice(0, max)) {
    const parsed = parseUci(u);
    if (!parsed) break;
    const move = normalizeMove(pos, parsed);
    if (!pos.isLegal(move)) break;
    out.push(makeSan(pos, move));
    pos.play(move);
  }
  return out;
}

/** One position in a line of play; the first node has no move. */
export interface GameNode {
  fen: string;
  san?: string;
  lastMove?: [string, string];
  check: 'white' | 'black' | false;
}

/** "Open this line in the Board tab" (from a finished puzzle). */
export interface AnalysisRequest {
  /** Changes on every request, so the same puzzle can be sent twice. */
  id: number;
  nodes: GameNode[];
  /** Index of the node to show first. */
  ply: number;
  orientation: 'white' | 'black';
}
