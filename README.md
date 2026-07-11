# Chess Trainer — standalone build

This is a standalone Vite + React version of the Chess Trainer app,
adapted from the original single-file Claude artifact so it can be built,
hosted, and pushed to GitHub from zo.computer.

## Running it

```
npm install
npm run dev       # local dev server
npm run build     # production build → dist/
npm run preview   # serve the production build locally
```

This has already been built and smoke-tested (headless browser: home
screen, Free Play setup, and an actual game move against the engine —
all verified working, zero console errors) before being handed off.

## What's different from the Claude-artifact version

Two things only work inside claude.ai and were adapted or flagged here:

1. **Persistent storage.** The original app calls `window.storage`, an
   API Claude's artifact runtime provides. `src/main.jsx` polyfills the
   same `get`/`set`/`delete`/`list` interface on top of `localStorage`,
   so profile data, settings, puzzle rating, and the ECO opening-cache
   all persist exactly as before — this needed no changes to
   `ChessTrainer.jsx` itself.

2. **"Ask the coach" AI chat.** Inside a Claude artifact, requests to
   `https://api.anthropic.com/v1/messages` are transparently proxied —
   no API key needed. Outside that environment (this build), that same
   fetch call will fail with an auth error, since there's no proxy and
   no key. The app already handles this gracefully — it shows "Couldn't
   reach the coach," not a crash — so the rest of the app is unaffected.
   If you want this feature working standalone, you'd need a small
   backend (even a single serverless function) that holds an Anthropic
   API key server-side and proxies the request — never put a real API
   key in client-side code. Happy to build that proxy function if you
   want this feature live.

Everything else — the engine, all 40 coached openings, the 413 puzzles,
Opening Recall, Free Play, board themes, sounds — is the unmodified app
logic, just bundled through Vite instead of the artifact runtime.

## Project structure

```
index.html            entry HTML (mounts #root)
src/main.jsx           localStorage polyfill + React mount
src/ChessTrainer.jsx    the entire app (unmodified from the artifact)
vite.config.js
package.json
```

## Pushing to GitHub from zo.computer

Once this is building cleanly in zo.computer, use its GitHub integration
to push the repo — that flow is zo's own UI, not something this project
needs to configure. If you'd like real version history preserved (v1
through v7, not one flattened commit) rather than a single import, let
me know and I'll hand you a git bundle with full commit history instead
of a plain source zip.
