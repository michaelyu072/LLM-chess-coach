# Chess Puzzle Coach

A chess puzzle trainer with an AI coach you can ask about any position.

**Live demo: [chess-puzzle-coach.michaelyu.workers.dev](https://chess-puzzle-coach.michaelyu.workers.dev/)**

**Demo video: [watch on Google Drive](https://drive.google.com/file/d/1bzmhd3Oa7wErZ9kHn1kbpECNOYdNKXAQ/view?usp=sharing)**

Solve curated puzzles from the Lichess database, get progressive hints when you're stuck, explore any position on a free analysis board, and ask the coach questions like "why not take the rook?". The coach's answers are checked against a real chess engine, so it explains what's actually true in the position instead of guessing.

## Features

- **1,000 curated puzzles** from the Lichess puzzle database, filterable by tactical theme (forks, pins, skewers, …) and rating
- **Progressive help:** after wrong attempts you get a hint about the idea, then which piece to move, then the solution
- **AI coach chat** on both the puzzle and the analysis board. It sees the position you're looking at, gives hints without spoiling unsolved puzzles, and explains plans and tactics
- **Stockfish in the browser** for live evaluation and analysis, no server needed
- **Progress tracking:** accuracy, streaks and history, saved in your browser
- Board and piece themes and move sounds from Lichess

## How it works

```
                    ┌──────────────────────── your browser ────────────────────────┐
                    │                                                              │
 Lichess puzzle  ──►│  Puzzle app (React)  ◄──►  Stockfish (runs locally, WASM)    │
 database           │        │                         ▲                           │
 (filtered offline) │        ▼                         │ "evaluate this move"      │
                    │   Coach chat  ───────────────────┘                           │
                    └────────┬─────────────────────────────────────────────────────┘
                             │ question + position + engine analysis
                             ▼
                    ┌─────────────────────┐        ┌──────────────┐
                    │ Cloudflare Worker   │ ─────► │ Gemini API   │
                    │ (holds the API key, │ ◄───── │ (the coach's │
                    │  per-visitor limits)│        │  language)   │
                    └─────────────────────┘        └──────────────┘
```

- **Puzzles are prepared ahead of time.** A small Python pipeline filters the 6.1 million Lichess puzzles by quality (well-rated, popular, widely played, not trivial), then picks 1,000 spread across tactical themes and exports them as a static file. Checking your moves is deterministic: they're compared to the known solution, with no AI involved.
- **The chess engine runs in your browser.** Stockfish is compiled to WebAssembly and analyzes positions on your own device, so analysis is instant and free.
- **The engine grounds the coach.** Each question is sent along with the position and Stockfish's evaluation. If the coach wants to check a move you didn't mention, it asks the browser to run Stockfish on that move before answering. The language model explains the ideas; the engine supplies the facts.
- **The key stays private.** The site and a small proxy are both served by one Cloudflare Worker. The proxy adds the Gemini API key server-side and limits how many requests each visitor can make, so the free-tier key can't be extracted or drained.

## Tech stack

TypeScript, React, Vite · [chessground](https://github.com/lichess-org/chessground) (board) and [chessops](https://github.com/niklasf/chessops) (rules) from Lichess · Stockfish 19 (WebAssembly) · Gemini API (Claude also supported) · Cloudflare Workers · Python for the data pipeline

## Running locally

```bash
cd web
npm install
cp .env.local.example .env.local   # add a free Gemini key from https://aistudio.google.com/apikey
npm run dev                        # http://localhost:5173
```

Everything except the coach works without a key.

To deploy your own copy to Cloudflare: `npx wrangler login`, then `npm run deploy`, then `npx wrangler secret put GEMINI_API_KEY`.

## Repository layout

| Path | What's there |
|---|---|
| `web/` | The app, plus the Cloudflare Worker in `web/worker/` |
| `pipeline/` | Scripts that select puzzles from the Lichess dump and export them for the app |
| `data/` | Notes on how the puzzle set was chosen |

## Credits

- Puzzles from the [Lichess puzzle database](https://database.lichess.org/#puzzles) (CC0)
- Board, piece and sound assets from [Lichess (lila)](https://github.com/lichess-org/lila), each under its own license as listed there
- Engine: [Stockfish](https://stockfishchess.org/) (GPLv3), via Lichess's [stockfish-web](https://github.com/lichess-org/stockfish-web) build
