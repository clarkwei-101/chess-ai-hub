# Chess AI Hub

> AlphaGo-style real-time AI analysis for Go (围棋), Xiangqi (中国象棋), and Chess (国际象棋).

A single Next.js app that bundles three state-of-the-art engines — **KataGo v1.18.1**, **Pikafish 2026**, and **Stockfish 18** — behind one streaming UI. The front-end pipes top-N candidate moves, win-rate curves, and principal variations from the engine directly into the browser through a server-sent-events (SSE) channel.

## Highlights

- **Three variants, one stack** — Go 19×19, Xiangqi 9×10, Chess 8×8
- **SSE streaming analysis** — first `info` line reaches the browser in milliseconds (no Next.js buffering)
- **Multi-PV reasoning** — top-3 candidate moves with principal variations
- **AlphaGo-style hints** — policy arrows and ownership heatmap (KataGo)
- **Style profiles** — `aggressive` / `defensive` / `positional` / `default` per player
- **Cyber-foundation dark UI** — black + silver palette, GSAP/Framer Motion micro-interactions

## Quick Start

```bash
# 1. Install
npm install

# 2. Download engines (~150 MB: stockfish, pikafish, katago + kata1-b10c384 network)
npm run engines:download

# 3. Run dev server
npm run dev    # http://localhost:3002
```

The dev server boots each engine lazily on first request, then keeps it warm in a singleton manager. Concurrent analyze calls are serialized per-variant so the engine never sees interleaved `go infinite` / `stop` commands.

## Architecture

```
Browser ──SSE──▶ /api/engine/analyze
                       │
                       ▼
                EngineManager (singleton)
                       │
            ┌──────────┼──────────┐
            ▼          ▼          ▼
         KataGo    Pikafish   Stockfish
         (GTP)      (UCI)      (UCI)
```

| Engine    | Protocol | Binary                          | Network file                 |
| --------- | -------- | ------------------------------- | ---------------------------- |
| KataGo    | GTP      | `engines/katago`                | `engines/networks/kata1-…bin.gz` |
| Pikafish  | UCI      | `engines/pikafish`              | `pikafish.nnue` (project root) |
| Stockfish | UCI      | `engines/stockfish`             | embedded                      |

The manager pins the engine instance to `globalThis.__engineManager` so Next.js dev hot-reload doesn't leak orphaned processes. Each `analyze()` runs through an event-driven queue (no polling) — every `info …` line triggers a single SSE `data:` enqueue.

## Routes

| Path           | Purpose                                                      |
| -------------- | ------------------------------------------------------------ |
| `/`            | Three-game selector with engine health badges                |
| `/go`          | 19×19 Go board + KataGo analysis                             |
| `/xiangqi`     | 9×10 Xiangqi board + Pikafish analysis (red/black picker)    |
| `/chess`       | 8×8 Chess board + Stockfish 18 analysis                     |
| `/visual`      | Lichess board FEN/PGN connector                              |
| `/go-agent`    | Go AI Agent — large-language-model move coach                |

## API Surface

| Endpoint                              | Method | Description                          |
| ------------------------------------- | ------ | ------------------------------------ |
| `/api/engine/health`                  | GET    | Returns binary-availability map      |
| `/api/engine/start?variant=chess`     | GET    | Boot engine                          |
| `/api/engine/analyze?variant=…&depth=18&multipv=3` | GET (SSE) | Stream analysis updates      |
| `/api/engine/move?variant=…`          | POST   | Engine plays one move                |
| `/api/engine/new-game?variant=…`      | POST   | Reset board                          |
| `/api/engine/set-style?variant=…&id=…` | POST | Switch player style profile         |
| `/api/engine/stop-analyze?variant=…`  | POST   | Stop infinite search                 |
| `/api/deepseek`                       | POST   | DeepSeek LLM move explanation        |
| `/api/go-knowledge`                   | GET    | Go opening / joseki knowledge base   |
| `/api/xiangqi-knowledge`              | GET    | Xiangqi opening-book knowledge       |

## Project Layout

```
app/
  api/         # Route handlers (engine, knowledge, deepseek)
  chess/       # /chess page
  go/          # /go page
  xiangqi/     # /xiangqi page
  visual/      # /visual page
  go-agent/    # /go-agent page
components/    # Board renderer + side panels
lib/
  engine/
    EngineManager.ts     # Process lifecycle + stdio routing
    protocols/
      uci.ts            # UCI parser + analysis builder
      gtp.ts            # GTP parser + KataGo adapter
  rules/        # Move generation + game-over detection
  styles/       # Style profile definitions
  go-knowledge/
  xiangqi-knowledge/
engines/        # Stockfish / Pikafish / KataGo binaries + KataGo network
public/
scripts/
  download-engines.sh    # Fetches engine binaries
  check-engines.sh       # Verifies installation
```

## Deployment

The repo ships with `vercel.json`. Pushing to `main` triggers an automatic Vercel build.

> **Note on serverless**: Vercel Functions cannot spawn local engine binaries, so the deployed build is a **UI-only demo** — all `/api/engine/*` endpoints will report engines missing. To run with full analysis, host this on a VM (Vercel does not support long-running processes).

## License

MIT — fan project by HKUST AI应用社 · Cyber Foundation.
