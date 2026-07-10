# Changelog

## v7
- **Fixed:** engine could freeze the tab at Grandmaster level. Root cause
  was an unbounded depth-6 + quiescence search with no time limit and no
  pruning between root candidate moves. Rewritten as iterative deepening
  with a hard ~2.2s wall-clock budget — always returns the best move found
  from the last fully-completed depth, regardless of position complexity.
- **Sound:** move/capture/castle sounds retuned to a short (<100ms), dry,
  bandpassed "click + low body" design closer to real chess-piece contact
  sound, replacing an earlier attempt that was too tinny and a follow-up
  that was too soft/boomy.

## v6
- Move sounds reworked from a bright "clock click" to a warmer thud
  (superseded by the v7 retune above).
- Pieces enlarged (86% → 94% of square) with richer gradients, bolder
  stroke, deeper drop shadow for a more polished look.
- Board UI now expands to fill more of the screen during active play:
  header's theme/sound/voice icons hide once a game starts; Free Play,
  Puzzles, and Opening Recall get a compact layout.
- Free Play's level/color picker became a proper "Game Setup" step with
  its own theme/sound/voice controls, instead of living in the persistent
  header.
- Added board-flip toggle (Free Play, Puzzles).
- Added **Opening Recall** quiz mode: coach auto-plays one side, you
  recall the other from memory; tracks per-opening mastery and weights
  weaker lines to appear more often.

## v5
- Added **Puzzles**: 413 tactics curated from the real Lichess puzzle
  database (filtered by popularity/play count, verified move-by-move with
  python-chess), across 17 themes and 5 difficulty tiers. Adaptive puzzle
  rating, streak tracking, hint/skip.
- Added a live evaluation bar (Free Play).
- Fixed stale home-screen copy ("8 openings" / "3 strengths" → accurate
  40 openings / 16 levels).

## v4
- Pointer-based drag-and-drop piece movement (alongside tap-to-move).
- Elo ladder extended from 3 tiers to 16 (600–2500), with an opening book
  above 1500 Elo and quiescence search above 1800.
- Fixed Android Chrome bug where `speechSynthesis` silently dropped
  utterances; added spoken move announcements.
- Added 40 fully-commented coached openings (20 White, 20 Black),
  replacing the original 8 — every line verified legal with python-chess.

## v3
- Searchable ECO openings database (1,751 embedded lines ≤8 plies, full
  3,733-line dataset fetched and cached on first run).
- Move sounds reworked to a tournament-clock-click design (superseded in
  v6/v7).
- Three board themes (green / walnut / ice), daily training streak,
  full-bleed edge-to-edge board.

## v2
- Unicode piece glyphs replaced with an inline SVG piece set.
- Web Audio sound effects + haptics, Settings context, persistent
  storage.
- Free Play with Elo rating (3 strengths), alpha-beta engine with
  piece-square tables.
- Post-game move-by-move review mode.

## v1
- Initial release: full legal-move chess engine, 8 coached openings,
  Learn mode, Play-vs-Coach, Fundamentals and Strategy lessons, AI
  "Ask the coach" chat.
