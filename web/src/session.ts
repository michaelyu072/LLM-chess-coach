import { Chess, normalizeMove } from 'chessops/chess';
import { chessgroundDests } from 'chessops/compat';
import { makeFen, parseFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import type { Color, Piece } from 'chessops/types';
import { makeUci, parseSquare, parseUci } from 'chessops/util';

export interface Puzzle {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  themes: string[];
  primary_theme: string;
  player_color: Color;
  solution_san: string[];
  game_url: string;
}

export type Verdict = 'correct' | 'wrong' | 'illegal';

/** Board state after each ply; snapshots[0] is the FEN before the setup move. */
export interface Snapshot {
  fen: string;
  lastMove: [string, string] | undefined;
  check: Color | false;
}

/**
 * Deterministic puzzle state. Lichess convention: the FEN is the position
 * before the opponent's move; moves[0] is played automatically and the player
 * answers with moves[1], moves[3], ...
 */
export class PuzzleSession {
  readonly pos: Chess;
  ply = 0;
  sans: string[] = [];
  lastMove: [string, string] | undefined;
  snapshots: Snapshot[] = [];

  constructor(readonly puzzle: Puzzle) {
    this.pos = Chess.fromSetup(parseFen(puzzle.fen).unwrap()).unwrap();
    this.snapshot();
  }

  private snapshot(): void {
    this.snapshots.push({ fen: this.fen(), lastMove: this.lastMove, check: this.checkColor });
  }

  get done(): boolean {
    return this.ply >= this.puzzle.moves.length;
  }
  get userTurn(): boolean {
    return !this.done && this.ply % 2 === 1;
  }
  get expected(): string {
    return this.puzzle.moves[this.ply];
  }
  get turn(): Color {
    return this.pos.turn;
  }
  get checkColor(): Color | false {
    return this.pos.isCheck() ? this.pos.turn : false;
  }

  fen(): string {
    return makeFen(this.pos.toSetup());
  }
  dests(): Map<string, string[]> {
    return chessgroundDests(this.pos);
  }
  pieceAt(square: string): Piece | undefined {
    const sq = parseSquare(square);
    return sq === undefined ? undefined : this.pos.board.get(sq);
  }

  /** Judge a user move without playing it. Accepts any mate on the final move. */
  check(uci: string): Verdict {
    const move = parseUci(uci);
    if (!move) return 'illegal';
    const norm = normalizeMove(this.pos, move);
    if (!this.pos.isLegal(norm)) return 'illegal';
    if (makeUci(norm) === makeUci(normalizeMove(this.pos, parseUci(this.expected)!))) return 'correct';
    if (this.ply === this.puzzle.moves.length - 1) {
      const after = this.pos.clone();
      after.play(norm);
      if (after.isCheckmate()) return 'correct';
    }
    return 'wrong';
  }

  /** Play a move (user's or the expected one); returns its SAN. */
  apply(uci: string = this.expected): string {
    const move = normalizeMove(this.pos, parseUci(uci)!);
    const san = makeSan(this.pos, move);
    this.pos.play(move);
    this.sans.push(san);
    this.lastMove = [uci.slice(0, 2), uci.slice(2, 4)];
    this.ply++;
    this.snapshot();
    return san;
  }
}

export interface LineMove {
  /** "32." before a white move, "32…" before a line-opening black move, else null */
  number: string | null;
  san: string;
}

/** Split SAN moves into numbered tokens, starting from the given FEN's side/move. */
export function lineMoves(fen: string, sans: string[], startPly = 0): LineMove[] {
  const setup = parseFen(fen).unwrap();
  const plyOffset = (setup.fullmoves - 1) * 2 + (setup.turn === 'black' ? 1 : 0) + startPly;
  return sans.map((san, i) => {
    const ply = plyOffset + i;
    const num = Math.floor(ply / 2) + 1;
    if (ply % 2 === 0) return { number: `${num}.`, san };
    return { number: i === 0 ? `${num}…` : null, san };
  });
}
