// Tactical facts computed with chessops and sent to the coach alongside the
// Stockfish lines. Language models are unreliable at tracing lines across the
// board (a check uncovered by another piece's move, a pin, an x-ray), so the
// app works the geometry out and states it as fact. Whether acting on a fact
// is good is still Stockfish's call.
import { between, bishopAttacks, rookAttacks } from 'chessops/attacks';
import { castlingSide, normalizeMove, type Chess } from 'chessops/chess';
import { makeSan, parseSan } from 'chessops/san';
import { SquareSet } from 'chessops/squareSet';
import type { Color, Move, Piece, Role, Square } from 'chessops/types';
import { makeSquare, opposite, parseUci } from 'chessops/util';
import { legalMovesSan, posFromFen } from './position';

const VALUE: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 100 };
const LETTER: Record<Role, string> = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: '' };
const MAX_LISTED = 10;

const sideName = (c: Color) => (c === 'white' ? 'White' : 'Black');

/** "Rb2", "pawn c2". */
const pieceName = (piece: Piece, sq: Square) =>
  piece.role === 'pawn' ? `pawn ${makeSquare(sq)}` : `${LETTER[piece.role]}${makeSquare(sq)}`;

const list = (items: string[]) =>
  items.length > MAX_LISTED ? `${items.slice(0, MAX_LISTED).join(', ')} (+${items.length - MAX_LISTED} more)` : items.join(', ');

/**
 * How `move` gives check when it isn't simply the moved piece checking:
 * "discovered check by Rb2", "double check by Qc1 and Rb2". Null otherwise.
 */
export function checkNote(pos: Chess, move: Move): string | null {
  if (!('from' in move) || castlingSide(pos, move)) return null;
  const after = pos.clone();
  after.play(move);
  const checkers = after.ctx().checkers;
  if (checkers.isEmpty()) return null;
  const names = [...checkers].map(sq => pieceName(after.board.get(sq)!, sq));
  if (checkers.moreThanOne()) return `double check by ${names.join(' and ')}`;
  return checkers.has(move.to) ? null : `discovered check by ${names[0]}`;
}

/** SAN for an engine line (UCI moves), with indirect checks spelled out: "c1=Q+ (discovered check by Rb2)". */
export function annotatedPv(fen: string, uci: string[], max = 10): string[] {
  const pos = posFromFen(fen);
  const out: string[] = [];
  for (const u of uci.slice(0, max)) {
    const parsed = parseUci(u);
    if (!parsed) break;
    const move = normalizeMove(pos, parsed);
    if (!pos.isLegal(move)) break;
    const note = checkNote(pos, move);
    out.push(note ? `${makeSan(pos, move)} (${note})` : makeSan(pos, move));
    pos.play(move);
  }
  return out;
}

/** Pins, skewers and discovered-attack setups: a slider, one piece in between, and a target behind it. */
function lineFacts(pos: Chess): string[] {
  const facts: string[] = [];
  const occupied = pos.board.occupied;
  for (const [s, slider] of pos.board) {
    if (slider.role !== 'bishop' && slider.role !== 'rook' && slider.role !== 'queen') continue;
    const enemy = opposite(slider.color);
    const by = `${sideName(slider.color)} ${pieceName(slider, s)}`;
    for (const t of pos.board[enemy]) {
      const straight = slider.role !== 'bishop' && rookAttacks(s, SquareSet.empty()).has(t);
      const diagonal = slider.role !== 'rook' && bishopAttacks(s, SquareSet.empty()).has(t);
      if (!straight && !diagonal) continue;
      const blockers = between(s, t).intersect(occupied);
      if (blockers.size() !== 1) continue;
      const m = blockers.first()!;
      const mid = pos.board.get(m)!;
      const target = pos.board.get(t)!;
      const behind = `${sideName(enemy)} ${pieceName(target, t)}`;
      const front = `${sideName(mid.color)} ${pieceName(mid, m)}`;
      // Only pins and skewers that win something: against the king, or a target worth more than the slider.
      const worthIt = target.role === 'king' || VALUE[target.role] > VALUE[slider.role];
      if (mid.color === slider.color) {
        if (target.role === 'king') facts.push(`Discovered check setup: moving ${front} off the line uncovers check from ${by} on ${behind}.`);
        else if (target.role === 'queen') facts.push(`Discovered attack setup: moving ${front} off the line uncovers an attack by ${by} on ${behind}.`);
      } else if (VALUE[target.role] > VALUE[mid.role] && worthIt) {
        const kind = target.role === 'king' ? 'pinned to its king (it may not leave the line)' : `pinned to ${behind}`;
        facts.push(`${front} is ${kind} by ${by}.`);
      } else if (VALUE[mid.role] > VALUE[target.role] && (mid.role === 'king' || VALUE[mid.role] > VALUE[slider.role])) {
        facts.push(`Skewer: ${by} attacks ${front}, with ${behind} behind it on the same line.`);
      }
    }
  }
  return facts;
}

/** Non-king pieces that are attacked and either undefended or attacked by something cheaper. */
function looseFacts(pos: Chess): string[] {
  const facts: string[] = [];
  const occupied = pos.board.occupied;
  for (const [sq, piece] of pos.board) {
    if (piece.role === 'king') continue;
    const attackers = [...pos.kingAttackers(sq, opposite(piece.color), occupied)];
    if (!attackers.length) continue;
    const defenders = pos.kingAttackers(sq, piece.color, occupied).size();
    const cheapest = Math.min(...attackers.map(a => VALUE[pos.board.get(a)!.role]));
    const by = attackers.map(a => pieceName(pos.board.get(a)!, a)).join(', ');
    const name = `${sideName(piece.color)} ${pieceName(piece, sq)}`;
    if (!defenders) facts.push(`${name} is attacked (by ${by}) and undefended.`);
    else if (cheapest < VALUE[piece.role]) facts.push(`${name} is attacked by a cheaper piece (${by}).`);
    else if (attackers.length > defenders)
      facts.push(`${name} is attacked ${attackers.length} times (by ${by}) and defended ${defenders === 1 ? 'once' : `${defenders} times`}.`);
  }
  return facts;
}

/** Checks and captures for the side to move, with indirect checks spelled out. */
function forcingFacts(pos: Chess): string[] {
  const checks: string[] = [];
  const captures: string[] = [];
  for (const san of legalMovesSan(pos)) {
    if (/[+#]/.test(san)) {
      const move = parseSan(pos, san);
      const note = move && checkNote(pos, move);
      checks.push(note ? `${san} (${note})` : san);
    } else if (san.includes('x')) captures.push(san);
  }
  const side = sideName(pos.turn);
  return [
    `Checks available to ${side}: ${checks.length ? list(checks) : 'none'}.`,
    `Captures available to ${side} (besides checks): ${captures.length ? list(captures) : 'none'}.`,
  ];
}

/** A "Tactical facts" block for the coach's context. */
export function describeTactics(pos: Chess): string {
  const facts = [...forcingFacts(pos), ...lineFacts(pos), ...looseFacts(pos)];
  return `Tactical facts (computed exactly from the board):\n${facts.map(f => `- ${f}`).join('\n')}`;
}
