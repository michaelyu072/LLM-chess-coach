// "Show me on the board": a short line of play the coach annotates move by
// move. The model proposes the line through the `show_line` tool; everything
// is checked here before the user can see it. The first move may be any legal
// move (the user's "what if I played…"), every later move must be one of
// Stockfish's top moves in its position, so a walkthrough never shows a reply
// the engine doesn't back.
import { castlingSide, type Chess } from 'chessops/chess';
import { makeFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import type { Color, Move } from 'chessops/types';
import { kingCastlesTo, makeSquare, parseSquare } from 'chessops/util';
import { formatScore, type Evaluation } from './engine';
import { legalMovesSan, parseMove, posFromFen, pvToSan } from './position';
import { lineMoves } from './session';

export const MAX_STEPS = 6;
const MAX_NOTE = 170;

export interface WalkStep {
  san: string;
  /** "12." / "12…" label when the move starts a numbered pair, else null. */
  number: string | null;
  mover: Color;
  /** Position after the move. */
  fen: string;
  from: string;
  /** Where the moved piece ends up (the king's square for castling). */
  to: string;
  check: Color | false;
  note: string;
  /** Squares the note talks about, ringed on the board. */
  focus: string[];
}

export interface Walkthrough {
  id: number;
  startFen: string;
  steps: WalkStep[];
  /** Stockfish's verdict before and after the line, from White's point of view ("+1.2", "#-3"). */
  evalBefore?: string;
  evalAfter?: string;
}

export const SHOW_LINE = {
  name: 'show_line',
  description:
    'Give the user a "Show me on the board" button that plays a short line from the current position, one move at a ' +
    'time, with a one-sentence note beside each move. Use it when seeing the moves played helps: "what if I played X?", ' +
    '"why doesn\'t X work?", "what is the plan?", "show me". The first move may be any legal move (for example the move ' +
    'the user asked about). Every later move must be a Stockfish move you were given: continue with the top line from ' +
    '<context> or from analyze_move. The line is rejected if a later move is not one of Stockfish\'s top moves.',
  schema: {
    type: 'object' as const,
    properties: {
      steps: {
        type: 'array',
        description: `The moves in order, alternating sides, starting from the current position. 2 to ${MAX_STEPS} moves.`,
        items: {
          type: 'object',
          properties: {
            move: { type: 'string', description: 'The move in SAN, without a move number (e.g. "Nxe5", "O-O").' },
            note: {
              type: 'string',
              description:
                'One short, plain sentence (under 120 characters) on what this move does or threatens. No evaluations in numbers.',
            },
            focus: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional: up to 2 squares the note is about (e.g. ["d8"]), ringed on the board.',
            },
          },
          required: ['move', 'note'],
          additionalProperties: false,
        },
      },
    },
    required: ['steps'],
    additionalProperties: false,
  },
};

export interface LineCheckOptions {
  /** Stockfish's view of `fen` (top 3 lines), or null when the engine is unavailable. Results may be cached by the caller. */
  evalAt: (fen: string) => Promise<Evaluation | null>;
  /** An unsolved puzzle: the line must not start with the best move. */
  hideBestMove?: boolean;
}

export type LineCheck = { ok: true; line: Walkthrough } | { ok: false; error: string };

let nextId = 1;

const sanOfUci = (pos: Chess, uci: string | undefined): string | undefined => (uci ? pvToSan(makeFen(pos.toSetup()), [uci], 1)[0] : undefined);

function landingSquare(pos: Chess, move: Move): string {
  if (!('from' in move)) return makeSquare(move.to);
  const side = castlingSide(pos, move);
  return makeSquare(side ? kingCastlesTo(pos.turn, side) : move.to);
}

function cleanNote(note: unknown): string {
  // Drop TeX math dollars the model sometimes wraps moves in ("$a4$").
  const text =
    typeof note === 'string'
      ? note
          .replace(/\$(?=\S)([^$\n]{1,40}?)(?<=\S)\$/g, '$1')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
  return text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE - 1).trimEnd()}…` : text;
}

function cleanFocus(focus: unknown): string[] {
  if (!Array.isArray(focus)) return [];
  const squares = focus.filter((s): s is string => typeof s === 'string').map(s => s.trim().toLowerCase());
  return [...new Set(squares.filter(s => parseSquare(s) !== undefined))].slice(0, 2);
}

/** Check a proposed line against the rules and the engine, and build what the board needs to play it. */
export async function checkLine(startFen: string, input: unknown, opts: LineCheckOptions): Promise<LineCheck> {
  const raw = (input as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: 'Invalid input: "steps" must be a non-empty array.' };

  const pos = posFromFen(startFen);
  const root = await opts.evalAt(startFen);
  if (!root) return { ok: false, error: 'Stockfish is unavailable, so the line cannot be checked. Answer in text only.' };

  const steps: WalkStep[] = [];
  const sans: string[] = [];
  // Engine lines (remaining UCI moves) that the steps so far have followed.
  let following: string[][] = [];

  for (const [i, item] of raw.slice(0, MAX_STEPS).entries()) {
    if (pos.isEnd()) break;
    const text = (item as { move?: unknown } | null)?.move;
    const move = typeof text === 'string' && text.length <= 16 ? parseMove(pos, text) : undefined;
    const soFar = sans.length ? ` after ${sans.join(' ')}` : '';
    if (!move)
      return {
        ok: false,
        error: `Step ${i + 1}: "${String(text)}" is not a legal move${soFar}. Legal moves there: ${legalMovesSan(pos).join(', ')}.`,
      };
    const san = makeSan(pos, move);
    const note = cleanNote((item as { note?: unknown }).note);
    if (!note) return { ok: false, error: `Step ${i + 1} (${san}) needs a note.` };

    const fen = makeFen(pos.toSetup());
    let matching = following.filter(pv => sanOfUci(pos, pv[0]) === san);
    if (!matching.length) {
      const ev = i === 0 ? root : await opts.evalAt(fen);
      const lines = (ev?.lines ?? []).filter(l => l?.moves.length).map(l => l.moves);
      matching = lines.filter(pv => sanOfUci(pos, pv[0]) === san);
      if (i === 0 && opts.hideBestMove && sanOfUci(pos, lines[0]?.[0]) === san)
        return {
          ok: false,
          error:
            'The puzzle is unsolved, so the board must not play the best move. Only show why a move the user tried or asked about fails; otherwise answer with a hint in text.',
        };
      if (i > 0 && !matching.length) {
        if (!ev) return { ok: false, error: 'Stockfish is unavailable, so the line cannot be checked. Answer in text only.' };
        const top = lines.map(pv => sanOfUci(pos, pv[0])).filter(Boolean);
        return {
          ok: false,
          error: `Step ${i + 1}: ${san} is not one of Stockfish's top moves${soFar}. Its top moves there: ${top.join(', ')}. Send the line again using one of them.`,
        };
      }
    }
    following = matching.map(pv => pv.slice(1));

    const mover = pos.turn;
    const from = 'from' in move ? makeSquare(move.from) : makeSquare(move.to);
    const to = landingSquare(pos, move);
    pos.play(move);
    sans.push(san);
    steps.push({
      san,
      number: null,
      mover,
      fen: makeFen(pos.toSetup()),
      from,
      to,
      check: pos.isCheck() ? pos.turn : false,
      note,
      focus: cleanFocus((item as { focus?: unknown }).focus),
    });
  }

  lineMoves(startFen, sans).forEach((m, i) => (steps[i].number = m.number));

  let evalAfter: string | undefined;
  if (pos.isCheckmate()) evalAfter = 'checkmate';
  else if (pos.isEnd()) evalAfter = 'draw';
  else {
    const last = await opts.evalAt(steps[steps.length - 1].fen);
    if (last?.lines[0]) evalAfter = formatScore(last.lines[0]);
  }
  return {
    ok: true,
    line: { id: nextId++, startFen, steps, evalBefore: root.lines[0] ? formatScore(root.lines[0]) : undefined, evalAfter },
  };
}

/** "12. Nxe5 Bxe5 13. Qh5" */
export function lineText(line: Walkthrough): string {
  return line.steps.map(s => (s.number ? `${s.number} ${s.san}` : s.san)).join(' ');
}
