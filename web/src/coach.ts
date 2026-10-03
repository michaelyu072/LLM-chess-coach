// Coach chat: Gemini or Claude, grounded in Stockfish.
//
// Every question is sent with a <context> block built in the browser: the
// position (FEN + piece list), puzzle info, and a fresh Stockfish evaluation
// with the top 3 lines. Moves the question names explicitly ("what about
// Nxe5?") are played and evaluated up front; for moves described in words,
// the model can call the `analyze_move` tool, which runs Stockfish here in the
// browser and returns the evaluation after that move.
//
// Requests go to /api/gemini or /api/anthropic, Vite dev-server proxies that
// add the API key from web/.env.local (see vite.config.ts), so the key never
// reaches the browser. That makes the coach local-only, by design.
import Anthropic from '@anthropic-ai/sdk';
import { ApiError, GoogleGenAI, type Content, type Part } from '@google/genai';
import type { Chess } from 'chessops/chess';
import { chessgroundDests } from 'chessops/compat';
import { makeFen } from 'chessops/fen';
import { makeSan, parseSan } from 'chessops/san';
import type { Move } from 'chessops/types';
import { parseSquare, parseUci } from 'chessops/util';
import { engine, ENGINE_NAME, formatScore, type Evaluation } from './engine';
import { posFromFen, pvToSan } from './position';
import { lineMoves } from './session';

const PROVIDER = __COACH_PROVIDER__;
export const COACH_ENABLED = PROVIDER !== 'none';
const MODEL = __COACH_MODEL__;
const EFFORT = __COACH_EFFORT__;
const MAX_TOOL_ROUNDS = 5;

export interface CoachContext {
  source: 'puzzle' | 'board';
  /** FEN of the position the user is looking at right now. */
  fen: string;
  puzzle?: {
    id: string;
    rating: number;
    themes: string[];
    playerColor: 'white' | 'black';
    /** False while unsolved: the coach must not reveal the solution. */
    solved: boolean;
    /** Solution line in SAN, only included once the puzzle is over. */
    solution?: string[];
  };
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'coach';
  text: string;
  /** Short label of the position the message was sent from. */
  contextLabel?: string;
}

export function contextLabel(ctx: CoachContext): string {
  const turn = ctx.fen.split(' ')[1] === 'b' ? 'Black' : 'White';
  if (ctx.source === 'puzzle' && ctx.puzzle)
    return `Puzzle #${ctx.puzzle.id} · ${ctx.puzzle.solved ? 'solved' : `${turn} to move`}`;
  return `Board · ${turn} to move`;
}

// ---------------------------------------------------------------------------
// Prompt

const SYSTEM = `You are a friendly, expert chess coach inside a chess training app. The user is looking at a position (from a puzzle or from a free analysis board) and asks you about it.

Each user message starts with a <context> block describing the position they are looking at right now: the FEN, a list of pieces, puzzle details if any, and a fresh Stockfish evaluation with its top lines. If the user named specific moves, the context also includes Stockfish's evaluation after each of those moves. The position can change between messages; always answer about the latest <context>.

How to coach:
- Ground concrete claims (who is better, whether a move works, what the best continuation is) in the Stockfish data you are given. Don't invent evaluations or variations. If you need the evaluation of a move that isn't in the context, call the analyze_move tool.
- Explain ideas, not just numbers: threats, tactics, weaknesses, plans, and why the engine's move works. Translate evaluations into plain language (e.g. "+1.5" is "White is clearly better, roughly a piece's worth of advantage in practice").
- Write moves in standard algebraic notation (Nf3, exd5, O-O). Scores are from White's point of view in pawns; "#3" means mate in 3 for White and "#-3" mate in 3 for Black.
- Keep answers short, usually 2 to 5 sentences, unless the user asks for more depth.

Puzzles: while a puzzle is unsolved, help the user find the answer themselves. Give hints that point at the idea (a weak square, an overloaded piece, a forcing move) rather than stating the solution move, unless the user explicitly asks for the answer. Once the puzzle is solved, discuss the solution freely.`;

const ANALYZE_MOVE = {
  name: 'analyze_move',
  description:
    'Evaluate a candidate move in the current position with Stockfish. Use it when the user asks about a move ' +
    'that the <context> block does not already cover (e.g. "why not take the rook?"), or to check a move before ' +
    'recommending it. Returns whether the move is legal, the evaluation after it, and the best replies.',
  schema: {
    type: 'object' as const,
    properties: {
      move: {
        type: 'string',
        description: 'The move in SAN (e.g. "Nxe5", "O-O", "e8=Q") or UCI (e.g. "g1f3"), played from the current position.',
      },
    },
    required: ['move'],
    additionalProperties: false,
  },
};

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: ANALYZE_MOVE.name,
    description: ANALYZE_MOVE.description,
    input_schema: ANALYZE_MOVE.schema,
    eager_input_streaming: true,
  },
];

const GEMINI_TOOLS = [
  {
    functionDeclarations: [
      { name: ANALYZE_MOVE.name, description: ANALYZE_MOVE.description, parametersJsonSchema: ANALYZE_MOVE.schema },
    ],
  },
];

/** The move argument of an analyze_move call, or null if the call is malformed. */
function toolMove(name: string | undefined, input: unknown): string | null {
  const move = (input as { move?: unknown } | null)?.move;
  return name === ANALYZE_MOVE.name && typeof move === 'string' && move.trim() && move.length <= 16 ? move.trim() : null;
}

// ---------------------------------------------------------------------------
// Context building (all local: chessops + browser Stockfish)

const ROLE_LETTER = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: '' } as const;
const ROLE_ORDER = ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn'] as const;
const SQUARE_NAMES = 'abcdefgh';
const squareName = (sq: number) => `${SQUARE_NAMES[sq % 8]}${Math.floor(sq / 8) + 1}`;

/** "White: Kg1, Qd1, Rf1, … pawns a2 b2 …" — LLMs read this far better than FEN. */
function describePieces(pos: Chess): string {
  return (['white', 'black'] as const)
    .map(color => {
      const parts: string[] = [];
      for (const role of ROLE_ORDER) {
        const squares = [...pos.board.pieces(color, role)].map(squareName);
        if (!squares.length) continue;
        parts.push(role === 'pawn' ? `pawns ${squares.join(' ')}` : squares.map(s => ROLE_LETTER[role] + s).join(', '));
      }
      return `${color === 'white' ? 'White' : 'Black'}: ${parts.join(', ')}`;
    })
    .join('\n');
}

function gameOverText(pos: Chess): string | null {
  if (pos.isCheckmate()) return `Checkmate: ${pos.turn === 'white' ? 'Black' : 'White'} has won.`;
  if (pos.isStalemate()) return 'Stalemate: the game is drawn.';
  if (pos.isInsufficientMaterial()) return 'Draw by insufficient material.';
  return null;
}

function describeEval(ev: Evaluation): string {
  const lines = ev.lines.filter(Boolean).map((l, i) => {
    const moves = lineMoves(ev.fen, pvToSan(ev.fen, l.moves, 8))
      .map(m => (m.number ? `${m.number} ${m.san}` : m.san))
      .join(' ');
    return `  ${i + 1}. ${formatScore(l).padEnd(6)} ${moves}`;
  });
  return `Stockfish (${ENGINE_NAME}, depth ${ev.depth}): ${formatScore(ev.lines[0])}\nTop lines:\n${lines.join('\n')}`;
}

function parseMove(pos: Chess, text: string): Move | undefined {
  const t = text.trim().replace(/[!?]+$/, '').replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O');
  const san = parseSan(pos, t);
  if (san) return san;
  const uci = parseUci(t.toLowerCase());
  return uci && pos.isLegal(uci) ? uci : undefined;
}

function legalMovesSan(pos: Chess): string[] {
  const out: string[] = [];
  for (const [from, dests] of chessgroundDests(pos)) {
    for (const to of dests) {
      const promo = pos.board.get(parseSquare(from)!)?.role === 'pawn' && /[18]$/.test(to);
      out.push(makeSan(pos, { from: parseSquare(from)!, to: parseSquare(to)!, promotion: promo ? 'queen' : undefined }));
    }
  }
  return out;
}

/** Play `moveText` from `fen` and evaluate the result. Used by both the up-front scan and the tool. */
async function analyzeMove(fen: string, moveText: string): Promise<{ ok: boolean; san?: string; text: string }> {
  const pos = posFromFen(fen);
  const move = parseMove(pos, moveText);
  if (!move)
    return {
      ok: false,
      text: `"${moveText}" is not a legal move in this position. Legal moves: ${legalMovesSan(pos).join(', ')}.`,
    };
  const [numbered] = lineMoves(fen, [makeSan(pos, move)]);
  const san = numbered.san;
  const label = `${numbered.number ?? ''} ${san}`.trim();
  pos.play(move);
  const after = makeFen(pos.toSetup());
  const over = gameOverText(pos);
  if (over) return { ok: true, san, text: `After ${label}: ${over}` };
  const ev = await engine.evaluate(after, { multiPv: 3, depth: 16 });
  if (!ev) return { ok: true, san, text: `After ${label} (FEN ${after}): Stockfish is unavailable.` };
  return { ok: true, san, text: `After ${label} (FEN ${after}):\n${describeEval(ev)}` };
}

/** Explicit moves in the question, e.g. "what about Nxe5?" or "why not O-O". */
function mentionedMoves(question: string, pos: Chess): string[] {
  const token = /(?:^|[\s(,"'“])((?:O-O(?:-O)?|0-0(?:-0)?|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8](?:=?[QRBN])?|[a-h][1-8](?:=?[QRBN])?)[+#]?)(?=$|[\s?!.,)"'”])/g;
  const found = new Map<string, string>();
  for (const m of question.matchAll(token)) {
    const raw = m[1];
    // A bare square ("the knight on f3") is only a pawn move if it isn't a location.
    const before = question.slice(0, m.index! + m[0].indexOf(raw)).toLowerCase();
    if (/^[a-h][1-8]$/.test(raw) && /\b(on|at|to|from|of|square)\s*$/.test(before)) continue;
    const move = parseMove(pos, raw);
    if (move) found.set(makeSan(pos, move), raw);
    if (found.size >= 3) break;
  }
  return [...found.keys()];
}

export async function buildContext(ctx: CoachContext, question: string, onStatus: (s: string | null) => void): Promise<string> {
  const pos = posFromFen(ctx.fen);
  const out: string[] = [
    `Position (FEN): ${ctx.fen}`,
    `${pos.turn === 'white' ? 'White' : 'Black'} to move${pos.isCheck() ? ' (in check)' : ''}.`,
    describePieces(pos),
  ];
  if (ctx.source === 'puzzle' && ctx.puzzle) {
    const p = ctx.puzzle;
    out.push(
      `Source: puzzle #${p.id} (rating ${p.rating}; themes: ${p.themes.join(', ')}). The user plays ${p.playerColor}.`,
      p.solved
        ? `Status: solved. Solution: ${p.solution?.join(' ') ?? 'n/a'}`
        : 'Status: unsolved. Do not reveal the solution unless the user explicitly asks for it.',
    );
  } else out.push('Source: free analysis board.');

  const over = gameOverText(pos);
  if (over) out.push(over);
  else {
    onStatus('Analyzing the position with Stockfish…');
    const ev = await engine.evaluate(ctx.fen);
    out.push(ev ? describeEval(ev) : 'Stockfish evaluation unavailable.');
    for (const san of over ? [] : mentionedMoves(question, pos)) {
      onStatus(`Checking ${san}…`);
      out.push(`Move mentioned by the user:\n${(await analyzeMove(ctx.fen, san)).text}`);
    }
  }
  onStatus(null);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Conversation (append-only history, streamed replies, local tool loop)

// The API keys are added by the dev-server proxies; the browser only ever
// holds these placeholders, which is why direct browser use is safe here.
let anthropicClient: Anthropic | undefined;
function anthropic(): Anthropic {
  anthropicClient ??= new Anthropic({
    apiKey: 'added-by-vite-dev-proxy',
    baseURL: new URL('/api/anthropic', location.href).href,
    dangerouslyAllowBrowser: true,
  });
  return anthropicClient;
}

let geminiClient: GoogleGenAI | undefined;
function gemini(): GoogleGenAI {
  geminiClient ??= new GoogleGenAI({
    apiKey: 'added-by-vite-dev-proxy',
    httpOptions: { baseUrl: new URL('/api/gemini', location.href).href },
  });
  return geminiClient;
}

export interface SendCallbacks {
  signal: AbortSignal;
  /** The reply text so far (called as it streams). */
  onText: (text: string) => void;
  /** What the coach is doing before/between replies, or null. */
  onStatus: (status: string | null) => void;
}

const SETUP_HELP = [
  'The coach isn’t configured yet.',
  'Put GEMINI_API_KEY=… in web/.env.local (see web/.env.local.example), then restart `npm run dev`.',
  'Gemini API keys are free from aistudio.google.com/apikey. ANTHROPIC_API_KEY works too, if you’d rather use Claude.',
].join('\n\n');

export class CoachConversation {
  private claudeHistory: Anthropic.Beta.BetaMessageParam[] = [];
  private geminiHistory: Content[] = [];

  async send(question: string, ctx: CoachContext, cb: SendCallbacks): Promise<string> {
    if (!COACH_ENABLED) return SETUP_HELP;

    const context = await buildContext(ctx, question, cb.onStatus);
    if (cb.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const history = PROVIDER === 'gemini' ? this.geminiHistory : this.claudeHistory;
    const start = history.length;
    try {
      const answer =
        PROVIDER === 'gemini'
          ? await this.sendGemini(`<context>\n${context}\n</context>`, question, ctx, cb)
          : await this.sendClaude(`<context>\n${context}\n</context>`, question, ctx, cb);
      return answer.trim() || '(The coach returned no text.)';
    } catch (e) {
      // Leave the history as it was before this question so the next one can
      // continue cleanly (the failed turn is simply not part of the chat).
      history.length = start;
      throw e;
    }
  }

  private async sendGemini(context: string, question: string, ctx: CoachContext, cb: SendCallbacks): Promise<string> {
    this.geminiHistory.push({ role: 'user', parts: [{ text: context }, { text: question }] });

    let answer = '';
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const stream = await gemini().models.generateContentStream({
        model: MODEL,
        contents: this.geminiHistory,
        config: { systemInstruction: SYSTEM, tools: GEMINI_TOOLS, abortSignal: cb.signal },
      });
      const prefix = answer ? `${answer}\n\n` : '';
      let streamed = '';
      // Keep every part as returned (thought signatures included): Gemini
      // needs them echoed back to continue a turn that used a tool.
      const parts: Part[] = [];
      for await (const chunk of stream) {
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          parts.push(part);
          if (part.text && !part.thought) {
            streamed += part.text;
            cb.onText(prefix + streamed);
          }
        }
      }
      if (cb.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      // A turn with no parts (e.g. blocked by a safety filter) still needs a
      // model reply in the history, or the next question would follow a user turn.
      this.geminiHistory.push({ role: 'model', parts: parts.length ? parts : [{ text: '(no reply)' }] });
      if (streamed) answer = prefix + streamed;

      const calls = parts.flatMap(p => (p.functionCall ? [p.functionCall] : []));
      if (!calls.length) break;

      const results: Part[] = [];
      for (const call of calls) {
        const move = toolMove(call.name, call.args);
        let response: Record<string, unknown>;
        if (!move) response = { error: `Invalid input: ${JSON.stringify(call.args)}` };
        else {
          cb.onStatus(`Checking ${move}…`);
          const r = await analyzeMove(ctx.fen, move);
          response = r.ok ? { output: r.text } : { error: r.text };
        }
        results.push({ functionResponse: { id: call.id, name: call.name, response } });
      }
      cb.onStatus(null);
      this.geminiHistory.push({ role: 'user', parts: results });
    }
    return answer;
  }

  private async sendClaude(context: string, question: string, ctx: CoachContext, cb: SendCallbacks): Promise<string> {
    this.claudeHistory.push({
      role: 'user',
      content: [
        { type: 'text', text: context },
        { type: 'text', text: question },
      ],
    });

    let answer = '';
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const stream = anthropic().beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 16000,
          system: SYSTEM,
          tools: TOOLS,
          messages: this.claudeHistory,
          thinking: { type: 'adaptive' },
          output_config: { effort: EFFORT },
          cache_control: { type: 'ephemeral' },
          // Opus 5: if a safety classifier declines, retry server-side on
          // Anthropic's recommended fallback model instead of refusing.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { signal: cb.signal },
      );
      const prefix = answer ? `${answer}\n\n` : '';
      let streamed = '';
      stream.on('text', delta => {
        streamed += delta;
        cb.onText(prefix + streamed);
      });
      const message = await stream.finalMessage();
      this.claudeHistory.push({ role: 'assistant', content: message.content });

      if (message.stop_reason === 'refusal') {
        // The whole fallback chain declined; drop any partial text.
        answer = answer || 'Sorry, I can’t help with that one.';
        break;
      }
      if (streamed) answer = prefix + streamed;

      const toolUses = message.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
      );
      // A tool call cut off at max_tokens may carry truncated input: don't run it.
      if (message.stop_reason !== 'tool_use' || !toolUses.length) break;

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const move = toolMove(use.name, use.input);
        if (!move) {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: JSON.stringify({ INVALID_INPUT: use.input }),
          });
          continue;
        }
        cb.onStatus(`Checking ${move}…`);
        const r = await analyzeMove(ctx.fen, move);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: r.text, is_error: !r.ok });
      }
      cb.onStatus(null);
      this.claudeHistory.push({ role: 'user', content: results });
    }
    return answer;
  }
}

/** User-facing message for a failed request. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    // The deployed Worker's per-visitor cap (worker/index.ts).
    if (e.status === 429 && /visitor limit reached/i.test(e.message))
      return /per day/.test(e.message)
        ? 'You’ve reached the coach’s daily limit for this demo. It resets at midnight UTC.'
        : 'You’re asking faster than this demo allows. Wait a minute and try again.';
    if (e.status === 429)
      return 'The coach is busy right now (the Gemini free tier allows about 30 requests a minute and 1,500 a day). Try again in a moment.';
    if (e.status === 503 && /not configured/i.test(e.message)) return 'The coach isn’t set up on this deployment yet.';
    if (e.status === 400 && /api key/i.test(e.message))
      return 'The API key was rejected. Check GEMINI_API_KEY in web/.env.local and restart the dev server.';
    if (e.status === 403) return 'This Gemini API key doesn’t have access to that model.';
    if (e.status === 404) return `Gemini doesn’t recognize the model "${MODEL}". Check COACH_MODEL in web/.env.local.`;
    return `Gemini API error ${e.status}: ${e.message}`;
  }
  if (e instanceof Anthropic.AuthenticationError)
    return 'The API key was rejected. Check ANTHROPIC_API_KEY in web/.env.local and restart the dev server.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key doesn’t have access to that model.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API. Try again in a moment.';
  if (e instanceof Anthropic.APIConnectionError)
    return 'Couldn’t reach the Anthropic API through the dev server. Is `npm run dev` running with a key set?';
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status ?? ''}: ${e.message}`;
  if (e instanceof TypeError && PROVIDER === 'gemini')
    return 'Couldn’t reach the Gemini API through the dev server. Is `npm run dev` running with a key set?';
  return `Something went wrong: ${String(e)}`;
}

export const isAbort = (e: unknown) =>
  e instanceof Anthropic.APIUserAbortError || (e instanceof Error && e.name === 'AbortError');
