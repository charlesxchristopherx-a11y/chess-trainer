# Chess Trainer

A mobile-first chess coaching app: full legal-move chess engine, 40 coached
openings, a searchable openings database, 413 curated tactics puzzles, a
spaced-repetition-style opening recall quiz, rated Free Play against an
engine across 16 Elo levels (600–2500), full game review, and an AI
"Ask the coach" chat. Originally built as a single-file Claude.ai artifact;
this repo is the standalone build for hosting it yourself.

## Running it

```
npm install
npm run dev       # local dev server (localhost:5173)
npm run build     # production build → dist/
npm run deploy    # build + deploy to Cloudflare Workers (needs wrangler auth)
```

## Architecture

- **Frontend**: React + Vite, single component (`src/ChessTrainer.jsx`) —
  the entire app: engine, UI, and embedded datasets (openings, puzzles).
- **Hosting**: a Cloudflare Worker (`src/worker.js`) serves the built
  static site and also answers `POST /api/coach`.
- **AI**: the coach's answers come from **Workers AI**
  (`@cf/meta/llama-3.1-8b-instruct` by default — swap the `MODEL` constant
  in `src/worker.js` for any other [Workers AI model](https://developers.cloudflare.com/workers-ai/models/)).
  No Anthropic API key, no third-party key of any kind — the "brains" are
  entirely Cloudflare's.
- **Storage**: `src/main.jsx` polyfills the `window.storage` API the app
  uses for persistence (profile, settings, puzzle rating) on top of
  `localStorage`, since that API only exists natively inside a Claude.ai
  artifact.

### Why this still works as a Claude.ai artifact too

`ChessTrainer.jsx` is unmodified app logic — the only change from the
original artifact is in the "Ask the coach" call: it tries the same-origin
`/api/coach` route first, and only falls back to Anthropic's endpoint
(which is proxied for free *inside* claude.ai, and only there) if that
route doesn't exist. So the exact same file works correctly whether it's
pasted into a fresh Claude conversation as an artifact, or built and
deployed here.

## Deploying to Cloudflare

**Option A — GitHub-connected (recommended, no CLI needed):**

1. Push this repo to GitHub.
2. In the Cloudflare dashboard: **Workers & Pages → Create → Connect to Git**,
   pick this repo.
3. Build command: `npm run build`. Build output directory: `dist`.
   Deploy command: leave default (it reads `wrangler.jsonc`).
4. Under the Worker's **Settings → Bindings**, add an **AI** binding named
   `AI` if it isn't picked up automatically from `wrangler.jsonc`.
5. Every push to the connected branch auto-deploys, the same way Pages
   used to work.

**Option B — CLI, from a machine with Node:**

```
npx wrangler login
npm run deploy
```

Both produce a `*.workers.dev` URL immediately; add a custom domain from
the same dashboard page whenever you're ready.

## Project structure

```
index.html              entry HTML
src/main.jsx             localStorage polyfill + React mount
src/ChessTrainer.jsx      the entire app (engine, UI, datasets)
src/worker.js             Cloudflare Worker: static assets + /api/coach (Workers AI)
wrangler.jsonc            Worker config (assets + AI bindings)
vite.config.js
CHANGELOG.md              version history (v1 → current)
LICENSE                   MIT
```

## Data provenance

- Openings: [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0-equivalent).
- Puzzles: [Lichess puzzle database](https://database.lichess.org/#puzzles) (CC0).
  Puzzle IDs are preserved, so any puzzle can be looked up at
  `lichess.org/training/{id}`.

## License

MIT — see [LICENSE](LICENSE).
