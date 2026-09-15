import React, { useState, useMemo, useEffect, useRef, createContext, useContext } from "react";

/* ============================================================
   CHESS TRAINER v4
   • Drag-and-drop piece movement (pointer events), alongside tap-to-move
   • Elo ladder extended to 16 tiers, 600–2500, with opening-book
     lookups and quiescence search kicking in at higher tiers
   • Voice coach fixed on Android (cancel/speak race condition) and
     now announces the opponent's moves aloud during games
   • 40 fully coached openings (20 White repertoires, 20 Black
     defenses) with move-by-move commentary, verified move-legal
     via python-chess during the build
   • Everything from v3: searchable ECO database (1,751 lines
     embedded + live-fetch of all 3,733, cached), clock-click move
     sounds, board themes (green / walnut / ice), daily streak,
     rated free play, move-by-move review, lessons
   ============================================================ */

/* ---------- core chess engine ---------- */
const VAL = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
const FILESTR = "abcdefgh";
const sqIdx = (name) => (8 - parseInt(name[1], 10)) * 8 + FILESTR.indexOf(name[0]);
const idxName = (i) => FILESTR[i % 8] + (8 - Math.floor(i / 8));

function initialBoard() {
  const b = new Array(64).fill(null);
  const back = ["R", "N", "B", "Q", "K", "B", "N", "R"];
  for (let f = 0; f < 8; f++) {
    b[f] = "b" + back[f]; b[8 + f] = "bP";
    b[48 + f] = "wP"; b[56 + f] = "w" + back[f];
  }
  return b;
}
const startState = () => ({
  board: initialBoard(), turn: "w",
  castling: { wK: true, wQ: true, bK: true, bQ: true },
  ep: null, full: 1,
});
const cloneState = (s) => ({
  board: s.board.slice(), turn: s.turn, castling: { ...s.castling }, ep: s.ep, full: s.full,
});

const KN = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const KG = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const DIAG = [[-1,-1],[-1,1],[1,-1],[1,1]];
const ORTH = [[-1,0],[1,0],[0,-1],[0,1]];

function isAttacked(board, idx, byColor) {
  const r = Math.floor(idx / 8), f = idx % 8;
  const pd = byColor === "w" ? 1 : -1;
  for (const df of [-1, 1]) {
    const rr = r + pd, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && board[rr * 8 + ff] === byColor + "P") return true;
  }
  for (const [dr, df] of KN) {
    const rr = r + dr, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && board[rr * 8 + ff] === byColor + "N") return true;
  }
  for (const [dr, df] of KG) {
    const rr = r + dr, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && board[rr * 8 + ff] === byColor + "K") return true;
  }
  for (const [dr, df] of DIAG) {
    let rr = r + dr, ff = f + df;
    while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
      const p = board[rr * 8 + ff];
      if (p) { if (p[0] === byColor && (p[1] === "B" || p[1] === "Q")) return true; break; }
      rr += dr; ff += df;
    }
  }
  for (const [dr, df] of ORTH) {
    let rr = r + dr, ff = f + df;
    while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
      const p = board[rr * 8 + ff];
      if (p) { if (p[0] === byColor && (p[1] === "R" || p[1] === "Q")) return true; break; }
      rr += dr; ff += df;
    }
  }
  return false;
}
const kingIdx = (board, color) => board.indexOf(color + "K");

function pseudoMoves(state, idx) {
  const { board, ep, castling } = state;
  const p = board[idx];
  if (!p) return [];
  const color = p[0], type = p[1], opp = color === "w" ? "b" : "w";
  const r = Math.floor(idx / 8), f = idx % 8;
  const out = [];
  const push = (rr, ff) => { if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) out.push(rr * 8 + ff); };
  if (type === "P") {
    const dir = color === "w" ? -1 : 1;
    const startR = color === "w" ? 6 : 1;
    if (!board[(r + dir) * 8 + f]) {
      push(r + dir, f);
      if (r === startR && !board[(r + 2 * dir) * 8 + f]) push(r + 2 * dir, f);
    }
    for (const df of [-1, 1]) {
      const rr = r + dir, ff = f + df;
      if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
        const t = rr * 8 + ff;
        if (board[t] && board[t][0] === opp) out.push(t);
        else if (ep === t) out.push(t);
      }
    }
  } else if (type === "N") {
    for (const [dr, df] of KN) {
      const rr = r + dr, ff = f + df;
      if (rr < 0 || rr > 7 || ff < 0 || ff > 7) continue;
      const t = rr * 8 + ff;
      if (!board[t] || board[t][0] === opp) out.push(t);
    }
  } else if (type === "K") {
    for (const [dr, df] of KG) {
      const rr = r + dr, ff = f + df;
      if (rr < 0 || rr > 7 || ff < 0 || ff > 7) continue;
      const t = rr * 8 + ff;
      if (!board[t] || board[t][0] === opp) out.push(t);
    }
    const home = color === "w" ? 7 : 0;
    if (r === home && f === 4 && !isAttacked(board, idx, opp)) {
      if (castling[color + "K"] && !board[home * 8 + 5] && !board[home * 8 + 6] &&
          board[home * 8 + 7] === color + "R" &&
          !isAttacked(board, home * 8 + 5, opp) && !isAttacked(board, home * 8 + 6, opp))
        out.push(home * 8 + 6);
      if (castling[color + "Q"] && !board[home * 8 + 3] && !board[home * 8 + 2] && !board[home * 8 + 1] &&
          board[home * 8 + 0] === color + "R" &&
          !isAttacked(board, home * 8 + 3, opp) && !isAttacked(board, home * 8 + 2, opp))
        out.push(home * 8 + 2);
    }
  } else {
    const dirs = type === "B" ? DIAG : type === "R" ? ORTH : [...DIAG, ...ORTH];
    for (const [dr, df] of dirs) {
      let rr = r + dr, ff = f + df;
      while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
        const t = rr * 8 + ff;
        if (!board[t]) out.push(t);
        else { if (board[t][0] === opp) out.push(t); break; }
        rr += dr; ff += df;
      }
    }
  }
  return out;
}

function applyMove(state, from, to) {
  const s = cloneState(state);
  const p = s.board[from];
  const color = p[0], type = p[1];
  const fr = Math.floor(from / 8), tr = Math.floor(to / 8), tf = to % 8, ff = from % 8;
  let captured = s.board[to];
  if (type === "P" && to === s.ep && !captured) {
    const capIdx = (color === "w" ? tr + 1 : tr - 1) * 8 + tf;
    captured = s.board[capIdx];
    s.board[capIdx] = null;
  }
  s.board[to] = p; s.board[from] = null;
  let castleSAN = null;
  if (type === "K" && Math.abs(tf - ff) === 2) {
    const home = color === "w" ? 7 : 0;
    if (tf === 6) { s.board[home * 8 + 5] = s.board[home * 8 + 7]; s.board[home * 8 + 7] = null; castleSAN = "O-O"; }
    else { s.board[home * 8 + 3] = s.board[home * 8 + 0]; s.board[home * 8 + 0] = null; castleSAN = "O-O-O"; }
  }
  let promo = false;
  if (type === "P" && (tr === 0 || tr === 7)) { s.board[to] = color + "Q"; promo = true; }
  s.ep = type === "P" && Math.abs(tr - fr) === 2 ? ((fr + tr) / 2) * 8 + tf : null;
  if (type === "K") { s.castling[color + "K"] = false; s.castling[color + "Q"] = false; }
  if (from === 56 || to === 56) s.castling.wQ = false;
  if (from === 63 || to === 63) s.castling.wK = false;
  if (from === 0 || to === 0) s.castling.bQ = false;
  if (from === 7 || to === 7) s.castling.bK = false;
  if (color === "b") s.full += 1;
  s.turn = color === "w" ? "b" : "w";
  return { state: s, captured, castleSAN, promo, type, color };
}

function legalMoves(state, idx) {
  const p = state.board[idx];
  if (!p || p[0] !== state.turn) return [];
  const opp = p[0] === "w" ? "b" : "w";
  return pseudoMoves(state, idx).filter((to) => {
    const { state: ns } = applyMove(state, idx, to);
    return !isAttacked(ns.board, kingIdx(ns.board, p[0]), opp);
  });
}
function allLegalMoves(state) {
  const out = [];
  for (let i = 0; i < 64; i++)
    if (state.board[i] && state.board[i][0] === state.turn)
      for (const to of legalMoves(state, i)) out.push({ from: i, to });
  return out;
}
function inCheck(state) {
  const opp = state.turn === "w" ? "b" : "w";
  return isAttacked(state.board, kingIdx(state.board, state.turn), opp);
}
function gameStatus(state) {
  const moves = allLegalMoves(state);
  if (moves.length) return inCheck(state) ? "check" : "ok";
  return inCheck(state) ? "checkmate" : "stalemate";
}
function makeSAN(state, from, to) {
  const res = applyMove(state, from, to);
  let san;
  if (res.castleSAN) san = res.castleSAN;
  else {
    const cap = res.captured ? "x" : "";
    const pre = res.type === "P" ? (res.captured ? FILESTR[from % 8] : "") : res.type;
    san = pre + cap + idxName(to) + (res.promo ? "=Q" : "");
  }
  const st = gameStatus(res.state);
  if (st === "checkmate") san += "#";
  else if (st === "check") san += "+";
  return { san, ...res };
}

/* SAN text -> legal move (for the openings database viewer) */
function sanToMove(state, sanRaw) {
  let san = sanRaw.replace(/[+#!?]+$/g, "");
  if (san === "O-O" || san === "0-0") {
    const home = state.turn === "w" ? 7 : 0;
    return { from: home * 8 + 4, to: home * 8 + 6 };
  }
  if (san === "O-O-O" || san === "0-0-0") {
    const home = state.turn === "w" ? 7 : 0;
    return { from: home * 8 + 4, to: home * 8 + 2 };
  }
  san = san.replace(/=([QRBN])$/, "");
  const m = san.match(/^([KQRBN])?([a-h])?([1-8])?x?([a-h][1-8])$/);
  if (!m) return null;
  const type = m[1] || "P";
  const to = sqIdx(m[4]);
  const cands = allLegalMoves(state).filter((mm) => {
    const p = state.board[mm.from];
    if (!p || p[1] !== type || mm.to !== to) return false;
    if (m[2] && FILESTR[mm.from % 8] !== m[2]) return false;
    if (m[3] && String(8 - Math.floor(mm.from / 8)) !== m[3]) return false;
    return true;
  });
  return cands[0] || null;
}
const pgnTokens = (pgn) => pgn.split(/\s+/).filter((t) => t && !/^\d+\.+$/.test(t));

/* ---------- evaluation + search ---------- */
const PST = {
  P: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5,
      0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
  N: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30,
      -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  B: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10,
      -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  R: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
      -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
  Q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5,
      0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
  K: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10,
      20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
};
function evaluate(state) {
  let s = 0;
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (!p) continue;
    const t = p[1];
    const pst = p[0] === "w" ? PST[t][i] : PST[t][(7 - ((i / 8) | 0)) * 8 + (i % 8)];
    s += (p[0] === "w" ? 1 : -1) * (VAL[t] * 100 + pst);
  }
  return state.turn === "w" ? s : -s;
}
function nowMs() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }
const TIME_UP = Symbol("time_up");
let NODE_COUNT = 0;
function qsearch(state, alpha, beta, qdepth, deadline) {
  if ((++NODE_COUNT & 511) === 0 && nowMs() > deadline) throw TIME_UP;
  const standPat = evaluate(state);
  if (standPat >= beta) return beta;
  if (alpha < standPat) alpha = standPat;
  if (qdepth <= 0) return alpha;
  const caps = allLegalMoves(state).filter((m) => state.board[m.to]);
  caps.sort((a, b) => (VAL[state.board[b.to][1]] || 0) - (VAL[state.board[a.to][1]] || 0));
  for (const m of caps) {
    const { state: ns } = applyMove(state, m.from, m.to);
    const v = -qsearch(ns, -beta, -alpha, qdepth - 1, deadline);
    if (v >= beta) return beta;
    if (v > alpha) alpha = v;
  }
  return alpha;
}
let ENGINE_QS = false; // toggled per-search by rootSearchTimed based on the level's `qs` flag
function negamax(state, depth, alpha, beta, deadline) {
  if ((++NODE_COUNT & 511) === 0 && nowMs() > deadline) throw TIME_UP;
  const moves = allLegalMoves(state);
  if (!moves.length) return inCheck(state) ? -99999 - depth : 0;
  if (depth <= 0) return ENGINE_QS ? qsearch(state, alpha, beta, 3, deadline) : evaluate(state);
  moves.sort((a, b) =>
    (state.board[b.to] ? VAL[state.board[b.to][1]] : 0) - (state.board[a.to] ? VAL[state.board[a.to][1]] : 0));
  let best = -Infinity;
  for (const m of moves) {
    const { state: ns } = applyMove(state, m.from, m.to);
    const v = -negamax(ns, depth - 1, -beta, -alpha, deadline);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}
/* Iterative deepening with a hard wall-clock budget: searches depth 1, 2, 3…
   up to maxDepth, keeping the best-scored move list from the last FULLY
   completed depth. If a deeper pass runs past the budget it's abandoned
   mid-way and the previous depth's result is kept — this is what actually
   prevents the engine from ever freezing the tab, regardless of position
   complexity or device speed. Also reorders moves by the previous depth's
   scores before each new pass, which makes alpha-beta pruning far more
   effective (best move searched first). */
function rootSearchTimed(state, maxDepth, qs, budgetMs = 2200) {
  const deadline = nowMs() + budgetMs;
  let moves = allLegalMoves(state);
  let best = moves.map((m) => ({ ...m, score: 0 }));
  if (!moves.length) return best;
  ENGINE_QS = !!qs;
  for (let d = 1; d <= maxDepth; d++) {
    if (nowMs() > deadline) break;
    NODE_COUNT = 0;
    try {
      const scored = moves.map((m) => {
        const { state: ns } = applyMove(state, m.from, m.to);
        return { ...m, score: -negamax(ns, d - 1, -Infinity, Infinity, deadline) };
      });
      scored.sort((a, b) => b.score - a.score);
      best = scored;
      moves = scored.map(({ score, ...m }) => m); // reorder for next iteration's move ordering
    } catch (e) {
      if (e === TIME_UP) break;
      ENGINE_QS = false;
      throw e;
    }
  }
  ENGINE_QS = false;
  return best;
}
function enginePick(state, depth, margin, qs = false) {
  const scored = rootSearchTimed(state, depth, qs);
  if (!scored.length) return null;
  const top = scored[0].score;
  const pool = scored.filter((m) => top - m.score <= margin);
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ---------- opening-book lookup (used by higher Elo levels) ---------- */
function sansToPgnPrefix(sans) {
  let out = "";
  for (let i = 0; i < sans.length; i++) {
    out += (i % 2 === 0 ? `${i / 2 + 1}. ${sans[i]} ` : `${sans[i]} `);
  }
  return out.trim();
}
function bookMoveFromEco(rows, sans) {
  if (!rows || !rows.length || sans.length >= 14) return null;
  const prefix = sansToPgnPrefix(sans);
  const cands = [];
  for (const r of rows) {
    const pgn = r[2];
    if (!pgn || pgn === prefix || !pgn.startsWith(prefix + " ")) continue;
    const rest = pgn.slice(prefix.length + 1).trim().split(/\s+/).filter(Boolean);
    const tok = rest.find((t) => !/^\d+\.+$/.test(t));
    if (tok) cands.push(tok);
  }
  if (!cands.length) return null;
  return cands[Math.floor(Math.random() * cands.length)];
}
const LEVELS = [
  { id: "beginner", name: "Beginner", elo: 600, depth: 1, margin: 260, book: false, qs: false, desc: "Sees one move ahead and gets distracted. Great for learning." },
  { id: "novice", name: "Novice", elo: 800, depth: 1, margin: 180, book: false, qs: false, desc: "A little steadier, still misses tactics often." },
  { id: "casual", name: "Casual", elo: 1000, depth: 2, margin: 110, book: false, qs: false, desc: "Solid club-night opponent. Punishes hanging pieces." },
  { id: "intermediate", name: "Intermediate", elo: 1200, depth: 2, margin: 70, book: false, qs: false, desc: "Comfortable with basic tactics and plans." },
  { id: "club", name: "Club Player", elo: 1400, depth: 3, margin: 40, book: false, qs: false, desc: "Calculates real lines. Bring your best chess." },
  { id: "strongclub", name: "Strong Club", elo: 1500, depth: 3, margin: 28, book: true, qs: false, desc: "Knows opening theory and punishes inaccuracies." },
  { id: "expert", name: "Expert", elo: 1600, depth: 3, margin: 20, book: true, qs: false, desc: "Sharp tactically, plays principled openings." },
  { id: "seniorexpert", name: "Senior Expert", elo: 1700, depth: 4, margin: 16, book: true, qs: false, desc: "Rarely blunders, calculates several moves deep." },
  { id: "natmaster", name: "National Master", elo: 1800, depth: 4, margin: 12, book: true, qs: true, desc: "Strong all-round play with real endgame technique." },
  { id: "natmasterplus", name: "NM+", elo: 1900, depth: 4, margin: 9, book: true, qs: true, desc: "Very few weaknesses to exploit." },
  { id: "candidate", name: "Candidate", elo: 2000, depth: 5, margin: 7, book: true, qs: true, desc: "Candidate-master strength; deep, accurate calculation." },
  { id: "candidateplus", name: "Candidate+", elo: 2100, depth: 5, margin: 5, book: true, qs: true, desc: "Approaching titled-player accuracy." },
  { id: "cm", name: "Candidate Master", elo: 2200, depth: 5, margin: 4, book: true, qs: true, desc: "Titled-level tactical vision." },
  { id: "fm", name: "FIDE Master", elo: 2300, depth: 6, margin: 3, book: true, qs: true, desc: "Very few practical chances against this level." },
  { id: "im", name: "International Master", elo: 2400, depth: 6, margin: 2, book: true, qs: true, desc: "Elite strength for a browser engine on a phone." },
  { id: "gm", name: "Grandmaster", elo: 2500, depth: 6, margin: 0, book: true, qs: true, desc: "Our strongest setting. A real phone JS engine has real limits — treat this as 'very hard', not literal GM strength." },
];

function toFEN(state) {
  let fen = "";
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = state.board[r * 8 + f];
      if (!p) empty++;
      else { if (empty) { fen += empty; empty = 0; } fen += p[0] === "w" ? p[1] : p[1].toLowerCase(); }
    }
    if (empty) fen += empty;
    if (r < 7) fen += "/";
  }
  const c = state.castling;
  const cs = (c.wK ? "K" : "") + (c.wQ ? "Q" : "") + (c.bK ? "k" : "") + (c.bQ ? "q" : "");
  return `${fen} ${state.turn} ${cs || "-"} ${state.ep != null ? idxName(state.ep) : "-"} 0 ${state.full}`;
}
function fenBoard(fen) {
  const b = new Array(64).fill(null);
  fen.split(" ")[0].split("/").forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += parseInt(ch, 10);
      else { b[r * 8 + f] = (ch === ch.toUpperCase() ? "w" : "b") + ch.toUpperCase(); f++; }
    }
  });
  return b;
}
/* Full FEN parser (turn, castling rights, en passant) — used for puzzle
   positions, which start mid-game and need real legal-move generation. */
function fenToState(fen) {
  const parts = fen.split(" ");
  const board = fenBoard(fen);
  const turn = parts[1] === "b" ? "b" : "w";
  const cs = parts[2] || "-";
  const castling = { wK: cs.includes("K"), wQ: cs.includes("Q"), bK: cs.includes("k"), bQ: cs.includes("q") };
  const ep = parts[3] && parts[3] !== "-" ? sqIdx(parts[3]) : null;
  const full = parseInt(parts[5], 10) || 1;
  return { board, turn, castling, ep, full };
}

/* ---------- SVG piece set ---------- */
function PieceSVG({ code, size = "94%" }) {
  const white = code[0] === "w";
  const fill = white ? "url(#ctgw)" : "url(#ctgb)";
  const stroke = white ? "#2E2C29" : "#000000";
  const detail = white ? "#2E2C29" : "#E8E6E1";
  const sw = 1.7;
  const common = { fill, stroke, strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" };
  const line = { fill: "none", stroke: detail, strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" };
  const t = code[1];
  return (
    <svg viewBox="0 0 45 45" style={{ width: size, height: size, filter: "drop-shadow(0 3px 3px rgba(0,0,0,.45))" }}>
      <defs>
        <linearGradient id="ctgw" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" /><stop offset="0.45" stopColor="#f2f0eb" /><stop offset="1" stopColor="#d8d5cd" />
        </linearGradient>
        <linearGradient id="ctgb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6b6660" /><stop offset="0.45" stopColor="#48443f" /><stop offset="1" stopColor="#242220" />
        </linearGradient>
      </defs>
      {t === "P" && (
        <path {...common} d="m 22.5,9 c -2.21,0 -4,1.79 -4,4 0.24,1.25 0.76,2.31 1.56,3.03 -2.98,1.05 -5.06,3.86 -5.06,7.22 0,2.03 0.94,3.84 2.41,5.03 -3,1.06 -7.41,5.55 -7.41,13.47 l 23,0 c 0,-7.92 -4.41,-12.41 -7.41,-13.47 1.47,-1.19 2.41,-3 2.41,-5.03 0,-3.36 -2.08,-6.17 -5.06,-7.22 0.8,-0.72 1.32,-1.78 1.56,-3.03 0,-2.21 -1.79,-4 -4,-4 z" />
      )}
      {t === "R" && (<g>
        <path {...common} d="M 9,39 L 36,39 L 36,36 L 9,36 L 9,39 z" />
        <path {...common} d="M 12,36 L 12,32 L 33,32 L 33,36 L 12,36 z" />
        <path {...common} d="M 11,14 L 11,9 L 15,9 L 15,11 L 20,11 L 20,9 L 25,9 L 25,11 L 30,11 L 30,9 L 34,9 L 34,14 L 11,14 z" />
        <path {...common} d="M 34,14 L 31,17 L 14,17 L 11,14 z" />
        <path {...common} d="M 31,17 L 31,29.5 L 14,29.5 L 14,17 z" />
        <path {...common} d="M 31,29.5 L 32.5,32 L 12.5,32 L 14,29.5 z" />
        <path {...line} d="M 11,14 L 34,14" />
      </g>)}
      {t === "N" && (<g>
        <path {...common} d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18" />
        <path {...common} d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10" />
        <circle cx="9.5" cy="25.5" r="0.9" fill={detail} stroke="none" />
        <ellipse cx="15" cy="15.5" rx="0.9" ry="1.4" transform="rotate(30 15 15.5)" fill={detail} stroke="none" />
      </g>)}
      {t === "B" && (<g>
        <path {...common} d="M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.646,38.99 6.677,38.97 6,38 C 7.354,36.06 9,36 9,36 z" />
        <path {...common} d="M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z" />
        <circle cx="22.5" cy="8" r="2.5" {...common} />
        <path {...line} d="M 17.5,26 L 27.5,26 M 15,30 L 30,30 M 22.5,15.5 L 22.5,20.5 M 20,18 L 25,18" />
      </g>)}
      {t === "Q" && (<g>
        {[[6,12],[14,9],[22.5,8],[31,9],[39,12]].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="2" {...common} />
        ))}
        <path {...common} d="M 9,26 C 17.5,24.5 30,24.5 36,26 L 38.5,13.5 L 31,25 L 30.7,10.9 L 25.5,24.5 L 22.5,10 L 19.5,24.5 L 14.3,10.9 L 14,25 L 6.5,13.5 L 9,26 z" />
        <path {...common} d="M 9,26 C 9,28 10.5,28 11.5,30 C 12.5,31.5 12.5,31 12,33.5 C 10.5,34.5 11,36 11,36 C 9.5,37.5 11,38.5 11,38.5 C 17.5,39.5 27.5,39.5 34,38.5 C 34,38.5 35.5,37.5 34,36 C 34,36 34.5,34.5 33,33.5 C 32.5,31 32.5,31.5 33.5,30 C 34.5,28 36,28 36,26 C 27.5,24.5 17.5,24.5 9,26 z" />
        <path {...line} d="M 11,38.5 A 35,35 1 0 0 34,38.5" />
        <path {...line} d="M 11,29 A 35,35 1 0 1 34,29" />
        <path {...line} d="M 12.5,31.5 L 32.5,31.5" />
        <path {...line} d="M 11.5,34.5 A 35,35 1 0 0 33.5,34.5" />
      </g>)}
      {t === "K" && (<g>
        <path {...line} stroke={white ? "#3C3A36" : "#E8E6E1"} d="M 22.5,11.63 L 22.5,6 M 20,8 L 25,8" strokeWidth="2" />
        <path {...common} d="M 22.5,25 C 22.5,25 27,17.5 25.5,14.5 C 25.5,14.5 24.5,12 22.5,12 C 20.5,12 19.5,14.5 19.5,14.5 C 18,17.5 22.5,25 22.5,25" />
        <path {...common} d="M 12.5,37 C 18,40.5 27,40.5 32.5,37 L 32.5,30 C 32.5,30 41.5,25.5 38.5,19.5 C 34.5,13 25,16 22.5,23.5 L 22.5,27 L 22.5,23.5 C 20,16 10.5,13 6.5,19.5 C 3.5,25.5 12.5,30 12.5,30 L 12.5,37 z" />
        <path {...line} d="M 12.5,30 C 18,27 27,27 32.5,30 M 12.5,33.5 C 18,30.5 27,30.5 32.5,33.5 M 12.5,37 C 18,34 27,34 32.5,37" />
      </g>)}
    </svg>
  );
}

/* ---------- sound (competition clock click) + voice ---------- */
let ACTX = null;
function actx() {
  if (!ACTX) ACTX = new (window.AudioContext || window.webkitAudioContext)();
  if (ACTX.state === "suspended") ACTX.resume();
  return ACTX;
}
/* A heavy, weighted piece-on-board "thock": two layered low sine sweeps
   for real bass body/mass, plus a soft, low-pitched noise transient just
   for attack definition — this is what a real felted, lead-weighted
   tournament piece sounds like against a wood board, not a light click. */
function pieceThud(gain = 0.6, when = 0, pitch = 1.0) {
  const c = actx(), t = c.currentTime + when;
  // Soft attack transient — much lower and quieter than a "click": just
  // enough definition to mark the moment of contact.
  const len = Math.floor(c.sampleRate * 0.018);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.5);
  const n = c.createBufferSource(); n.buffer = buf;
  const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 550 * pitch; bp.Q.value = 0.8;
  const ng = c.createGain();
  ng.gain.setValueAtTime(gain * 0.32, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
  n.connect(bp).connect(ng).connect(c.destination); n.start(t);
  // Primary body thump — the main "thock" of a weighted piece landing.
  const o = c.createOscillator(); o.type = "sine";
  o.frequency.setValueAtTime(120 * pitch, t);
  o.frequency.exponentialRampToValueAtTime(55 * pitch, t + 0.07);
  const og = c.createGain();
  og.gain.setValueAtTime(gain * 1.15, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
  o.connect(og).connect(c.destination); o.start(t); o.stop(t + 0.15);
  // Sub-bass layer — the felt-bottomed mass/weight underneath the thock.
  const sub = c.createOscillator(); sub.type = "sine";
  sub.frequency.setValueAtTime(68 * pitch, t);
  sub.frequency.exponentialRampToValueAtTime(36 * pitch, t + 0.1);
  const subg = c.createGain();
  subg.gain.setValueAtTime(gain * 0.8, t);
  subg.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
  sub.connect(subg).connect(c.destination); sub.start(t); sub.stop(t + 0.19);
}
function tone(freq, dur, gain, when = 0) {
  const c = actx(), t = c.currentTime + when;
  const o = c.createOscillator(), g = c.createGain();
  o.type = "sine"; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
}
function playFX(kind, enabled) {
  if (!enabled) return;
  try {
    if (kind === "move") pieceThud(0.6);
    else if (kind === "capture") { pieceThud(0.7, 0, 0.85); pieceThud(0.55, 0.07, 1.15); }
    else if (kind === "castle") { pieceThud(0.55); pieceThud(0.5, 0.16, 1.05); }
    else if (kind === "check") { pieceThud(0.6); tone(660, 0.14, 0.16, 0.03); }
    else if (kind === "win") { [440, 554, 659, 880].forEach((f, i) => tone(f, 0.18, 0.24, i * 0.13)); }
    else if (kind === "lose") { [330, 262, 196].forEach((f, i) => tone(f, 0.22, 0.24, i * 0.16)); }
    if (navigator.vibrate) navigator.vibrate(12);
  } catch (e) {}
}
function moveSound(res, statusAfter, sound) {
  if (statusAfter === "checkmate" || statusAfter === "check") playFX("check", sound);
  else if (res.castleSAN) playFX("castle", sound);
  else if (res.captured) playFX("capture", sound);
  else playFX("move", sound);
}
function speak(text, enabled) {
  if (!enabled || !window.speechSynthesis) return;
  try {
    const clean = String(text).replace(/[🧔♟📖🎓🧠💡⟲↩✓🎉🔊🗣›‹🔍⚔️📊🏳🎨🔥★]/g, "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    // Android Chrome/WebView drops the utterance if speak() fires in the same
    // tick as cancel() — a short delay avoids that race condition.
    window.speechSynthesis.cancel();
    setTimeout(() => {
      try {
        const u = new SpeechSynthesisUtterance(clean);
        u.rate = 1.02; u.pitch = 1.0;
        window.speechSynthesis.speak(u);
      } catch (e) {}
    }, 80);
  } catch (e) {}
}
/* Converts a SAN move into a short spoken phrase, e.g. "Knight takes f6, check". */
function sanSpeech(san) {
  if (!san) return "";
  if (san === "O-O") return "castles short";
  if (san === "O-O-O") return "castles long";
  let s = san.replace(/[+#]$/, "");
  const suffix = san.endsWith("#") ? ", checkmate" : san.endsWith("+") ? ", check" : "";
  const promo = s.match(/=([QRBN])$/);
  if (promo) s = s.slice(0, -2);
  const pieceNames = { N: "Knight", B: "Bishop", R: "Rook", Q: "Queen", K: "King" };
  let out = s;
  if (/^[NBRQK]/.test(out)) out = pieceNames[out[0]] + " " + out.slice(1);
  out = out.replace(/x/g, " takes ").replace(/\s+/g, " ").trim();
  if (promo) out += " promoting to " + pieceNames[promo[1]];
  return out + suffix;
}

/* ---------- persistent storage ---------- */
async function loadStore(key, fallback) {
  try {
    const r = await window.storage.get(key);
    return r && r.value ? JSON.parse(r.value) : fallback;
  } catch (e) { return fallback; }
}
async function saveStore(key, val) {
  try { await window.storage.set(key, JSON.stringify(val)); } catch (e) {}
}

/* ---------- ECO openings database ----------
   Core set embedded below (all lines up to 8 plies, from the
   Lichess chess-openings dataset). The full 3,733-line database
   is fetched live from GitHub on first run and cached. */
const ECO_EMBED = "A00\tAmar Opening\t1. Nh3\nA00\tAmar Opening: Paris Gambit\t1. Nh3 d5 2. g3 e5 3. f4\nA00\tAmsterdam Attack\t1. e3 e5 2. c4 d6 3. Nc3 Nc6 4. b3 Nf6\nA00\tAnderssen's Opening\t1. a3\nA00\tAnderssen's Opening: Polish Gambit\t1. a3 a5 2. b4\nA00\tBarnes Opening\t1. f3\nA00\tBarnes Opening: Fool's Mate\t1. f3 e5 2. g4 Qh4#\nA00\tBarnes Opening: Gedult Gambit\t1. f3 d5 2. e4 g6 3. d4 dxe4 4. c3\nA00\tBarnes Opening: Gedult Gambit\t1. f3 f5 2. e4 fxe4 3. Nc3\nA00\tBarnes Opening: Hammerschlag\t1. f3 e5 2. Kf2\nA00\tClemenz Opening\t1. h3\nA00\tClemenz Opening: Spike Lee Gambit\t1. h3 h5 2. g4\nA00\tCreepy Crawly Formation: Classical Defense\t1. h3 d5 2. a3 e5\nA00\tGlobal Opening\t1. h3 e5 2. a3\nA00\tGrob Opening\t1. g4\nA00\tGrob Opening: Alessi Gambit\t1. g4 f5\nA00\tGrob Opening: Double Grob\t1. g4 g5\nA00\tGrob Opening: Double Grob, Coca-Cola Gambit\t1. g4 g5 2. f4\nA00\tGrob Opening: Grob Gambit\t1. g4 d5 2. Bg2\nA00\tGrob Opening: Grob Gambit Declined\t1. g4 d5 2. Bg2 c6\nA00\tGrob Opening: Grob Gambit, Basman Gambit\t1. g4 d5 2. Bg2 h5 3. gxh5\nA00\tGrob Opening: Grob Gambit, Fritz Gambit\t1. g4 d5 2. Bg2 Bxg4 3. c4\nA00\tGrob Opening: Grob Gambit, Keres Gambit\t1. g4 d5 2. Bg2 e5 3. d4 exd4 4. c3\nA00\tGrob Opening: Grob Gambit, Richter-Grob Gambit\t1. g4 d5 2. Bg2 c6 3. c4 dxc4 4. b3\nA00\tGrob Opening: Keene Defense\t1. g4 d5 2. h3 e5 3. Bg2 c6\nA00\tGrob Opening: London Defense\t1. g4 e5 2. h3 Nc6\nA00\tGrob Opening: Romford Countergambit\t1. g4 d5 2. Bg2 Bxg4 3. c4 d4\nA00\tGrob Opening: Spike Attack\t1. g4 d5 2. Bg2 c6 3. g5\nA00\tGrob Opening: Spike, Hurst Attack\t1. g4 e5 2. Bg2 d5 3. c4\nA00\tGrob Opening: Zilbermints Gambit\t1. g4 d5 2. e4 dxe4 3. Nc3\nA00\tGrob Opening: Zilbermints Gambit, Schiller Defense\t1. g4 d5 2. e4 dxe4 3. Nc3 h5\nA00\tGrob Opening: Zilbermints Gambit, Zilbermints-Hartlaub Gambit\t1. g4 d5 2. e4 dxe4 3. Nc3 e5 4. d3\nA00\tHungarian Opening\t1. g3\nA00\tHungarian Opening: Bücker Gambit\t1. g3 d5 2. Bg2 e5 3. b4\nA00\tHungarian Opening: Catalan Formation\t1. g3 d5 2. Bg2 e6\nA00\tHungarian Opening: Dutch Defense\t1. g3 f5\nA00\tHungarian Opening: Indian Defense\t1. g3 Nf6\nA00\tHungarian Opening: Myers Defense\t1. g3 g5\nA00\tHungarian Opening: Pachman Gambit\t1. g3 f5 2. e4 fxe4 3. Qh5+ g6\nA00\tHungarian Opening: Reversed Alekhine\t1. g3 e5 2. Nf3\nA00\tHungarian Opening: Reversed Brooklyn Defense, Brooklyn Benko Gambit\t1. g3 e5 2. Nf3 e4 3. Ng1 Nf6 4. b4\nA00\tHungarian Opening: Reversed Modern Defense\t1. g3 d5 2. Bg2 c5\nA00\tHungarian Opening: Reversed Norwegian Defense\t1. g3 e5 2. Nf3 e4 3. Nh4\nA00\tHungarian Opening: Sicilian Invitation\t1. g3 c5\nA00\tHungarian Opening: Slav Formation\t1. g3 d5 2. Bg2 c6\nA00\tHungarian Opening: Symmetrical Variation\t1. g3 g6\nA00\tHungarian Opening: Van Kuijk Gambit\t1. g3 h5 2. Nf3 h4\nA00\tHungarian Opening: Winterberg Gambit\t1. g3 d5 2. Bg2 e5 3. c4 dxc4 4. b3\nA00\tKádas Opening\t1. h4\nA00\tKádas Opening: Beginner's Trap\t1. h4 d5 2. Rh3\nA00\tKádas Opening: Koola-Koola Variation\t1. h4 a5\nA00\tKádas Opening: Kádas Gambit\t1. h4 c5 2. b4\nA00\tKádas Opening: Kádas Gambit\t1. h4 d5 2. d4 c5 3. Nf3 cxd4 4. c3\nA00\tKádas Opening: Kádas Gambit\t1. h4 e5 2. d4 exd4 3. c3\nA00\tKádas Opening: Myers Variation\t1. h4 d5 2. d4 c5 3. e4\nA00\tKádas Opening: Schneider Gambit\t1. h4 g5\nA00\tKádas Opening: Steinbok Gambit\t1. h4 f5 2. e4 fxe4 3. d3\nA00\tLasker Simul Special\t1. g3 h5\nA00\tMieses Opening\t1. d3\nA00\tMieses Opening: Myers Spike Attack\t1. d3 g6 2. g4\nA00\tMieses Opening: Reversed Rat\t1. d3 e5\nA00\tMieses Opening: Venezolana Variation\t1. d3 c5 2. Nc3 Nc6 3. g3\nA00\tPolish Opening\t1. b4\nA00\tPolish Opening, with d5\t1. b4 d5\nA00\tPolish Opening, with d5\t1. b4 d5 2. Bb2 Nf6 3. Nf3\nA00\tPolish Opening: Baltic Defense\t1. b4 d5 2. Bb2 Bf5\nA00\tPolish Opening: Birmingham Gambit\t1. b4 c5\nA00\tPolish Opening: Bugayev Advance Variation\t1. b4 e5 2. Bb2 f6 3. b5\nA00\tPolish Opening: Bugayev Attack\t1. b4 e5 2. a3\nA00\tPolish Opening: Czech Defense\t1. b4 e5 2. Bb2 d6\nA00\tPolish Opening: Dutch Defense\t1. b4 f5\nA00\tPolish Opening: German Defense\t1. b4 d5 2. Bb2 Qd6\nA00\tPolish Opening: Grigorian Variation\t1. b4 Nc6\nA00\tPolish Opening: Karniewski Variation\t1. b4 Nh6\nA00\tPolish Opening: King's Indian Variation\t1. b4 Nf6 2. Bb2 g6\nA00\tPolish Opening: King's Indian Variation, Schiffler Attack\t1. b4 Nf6 2. Bb2 g6 3. e4\nA00\tPolish Opening: Myers Variation\t1. b4 d5 2. Bb2 c6 3. a4\nA00\tPolish Opening: Outflank Variation\t1. b4 c6\nA00\tPolish Opening: Outflank Variation, Schuehler Gambit\t1. b4 c6 2. Bb2 a5 3. b5\nA00\tPolish Opening: Queen's Indian Variation\t1. b4 e6 2. Bb2 Nf6 3. b5 b6\nA00\tPolish Opening: Queenside Defense\t1. b4 e6 2. Bb2 Nf6 3. b5 a6\nA00\tPolish Opening: Schiffler-Sokolsky Variation\t1. b4 e6 2. Bb2 Nf6 3. b5 d5 4. e3\nA00\tPolish Opening: Schuehler Gambit\t1. b4 c6 2. Bb2 a5 3. b5 cxb5 4. e4\nA00\tPolish Opening: Symmetrical Variation\t1. b4 b5\nA00\tPolish Opening: Tartakower Gambit\t1. b4 e5 2. Bb2 f6 3. e4\nA00\tPolish Opening: Wolferts Gambit\t1. b4 e5 2. Bb2 c5\nA00\tSaragossa Opening\t1. c3\nA00\tSodium Attack\t1. Na3\nA00\tSodium Attack: Chenoboskion Variation\t1. Na3 g6 2. g4\nA00\tSodium Attack: Durkin Gambit\t1. Na3 e5 2. Nc4 Nc6 3. e4 f5\nA00\tValencia Opening\t1. d3 e5 2. Nd2\nA00\tVan Geet Opening\t1. Nc3\nA00\tVan Geet Opening: Battambang Variation\t1. a3 e5 2. Nc3\nA00\tVan Geet Opening: Billockus-Johansen Gambit\t1. Nc3 e5 2. Nf3 Bc5\nA00\tVan Geet Opening: Damhaug Gambit\t1. Nc3 d5 2. f4 e5\nA00\tVan Geet Opening: Dougherty Gambit\t1. Nc3 d5 2. e4 dxe4 3. f3\nA00\tVan Geet Opening: Dunst-Perrenet Gambit\t1. Nc3 d5 2. e4 dxe4 3. d3\nA00\tVan Geet Opening: Düsseldorf Gambit\t1. Nc3 c5 2. b4\nA00\tVan Geet Opening: Gladbacher Gambit\t1. Nc3 e5 2. b3 d5 3. e4 dxe4 4. d3\nA00\tVan Geet Opening: Hector Gambit\t1. Nc3 d5 2. e4 dxe4 3. Bc4\nA00\tVan Geet Opening: Hergert Gambit\t1. Nc3 d6 2. f4 e5 3. fxe5 Nc6\nA00\tVan Geet Opening: Hulsemann Gambit\t1. Nc3 e5 2. e3 d5 3. Qh5 Be6\nA00\tVan Geet Opening: Kluever Gambit\t1. Nc3 f5 2. e4 fxe4 3. d3\nA00\tVan Geet Opening: Laroche Gambit\t1. Nc3 b5\nA00\tVan Geet Opening: Liebig Gambit\t1. Nc3 e5 2. e3 d5 3. Qh5 Nf6\nA00\tVan Geet Opening: Melleby Gambit\t1. Nc3 d5 2. f4 d4 3. Ne4 c5\nA00\tVan Geet Opening: Myers Attack\t1. Nc3 g6 2. h4\nA00\tVan Geet Opening: Napoleon Attack\t1. Nc3 e5 2. Nf3 Nc6 3. d4\nA00\tVan Geet Opening: Novosibirsk Variation\t1. Nc3 c5 2. d4 cxd4 3. Qxd4 Nc6 4. Qh4\nA00\tVan Geet Opening: Nowokunski Gambit\t1. Nc3 e5 2. f4 exf4 3. e4\nA00\tVan Geet Opening: Pfeiffer Gambit\t1. Nc3 d5 2. f4 d4 3. Ne4 e5\nA00\tVan Geet Opening: Pfeiffer Gambit, Sleipnir Countergambit\t1. Nc3 d5 2. f4 d4 3. Ne4 e5 4. Nf3\nA00\tVan Geet Opening: Reversed Nimzowitsch\t1. Nc3 e5\nA00\tVan Geet Opening: Reversed Scandinavian\t1. Nc3 e5 2. d4 exd4 3. Qxd4 Nc6 4. Qa4\nA00\tVan Geet Opening: Sicilian Two Knights\t1. Nc3 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4\nA00\tVan Geet Opening: Sleipnir Gambit\t1. Nc3 d5 2. e3 e5 3. d4 Bb4\nA00\tVan Geet Opening: Twyble Attack\t1. Nc3 c5 2. Rb1\nA00\tVan Geet Opening: Tübingen Gambit\t1. Nc3 Nf6 2. g4\nA00\tVan Geet Opening: Venezolana Variation\t1. Nc3 d5 2. d3 Nf6 3. g3\nA00\tVan Geet Opening: Warsteiner Gambit\t1. Nc3 d5 2. f4 g5\nA00\tVan't Kruijs Opening\t1. e3\nA00\tVan't Kruijs Opening: Bouncing Bishop Variation\t1. e3 e5 2. Bc4 b5 3. Bb3\nA00\tVan't Kruijs Opening: Keoni-Hiva Gambit, Akahi Variation\t1. e3 e5 2. Nc3 Nf6 3. f4 exf4 4. Nf3\nA00\tVan't Kruijs Opening: Keoni-Hiva Gambit, Alua Variation\t1. e3 e5 2. Nc3 Nc6 3. f4 exf4 4. Nf3\nA00\tVan't Kruijs Opening: Keoni-Hiva Gambit, Ekolu Variation\t1. e3 e5 2. Nc3 d5 3. f4 exf4 4. Nf3\nA00\tWare Opening\t1. a4\nA00\tWare Opening: Cologne Gambit\t1. a4 b6 2. d4 d5 3. Nc3 Nd7\nA00\tWare Opening: Crab Variation\t1. a4 e5 2. h4\nA00\tWare Opening: Meadow Hay Trap\t1. a4 e5 2. Ra3\nA00\tWare Opening: Symmetric Variation\t1. a4 a5\nA00\tWare Opening: Ware Gambit\t1. a4 e5 2. a5 d5 3. e3 f5 4. a6\nA00\tWare Opening: Wing Gambit\t1. a4 b5 2. axb5 Bb7\nA01\tNimzo-Larsen Attack\t1. b3\nA01\tNimzo-Larsen Attack: Classical Variation\t1. b3 d5\nA01\tNimzo-Larsen Attack: Dutch Variation\t1. b3 f5\nA01\tNimzo-Larsen Attack: English Variation\t1. b3 c5\nA01\tNimzo-Larsen Attack: Graz Attack\t1. b3 d5 2. Ba3\nA01\tNimzo-Larsen Attack: Indian Variation\t1. b3 Nf6\nA01\tNimzo-Larsen Attack: Modern Variation\t1. b3 e5\nA01\tNimzo-Larsen Attack: Modern Variation\t1. b3 e5 2. Bb2 Nc6\nA01\tNimzo-Larsen Attack: Modern Variation\t1. b3 e5 2. Bb2 Nc6 3. e3\nA01\tNimzo-Larsen Attack: Modern Variation\t1. b3 e5 2. Bb2 Nc6 3. c4 Nf6\nA01\tNimzo-Larsen Attack: Pachman Gambit\t1. b3 e5 2. Bb2 Nc6 3. f4\nA01\tNimzo-Larsen Attack: Polish Variation\t1. b3 b5\nA01\tNimzo-Larsen Attack: Ringelbach Gambit\t1. b3 f5 2. Bb2 e6 3. e4\nA01\tNimzo-Larsen Attack: Spike Variation\t1. b3 Nf6 2. Bb2 g6 3. g4\nA01\tNimzo-Larsen Attack: Symmetrical Variation\t1. b3 b6\nA02\tBird Opening\t1. f4\nA02\tBird Opening: Batavo-Polish Attack\t1. f4 Nf6 2. Nf3 g6 3. b4\nA02\tBird Opening: Double Duck Formation\t1. f4 f5 2. d4 d5\nA02\tBird Opening: From's Gambit\t1. f4 e5\nA02\tBird Opening: From's Gambit, Bahr Gambit\t1. f4 e5 2. Nc3\nA02\tBird Opening: From's Gambit, Langheld Gambit\t1. f4 e5 2. fxe5 d6 3. exd6 Nf6\nA02\tBird Opening: From's Gambit, Lasker Variation\t1. f4 e5 2. fxe5 d6 3. exd6 Bxd6 4. Nf3 g5\nA02\tBird Opening: Hobbs Gambit\t1. f4 g5\nA02\tBird Opening: Hobbs-Zilbermints Gambit\t1. f4 h6 2. Nf3 g5\nA02\tBird Opening: Horsefly Defense\t1. f4 Nh6\nA02\tBird Opening: Lasker Gambit\t1. f4 e5 2. fxe5 f6\nA02\tBird Opening: Mujannah\t1. f4 Nf6 2. c4\nA02\tBird Opening: Myers Defense\t1. f4 b5\nA02\tBird Opening: Platz Gambit\t1. f4 e5 2. fxe5 Ne7\nA02\tBird Opening: Schlechter Gambit\t1. f4 e5 2. fxe5 Nc6\nA02\tBird Opening: Siegener Gambit\t1. f4 e5 2. d4 exd4 3. Nf3 c5 4. c3\nA02\tBird Opening: Swiss Gambit\t1. f4 f5 2. e4 fxe4 3. Nc3 Nf6 4. g4\nA02\tBird Opening: Wagner-Zwitersch Gambit\t1. f4 f5 2. e4\nA03\tBird Opening: Dutch Variation\t1. f4 d5\nA03\tBird Opening: Dutch Variation, Dudweiler Gambit\t1. f4 d5 2. g4\nA03\tBird Opening: Lasker Variation\t1. f4 d5 2. Nf3 Nf6 3. e3 c5\nA03\tBird Opening: Sturm Gambit\t1. f4 d5 2. c4\nA03\tBird Opening: Williams Gambit\t1. f4 d5 2. e4\nA03\tBird Opening: Williams Gambit\t1. f4 d5 2. e4 dxe4 3. Nc3 Nf6 4. Qe2\nA03\tBird Opening: Williams-Zilbermints Gambit\t1. f4 d5 2. e4 dxe4 3. Nc3 Nf6 4. Nge2\nA04\tColle System: Rhamphorhynchus Variation\t1. Nf3 c5 2. e3 g6 3. d4 Bg7 4. dxc5 Qa5+\nA04\tModern Defense: Semi-Averbakh Variation, Polish Variation\t1. Nf3 c5 2. c4 g6 3. d4 Bg7 4. e4 Qb6\nA04\tModern Defense: Semi-Averbakh Variation, Pterodactyl Variation\t1. Nf3 c5 2. c4 g6 3. d4 Bg7 4. e4 Qa5+\nA04\tZukertort Defense: Kingside Variation\t1. Nf3 Nh6 2. d4 g6\nA04\tZukertort Defense: Sicilian Knight Variation\t1. Nf3 Na6 2. e4 c5\nA04\tZukertort Opening\t1. Nf3\nA04\tZukertort Opening: Arctic Defense\t1. Nf3 f6\nA04\tZukertort Opening: Arctic Defense, Drunken Knight Variation\t1. Nf3 f6 2. e4 Nh6 3. d4 Nf7\nA04\tZukertort Opening: Basman Defense\t1. Nf3 h6\nA04\tZukertort Opening: Black Mustang Defense\t1. Nf3 Nc6\nA04\tZukertort Opening: Drunken Cavalry Variation\t1. Nf3 Na6 2. e4 Nh6\nA04\tZukertort Opening: Dutch Variation\t1. Nf3 f5\nA04\tZukertort Opening: Herrstrom Gambit\t1. Nf3 g5\nA04\tZukertort Opening: Kingside Fianchetto\t1. Nf3 g6\nA04\tZukertort Opening: Lisitsyn Gambit\t1. Nf3 f5 2. e4\nA04\tZukertort Opening: Lisitsyn Gambit Deferred\t1. Nf3 f5 2. d3 Nf6 3. e4\nA04\tZukertort Opening: Pirc Invitation\t1. Nf3 d6\nA04\tZukertort Opening: Polish Defense\t1. Nf3 b5\nA04\tZukertort Opening: Queen's Gambit Invitation\t1. Nf3 e6\nA04\tZukertort Opening: Queenside Fianchetto Variation\t1. Nf3 b6\nA04\tZukertort Opening: Ross Gambit\t1. Nf3 e5\nA04\tZukertort Opening: Shabalov Gambit\t1. Nf3 e6 2. c4 a6 3. Nc3 c5 4. g3 b5\nA04\tZukertort Opening: Sicilian Invitation\t1. Nf3 c5\nA04\tZukertort Opening: Slav Invitation\t1. Nf3 c6\nA04\tZukertort Opening: Speelsmet Gambit\t1. Nf3 c5 2. d4 cxd4 3. e3\nA04\tZukertort Opening: St. George Defense\t1. Nf3 a6\nA04\tZukertort Opening: The Walrus\t1. Nf3 e5 2. Nxe5 Nc6 3. Nxc6 dxc6\nA04\tZukertort Opening: Vos Gambit\t1. Nf3 d6 2. d4 e5\nA04\tZukertort Opening: Wade Defense\t1. Nf3 d6 2. e4 Bg4\nA04\tZukertort Opening: Ware Defense\t1. Nf3 a5\nA05\tKing's Indian Attack\t1. Nf3 Nf6 2. g3 d5\nA05\tKing's Indian Attack: Smyslov Variation\t1. Nf3 Nf6 2. g3 g6 3. b4\nA05\tKing's Indian Attack: Spassky Variation\t1. Nf3 Nf6 2. g3 b5\nA05\tKing's Indian Attack: Symmetrical Defense\t1. Nf3 Nf6 2. g3 g6\nA05\tPolish Opening: Zukertort System\t1. Nf3 Nf6 2. b4 g6 3. Bb2\nA05\tZukertort Opening\t1. Nf3 Nf6\nA05\tZukertort Opening\t1. Nf3 Nf6 2. Nc3 Nc6\nA05\tZukertort Opening: Lemberger Gambit\t1. Nf3 Nf6 2. e4\nA05\tZukertort Opening: Myers Polish Attack\t1. Nf3 Nf6 2. a4 g6 3. b4\nA05\tZukertort Opening: Nimzo-Larsen Variation\t1. Nf3 Nf6 2. b3\nA05\tZukertort Opening: Quiet System\t1. Nf3 Nf6 2. e3\nA06\tNimzo-Larsen Attack: Classical Variation\t1. Nf3 d5 2. b3\nA06\tNimzo-Larsen Attack: Norfolk Gambit\t1. Nf3 d5 2. b3 c5 3. e4\nA06\tNimzo-Larsen Attack: Norfolk Gambit\t1. Nf3 d5 2. b3 Nf6 3. Bb2 c5 4. e4\nA06\tZukertort Opening\t1. Nf3 d5\nA06\tZukertort Opening: Ampel Variation\t1. Nf3 d5 2. Rg1\nA06\tZukertort Opening: Old Indian Attack\t1. Nf3 d5 2. d3\nA06\tZukertort Opening: Pachman Gambit\t1. Nf3 d5 2. e3 c5 3. c4 dxc4 4. b3\nA06\tZukertort Opening: Regina-Nu Gambit\t1. Nf3 d5 2. b3 c5 3. c4 dxc4 4. Nc3\nA06\tZukertort Opening: Reversed Mexican Defense\t1. Nf3 d5 2. Nc3\nA06\tZukertort Opening: Santasiere's Folly\t1. b4 d5 2. Nf3\nA06\tZukertort Opening: Tennison Gambit\t1. e4 d5 2. Nf3\nA06\tZukertort Opening: The Potato\t1. Nf3 d5 2. a4\nA07\tHungarian Opening: Wiedenhagen-Beta Gambit\t1. g3 d5 2. Nf3 g5\nA07\tKing's Indian Attack\t1. Nf3 d5 2. g3\nA07\tKing's Indian Attack, with Bf5\t1. Nf3 Nf6 2. g3 d5 3. Bg2 c6 4. O-O Bf5\nA07\tKing's Indian Attack, with e6\t1. Nf3 Nf6 2. g3 d5 3. Bg2 e6\nA07\tKing's Indian Attack, with e6\t1. Nf3 Nf6 2. g3 d5 3. Bg2 e6 4. O-O Be7\nA07\tKing's Indian Attack: Double Fianchetto\t1. Nf3 d5 2. g3 g6\nA07\tKing's Indian Attack: Keres Variation\t1. Nf3 d5 2. g3 Bg4\nA07\tKing's Indian Attack: Keres Variation\t1. Nf3 d5 2. g3 Bg4 3. Bg2 Nd7\nA07\tKing's Indian Attack: Keres Variation\t1. Nf3 d5 2. g3 c6 3. Bg2 Bg4 4. O-O Nd7\nA07\tKing's Indian Attack: Omega-Delta Gambit\t1. Nf3 d5 2. g3 e5\nA07\tKing's Indian Attack: Sicilian Variation\t1. Nf3 d5 2. g3 c5\nA07\tKing's Indian Attack: Yugoslav Variation\t1. Nf3 Nf6 2. g3 d5 3. Bg2 c6 4. O-O Bg4\nA08\tKing's Indian Attack: French Variation\t1. Nf3 d5 2. g3 c5 3. Bg2 Nc6\nA08\tKing's Indian Attack: Sicilian Variation\t1. Nf3 d5 2. g3 c5 3. Bg2\nA08\tZukertort Opening: Reversed Grünfeld\t1. Nf3 d5 2. g3 c5 3. Bg2 Nc6 4. d4\nA08\tZukertort Opening: Reversed Grünfeld\t1. Nf3 d5 2. g3 c5 3. Bg2 Nc6 4. d4 Nf6\nA09\tRéti Opening\t1. Nf3 d5 2. c4\nA09\tRéti Opening: Advance Variation\t1. Nf3 d5 2. c4 d4\nA09\tRéti Opening: Advance Variation, Michel Gambit\t1. Nf3 d5 2. c4 d4 3. b4 c5\nA09\tRéti Opening: Advance Variation, Navara Gambit\t1. Nf3 d5 2. c4 d4 3. b4 g5\nA09\tRéti Opening: Penguin Variation\t1. Nf3 d5 2. c4 d4 3. Rg1\nA09\tRéti Opening: Reversed Blumenfeld Gambit\t1. Nf3 d5 2. c4 d4 3. e3 c5 4. b4\nA09\tRéti Opening: Réti Accepted\t1. Nf3 d5 2. c4 dxc4\nA09\tRéti Opening: Réti Gambit, Keres Variation\t1. Nf3 d5 2. c4 dxc4 3. e3 Be6\nA09\tRéti Opening: Zilbermints Gambit\t1. Nf3 d5 2. c4 b5\nA10\tEnglish Opening\t1. c4\nA10\tEnglish Opening: Achilles-Omega Gambit\t1. c4 Nf6 2. e4\nA10\tEnglish Opening: Adorjan Defense\t1. c4 g6 2. e4 e5\nA10\tEnglish Opening: Anglo-Dutch Defense\t1. c4 f5\nA10\tEnglish Opening: Anglo-Dutch Defense, Hickmann Gambit\t1. c4 f5 2. e4\nA10\tEnglish Opening: Anglo-Dutch Variation, Chabanon Gambit\t1. c4 f5 2. Nf3 d6 3. e4\nA10\tEnglish Opening: Anglo-Dutch Variation, Ferenc Gambit\t1. c4 f5 2. Nc3 Nf6 3. e4\nA10\tEnglish Opening: Anglo-Lithuanian Variation\t1. c4 Nc6\nA10\tEnglish Opening: Anglo-Scandinavian Defense\t1. c4 d5\nA10\tEnglish Opening: Anglo-Scandinavian Defense, Löhn Gambit\t1. c4 d5 2. cxd5 e6\nA10\tEnglish Opening: Anglo-Scandinavian Defense, Malvinas Variation\t1. c4 d5 2. cxd5 Qxd5 3. Nc3 Qa5\nA10\tEnglish Opening: Anglo-Scandinavian Defense, Schulz Gambit\t1. c4 d5 2. cxd5 Nf6\nA10\tEnglish Opening: Great Snake Variation\t1. c4 g6\nA10\tEnglish Opening: Jaenisch Gambit\t1. c4 b5\nA10\tEnglish Opening: Myers Defense\t1. c4 g5\nA10\tEnglish Opening: Myers Gambit\t1. c4 g5 2. d4 Bg7\nA10\tEnglish Opening: Porcupine Variation\t1. c4 f5 2. Nc3 Nf6 3. e4 fxe4 4. g4\nA10\tEnglish Opening: Wade Gambit\t1. c4 f5 2. g4\nA10\tEnglish Opening: Zilbermints Gambit\t1. c4 g5 2. d4 e5\nA11\tEnglish Opening: Caro-Kann Defensive System\t1. c4 c6\nA11\tRéti Opening: Anglo-Slav Variation, Gurevich System\t1. c4 c6 2. Nf3 d5 3. e3\nA11\tRéti Opening: Anglo-Slav Variation, Gurevich System\t1. c4 c6 2. Nf3 d5 3. e3 Nf6 4. Qc2\nA11\tRéti Opening: Anglo-Slav Variation, with g3\t1. c4 c6 2. Nf3 d5 3. g3 Nf6 4. b3 g6\nA11\tRéti Opening: Anglo-Slav Variation, with g3\t1. c4 c6 2. Nf3 d5 3. g3 Nf6 4. Bg2\nA11\tRéti Opening: Anglo-Slav Variation, with g3\t1. c4 c6 2. Nf3 d5 3. g3 Nf6 4. Bg2 dxc4\nA11\tRéti Opening: Anglo-Slav Variation, with g3\t1. c4 c6 2. Nf3 d5 3. g3 Nf6 4. Bg2 Bf5\nA12\tRéti Opening: Anglo-Slav Variation\t1. c4 Nf6 2. g3 c6 3. Nf3 d5 4. b3\nA12\tRéti Opening: Anglo-Slav Variation, Bled Variation\t1. Nf3 d5 2. b3 Nf6 3. Bb2 g6 4. c4 c6\nA12\tRéti Opening: Anglo-Slav Variation, Bogoljubow Variation\t1. Nf3 d5 2. c4 c6 3. b3\nA12\tRéti Opening: Anglo-Slav Variation, Bogoljubow Variation\t1. Nf3 d5 2. c4 c6 3. b3 Bg4\nA12\tRéti Opening: Anglo-Slav Variation, Bogoljubow Variation\t1. Nf3 d5 2. c4 c6 3. b3 Bf5\nA12\tRéti Opening: Anglo-Slav Variation, Bogoljubow Variation\t1. Nf3 d5 2. c4 c6 3. b3 Bf5 4. Bb2\nA12\tRéti Opening: Anglo-Slav Variation, Capablanca Variation\t1. c4 Nf6 2. Nf3 c6 3. b3 d5 4. Bb2 Bg4\nA12\tRéti Opening: Anglo-Slav Variation, London Defensive System\t1. c4 Nf6 2. g3 c6 3. Nf3 d5 4. b3 Bf5\nA12\tRéti Opening: Anglo-Slav Variation, New York System\t1. Nf3 Nf6 2. c4 c6 3. b3 d5 4. Bb2 Bf5\nA12\tRéti Opening: Anglo-Slav Variation, Torre System\t1. c4 Nf6 2. g3 c6 3. Nf3 d5 4. b3 Bg4\nA12\tRéti Opening: Anglo-Slav Variation, with dxc4\t1. c4 Nf6 2. g3 c6 3. Nf3 d5 4. b3 dxc4\nA13\tEnglish Opening: Agincourt Defense\t1. c4 e6\nA13\tEnglish Opening: Agincourt Defense\t1. c4 e6 2. Nf3\nA13\tEnglish Opening: Agincourt Defense\t1. c4 e6 2. Nf3 d5\nA13\tEnglish Opening: Agincourt Defense, Bogoljubow Defense\t1. c4 e6 2. Nf3 d5 3. g3 Nf6 4. Bg2 Bd6\nA13\tEnglish Opening: Agincourt Defense, Catalan Defense\t1. c4 e6 2. Nf3 d5 3. g3 c5\nA13\tEnglish Opening: Agincourt Defense, Catalan Defense Accepted\t1. c4 e6 2. Nf3 Nf6 3. g3 d5 4. Bg2 dxc4\nA13\tEnglish Opening: Agincourt Defense, Catalan Defense, Semi-Slav Defense\t1. c4 e6 2. Nf3 Nf6 3. g3 d5 4. Bg2 c6\nA13\tEnglish Opening: Agincourt Defense, Kurajica Defense\t1. c4 e6 2. Nf3 d5 3. g3 c6\nA13\tEnglish Opening: Neo-Catalan\t1. c4 e6 2. Nf3 d5 3. g3 Nf6\nA13\tEnglish Opening: Neo-Catalan Declined\t1. c4 e6 2. Nf3 d5 3. g3 Nf6 4. Bg2 Be7\nA13\tEnglish Opening: Romanishin Gambit\t1. c4 Nf6 2. Nf3 e6 3. g3 a6 4. Bg2 b5\nA15\tEnglish Opening: Anglo-Indian Defense\t1. c4 Nf6\nA15\tEnglish Opening: Anglo-Indian Defense, Anti-Anti-Grünfeld\t1. c4 Nf6 2. Nc3 g6 3. Nf3 Bg7 4. e4\nA15\tEnglish Opening: Anglo-Indian Defense, Grünfeld Formation\t1. c4 Nf6 2. Nf3 g6 3. g3 d5\nA15\tEnglish Opening: Anglo-Indian Defense, King's Indian Formation\t1. c4 Nf6 2. Nf3 g6\nA15\tEnglish Opening: Anglo-Indian Defense, King's Indian Formation, Double Fianchetto\t1. c4 Nf6 2. Nf3 g6 3. g3 b6 4. Bg2 Bb7\nA15\tEnglish Opening: Anglo-Indian Defense, King's Knight Variation\t1. c4 Nf6 2. Nf3\nA15\tEnglish Opening: Anglo-Indian Defense, Old Indian Formation\t1. c4 Nf6 2. Nf3 d6\nA15\tEnglish Opening: Anglo-Indian Defense, Queen's Indian Formation\t1. c4 Nf6 2. Nf3 b6\nA15\tEnglish Opening: Anglo-Indian Defense, Queen's Indian Formation\t1. c4 e6 2. Nf3 Nf6 3. g3 b6 4. Bg2 Bb7\nA15\tEnglish Opening: Anglo-Indian Defense, Romanishin Variation\t1. c4 e6 2. Nf3 Nf6 3. g3 a6\nA15\tEnglish Opening: Anglo-Indian Defense, Scandinavian Defense\t1. c4 Nf6 2. Nf3 d5\nA15\tEnglish Opening: Anglo-Indian Defense, Scandinavian Defense, Exchange Variation\t1. c4 Nf6 2. Nf3 d5 3. cxd5 Nxd5\nA15\tEnglish Opening: Anglo-Indian Defense, Slav Formation\t1. c4 Nf6 2. Nf3 g6 3. g3 c6\nA15\tEnglish Orangutan\t1. c4 Nf6 2. b4\nA15\tEnglish Orangutan\t1. c4 Nf6 2. Nf3 g6 3. b4\nA16\tEnglish Opening: Anglo-Grünfeld Defense\t1. c4 Nf6 2. Nc3 d5\nA16\tEnglish Opening: Anglo-Indian Defense, Anglo-Grünfeld Variation\t1. c4 Nf6 2. Nc3 d5 3. cxd5 Nxd5 4. Nf3\nA16\tEnglish Opening: Anglo-Indian Defense, Anglo-Grünfeld Variation\t1. c4 Nf6 2. Nc3 d5 3. cxd5 Nxd5 4. Nf3 g6\nA16\tEnglish Opening: Anglo-Indian Defense, Queen's Knight Variation\t1. c4 Nf6 2. Nc3\nA17\tEnglish Opening: Anglo-Indian Defense, Hedgehog System\t1. c4 Nf6 2. Nc3 e6\nA17\tEnglish Opening: Anglo-Indian Defense, Nimzo-English\t1. c4 Nf6 2. Nc3 e6 3. Nf3 Bb4\nA17\tEnglish Opening: Anglo-Indian Defense, Queen's Indian Formation\t1. c4 e6 2. Nc3 Nf6 3. Nf3 b6\nA17\tEnglish Opening: Anglo-Indian Defense, Zvjaginsev-Krasenkow Attack\t1. c4 e6 2. Nc3 Nf6 3. Nf3 Bb4 4. g4\nA18\tEnglish Opening: Mikenas-Carls Variation\t1. c4 e6 2. Nc3 Nf6 3. e4\nA18\tEnglish Opening: Mikenas-Carls Variation\t1. c4 e6 2. Nc3 Nf6 3. e4 Nc6\nA18\tEnglish Opening: Mikenas-Carls Variation\t1. c4 e6 2. Nc3 Nf6 3. e4 d5 4. e5\nA19\tEnglish Opening: Anglo-Indian Defense, Flohr-Mikenas-Carls Variation, Nei Gambit\t1. c4 e6 2. Nc3 Nf6 3. e4 c5 4. e5 Ng8\nA19\tEnglish Opening: Mikenas-Carls, Sicilian\t1. c4 e6 2. Nc3 Nf6 3. e4 c5\nA20\tEnglish Opening: Drill Variation\t1. c4 e5 2. g3 h5\nA20\tEnglish Opening: King's English Variation\t1. c4 e5\nA20\tEnglish Opening: King's English Variation, Kahiko-Hula Gambit\t1. c4 e5 2. e3 Nf6 3. f4 exf4 4. Nf3\nA20\tEnglish Opening: King's English Variation, Nimzowitsch Variation\t1. c4 e5 2. Nf3\nA20\tEnglish Opening: King's English Variation, Nimzowitsch-Flohr Variation\t1. c4 e5 2. Nf3 e4\nA21\tEnglish Opening: King's English Variation\t1. c4 e5 2. Nc3 d6 3. Nf3\nA21\tEnglish Opening: King's English Variation, Keres Defense\t1. c4 e5 2. Nc3 d6 3. g3 c6\nA21\tEnglish Opening: King's English Variation, Kramnik-Shirov Counterattack\t1. c4 e5 2. Nc3 Bb4\nA21\tEnglish Opening: King's English Variation, Reversed Sicilian\t1. c4 e5 2. Nc3\nA21\tEnglish Opening: King's English Variation, Smyslov Defense\t1. c4 e5 2. Nc3 d6 3. Nf3 Bg4\nA21\tEnglish Opening: King's English Variation, Troger Defense\t1. c4 e5 2. Nc3 Nc6 3. g3 d6 4. Bg2 Be6\nA22\tEnglish Opening: Carls-Bremen System\t1. c4 e5 2. Nc3 Nf6 3. g3\nA22\tEnglish Opening: King's English Variation, Adhiban Gambit\t1. c4 e5 2. Nc3 Nf6 3. Nf3 e4 4. Ng5 c6\nA22\tEnglish Opening: King's English Variation, Bellon Gambit\t1. c4 e5 2. Nc3 Nf6 3. Nf3 e4 4. Ng5 b5\nA22\tEnglish Opening: King's English Variation, Two Knights Variation\t1. c4 e5 2. Nc3 Nf6\nA22\tEnglish Opening: King's English Variation, Two Knights Variation, Reversed Dragon\t1. c4 e5 2. Nc3 Nf6 3. g3 d5\nA22\tEnglish Opening: King's English Variation, Two Knights Variation, Smyslov System\t1. c4 e5 2. Nc3 Nf6 3. g3 Bb4\nA22\tEnglish Opening: King's English, Erbenheimer Gambit\t1. c4 e5 2. Nc3 Nf6 3. Nf3 e4 4. Ng5 Ng4\nA22\tEnglish Opening: King's English, Mazedonisch\t1. c4 e5 2. Nc3 Nf6 3. f4\nA23\tEnglish Opening: King's English Variation, Two Knights Variation, Keres Variation\t1. c4 e5 2. Nc3 Nf6 3. g3 c6\nA23\tEnglish Opening: King's English Variation, Two Knights Variation, Keres Variation\t1. c4 e5 2. Nc3 Nf6 3. g3 Bc5 4. Bg2 c6\nA24\tEnglish Opening: King's English Variation, Two Knights Variation, Fianchetto Line\t1. c4 e5 2. Nc3 Nf6 3. g3 g6\nA25\tEnglish Opening: King's English Variation, Reversed Closed Sicilian\t1. c4 e5 2. Nc3 Nc6\nA25\tEnglish Opening: King's English Variation, Taimanov Variation\t1. c4 e5 2. Nc3 Nc6 3. g3 g6 4. Bg2 Bg7\nA27\tEnglish Opening: King's English Variation, Three Knights System\t1. c4 e5 2. Nc3 Nc6 3. Nf3\nA28\tEnglish Opening: Four Knights System, Nimzowitsch Variation\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6 4. e4\nA28\tEnglish Opening: King's English Variation, Four Knights Variation\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6\nA28\tEnglish Opening: King's English Variation, Four Knights Variation, Bradley Beach Variation\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6 4. d4 e4\nA28\tEnglish Opening: King's English Variation, Four Knights Variation, Flexible Line\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6 4. d3\nA28\tEnglish Opening: King's English Variation, Four Knights Variation, Korchnoi Line\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6 4. a3\nA28\tEnglish Opening: King's English Variation, Four Knights Variation, Quiet Line\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6 4. e3\nA29\tEnglish Opening: King's English Variation, Four Knights Variation, Fianchetto Line\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6 4. g3\nA30\tEnglish Opening: Symmetrical Variation\t1. c4 c5\nA30\tEnglish Opening: Symmetrical Variation\t1. c4 c5 2. Nf3\nA30\tEnglish Opening: Symmetrical Variation, Napolitano Gambit\t1. c4 c5 2. Nf3 Nf6 3. b4\nA30\tEnglish Opening: Wing Gambit\t1. c4 c5 2. b4\nA31\tEnglish Opening: Symmetrical Variation, Anti-Benoni Variation\t1. c4 Nf6 2. d4 c5 3. Nf3\nA32\tEnglish Opening: Symmetrical Variation, Anti-Benoni Variation, Spielmann Defense\t1. c4 e6 2. d4 c5 3. Nf3 cxd4 4. Nxd4 Nf6\nA34\tEnglish Opening: Symmetrical Variation, Fianchetto Variation\t1. c4 Nf6 2. Nc3 c5 3. g3\nA34\tEnglish Opening: Symmetrical Variation, Normal Variation\t1. c4 c5 2. Nc3\nA34\tEnglish Opening: Symmetrical Variation, Three Knights Variation\t1. c4 c5 2. Nc3 Nf6 3. Nf3\nA35\tEnglish Opening: Symmetrical Variation\t1. c4 c5 2. Nc3 Nf6 3. Nf3 e5\nA35\tEnglish Opening: Symmetrical Variation, Four Knights Variation\t1. c4 Nf6 2. Nf3 c5 3. Nc3 Nc6\nA35\tEnglish Opening: Symmetrical Variation, Two Knights Variation\t1. c4 c5 2. Nc3 Nc6\nA36\tEnglish Opening: Symmetrical Variation, Two Knights, Fianchetto Variation\t1. c4 c5 2. Nc3 Nc6 3. g3\nA36\tEnglish Opening: Symmetrical Variation, Ultra-Symmetrical Variation\t1. c4 c5 2. g3 g6 3. Bg2 Bg7 4. Nc3 Nc6\nA40\tAustralian Defense\t1. d4 Na6\nA40\tBorg Defense: Borg Gambit\t1. d4 g5\nA40\tColle System: Pterodactyl Variation\t1. d4 g6 2. Nf3 Bg7 3. e3 c5 4. Bd3 Qa5+\nA40\tEnglish Defense\t1. d4 b6\nA40\tEnglish Defense\t1. d4 e6 2. c4 b6\nA40\tEnglish Defense: Eastbourne Gambit\t1. d4 b6 2. c4 Bb7 3. Nc3 e5\nA40\tEnglish Defense: Perrin Variation\t1. d4 e6 2. c4 b6 3. e4 Bb7 4. Bd3 Nc6\nA40\tEnglund Gambit\t1. d4 e5\nA40\tEnglund Gambit Declined\t1. d4 e5 2. d5\nA40\tEnglund Gambit Declined: Diemer Counterattack\t1. d4 e5 2. d5 Bc5 3. e4 Qh4\nA40\tEnglund Gambit Declined: Reversed Alekhine\t1. d4 e5 2. Nf3\nA40\tEnglund Gambit Declined: Reversed Brooklyn\t1. d4 e5 2. Nf3 e4 3. Ng1\nA40\tEnglund Gambit Declined: Reversed French\t1. d4 e5 2. e3\nA40\tEnglund Gambit Declined: Reversed Krebs\t1. d4 e5 2. Nf3 e4\nA40\tEnglund Gambit Declined: Reversed Mokele Mbembe\t1. d4 e5 2. Nf3 e4 3. Ne5\nA40\tEnglund Gambit: Felbecker Gambit\t1. d4 e5 2. dxe5 Nc6 3. Nf3 Bc5\nA40\tEnglund Gambit: Hartlaub-Charlick Gambit\t1. d4 e5 2. dxe5 d6\nA40\tEnglund Gambit: Main Line\t1. d4 e5 2. dxe5 Nc6 3. Nf3 Qe7\nA40\tEnglund Gambit: Mosquito Gambit\t1. d4 e5 2. dxe5 Qh4\nA40\tEnglund Gambit: Soller Gambit\t1. d4 e5 2. dxe5 f6\nA40\tEnglund Gambit: Soller Gambit Deferred\t1. d4 e5 2. dxe5 Nc6 3. Nf3 f6\nA40\tEnglund Gambit: Stockholm Variation\t1. d4 e5 2. dxe5 Nc6 3. Nf3 Qe7 4. Qd5\nA40\tEnglund Gambit: Zilbermints Gambit\t1. d4 e5 2. dxe5 Nc6 3. Nf3 Nge7\nA40\tHorwitz Defense\t1. d4 e6\nA40\tHorwitz Defense: Zilbermints Gambit\t1. d4 e6 2. c4 e5\nA40\tKangaroo Defense\t1. d4 e6 2. c4 Bb4+\nA40\tKangaroo Defense: Keres Defense, Transpositional Variation\t1. d4 e6 2. c4 Bb4+ 3. Nc3\nA40\tMikenas Defense\t1. d4 Nc6\nA40\tMikenas Defense: Cannstatter Variation\t1. d4 Nc6 2. c4 e5 3. d5 Nd4\nA40\tMikenas Defense: Lithuanian Variation\t1. d4 Nc6 2. c4 e5 3. d5 Nce7\nA40\tMikenas Defense: Pozarek Gambit\t1. d4 Nc6 2. c4 e5 3. dxe5 Nxe5 4. Nc3 Nxc4\nA40\tModern Defense: Lizard Defense, Pirc-Diemer Gambit\t1. d4 g6 2. h4 Nf6 3. h5\nA40\tMontevideo Defense\t1. d4 Nc6 2. d5 Nb8\nA40\tPolish Defense\t1. d4 b5\nA40\tPolish Defense: Spassky Gambit Accepted\t1. d4 b5 2. e4 Bb7 3. Bxb5\nA40\tPterodactyl Defense: Central, Benoni Pterodactyl\t1. d4 g6 2. c4 Bg7 3. e4 c5 4. d5 Qa5+\nA40\tPterodactyl Defense: Fianchetto, Queen Benoni Pterodactyl\t1. d4 g6 2. c4 Bg7 3. Nc3 c5 4. d5 Qa5\nA40\tPterodactyl Defense: Fianchetto, Queen Pterodactyl\t1. d4 g6 2. Nf3 Bg7 3. g3 c5 4. Bg2 Qa5+\nA40\tPterodactyl Defense: Queen Pterodactyl, Quiet Line\t1. d4 g6 2. c4 Bg7 3. Nc3 c5 4. e3\nA40\tQueen's Pawn Game\t1. d4\nA40\tQueen's Pawn Game: Anglo-Slav Opening\t1. d4 c6 2. c4 d6\nA40\tQueen's Pawn Game: Modern Defense\t1. d4 g6\nA40\tSlav Indian: Kudischewitsch Gambit\t1. d4 c6 2. Nf3 Nf6 3. c4 b5\nA40\tZaire Defense\t1. d4 Nc6 2. d5 Nb8 3. e4 Nf6 4. e5 Ng8\nA41\tModern Defense\t1. d4 g6 2. c4 Bg7 3. Nc3 d6\nA41\tModern Defense: Neo-Modern Defense\t1. d4 g6 2. c4 Bg7 3. e4 e5\nA41\tOld Indian Defense\t1. d4 d6 2. c4\nA41\tQueen's Pawn Game\t1. d4 d6\nA41\tRat Defense: English Rat\t1. d4 d6 2. c4 e5\nA41\tRat Defense: English Rat, Lisbon Gambit\t1. d4 d6 2. c4 e5 3. dxe5 Nc6\nA41\tRat Defense: English Rat, Pounds Gambit\t1. d4 d6 2. c4 e5 3. dxe5 Be6\nA41\tRobatsch Defense\t1. d4 d6 2. Nf3 g6 3. c4 Bg7 4. e4 Bg4\nA41\tWade Defense\t1. d4 d6 2. Nf3 Bg4\nA41\tZukertort Opening: Wade Defense, Chigorin Plan\t1. d4 d6 2. Nf3 Bg4 3. c4 Nd7 4. Qb3 Rb8\nA42\tModern Defense: Averbakh System\t1. d4 g6 2. c4 Bg7 3. Nc3 d6 4. e4\nA42\tModern Defense: Kotov Variation\t1. d4 g6 2. c4 Bg7 3. Nc3 d6 4. e4 Nc6\nA42\tModern Defense: Randspringer Variation\t1. d4 g6 2. c4 Bg7 3. Nc3 d6 4. e4 f5\nA43\tBenoni Defense: Benoni Gambit Accepted\t1. d4 c5 2. dxc5\nA43\tBenoni Defense: Benoni Gambit, Schlenker Defense\t1. d4 c5 2. dxc5 Na6\nA43\tBenoni Defense: Benoni-Indian Defense\t1. d4 c5 2. d5 Nf6\nA43\tBenoni Defense: Benoni-Indian Defense, Kingside Move Order\t1. d4 c5 2. d5 Nf6 3. Nf3\nA43\tBenoni Defense: Benoni-Staunton Gambit\t1. d4 c5 2. d5 f5 3. e4\nA43\tBenoni Defense: Cormorant Gambit\t1. d4 c5 2. dxc5 b6\nA43\tBenoni Defense: French Benoni\t1. e4 e6 2. d4 c5 3. d5\nA43\tBenoni Defense: Hawk Variation\t1. d4 Nf6 2. Nf3 c5 3. d5 c4\nA43\tBenoni Defense: Old Benoni\t1. d4 c5\nA43\tBenoni Defense: Old Benoni\t1. d4 c5 2. d5\nA43\tBenoni Defense: Old Benoni\t1. d4 c5 2. d5 d6\nA43\tBenoni Defense: Old Benoni, Mujannah Formation\t1. d4 c5 2. d5 f5\nA43\tBenoni Defense: Old Benoni, Schmid Variation\t1. d4 c5 2. d5 d6 3. Nc3 g6\nA43\tBenoni Defense: Snail Variation\t1. d4 c5 2. d5 Na6\nA43\tBenoni Defense: Woozle\t1. d4 c5 2. d5 Nf6 3. Nc3 Qa5\nA43\tBenoni Defense: Zilbermints-Benoni Gambit\t1. d4 c5 2. b4\nA43\tBenoni Defense: Zilbermints-Benoni Gambit\t1. d4 c5 2. Nf3 cxd4 3. b4\nA43\tBenoni Defense: Zilbermints-Benoni Gambit, Tamarkin Countergambit\t1. d4 c5 2. Nf3 cxd4 3. b4 e5\nA43\tIndian Defense: Pseudo-Benko\t1. d4 Nf6 2. Nf3 c5 3. d5 b5\nA43\tQueen's Pawn Game: Liedmann Gambit\t1. d4 c5 2. c4 cxd4 3. e3\nA44\tBenoni Defense: Old Benoni\t1. d4 c5 2. d5 e5\nA44\tBenoni Defense: Semi-Benoni\t1. d4 c5 2. d5 e5 3. e4 d6\nA45\tAmazon Attack: Siberian Attack\t1. d4 Nf6 2. Nc3 d5 3. Qd3\nA45\tCanard Opening\t1. d4 Nf6 2. f4\nA45\tIndian Defense\t1. d4 Nf6\nA45\tIndian Defense: Accelerated London System\t1. d4 Nf6 2. Bf4\nA45\tIndian Defense: Gedult Attack\t1. d4 Nf6 2. f3 d5 3. g4\nA45\tIndian Defense: Gibbins-Weidenhagen Gambit\t1. d4 Nf6 2. g4\nA45\tIndian Defense: Gibbins-Weidenhagen Gambit Accepted\t1. d4 Nf6 2. g4 Nxg4\nA45\tIndian Defense: Gibbins-Weidenhagen Gambit, Maltese Falcon\t1. d4 Nf6 2. g4 Nxg4 3. f3 Nf6 4. e4\nA45\tIndian Defense: Gibbins-Weidenhagen Gambit, Oshima Defense\t1. d4 Nf6 2. g4 e5\nA45\tIndian Defense: Lazard Gambit\t1. d4 Nf6 2. Nd2 e5\nA45\tIndian Defense: Maddigan Gambit\t1. d4 Nf6 2. Nc3 e5\nA45\tIndian Defense: Omega Gambit\t1. d4 Nf6 2. e4\nA45\tIndian Defense: Omega Gambit, Arafat Gambit\t1. d4 Nf6 2. e4 Nxe4 3. Bd3 Nf6 4. Bg5\nA45\tIndian Defense: Paleface Attack, Blackmar-Diemer Gambit Deferred\t1. d4 Nf6 2. f3 d5 3. e4\nA45\tIndian Defense: Pawn Push Variation\t1. d4 Nf6 2. d5\nA45\tIndian Defense: Reversed Chigorin Defense\t1. d4 Nf6 2. Nc3 c5\nA45\tIndian Defense: Tartakower Attack\t1. d4 Nf6 2. g3\nA45\tPaleface Attack\t1. d4 Nf6 2. f3\nA45\tQueen's Pawn Game: Chigorin Variation\t1. d4 Nf6 2. Nc3 d5\nA45\tQueen's Pawn Game: Veresov, Richter Attack\t1. d4 Nf6 2. f3 d5 3. Nc3\nA45\tTrompowsky Attack\t1. d4 Nf6 2. Bg5\nA45\tTrompowsky Attack: Borg Variation\t1. d4 Nf6 2. Bg5 Ne4 3. Bf4 g5\nA45\tTrompowsky Attack: Classical Defense\t1. d4 Nf6 2. Bg5 e6\nA45\tTrompowsky Attack: Classical Defense, Big Center Variation\t1. d4 Nf6 2. Bg5 e6 3. e4\nA45\tTrompowsky Attack: Edge Variation\t1. d4 Nf6 2. Bg5 Ne4 3. Bh4\nA45\tTrompowsky Attack: Poisoned Pawn Variation\t1. d4 Nf6 2. Bg5 c5 3. d5 Qb6 4. Nc3\nA45\tTrompowsky Attack: Raptor Variation\t1. d4 Nf6 2. Bg5 Ne4 3. h4\nA45\tTrompowsky Attack: Raptor Variation, Hergert Gambit\t1. d4 Nf6 2. Bg5 Ne4 3. h4 Nxg5 4. hxg5 e5\nA46\tDöry Defense\t1. d4 Nf6 2. Nf3 Ne4\nA46\tIndian Defense: Czech-Indian\t1. d4 Nf6 2. Nf3 c6\nA46\tIndian Defense: Knights Variation\t1. d4 Nf6 2. Nf3\nA46\tIndian Defense: Knights Variation, Alburt-Miles Variation\t1. d4 Nf6 2. Nf3 a6\nA46\tIndian Defense: London System\t1. d4 Nf6 2. Nf3 e6 3. Bf4\nA46\tIndian Defense: Polish Variation\t1. d4 Nf6 2. Nf3 b5\nA46\tIndian Defense: Spielmann-Indian\t1. d4 Nf6 2. Nf3 c5\nA46\tIndian Defense: Wade-Tartakower Defense\t1. d4 Nf6 2. Nf3 d6\nA46\tQueen's Pawn Game: Veresov Attack, Classical Defense\t1. d4 Nf6 2. Nf3 e6 3. Nc3 d5 4. Bg5\nA46\tTorre Attack: Classical Defense\t1. d4 Nf6 2. Nf3 e6 3. Bg5\nA46\tTorre Attack: Classical Defense, Nimzowitsch Variation\t1. d4 Nf6 2. Nf3 e6 3. Bg5 h6\nA46\tTorre Attack: Wagner Gambit\t1. d4 Nf6 2. Nf3 e6 3. Bg5 c5 4. e4\nA46\tYusupov-Rubinstein System\t1. d4 Nf6 2. Nf3 e6 3. e3\nA47\tIndian Defense: Schnepper Gambit\t1. d4 Nf6 2. Nf3 b6 3. c3 e5\nA47\tMarienbad System\t1. d4 Nf6 2. Nf3 b6 3. g3 Bb7 4. Bg2 c5\nA47\tPseudo Queen's Indian Defense\t1. d4 Nf6 2. Nf3 b6\nA48\tEast Indian Defense\t1. d4 Nf6 2. Nf3 g6\nA48\tIndian Defense: Colle System, King's Indian Variation\t1. d4 Nf6 2. Nf3 g6 3. e3 Bg7 4. Bd3 d6\nA48\tLondon System\t1. d4 Nf6 2. Nf3 g6 3. Bf4\nA48\tLondon System\t1. d4 Nf6 2. Nf3 g6 3. Bf4 Bg7 4. e3\nA48\tLondon System\t1. d4 Nf6 2. Nf3 g6 3. Bf4 Bg7 4. e3 d6\nA48\tQueen's Pawn Game: Barry Attack\t1. d4 Nf6 2. Nf3 g6 3. Nc3 d5 4. Bf4\nA48\tQueen's Pawn Game: Barry Attack\t1. d4 Nf6 2. Nf3 g6 3. Nc3 d5 4. Bf4 Bg7\nA48\tTorre Attack: Fianchetto Defense\t1. d4 Nf6 2. Nf3 g6 3. Bg5\nA48\tTorre Attack: Fianchetto Defense, Euwe Variation\t1. d4 Nf6 2. Nf3 g6 3. Bg5 Bg7 4. Nbd2 c5\nA49\tIndian Defense: Przepiorka Variation\t1. d4 Nf6 2. Nf3 g6 3. g3\nA50\tIndian Defense: Medusa Gambit\t1. d4 Nf6 2. c4 g5\nA50\tIndian Defense: Normal Variation\t1. d4 Nf6 2. c4\nA50\tIndian Defense: Pyrenees Gambit\t1. d4 Nf6 2. c4 b5\nA50\tMexican Defense\t1. d4 Nf6 2. c4 Nc6\nA50\tMexican Defense: Horsefly Gambit\t1. d4 Nf6 2. c4 Nc6 3. d5 Ne5 4. f4\nA50\tQueen's Indian Accelerated\t1. d4 Nf6 2. c4 b6\nA50\tSlav Indian\t1. d4 Nf6 2. c4 c6\nA51\tIndian Defense: Budapest Gambit\t1. d4 Nf6 2. c4 e5\nA51\tIndian Defense: Budapest Gambit Accepted\t1. d4 Nf6 2. c4 e5 3. dxe5\nA51\tIndian Defense: Budapest Gambit Accepted, Fajarowicz Defense\t1. d4 Nf6 2. c4 e5 3. dxe5 Ne4\nA51\tIndian Defense: Budapest Gambit Accepted, Fajarowicz Defense, Bonsdorf Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ne4 4. a3\nA51\tIndian Defense: Budapest Gambit Accepted, Fajarowicz Defense, Steiner Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ne4 4. Qc2\nA52\tIndian Defense: Budapest Gambit Accepted, Main Line\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4\nA52\tIndian Defense: Budapest Gambit Accepted, Main Line, Adler Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4 4. Nf3\nA52\tIndian Defense: Budapest Gambit Accepted, Main Line, Alekhine Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4 4. e4\nA52\tIndian Defense: Budapest Gambit Accepted, Main Line, Alekhine Variation, Abonyi Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4 4. e4 Nxe5\nA52\tIndian Defense: Budapest Gambit Accepted, Main Line, Alekhine Variation, Tartakower Defense\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4 4. e4 d6\nA52\tIndian Defense: Budapest Gambit Accepted, Main Line, Rubinstein Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4 4. Bf4\nA53\tOld Indian Defense\t1. d4 Nf6 2. c4 d6\nA53\tOld Indian Defense: Aged Gibbon Gambit\t1. d4 Nf6 2. c4 d6 3. g4\nA53\tOld Indian Defense: Czech Variation, with Nc3\t1. d4 Nf6 2. c4 d6 3. Nc3 c6\nA53\tOld Indian Defense: Czech Variation, with Nf3\t1. d4 Nf6 2. c4 d6 3. Nf3 c6\nA53\tOld Indian Defense: Janowski Variation\t1. d4 Nf6 2. c4 d6 3. Nc3 Bf5\nA53\tOld Indian Defense: Janowski Variation, Fianchetto Variation\t1. d4 Nf6 2. c4 d6 3. Nc3 Bf5 4. g3\nA53\tOld Indian Defense: Janowski Variation, Grinberg Gambit\t1. d4 Nf6 2. c4 d6 3. Nc3 Bf5 4. e4\nA53\tOld Indian Defense: Janowski Variation, Main Line\t1. d4 Nf6 2. c4 d6 3. Nc3 Bf5 4. f3\nA54\tOld Indian Defense: Tartakower-Indian\t1. d4 Nf6 2. c4 d6 3. Nf3 Bg4\nA54\tOld Indian Defense: Two Knights Variation\t1. d4 Nf6 2. c4 d6 3. Nc3 e5 4. Nf3\nA54\tOld Indian Defense: Ukrainian Variation\t1. d4 Nf6 2. c4 d6 3. Nc3 e5\nA56\tBenoni Defense\t1. d4 Nf6 2. c4 c5\nA56\tBenoni Defense: Czech Benoni Defense\t1. d4 Nf6 2. c4 c5 3. d5 e5\nA56\tBenoni Defense: Hromádka System\t1. d4 Nf6 2. c4 c5 3. d5 d6\nA56\tBenoni Defense: Weenink Variation\t1. d4 Nf6 2. c4 c5 3. dxc5 e6\nA56\tVulture Defense\t1. d4 Nf6 2. c4 c5 3. d5 Ne4\nA57\tBenko Gambit\t1. d4 Nf6 2. c4 c5 3. d5 b5\nA57\tBenko Gambit Accepted\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. cxb5 a6\nA57\tBenko Gambit Declined: Bishop Attack\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. Bg5\nA57\tBenko Gambit Declined: Hjørring Countergambit\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. e4\nA57\tBenko Gambit Declined: Main Line\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. Nf3\nA57\tBenko Gambit Declined: Pseudo-Sämisch\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. f3\nA57\tBenko Gambit Declined: Quiet Line\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. Nd2\nA57\tBenko Gambit Declined: Sosonko Variation\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. a4\nA57\tBenko Gambit: Mutkin Countergambit\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. g4\nA60\tBenoni Defense: Modern Variation\t1. d4 Nf6 2. c4 c5 3. d5 e6\nA80\tDutch Defense\t1. d4 f5\nA80\tDutch Defense: Alapin Variation\t1. d4 f5 2. Qd3\nA80\tDutch Defense: Hevendehl Gambit\t1. d4 f5 2. g4 e5\nA80\tDutch Defense: Hopton Attack\t1. d4 f5 2. Bg5\nA80\tDutch Defense: Janzen-Korchnoi Gambit\t1. d4 f5 2. h3 Nf6 3. g4\nA80\tDutch Defense: Kingfisher Gambit\t1. d4 f5 2. Nc3 d5 3. e4\nA80\tDutch Defense: Korchnoi Attack\t1. d4 f5 2. h3\nA80\tDutch Defense: Krejcik Gambit\t1. d4 f5 2. g4\nA80\tDutch Defense: Krejcik Gambit, Tate Gambit\t1. d4 f5 2. g4 fxg4 3. e4 d5 4. Nc3\nA80\tDutch Defense: Manhattan Gambit, Anti-Classical Line\t1. d4 f5 2. Qd3 e6 3. g4\nA80\tDutch Defense: Manhattan Gambit, Anti-Leningrad\t1. d4 f5 2. Qd3 g6 3. g4\nA80\tDutch Defense: Manhattan Gambit, Anti-Modern\t1. d4 f5 2. Qd3 d6 3. g4\nA80\tDutch Defense: Manhattan Gambit, Anti-Stonewall\t1. d4 f5 2. Qd3 d5 3. g4\nA80\tDutch Defense: Omega-Isis Gambit\t1. d4 f5 2. Nf3 e5\nA80\tDutch Defense: Raphael Variation\t1. d4 f5 2. Nc3\nA80\tDutch Defense: Senechaud Gambit\t1. d4 f5 2. Bf4 e6 3. g4\nA80\tDutch Defense: Spielmann Gambit\t1. d4 f5 2. Nc3 Nf6 3. g4\nA80\tQueen's Pawn Game: Veresov Attack, Dutch System\t1. d4 f5 2. Nc3 d5\nA81\tDutch Defense: Blackburne Variation\t1. d4 f5 2. g3 Nf6 3. Bg2 e6 4. Nh3\nA81\tDutch Defense: Fianchetto Attack\t1. d4 f5 2. g3\nA81\tDutch Defense: Leningrad Variation, Carlsbad Variation\t1. d4 f5 2. g3 g6 3. Bg2 Bg7 4. Nh3\nA81\tDutch Defense: Semi-Leningrad Variation\t1. d4 f5 2. g3 Nf6 3. Bg2 g6\nA82\tDutch Defense: Blackmar's Second Gambit\t1. d4 f5 2. e4 fxe4 3. Nc3 Nf6 4. f3\nA82\tDutch Defense: Staunton Gambit\t1. d4 f5 2. e4\nA82\tDutch Defense: Staunton Gambit Accepted\t1. d4 f5 2. e4 fxe4\nA82\tDutch Defense: Staunton Gambit, American Attack\t1. d4 f5 2. e4 fxe4 3. Nd2\nA82\tDutch Defense: Staunton Gambit, Tartakower Variation\t1. d4 f5 2. e4 fxe4 3. Nc3 Nf6 4. g4\nA82\tRat Defense: Balogh Defense\t1. e4 d6 2. d4 f5\nA83\tDutch Defense: Staunton Gambit\t1. d4 f5 2. e4 fxe4 3. Nc3 Nf6 4. Bg5\nA83\tDutch Defense: Staunton Gambit, Chigorin Variation\t1. d4 f5 2. e4 fxe4 3. Nc3 Nf6 4. Bg5 c6\nA83\tDutch Defense: Staunton Gambit, Nimzowitsch Variation\t1. d4 f5 2. e4 fxe4 3. Nc3 Nf6 4. Bg5 b6\nA84\tDutch Defense\t1. d4 f5 2. c4\nA84\tDutch Defense: Bellon Gambit\t1. d4 f5 2. c4 e6 3. e4\nA84\tDutch Defense: Bladel Variation\t1. d4 f5 2. c4 g6 3. Nc3 Nh6\nA84\tDutch Defense: Classical Variation\t1. d4 f5 2. c4 e6\nA84\tDutch Defense: Krause Variation\t1. d4 f5 2. c4 Nf6 3. Nc3 d6 4. Nf3 Nc6\nA84\tDutch Defense: Normal Variation\t1. d4 f5 2. c4 Nf6\nA84\tDutch Defense: Rubinstein Variation\t1. d4 f5 2. c4 e6 3. Nc3\nA85\tDutch Defense: Queen's Knight Variation\t1. d4 f5 2. c4 Nf6 3. Nc3\nA86\tDutch Defense: Fianchetto Variation\t1. d4 f5 2. c4 Nf6 3. g3\nA86\tDutch Defense: Leningrad Variation\t1. d4 f5 2. c4 Nf6 3. g3 g6\nA90\tDutch Defense: Classical Variation\t1. d4 f5 2. c4 Nf6 3. g3 e6 4. Bg2\nA90\tDutch Defense: Nimzo-Dutch Variation\t1. d4 f5 2. c4 Nf6 3. g3 e6 4. Bg2 Bb4+\nA91\tDutch Defense: Classical Variation\t1. d4 f5 2. c4 Nf6 3. g3 e6 4. Bg2 Be7\nB00\tBarnes Defense\t1. e4 f6\nB00\tBorg Defense\t1. e4 g5\nB00\tBorg Defense: Borg Gambit\t1. e4 g5 2. d4 Bg7\nB00\tBorg Defense: Troon Gambit\t1. e4 g5 2. d4 h6 3. h4 g4\nB00\tBorg Defense: Zilbermints Gambit\t1. e4 g5 2. d4 e5\nB00\tCarr Defense\t1. e4 h6\nB00\tCarr Defense: Zilbermints Gambit\t1. e4 h6 2. d4 e5\nB00\tDuras Gambit\t1. e4 f5\nB00\tFried Fox Defense\t1. e4 f6 2. d4 Kf7\nB00\tGoldsmith Defense\t1. e4 h5\nB00\tGoldsmith Defense: Picklepuss Defense\t1. e4 h5 2. d4 Nf6\nB00\tHippopotamus Defense\t1. e4 Nh6\nB00\tHippopotamus Defense\t1. e4 Nh6 2. d4 g6 3. c4 f6\nB00\tKing's Pawn Game\t1. e4\nB00\tLemming Defense\t1. e4 Na6\nB00\tLion Defense: Lion's Jaw\t1. e4 d6 2. d4 Nf6 3. f3\nB00\tNimzowitsch Defense\t1. e4 Nc6\nB00\tNimzowitsch Defense\t1. e4 Nc6 2. d4\nB00\tNimzowitsch Defense: Breyer Variation\t1. e4 Nc6 2. Nc3 Nf6 3. d4 e5\nB00\tNimzowitsch Defense: Colorado Countergambit\t1. e4 Nc6 2. Nf3 f5\nB00\tNimzowitsch Defense: Colorado Countergambit Accepted\t1. e4 Nc6 2. Nf3 f5 3. exf5\nB00\tNimzowitsch Defense: Declined Variation\t1. e4 Nc6 2. Nf3\nB00\tNimzowitsch Defense: El Columpio Defense\t1. e4 Nc6 2. Nf3 Nf6 3. e5 Ng4\nB00\tNimzowitsch Defense: Franco-Nimzowitsch Variation\t1. e4 Nc6 2. Nf3 e6\nB00\tNimzowitsch Defense: French Connection\t1. e4 Nc6 2. Nc3 e6\nB00\tNimzowitsch Defense: Hornung Gambit\t1. e4 Nc6 2. d4 d5 3. Be3\nB00\tNimzowitsch Defense: Kennedy Variation\t1. e4 Nc6 2. d4 e5\nB00\tNimzowitsch Defense: Kennedy Variation, Bielefelder Gambit\t1. e4 Nc6 2. d4 e5 3. dxe5 Bc5\nB00\tNimzowitsch Defense: Kennedy Variation, Hammer Gambit\t1. e4 Nc6 2. d4 e5 3. dxe5 f6\nB00\tNimzowitsch Defense: Kennedy Variation, Herford Gambit\t1. e4 Nc6 2. d4 e5 3. dxe5 Qh4\nB00\tNimzowitsch Defense: Kennedy Variation, Keres Attack\t1. e4 Nc6 2. d4 e5 3. dxe5 Nxe5 4. Nc3\nB00\tNimzowitsch Defense: Kennedy Variation, Linksspringer Variation\t1. e4 Nc6 2. d4 e5 3. d5\nB00\tNimzowitsch Defense: Kennedy Variation, Main Line\t1. e4 Nc6 2. d4 e5 3. dxe5 Nxe5 4. f4 Ng6\nB00\tNimzowitsch Defense: Kennedy Variation, Paulsen Attack\t1. e4 Nc6 2. d4 e5 3. dxe5 Nxe5 4. Nf3\nB00\tNimzowitsch Defense: Kennedy Variation, Riemann Defense\t1. e4 Nc6 2. d4 e5 3. dxe5 Nxe5 4. f4 Nc6\nB00\tNimzowitsch Defense: Kennedy Variation, de Smet Gambit\t1. e4 Nc6 2. d4 e5 3. dxe5 d6\nB00\tNimzowitsch Defense: Mikenas Variation\t1. e4 Nc6 2. d4 d6\nB00\tNimzowitsch Defense: Neo-Mongoloid Defense\t1. e4 Nc6 2. d4 f6\nB00\tNimzowitsch Defense: Pirc Connection\t1. e4 Nc6 2. Nc3 g6\nB00\tNimzowitsch Defense: Pseudo-Spanish Variation\t1. e4 Nc6 2. Bb5\nB00\tNimzowitsch Defense: Scandinavian Variation\t1. e4 Nc6 2. d4 d5\nB00\tNimzowitsch Defense: Scandinavian Variation, Aachen Gambit\t1. e4 Nc6 2. d4 d5 3. exd5 Nb4\nB00\tNimzowitsch Defense: Scandinavian Variation, Advance Variation\t1. e4 Nc6 2. d4 d5 3. e5\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation\t1. e4 Nc6 2. d4 d5 3. Nc3\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation\t1. e4 Nc6 2. d4 d5 3. Nc3 dxe4\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation, Brandics Gambit\t1. e4 Nc6 2. d4 d5 3. Nc3 a6\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation, Erben Gambit\t1. e4 Nc6 2. d4 d5 3. Nc3 g6\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation, Heinola-Deppe Gambit\t1. e4 Nc6 2. d4 d5 3. Nc3 e5\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation, Nimzowitsch Gambit\t1. e4 Nc6 2. d4 d5 3. Nc3 dxe4 4. d5 Ne5\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation, Vehre Variation\t1. e4 Nc6 2. d4 d5 3. Nc3 Nf6\nB00\tNimzowitsch Defense: Scandinavian Variation, Exchange Variation\t1. e4 Nc6 2. d4 d5 3. exd5 Qxd5\nB00\tNimzowitsch Defense: Scandinavian Variation, Exchange Variation, Marshall Gambit\t1. e4 Nc6 2. d4 d5 3. exd5 Qxd5 4. Nc3\nB00\tNimzowitsch Defense: Wheeler Gambit\t1. e4 Nc6 2. b4\nB00\tNimzowitsch Defense: Williams Variation\t1. e4 Nc6 2. Nf3 d6\nB00\tNimzowitsch Defense: Woodchuck Variation\t1. e4 Nc6 2. d4 a6\nB00\tOwen Defense\t1. e4 b6\nB00\tOwen Defense: Guatemala Defense\t1. e4 b6 2. d4 Ba6\nB00\tOwen Defense: Hekili-Loa Gambit\t1. e4 b6 2. d4 c5 3. dxc5 Nc6\nB00\tOwen Defense: Naselwaus Gambit\t1. e4 b6 2. d4 Bb7 3. Bg5\nB00\tOwen Defense: Smith Gambit\t1. e4 b6 2. d4 Bb7 3. Nf3\nB00\tOwen Defense: Unicorn Variation\t1. e4 f6 2. d4 b6 3. c4 Bb7\nB00\tOwen Defense: Wind Gambit\t1. e4 b6 2. d4 Bb7 3. f3 e5\nB00\tPirc Defense\t1. e4 d6\nB00\tPirc Defense\t1. e4 d6 2. d4\nB00\tPirc Defense\t1. e4 d6 2. d4 Nf6\nB00\tPirc Defense: Roscher Gambit\t1. e4 d6 2. d4 Nf6 3. Nf3\nB00\tRat Defense: Antal Defense\t1. e4 d6 2. d4 Nd7\nB00\tRat Defense: Fuller Gambit\t1. e4 d6 2. f4 d5 3. exd5 Nf6\nB00\tRat Defense: Harmonist\t1. e4 d6 2. f4\nB00\tRat Defense: Petruccioli Attack\t1. e4 d6 2. h4\nB00\tRat Defense: Spike Attack\t1. e4 d6 2. g4\nB00\tSt. George Defense\t1. e4 a6\nB00\tSt. George Defense: Polish Variation\t1. e4 a6 2. d4 b5 3. Nf3 Bb7 4. Bd3 e6\nB00\tSt. George Defense: Zilbermints Gambit\t1. e4 a6 2. d4 e5\nB00\tVan Geet Opening: Berlin Gambit\t1. e4 Nc6 2. d4 d5 3. Nc3 dxe4 4. d5\nB00\tWare Defense\t1. e4 a5\nB00\tWare Defense: Snagglepuss Defense\t1. e4 a5 2. d4 Nc6\nB01\tScandinavian Defense\t1. e4 d5\nB01\tScandinavian Defense\t1. e4 d5 2. b3\nB01\tScandinavian Defense: Anderssen Counterattack\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 e5\nB01\tScandinavian Defense: Blackburne Gambit\t1. e4 d5 2. exd5 c6 3. dxc6 Nxc6\nB01\tScandinavian Defense: Blackburne-Kloosterboer Gambit\t1. e4 d5 2. exd5 c6\nB01\tScandinavian Defense: Boehnke Gambit\t1. e4 d5 2. exd5 e5 3. dxe6 Bxe6\nB01\tScandinavian Defense: Gubinsky-Melts Defense\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qd6\nB01\tScandinavian Defense: Icelandic-Palme Gambit\t1. e4 d5 2. exd5 Nf6 3. c4 e6\nB01\tScandinavian Defense: Kiel Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Nxd5 4. c4 Nb4\nB01\tScandinavian Defense: Kloosterboer Gambit\t1. e4 d5 2. exd5 c6 3. dxc6 e5\nB01\tScandinavian Defense: Kádas Gambit\t1. e4 d5 2. exd5 Nf6 3. d4 c6 4. dxc6 e5\nB01\tScandinavian Defense: Main Line\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5\nB01\tScandinavian Defense: Main Line, Leonhardt Gambit\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. b4\nB01\tScandinavian Defense: Main Line, Mieses Variation\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 Nf6\nB01\tScandinavian Defense: Marshall Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Nxd5\nB01\tScandinavian Defense: Mieses-Kotroc Variation\t1. e4 d5 2. exd5 Qxd5\nB01\tScandinavian Defense: Modern Variation\t1. e4 d5 2. exd5 Nf6\nB01\tScandinavian Defense: Modern Variation\t1. e4 d5 2. exd5 Nf6 3. d4\nB01\tScandinavian Defense: Modern Variation, Gipslis Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Nxd5 4. Nf3 Bg4\nB01\tScandinavian Defense: Modern Variation, Wing Gambit\t1. e4 d5 2. exd5 Nf6 3. d4 g6 4. c4 b5\nB01\tScandinavian Defense: Panov Transfer\t1. e4 d5 2. exd5 Nf6 3. c4 c6\nB01\tScandinavian Defense: Portuguese Gambit\t1. e4 d5 2. exd5 Nf6 3. d4 Bg4\nB01\tScandinavian Defense: Portuguese Gambit, Classical Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Bg4 4. Nf3\nB01\tScandinavian Defense: Portuguese Gambit, Elbow Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Bg4 4. Bb5+ c6\nB01\tScandinavian Defense: Portuguese Gambit, Wuss Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Bg4 4. Be2\nB01\tScandinavian Defense: Richter Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Nxd5 4. Nf3 g6\nB01\tScandinavian Defense: Richter Variation\t1. e4 d5 2. exd5 Nf6 3. d4 g6\nB01\tScandinavian Defense: Schiller-Pytel Variation\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qd6 4. d4 c6\nB01\tScandinavian Defense: Valencian Variation\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qd8\nB01\tScandinavian Defense: Zilbermints Gambit\t1. e4 d5 2. b4\nB01\tVan Geet Opening: Grünfeld Defense\t1. e4 d5 2. Nc3 dxe4 3. Nxe4 e5\nB02\tAlekhine Defense\t1. e4 Nf6\nB02\tAlekhine Defense: Brooklyn Variation\t1. e4 Nf6 2. e5 Ng8\nB02\tAlekhine Defense: Brooklyn Variation, Everglades Variation\t1. e4 Nf6 2. e5 Ng8 3. d4 f5\nB02\tAlekhine Defense: Buckley Attack\t1. e4 Nf6 2. e5 Nd5 3. Na3\nB02\tAlekhine Defense: Krejcik Variation\t1. e4 Nf6 2. Bc4\nB02\tAlekhine Defense: Krejcik Variation, Krejcik Gambit\t1. e4 Nf6 2. Bc4 Nxe4 3. Bxf7+\nB02\tAlekhine Defense: Maróczy Variation\t1. e4 Nf6 2. d3\nB02\tAlekhine Defense: Mokele Mbembe\t1. e4 Nf6 2. e5 Ne4\nB02\tAlekhine Defense: Mokele Mbembe, Modern Line\t1. e4 Nf6 2. e5 Ne4 3. d4 f6\nB02\tAlekhine Defense: Mokele Mbembe, Vavra Defense\t1. e4 Nf6 2. e5 Ne4 3. d4 e6\nB02\tAlekhine Defense: Normal Variation\t1. e4 Nf6 2. e5 Nd5\nB02\tAlekhine Defense: Scandinavian Variation\t1. e4 Nf6 2. Nc3 d5\nB02\tAlekhine Defense: Scandinavian Variation, Geschev Gambit\t1. e4 Nf6 2. Nc3 d5 3. exd5 c6\nB02\tAlekhine Defense: Scandinavian Variation, Myers Gambit\t1. e4 Nf6 2. Nc3 d5 3. d3 dxe4 4. Bg5\nB02\tAlekhine Defense: Spielmann Gambit\t1. e4 Nf6 2. Nc3 d5 3. e5 Nfd7 4. e6\nB02\tAlekhine Defense: Steiner Variation\t1. e4 Nf6 2. e5 Nd5 3. c4 Nb6 4. b3\nB02\tAlekhine Defense: Sämisch Attack\t1. e4 Nf6 2. e5 Nd5 3. Nc3\nB02\tAlekhine Defense: The Squirrel\t1. e4 Nf6 2. e5 Nd5 3. c4 Nf4\nB02\tAlekhine Defense: Two Pawns Attack\t1. e4 Nf6 2. e5 Nd5 3. c4\nB02\tAlekhine Defense: Two Pawns Attack, Lasker Variation\t1. e4 Nf6 2. e5 Nd5 3. c4 Nb6 4. c5\nB02\tAlekhine Defense: Two Pawns Attack, Tate Variation\t1. e4 Nf6 2. e5 Nd5 3. c4 Nb6 4. a4\nB02\tAlekhine Defense: Welling Variation\t1. e4 Nf6 2. e5 Nd5 3. b3\nB03\tAlekhine Defense\t1. e4 Nf6 2. e5 Nd5 3. d4\nB03\tAlekhine Defense\t1. e4 Nf6 2. e5 Nd5 3. d4 d6\nB03\tAlekhine Defense\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. c4\nB03\tAlekhine Defense: Balogh Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Bc4\nB03\tAlekhine Defense: O'Sullivan Gambit\t1. e4 Nf6 2. e5 Nd5 3. d4 b5\nB04\tAlekhine Defense: Modern Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3\nB04\tAlekhine Defense: Modern Variation, Alburt Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 g6\nB04\tAlekhine Defense: Modern Variation, Larsen Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 dxe5\nB04\tAlekhine Defense: Modern Variation, Larsen-Haakert Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Nc6\nB04\tAlekhine Defense: Modern Variation, Schmid Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Nb6\nB05\tAlekhine Defense: Modern Variation, Main Line\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Bg4\nB06\tModern Defense\t1. e4 g6\nB06\tModern Defense\t1. e4 g6 2. d4 Bg7\nB06\tModern Defense: Bishop Attack\t1. e4 g6 2. d4 Bg7 3. Bc4\nB06\tModern Defense: Bishop Attack, Bücker Gambit\t1. e4 g6 2. d4 Bg7 3. Bc4 b5\nB06\tModern Defense: Bishop Attack, Monkey's Bum\t1. e4 g6 2. Bc4 Bg7 3. Qf3 e6 4. d4 Bxd4\nB06\tModern Defense: Fianchetto Gambit\t1. e4 g6 2. d4 f5\nB06\tModern Defense: Lizard Defense, Mittenberger Gambit\t1. e4 g6 2. d4 Bg7 3. Nc3 d5\nB06\tModern Defense: Modern Pterodactyl\t1. e4 g6 2. d4 Bg7 3. Nc3 c5\nB06\tModern Defense: Mongredien Defense, with Nc3\t1. e4 g6 2. d4 Bg7 3. Nc3 b6\nB06\tModern Defense: Mongredien Defense, with Nf3\t1. e4 g6 2. d4 Bg7 3. Nf3 b6\nB06\tModern Defense: Norwegian Defense\t1. e4 g6 2. d4 Nf6\nB06\tModern Defense: Norwegian Defense, Norwegian Gambit\t1. e4 g6 2. d4 Nf6 3. e5 Nh5 4. Be2 d6\nB06\tModern Defense: Pseudo-Austrian Attack\t1. e4 g6 2. d4 Bg7 3. Nc3 d6 4. f4\nB06\tModern Defense: Standard Defense\t1. e4 g6 2. d4 Bg7 3. Nc3 d6\nB06\tModern Defense: Standard Line\t1. e4 g6 2. d4 Bg7 3. Nc3\nB06\tModern Defense: Three Pawns Attack\t1. e4 g6 2. d4 Bg7 3. f4\nB06\tModern Defense: Two Knights Variation\t1. e4 g6 2. d4 Bg7 3. Nc3 d6 4. Nf3\nB06\tModern Defense: Two Knights Variation, Suttles Variation\t1. e4 g6 2. d4 Bg7 3. Nc3 c6 4. Nf3 d6\nB06\tModern Defense: Westermann Gambit\t1. e4 g6 2. d4 Bg7 3. Bd2\nB06\tModern Defense: Wind Gambit\t1. e4 g6 2. d4 Bg7 3. Bd3\nB06\tPterodactyl Defense: Austrian, Austriadactylus Western\t1. e4 g6 2. d4 Bg7 3. f4 c5 4. Nf3 Qa5+\nB06\tPterodactyl Defense: Austrian, Grand Prix Pterodactyl\t1. e4 g6 2. Nc3 Bg7 3. f4 c5 4. Nf3 Qa5\nB06\tPterodactyl Defense: Austrian, Pteranodon\t1. e4 g6 2. d4 Bg7 3. f4 c5 4. c3 Qa5\nB06\tPterodactyl Defense: Eastern, Anhanguera\t1. e4 g6 2. d4 Bg7 3. Nc3 c5 4. Be3\nB06\tPterodactyl Defense: Eastern, Benoni\t1. d4 g6 2. e4 Bg7 3. Nc3 c5 4. d5\nB06\tPterodactyl Defense: Eastern, Benoni Pterodactyl\t1. d4 g6 2. Nc3 Bg7 3. e4 c5 4. d5 Qa5\nB06\tPterodactyl Defense: Eastern, Pterodactyl\t1. e4 g6 2. d4 Bg7 3. Nc3 c5 4. dxc5 Qa5\nB06\tPterodactyl Defense: Eastern, Rhamphorhynchus\t1. e4 g6 2. d4 Bg7 3. Nc3 c5 4. dxc5\nB06\tPterodactyl Defense: Fianchetto, King Pterodactyl\t1. e4 g6 2. d4 Bg7 3. g3 c5 4. Nf3 Qa5+\nB06\tPterodactyl Defense: Fianchetto, Rhamphorhynchus\t1. e4 g6 2. d4 Bg7 3. g3 c5 4. dxc5 Qa5+\nB06\tPterodactyl Defense: Western, Anhanguera\t1. e4 g6 2. d4 Bg7 3. Nf3 c5 4. Be3 Qa5+\nB06\tRat Defense: Accelerated Gurgenidze\t1. e4 g6 2. d4 d6 3. Nc3 c6\nB07\tCzech Defense\t1. e4 d6 2. d4 Nf6 3. Nc3 c6\nB07\tKing's Pawn Game: Maróczy Defense\t1. e4 d6 2. d4 e5\nB07\tLion Defense\t1. e4 d6 2. d4 Nf6 3. Nc3 Nbd7\nB07\tLion Defense: Anti-Philidor\t1. e4 d6 2. d4 Nf6 3. Nc3 Nbd7 4. f4\nB07\tLion Defense: Anti-Philidor, Lion's Cave\t1. e4 d6 2. d4 Nf6 3. Nc3 Nbd7 4. f4 e5\nB07\tLion Defense: Bayonet Attack\t1. e4 d6 2. d4 Nf6 3. Nc3 Nbd7 4. g4\nB07\tModern Defense: Geller's System\t1. e4 g6 2. d4 Bg7 3. Nf3 d6 4. c3\nB07\tPirc Defense\t1. e4 d6 2. d4 Nf6 3. Nc3 g6\nB07\tPirc Defense: Byrne Variation\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Bg5\nB07\tPirc Defense: Kholmov System\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Bc4\nB07\tPirc Defense: Sveshnikov System\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. g3\nB08\tPirc Defense: Classical Variation\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3\nB08\tPirc Defense: Classical Variation\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3 Bg7\nB09\tPirc Defense: Austrian Attack\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. f4\nB10\tCaro-Kann Defense\t1. e4 c6\nB10\tCaro-Kann Defense\t1. e4 c6 2. Nc3\nB10\tCaro-Kann Defense\t1. e4 c6 2. Nc3 d5\nB10\tCaro-Kann Defense: Accelerated Panov Attack\t1. e4 c6 2. c4\nB10\tCaro-Kann Defense: Accelerated Panov Attack\t1. e4 c6 2. c4 d5\nB10\tCaro-Kann Defense: Accelerated Panov Attack, Modern Variation\t1. e4 c6 2. c4 d5 3. exd5 cxd5 4. cxd5 Nf6\nB10\tCaro-Kann Defense: Accelerated Panov Attack, Open Variation\t1. e4 c6 2. c4 e5\nB10\tCaro-Kann Defense: Accelerated Panov Attack, Pseudo-Scandinavian\t1. e4 c6 2. c4 d5 3. exd5 Qxd5\nB10\tCaro-Kann Defense: Accelerated Panov Attack, Van Weersel Attack\t1. e4 c6 2. c4 d5 3. cxd5 cxd5 4. Qb3\nB10\tCaro-Kann Defense: Apocalypse Attack\t1. e4 c6 2. Nf3 d5 3. exd5 cxd5 4. Ne5\nB10\tCaro-Kann Defense: Breyer Variation\t1. e4 c6 2. d3\nB10\tCaro-Kann Defense: Dinic Gambit\t1. e4 c6 2. Nf3 d5 3. d3 dxe4 4. Ng5\nB10\tCaro-Kann Defense: Endgame Offer\t1. e4 c6 2. Nf3 d5 3. d3\nB10\tCaro-Kann Defense: Euwe Attack\t1. e4 c6 2. b3\nB10\tCaro-Kann Defense: Goldman Variation\t1. e4 c6 2. Nc3 d5 3. Qf3\nB10\tCaro-Kann Defense: Hector Gambit\t1. e4 c6 2. Nc3 d5 3. Nf3 dxe4 4. Ng5\nB10\tCaro-Kann Defense: Hillbilly Attack\t1. e4 c6 2. Bc4\nB10\tCaro-Kann Defense: Hillbilly Attack, Schaeffer Gambit\t1. e4 c6 2. Bc4 d5 3. Bb3 dxe4 4. Qh5\nB10\tCaro-Kann Defense: Labahn Attack\t1. e4 c6 2. b4\nB10\tCaro-Kann Defense: Labahn Attack, Double Gambit\t1. e4 c6 2. b4 d5 3. b5\nB10\tCaro-Kann Defense: Labahn Attack, Polish Variation\t1. e4 c6 2. b4 e5 3. Bb2\nB10\tCaro-Kann Defense: Scorpion-Horus Gambit\t1. e4 c6 2. Nc3 d5 3. d3 dxe4 4. Bg5\nB10\tCaro-Kann Defense: Spike Variation\t1. e4 c6 2. g4\nB10\tCaro-Kann Defense: Spike Variation, Scorpion-Grob Gambit\t1. e4 c6 2. g4 d5 3. Nc3 dxe4 4. d3\nB10\tCaro-Kann Defense: St. Patrick's Attack\t1. e4 c6 2. Nc3 d5 3. h3\nB10\tCaro-Kann Defense: Toikkanen Gambit\t1. e4 c6 2. c4 d5 3. e5\nB10\tCaro-Kann Defense: Two Knights Attack\t1. e4 c6 2. Nc3 d5 3. Nf3\nB11\tCaro-Kann Defense: Two Knights Attack, Mindeno Variation\t1. e4 c6 2. Nc3 d5 3. Nf3 Bg4\nB11\tCaro-Kann Defense: Two Knights Attack, Mindeno Variation, Exchange Line\t1. e4 c6 2. Nc3 d5 3. Nf3 Bg4 4. h3 Bxf3\nB11\tCaro-Kann Defense: Two Knights Attack, Mindeno Variation, Retreat Line\t1. e4 c6 2. Nc3 d5 3. Nf3 Bg4 4. h3 Bh5\nB12\tCaro-Kann Defense\t1. e4 c6 2. d4\nB12\tCaro-Kann Defense\t1. e4 c6 2. d4 d5\nB12\tCaro-Kann Defense: Advance Variation\t1. e4 c6 2. d4 d5 3. e5\nB12\tCaro-Kann Defense: Advance Variation, Bayonet Attack\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. g4\nB12\tCaro-Kann Defense: Advance Variation, Botvinnik-Carls Defense\t1. e4 c6 2. d4 d5 3. e5 c5\nB12\tCaro-Kann Defense: Advance Variation, Bronstein Variation\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. Ne2\nB12\tCaro-Kann Defense: Advance Variation, Prins Attack\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. b4\nB12\tCaro-Kann Defense: Advance Variation, Short Variation\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nf3\nB12\tCaro-Kann Defense: Advance Variation, Tal Variation\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. h4\nB12\tCaro-Kann Defense: Advance Variation, Van der Wiel Attack\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nc3\nB12\tCaro-Kann Defense: Advance Variation, Van der Wiel Attack, Dreyev Defense\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nc3 Qb6\nB12\tCaro-Kann Defense: De Bruycker Defense\t1. e4 c6 2. d4 Na6\nB12\tCaro-Kann Defense: De Bruycker Defense\t1. e4 c6 2. d4 Na6 3. Nc3 Nc7\nB12\tCaro-Kann Defense: Edinburgh Variation\t1. e4 c6 2. d4 d5 3. Nd2 Qb6\nB12\tCaro-Kann Defense: Maróczy Variation\t1. e4 c6 2. d4 d5 3. f3\nB12\tCaro-Kann Defense: Masi Variation\t1. e4 c6 2. d4 Nf6\nB12\tCaro-Kann Defense: Massachusetts Defense\t1. e4 c6 2. d4 f5\nB12\tCaro-Kann Defense: Mieses Gambit\t1. e4 c6 2. d4 d5 3. Be3\nB12\tCaro-Kann Defense: Modern Variation\t1. e4 c6 2. d4 d5 3. Nd2\nB12\tCaro-Kann Defense: Ulysses Gambit\t1. e4 c6 2. d4 d5 3. Nf3 dxe4 4. Ng5\nB13\tCaro-Kann Defense: Exchange Variation\t1. e4 c6 2. d4 d5 3. exd5\nB13\tCaro-Kann Defense: Exchange Variation\t1. e4 c6 2. d4 d5 3. exd5 cxd5\nB13\tCaro-Kann Defense: Exchange Variation\t1. e4 c6 2. d4 d5 3. exd5 cxd5 4. Bf4\nB13\tCaro-Kann Defense: Exchange Variation\t1. e4 c6 2. d4 d5 3. exd5 cxd5 4. Nf3 Nc6\nB13\tCaro-Kann Defense: Exchange Variation, Bulla Attack\t1. e4 c6 2. d4 d5 3. exd5 cxd5 4. g4\nB13\tCaro-Kann Defense: Panov Attack\t1. e4 c6 2. d4 d5 3. exd5 cxd5 4. c4\nB15\tCaro-Kann Defense\t1. e4 c6 2. d4 d5 3. Nc3\nB15\tCaro-Kann Defense\t1. e4 c6 2. d4 d5 3. Nc3 dxe4\nB15\tCaro-Kann Defense: Campomanes Attack\t1. e4 c6 2. d4 d5 3. Nc3 Nf6\nB15\tCaro-Kann Defense: Gurgenidze Counterattack\t1. e4 c6 2. d4 d5 3. Nc3 b5\nB15\tCaro-Kann Defense: Gurgenidze System\t1. e4 c6 2. d4 d5 3. Nc3 g6\nB15\tCaro-Kann Defense: Main Line\t1. e4 c6 2. d4 d5 3. Nd2 dxe4 4. Nxe4\nB15\tCaro-Kann Defense: Rasa-Studier Gambit\t1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. f3\nB15\tCaro-Kann Defense: von Hennig Gambit\t1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Bc4\nB16\tCaro-Kann Defense: Finnish Variation\t1. e4 c6 2. d4 d5 3. Nd2 dxe4 4. Nxe4 h6\nB17\tCaro-Kann Defense: Karpov Variation\t1. e4 c6 2. d4 d5 3. Nd2 dxe4 4. Nxe4 Nd7\nB18\tCaro-Kann Defense: Classical Variation\t1. e4 c6 2. d4 d5 3. Nd2 dxe4 4. Nxe4 Bf5\nB20\tSicilian Defense\t1. e4 c5\nB20\tSicilian Defense: Amazon Attack\t1. e4 c5 2. Qg4\nB20\tSicilian Defense: Big Clamp Formation\t1. e4 c5 2. d3 Nc6 3. c3 d6 4. f4\nB20\tSicilian Defense: Bowdler Attack\t1. e4 c5 2. Bc4\nB20\tSicilian Defense: Brick Variation\t1. e4 c5 2. Nh3\nB20\tSicilian Defense: Czerniak Attack\t1. e4 c5 2. b3\nB20\tSicilian Defense: Czerniak Attack, Queen Fianchetto Variation\t1. e4 c5 2. b3 b6\nB20\tSicilian Defense: Euwe Attack, Prins Gambit\t1. e4 c5 2. b3 d5 3. Bb2\nB20\tSicilian Defense: Gloria Variation\t1. e4 c5 2. c4 d6 3. Nc3 Nc6 4. g3 h5\nB20\tSicilian Defense: Grob Variation\t1. e4 c5 2. g4\nB20\tSicilian Defense: Keres Variation\t1. e4 c5 2. Ne2\nB20\tSicilian Defense: King David's Opening\t1. e4 c5 2. Ke2\nB20\tSicilian Defense: Kronberger Variation\t1. e4 c5 2. Na3\nB20\tSicilian Defense: Kronberger Variation, Nemeth Gambit\t1. e4 c5 2. Na3 Nc6 3. d4 cxd4 4. Bc4\nB20\tSicilian Defense: Lasker-Dunne Attack\t1. e4 c5 2. g3\nB20\tSicilian Defense: Mengarini Variation\t1. e4 c5 2. a3\nB20\tSicilian Defense: Myers Attack, with a4\t1. e4 c5 2. a4\nB20\tSicilian Defense: Myers Attack, with h4\t1. e4 c5 2. h4\nB20\tSicilian Defense: Staunton-Cochrane Variation\t1. e4 c5 2. c4\nB20\tSicilian Defense: Wing Gambit\t1. e4 c5 2. b4\nB20\tSicilian Defense: Wing Gambit, Abrahams Variation\t1. e4 c5 2. b4 cxb4 3. Bb2\nB20\tSicilian Defense: Wing Gambit, Carlsbad Variation\t1. e4 c5 2. b4 cxb4 3. a3 bxa3\nB20\tSicilian Defense: Wing Gambit, Marshall Variation\t1. e4 c5 2. b4 cxb4 3. a3\nB20\tSicilian Defense: Wing Gambit, Santasiere Variation\t1. e4 c5 2. b4 cxb4 3. c4\nB21\tBird Opening: Dutch Variation, Batavo Gambit\t1. e4 c5 2. f4 d5 3. Nf3 dxe4\nB21\tSicilian Defense: Halasz Gambit\t1. e4 c5 2. d4 cxd4 3. f4\nB21\tSicilian Defense: McDonnell Attack\t1. e4 c5 2. f4\nB21\tSicilian Defense: McDonnell Attack, Tal Gambit\t1. e4 c5 2. f4 d5 3. exd5 Nf6\nB21\tSicilian Defense: McDonnell Attack, Toilet Variation\t1. e4 c5 2. f4 d5 3. Nc3\nB21\tSicilian Defense: Morphy Gambit\t1. e4 c5 2. d4 cxd4 3. Nf3\nB21\tSicilian Defense: Morphy Gambit, Andreaschek Gambit\t1. e4 c5 2. d4 cxd4 3. Nf3 e5 4. c3\nB21\tSicilian Defense: Smith-Morra Gambit\t1. e4 c5 2. d4\nB21\tSicilian Defense: Smith-Morra Gambit\t1. e4 c5 2. d4 cxd4 3. c3\nB21\tSicilian Defense: Smith-Morra Gambit Accepted\t1. e4 c5 2. d4 cxd4 3. c3 dxc3\nB21\tSicilian Defense: Smith-Morra Gambit Accepted, Danish Variation\t1. e4 c5 2. d4 cxd4 3. c3 dxc3 4. Nf3\nB21\tSicilian Defense: Smith-Morra Gambit Declined, Alapin Formation\t1. e4 c5 2. d4 cxd4 3. c3 Nf6\nB21\tSicilian Defense: Smith-Morra Gambit Declined, Center Formation\t1. e4 c5 2. d4 cxd4 3. c3 e5\nB21\tSicilian Defense: Smith-Morra Gambit Declined, Dubois Variation\t1. e4 c5 2. d4 cxd4 3. c3 d3 4. c4\nB21\tSicilian Defense: Smith-Morra Gambit Declined, Push Variation\t1. e4 c5 2. d4 cxd4 3. c3 d3\nB21\tSicilian Defense: Smith-Morra Gambit Declined, Scandinavian Formation\t1. e4 c5 2. d4 cxd4 3. c3 d5\nB21\tSicilian Defense: Smith-Morra Gambit Declined, Wing Formation\t1. e4 c5 2. d4 cxd4 3. c3 Qa5\nB22\tSicilian Defense: Alapin Variation\t1. e4 c5 2. c3\nB22\tSicilian Defense: Alapin Variation, Anti-Alapin Gambit\t1. e4 c5 2. c3 d5 3. exd5 Nf6\nB22\tSicilian Defense: Alapin Variation, Barmen Defense\t1. e4 c5 2. c3 d5 3. exd5 Qxd5\nB22\tSicilian Defense: Alapin Variation, Smith-Morra Declined\t1. e4 c5 2. c3 Nf6 3. e5 Nd5 4. d4 cxd4\nB23\tSicilian Defense: Closed\t1. e4 c5 2. Nc3\nB23\tSicilian Defense: Closed\t1. e4 c5 2. Nc3 e6\nB23\tSicilian Defense: Closed\t1. e4 c5 2. Nc3 e6 3. g3\nB23\tSicilian Defense: Closed, Chameleon Variation\t1. e4 c5 2. Nc3 Nc6 3. Nge2\nB23\tSicilian Defense: Closed, Grob Attack\t1. e4 c5 2. Nc3 Nc6 3. g4\nB23\tSicilian Defense: Closed, Korchnoi Defense\t1. e4 c5 2. Nc3 e6 3. g3 d5\nB23\tSicilian Defense: Closed, Portland Attack\t1. e4 c5 2. Nc3 Nc6 3. d3 g6 4. g4\nB23\tSicilian Defense: Closed, Traditional\t1. e4 c5 2. Nc3 Nc6\nB23\tSicilian Defense: Grand Prix Attack\t1. e4 c5 2. Nc3 Nc6 3. f4\nB24\tSicilian Defense: Closed\t1. e4 c5 2. Nc3 Nc6 3. g3 g6\nB24\tSicilian Defense: Closed\t1. e4 c5 2. Nc3 Nc6 3. g3 g6 4. Bg2 Bg7\nB24\tSicilian Defense: Closed, Fianchetto Variation\t1. e4 c5 2. Nc3 Nc6 3. g3\nB27\tModern Defense: Pterodactyl Variation\t1. e4 c5 2. Nf3 g6 3. d4 Bg7 4. Nc3 Qa5\nB27\tPterodactyl Defense: Western, Pterodactyl\t1. e4 c5 2. Nf3 g6 3. c3 Bg7 4. d4 Qa5\nB27\tPterodactyl Defense: Western, Rhamphorhynchus\t1. e4 c5 2. Nf3 g6 3. d4 Bg7 4. dxc5 Qa5+\nB27\tSicilian Defense\t1. e4 c5 2. Nf3\nB27\tSicilian Defense: Acton Extension\t1. e4 c5 2. Nf3 g6 3. c4 Bh6\nB27\tSicilian Defense: Brussels Gambit\t1. e4 c5 2. Nf3 f5\nB27\tSicilian Defense: Bücker Variation\t1. e4 c5 2. Nf3 h6\nB27\tSicilian Defense: Double-Dutch Gambit\t1. e4 c5 2. Nf3 f5 3. exf5 Nh6\nB27\tSicilian Defense: Frederico Variation\t1. e4 c5 2. Nf3 g6 3. d4 f5\nB27\tSicilian Defense: Hyperaccelerated Dragon\t1. e4 c5 2. Nf3 g6\nB27\tSicilian Defense: Hyperaccelerated Dragon\t1. e4 c5 2. Nf3 g6 3. d4\nB27\tSicilian Defense: Hyperaccelerated Pterodactyl\t1. e4 c5 2. Nf3 g6 3. d4 Bg7\nB27\tSicilian Defense: Jalalabad Variation\t1. e4 c5 2. Nf3 e5\nB27\tSicilian Defense: Katalimov Variation\t1. e4 c5 2. Nf3 b6\nB27\tSicilian Defense: Mongoose Variation\t1. e4 c5 2. Nf3 Qa5\nB27\tSicilian Defense: Polish Gambit\t1. e4 c5 2. Nf3 b5\nB27\tSicilian Defense: Quinteros Variation\t1. e4 c5 2. Nf3 Qc7\nB28\tSicilian Defense: O'Kelly Variation\t1. e4 c5 2. Nf3 a6\nB28\tSicilian Defense: O'Kelly Variation, Aronin System\t1. e4 c5 2. Nf3 a6 3. Be2\nB28\tSicilian Defense: O'Kelly Variation, Kieseritzky System\t1. e4 c5 2. Nf3 a6 3. b3\nB28\tSicilian Defense: O'Kelly Variation, Maróczy Bind\t1. e4 c5 2. Nf3 a6 3. c4\nB28\tSicilian Defense: O'Kelly Variation, Maróczy Bind, Paulsen Line\t1. e4 c5 2. Nf3 a6 3. c4 e6\nB28\tSicilian Defense: O'Kelly Variation, Maróczy Bind, Robatsch Line\t1. e4 c5 2. Nf3 a6 3. c4 d6\nB28\tSicilian Defense: O'Kelly Variation, Normal System\t1. e4 c5 2. Nf3 a6 3. d4\nB28\tSicilian Defense: O'Kelly Variation, Normal System, Cortlever Gambit\t1. e4 c5 2. Nf3 a6 3. d4 cxd4 4. Bc4\nB28\tSicilian Defense: O'Kelly Variation, Normal System, Smith-Morra Line\t1. e4 c5 2. Nf3 a6 3. d4 cxd4 4. c3\nB28\tSicilian Defense: O'Kelly Variation, Normal System, Taimanov Line\t1. e4 c5 2. Nf3 a6 3. d4 cxd4 4. Nxd4 e5\nB28\tSicilian Defense: O'Kelly Variation, Normal System, Zagorovsky Line\t1. e4 c5 2. Nf3 a6 3. d4 cxd4 4. Qxd4\nB28\tSicilian Defense: O'Kelly Variation, Quiet System\t1. e4 c5 2. Nf3 a6 3. d3\nB28\tSicilian Defense: O'Kelly Variation, Réti System\t1. e4 c5 2. Nf3 a6 3. g3\nB28\tSicilian Defense: O'Kelly Variation, Venice System\t1. e4 c5 2. Nf3 a6 3. c3\nB28\tSicilian Defense: O'Kelly Variation, Venice System, Barcza Line\t1. e4 c5 2. Nf3 a6 3. c3 Nf6\nB28\tSicilian Defense: O'Kelly Variation, Venice System, Gambit Line\t1. e4 c5 2. Nf3 a6 3. c3 d5 4. exd5 Nf6\nB28\tSicilian Defense: O'Kelly Variation, Venice System, Ljubojevic Line\t1. e4 c5 2. Nf3 a6 3. c3 b5\nB28\tSicilian Defense: O'Kelly Variation, Venice System, Steiner Line\t1. e4 c5 2. Nf3 a6 3. c3 d6\nB28\tSicilian Defense: O'Kelly Variation, Wing Gambit\t1. e4 c5 2. Nf3 a6 3. b4\nB28\tSicilian Defense: O'Kelly Variation, Yerevan System\t1. e4 c5 2. Nf3 a6 3. Nc3\nB29\tSicilian Defense: Nimzowitsch Variation\t1. e4 c5 2. Nf3 Nf6\nB29\tSicilian Defense: Nimzowitsch Variation, Advance Variation\t1. e4 c5 2. Nf3 Nf6 3. e5\nB29\tSicilian Defense: Nimzowitsch Variation, Closed Variation\t1. e4 c5 2. Nf3 Nf6 3. Nc3\nB29\tSicilian Defense: Nimzowitsch Variation, Exchange Variation\t1. e4 c5 2. Nf3 Nf6 3. e5 Nd5 4. Nc3 Nxc3\nB30\tSicilian Defense: Closed, Anti-Sveshnikov Variation\t1. e4 c5 2. Nf3 Nc6 3. Nc3 e5\nB30\tSicilian Defense: Nyezhmetdinov-Rossolimo Attack\t1. e4 c5 2. Nf3 Nc6 3. Bb5\nB30\tSicilian Defense: Nyezhmetdinov-Rossolimo Attack, Brooklyn Retreat Defense\t1. e4 c5 2. Nf3 Nc6 3. Bb5 Nb8\nB30\tSicilian Defense: Nyezhmetdinov-Rossolimo Attack, San Francisco Gambit\t1. e4 c5 2. Nf3 Nc6 3. Bb5 Na5 4. b4\nB30\tSicilian Defense: Old Sicilian\t1. e4 c5 2. Nf3 Nc6\nB30\tSicilian Defense: Portsmouth Gambit\t1. e4 c5 2. Nf3 Nc6 3. b4\nB31\tSicilian Defense: Nyezhmetdinov-Rossolimo Attack, Fianchetto Variation\t1. e4 c5 2. Nf3 Nc6 3. Bb5 g6\nB32\tSicilian Defense: Accelerated Dragon\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 g6\nB32\tSicilian Defense: Flohr Variation\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Qc7\nB32\tSicilian Defense: Franco-Sicilian Variation\t1. e4 c5 2. Nf3 Nc6 3. d4 e6\nB32\tSicilian Defense: Godiva Variation\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Qb6\nB32\tSicilian Defense: Löwenthal Variation\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 e5\nB32\tSicilian Defense: Nimzo-American Variation\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 d5\nB32\tSicilian Defense: Open\t1. e4 c5 2. Nf3 Nc6 3. d4\nB32\tSicilian Defense: Open\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4\nB32\tSicilian Defense: Open\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4\nB33\tSicilian Defense: Open\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Nf6\nB40\tSicilian Defense: Delayed Alapin Variation, with e6\t1. e4 c5 2. Nf3 e6 3. c3\nB40\tSicilian Defense: Drazic Variation\t1. e4 c5 2. Nf3 e6 3. d4 a6\nB40\tSicilian Defense: French Variation\t1. e4 c5 2. Nf3 e6\nB40\tSicilian Defense: French Variation, Normal\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Nf6\nB40\tSicilian Defense: French Variation, Open\t1. e4 c5 2. Nf3 e6 3. d4 cxd4\nB40\tSicilian Defense: French Variation, Westerinen Attack\t1. e4 c5 2. Nf3 e6 3. b3\nB40\tSicilian Defense: Kramnik Variation\t1. e4 c5 2. Nf3 e6 3. c4\nB40\tSicilian Defense: Kveinis Variation\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Qb6\nB40\tSicilian Defense: Marshall Counterattack\t1. e4 c5 2. Nf3 e6 3. d4 d5\nB40\tSicilian Defense: Paulsen-Basman Defense\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Bc5\nB40\tSicilian Defense: Smith-Morra Gambit Deferred\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. c3\nB40\tSicilian Defense: Wing Gambit Deferred\t1. e4 c5 2. Nf3 e6 3. b4\nB41\tSicilian Defense: Kan Variation\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 a6\nB44\tSicilian Defense: Taimanov Variation\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Nc6\nB50\tSicilian Defense\t1. e4 c5 2. Nf3 d6 3. d4\nB50\tSicilian Defense\t1. e4 c5 2. Nf3 d6 3. d4 cxd4\nB50\tSicilian Defense: Delayed Alapin Variation, with d6\t1. e4 c5 2. Nf3 d6 3. c3\nB50\tSicilian Defense: Kopec System\t1. e4 c5 2. Nf3 d6 3. Bd3\nB50\tSicilian Defense: Kotov Gambit\t1. e4 c5 2. Nf3 d6 3. g3 b5\nB50\tSicilian Defense: Modern Variations\t1. e4 c5 2. Nf3 d6\nB50\tSicilian Defense: Modern Variations, Anti-Qxd4 Move Order\t1. e4 c5 2. Nf3 d6 3. d4 Nf6\nB50\tSicilian Defense: Modern Variations, Anti-Qxd4 Move Order Accepted\t1. e4 c5 2. Nf3 d6 3. d4 Nf6 4. dxc5 Nxe4\nB50\tSicilian Defense: Modern Variations, Tartakower\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. c3\nB50\tSicilian Defense: Wing Gambit, Deferred Variation\t1. e4 c5 2. Nf3 d6 3. b4\nB51\tSicilian Defense: Moscow Variation\t1. e4 c5 2. Nf3 d6 3. Bb5+\nB52\tSicilian Defense: Moscow Variation, Main Line\t1. e4 c5 2. Nf3 d6 3. Bb5+ Bd7\nB53\tSicilian Defense: Chekhover Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Qxd4\nB54\tSicilian Defense: Dragon Variation, Accelerated Dragon\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 g6\nB54\tSicilian Defense: Modern Variations, Main Line\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6\nC00\tFrench Defense\t1. e4 e6\nC00\tFrench Defense\t1. e4 e6 2. d4 d5\nC00\tFrench Defense: Alapin Gambit\t1. e4 e6 2. d4 d5 3. Be3\nC00\tFrench Defense: Baeuerle Gambit\t1. e4 e6 2. d4 b5\nC00\tFrench Defense: Banzai-Leong Gambit\t1. e4 e6 2. b4\nC00\tFrench Defense: Banzai-Leong Gambit, Pinova Gambit\t1. e4 e6 2. b4 Bxb4 3. e5\nC00\tFrench Defense: Bird Invitation\t1. e4 e6 2. Bb5\nC00\tFrench Defense: Carlson Gambit\t1. e4 e6 2. d4 d5 3. Nf3 dxe4 4. Ne5\nC00\tFrench Defense: Chigorin Variation\t1. e4 e6 2. Qe2\nC00\tFrench Defense: Diemer-Duhm Gambit\t1. e4 e6 2. d4 d5 3. c4\nC00\tFrench Defense: Diemer-Duhm Gambit Accepted\t1. e4 e6 2. d4 d5 3. c4 dxe4\nC00\tFrench Defense: Franco-Hiva Gambit\t1. e4 e6 2. d4 f5\nC00\tFrench Defense: Franco-Hiva Gambit Accepted\t1. e4 e6 2. d4 f5 3. exf5\nC00\tFrench Defense: Franco-Sicilian Defense\t1. e4 e6 2. d4 c5\nC00\tFrench Defense: Hoffmann Gambit\t1. e4 e6 2. d4 d5 3. Qe2 e5 4. f4 exf4\nC00\tFrench Defense: Horwitz Attack\t1. e4 e6 2. b3\nC00\tFrench Defense: Horwitz Attack, Papa-Ticulat Gambit\t1. e4 e6 2. b3 d5 3. Bb2\nC00\tFrench Defense: King's Indian Attack\t1. e4 e6 2. d3\nC00\tFrench Defense: King's Indian Attack, Franco-Hiva Gambit\t1. e4 e6 2. d3 f5\nC00\tFrench Defense: Knight Variation\t1. e4 e6 2. Nf3\nC00\tFrench Defense: Knight Variation, Franco-Hiva Gambit\t1. e4 e6 2. Nf3 f5\nC00\tFrench Defense: La Bourdonnais Variation\t1. e4 e6 2. f4\nC00\tFrench Defense: La Bourdonnais Variation, Reuter Gambit\t1. e4 e6 2. f4 d5 3. Nf3 dxe4\nC00\tFrench Defense: Mediterranean Defense\t1. e4 e6 2. d4 Nf6\nC00\tFrench Defense: Morphy Gambit\t1. e4 e6 2. d4 d5 3. Nh3\nC00\tFrench Defense: Normal Variation\t1. e4 e6 2. d4\nC00\tFrench Defense: Orthoschnapp Gambit\t1. e4 e6 2. c4 d5 3. cxd5 exd5 4. Qb3\nC00\tFrench Defense: Pelikan Variation\t1. e4 e6 2. Nc3 d5 3. f4\nC00\tFrench Defense: Perseus Gambit\t1. e4 e6 2. d4 d5 3. Nf3\nC00\tFrench Defense: Queen's Knight\t1. e4 e6 2. Nc3\nC00\tFrench Defense: Réti-Spielmann Attack\t1. e4 e6 2. g3\nC00\tFrench Defense: Schlechter Variation\t1. e4 e6 2. d4 d5 3. Bd3\nC00\tFrench Defense: St. George Defense\t1. e4 e6 2. d4 a6\nC00\tFrench Defense: St. George Defense, Sanky-George Gambit\t1. e4 e6 2. d4 a6 3. c4 b5\nC00\tFrench Defense: St. George Defense, St. George Gambit\t1. e4 e6 2. d4 a6 3. c4 b5 4. cxb5 axb5\nC00\tFrench Defense: St. George Defense, Three Pawn Attack\t1. e4 e6 2. d4 a6 3. c4\nC00\tFrench Defense: Steiner Variation\t1. e4 e6 2. c4\nC00\tFrench Defense: Steinitz Attack\t1. e4 e6 2. e5\nC00\tFrench Defense: Two Knights Variation\t1. e4 e6 2. Nf3 d5 3. Nc3\nC00\tFrench Defense: Wing Gambit\t1. e4 e6 2. Nf3 d5 3. e5 c5 4. b4\nC00\tRat Defense: Small Center Defense\t1. d4 e6 2. e4 d6\nC01\tFrench Defense: Exchange Variation\t1. e4 e6 2. d4 d5 3. exd5\nC01\tFrench Defense: Exchange Variation\t1. e4 e6 2. d4 d5 3. exd5 exd5 4. Nf3\nC01\tFrench Defense: Exchange Variation\t1. e4 e6 2. d4 d5 3. exd5 exd5 4. Nc3\nC01\tFrench Defense: Exchange Variation, Monte Carlo Variation\t1. e4 e6 2. d4 d5 3. exd5 exd5 4. c4\nC02\tFrench Defense: Advance Variation\t1. e4 e6 2. d4 d5 3. e5\nC02\tFrench Defense: Advance Variation\t1. e4 e6 2. d4 d5 3. e5 c5\nC02\tFrench Defense: Advance Variation\t1. e4 e6 2. d4 d5 3. e5 c5 4. c3\nC02\tFrench Defense: Advance Variation\t1. e4 e6 2. d4 d5 3. e5 c5 4. c3 Nc6\nC02\tFrench Defense: Advance Variation, Extended Bishop Swap\t1. e4 e6 2. d4 d5 3. e5 Bd7\nC02\tFrench Defense: Advance Variation, Frenkel Gambit\t1. e4 e6 2. d4 d5 3. e5 c5 4. b4\nC02\tFrench Defense: Advance Variation, Nimzowitsch Attack\t1. e4 e6 2. d4 d5 3. e5 c5 4. Qg4\nC02\tFrench Defense: Advance Variation, Nimzowitsch System\t1. e4 e6 2. d4 d5 3. e5 c5 4. Nf3\nC02\tFrench Defense: Advance Variation, Steinitz Variation\t1. e4 e6 2. d4 d5 3. e5 c5 4. dxc5\nC03\tFrench Defense: Tarrasch Variation\t1. e4 e6 2. d4 d5 3. Nd2\nC03\tFrench Defense: Tarrasch Variation, Guimard Defense\t1. e4 e6 2. d4 d5 3. Nd2 Nc6\nC03\tFrench Defense: Tarrasch Variation, Haberditz Variation\t1. e4 e6 2. d4 d5 3. Nd2 f5\nC03\tFrench Defense: Tarrasch Variation, Modern System\t1. e4 e6 2. d4 d5 3. Nd2 a6\nC03\tFrench Defense: Tarrasch Variation, Morozevich Variation\t1. e4 e6 2. d4 d5 3. Nd2 Be7\nC04\tFrench Defense: Tarrasch Variation, Guimard Defense, Main Line\t1. e4 e6 2. d4 d5 3. Nd2 Nc6 4. Ngf3 Nf6\nC05\tFrench Defense: Tarrasch Variation, Closed Variation\t1. e4 e6 2. d4 d5 3. Nd2 Nf6\nC07\tFrench Defense: Tarrasch Variation, Chistyakov Defense\t1. e4 e6 2. d4 d5 3. Nd2 c5 4. exd5 Qxd5\nC07\tFrench Defense: Tarrasch Variation, Open System\t1. e4 e6 2. d4 d5 3. Nd2 c5\nC07\tFrench Defense: Tarrasch Variation, Open System, Euwe-Keres Line\t1. e4 e6 2. d4 d5 3. Nd2 c5 4. Ngf3\nC07\tFrench Defense: Tarrasch Variation, Open System, Shaposhnikov Gambit\t1. e4 e6 2. d4 d5 3. Nd2 c5 4. exd5 Nf6\nC07\tFrench Defense: Tarrasch Variation, Open System, Süchting Line\t1. e4 e6 2. d4 d5 3. Nd2 c5 4. c3\nC08\tFrench Defense: Tarrasch Variation, Open System\t1. e4 e6 2. d4 d5 3. Nd2 c5 4. exd5 exd5\nC10\tFrench Defense: Hecht-Reefschläger Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nc6\nC10\tFrench Defense: Marshall Gambit\t1. e4 e6 2. d4 d5 3. Nc3 c5\nC10\tFrench Defense: Paulsen Variation\t1. e4 e6 2. d4 d5 3. Nc3\nC10\tFrench Defense: Rubinstein Variation\t1. e4 e6 2. d4 d5 3. Nc3 dxe4\nC10\tFrench Defense: Rubinstein Variation, Blackburne Defense\t1. e4 e6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Nd7\nC10\tFrench Defense: Rubinstein Variation, Ellis Gambit\t1. e4 e6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 e5\nC10\tFrench Defense: Rubinstein Variation, Maric Variation\t1. e4 e6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Qd5\nC11\tFrench Defense: Classical Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6\nC11\tFrench Defense: Classical Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5\nC11\tFrench Defense: Classical Variation, Burn Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5 dxe4\nC11\tFrench Defense: Classical Variation, Delayed Exchange Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. exd5\nC11\tFrench Defense: Classical Variation, Steinitz Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. e5\nC11\tFrench Defense: Classical Variation, Swiss Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bd3\nC11\tFrench Defense: Henneberger Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Be3\nC12\tFrench Defense: McCutcheon Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5 Bb4\nC13\tFrench Defense: Classical Variation, Normal Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5 Be7\nC15\tFrench Defense: Winawer Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4\nC15\tFrench Defense: Winawer Variation, Alekhine-Maróczy Gambit\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. Ne2\nC15\tFrench Defense: Winawer Variation, Delayed Exchange Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. exd5\nC15\tFrench Defense: Winawer Variation, Fingerslip Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. Bd2\nC16\tFrench Defense: Winawer Variation, Advance Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5\nC16\tFrench Defense: Winawer Variation, Petrosian Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5 Qd7\nC17\tFrench Defense: Winawer Variation, Advance Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5 c5\nC20\tBarnes Opening: Walkerling\t1. f3 e5 2. e4 Nf6 3. Bc4\nC20\tBongcloud Attack\t1. e4 e5 2. Ke2\nC20\tCenter Game\t1. e4 e5 2. d4\nC20\tEnglish Opening: The Whale\t1. e4 e5 2. c4\nC20\tKing's Pawn Game\t1. e4 e5\nC20\tKing's Pawn Game: Alapin Opening\t1. e4 e5 2. Ne2\nC20\tKing's Pawn Game: Bavarian Gambit\t1. e4 e5 2. c4 d5\nC20\tKing's Pawn Game: Beyer Gambit\t1. e4 e5 2. d4 d5\nC20\tKing's Pawn Game: Clam Variation, King's Gambit Reversed\t1. e4 e5 2. d3 f5\nC20\tKing's Pawn Game: Clam Variation, Radisch Gambit\t1. e4 e5 2. d3 Nf6 3. f4 Bc5\nC20\tKing's Pawn Game: King's Head Opening\t1. e4 e5 2. f3\nC20\tKing's Pawn Game: King's Head Opening\t1. e4 e5 2. f3 Nf6 3. Nc3\nC20\tKing's Pawn Game: Leonardis Variation\t1. e4 e5 2. d3\nC20\tKing's Pawn Game: MacLeod Attack\t1. e4 e5 2. c3\nC20\tKing's Pawn Game: MacLeod Attack, Lasa Gambit\t1. e4 e5 2. c3 f5\nC20\tKing's Pawn Game: MacLeod Attack, Norwalde Gambit\t1. e4 e5 2. c3 d5 3. Qh5 Bd6\nC20\tKing's Pawn Game: Mengarini's Opening\t1. e4 e5 2. a3\nC20\tKing's Pawn Game: Napoleon Attack\t1. e4 e5 2. Qf3\nC20\tKing's Pawn Game: Philidor Gambit\t1. e4 e5 2. d4 d6 3. dxe5 Bd7\nC20\tKing's Pawn Game: Tortoise Opening\t1. e4 e5 2. Bd3\nC20\tKing's Pawn Game: Wayward Queen Attack\t1. e4 e5 2. Qh5\nC20\tKing's Pawn Game: Wayward Queen Attack, Kiddie Countergambit\t1. e4 e5 2. Qh5 Nf6\nC20\tKing's Pawn Game: Weber Gambit\t1. e4 e5 2. d3 d5 3. exd5 c6 4. dxc6 Nxc6\nC20\tKing's Pawn Opening\t1. e4 e5 2. b3\nC20\tKing's Pawn Opening: Speers\t1. e4 e5 2. Qg4 Nf6 3. Qf5\nC20\tPortuguese Opening\t1. e4 e5 2. Bb5\nC20\tPortuguese Opening: Miguel Gambit\t1. e4 e5 2. Bb5 Bc5 3. b4\nC20\tPortuguese Opening: Portuguese Gambit\t1. e4 e5 2. Bb5 Nf6 3. d4\nC21\tCenter Game\t1. e4 e5 2. d4 exd4 3. Qxd4\nC21\tCenter Game Accepted\t1. e4 e5 2. d4 exd4\nC21\tCenter Game: Halasz-McDonnell Gambit\t1. e4 e5 2. d4 exd4 3. f4\nC21\tCenter Game: Kieseritzky Variation\t1. e4 e5 2. d4 exd4 3. Nf3\nC21\tCenter Game: Kieseritzky Variation\t1. e4 e5 2. d4 exd4 3. Nf3 c5\nC21\tCenter Game: Kieseritzky Variation\t1. e4 e5 2. d4 exd4 3. Nf3 c5 4. Bc4\nC21\tCenter Game: Lanc-Arnold Gambit\t1. e4 e5 2. d4 exd4 3. Nf3 Bc5 4. c3\nC21\tCenter Game: Ross Gambit\t1. e4 e5 2. d4 exd4 3. Bd3\nC21\tCenter Game: von der Lasa Gambit\t1. e4 e5 2. d4 exd4 3. Bc4\nC21\tDanish Gambit\t1. e4 e5 2. d4 exd4 3. c3\nC21\tDanish Gambit Accepted\t1. e4 e5 2. d4 exd4 3. c3 dxc3\nC21\tDanish Gambit Accepted: Svenonius Defense\t1. e4 e5 2. d4 exd4 3. c3 Ne7\nC21\tDanish Gambit Declined: Sörensen Defense\t1. e4 e5 2. d4 exd4 3. c3 d5\nC22\tCenter Game: Berger Variation\t1. e4 e5 2. d4 exd4 3. Qxd4 Nc6 4. Qe3 Nf6\nC22\tCenter Game: Hall Variation\t1. e4 e5 2. d4 exd4 3. Qxd4 Nc6 4. Qc4\nC22\tCenter Game: Normal Variation\t1. e4 e5 2. d4 exd4 3. Qxd4 Nc6\nC22\tCenter Game: Paulsen Attack Variation\t1. e4 e5 2. d4 exd4 3. Qxd4 Nc6 4. Qe3\nC22\tCenter Game: l'Hermet Variation\t1. e4 e5 2. d4 exd4 3. Qxd4 Nc6 4. Qe3 f5\nC23\tBishop's Opening\t1. e4 e5 2. Bc4\nC23\tBishop's Opening: Anderssen Gambit\t1. e4 e5 2. Bc4 b5 3. Bxb5 c6\nC23\tBishop's Opening: Boi Variation\t1. e4 e5 2. Bc4 Bc5\nC23\tBishop's Opening: Calabrese Countergambit\t1. e4 e5 2. Bc4 f5\nC23\tBishop's Opening: Calabrese Countergambit, Jaenisch Variation\t1. e4 e5 2. Bc4 f5 3. d3\nC23\tBishop's Opening: Khan Gambit\t1. e4 e5 2. Bc4 d5\nC23\tBishop's Opening: Lewis Countergambit\t1. e4 e5 2. Bc4 Bc5 3. c3 d5\nC23\tBishop's Opening: Lewis Countergambit\t1. e4 e5 2. Bc4 Bc5 3. c3 d5 4. Bxd5 Nf6\nC23\tBishop's Opening: Lewis Gambit\t1. e4 e5 2. Bc4 Bc5 3. d4\nC23\tBishop's Opening: Lopez Variation\t1. e4 e5 2. Bc4 Bc5 3. Qe2\nC23\tBishop's Opening: Lopez Variation, Lopez Gambit\t1. e4 e5 2. Bc4 Bc5 3. Qe2 Nf6 4. f4\nC23\tBishop's Opening: McDonnell Gambit\t1. e4 e5 2. Bc4 Bc5 3. b4\nC23\tBishop's Opening: McDonnell Gambit, La Bourdonnais-Denker Gambit\t1. e4 e5 2. Bc4 Bc5 3. b4 Bxb4 4. c3\nC23\tBishop's Opening: McDonnell Gambit, McDonnell Double Gambit\t1. e4 e5 2. Bc4 Bc5 3. b4 Bxb4 4. f4\nC23\tBishop's Opening: Philidor Counterattack\t1. e4 e5 2. Bc4 c6\nC23\tBishop's Opening: Philidor Variation\t1. e4 e5 2. Bc4 Bc5 3. c3\nC23\tBishop's Opening: Stein Gambit\t1. e4 e5 2. Bc4 Bc5 3. f4\nC23\tBishop's Opening: Thorold Gambit\t1. e4 e5 2. Bc4 b5 3. Bxb5 f5\nC23\tBishop's Opening: del Rio Variation\t1. e4 e5 2. Bc4 Bc5 3. c3 Qg5\nC24\tBishop's Opening: Berlin Defense\t1. e4 e5 2. Bc4 Nf6\nC24\tBishop's Opening: Berlin Defense, Greco Gambit\t1. e4 e5 2. Bc4 Nf6 3. f4\nC24\tBishop's Opening: Kitchener Folly\t1. e4 e5 2. Bc4 Nf6 3. d3 Be7 4. Nf3 O-O\nC24\tBishop's Opening: Pachman Gambit\t1. e4 e5 2. Bc4 Nf6 3. Ne2 Nxe4 4. Nec3\nC24\tBishop's Opening: Paulsen Defense\t1. e4 e5 2. Bc4 Nf6 3. d3 c6\nC24\tBishop's Opening: Ponziani Gambit\t1. e4 e5 2. Bc4 Nf6 3. d4\nC24\tBishop's Opening: Vienna Hybrid\t1. e4 e5 2. Bc4 Nf6 3. d3 Nc6 4. Nc3\nC24\tBishop's Opening: Warsaw Gambit\t1. e4 e5 2. Bc4 Nf6 3. d4 exd4 4. c3\nC25\tVienna Gambit, with Max Lange Defense\t1. e4 e5 2. Nc3 Nc6 3. f4\nC25\tVienna Gambit, with Max Lange Defense: Cunningham Defense\t1. e4 e5 2. Nc3 Nc6 3. f4 exf4 4. Nf3 Be7\nC25\tVienna Gambit, with Max Lange Defense: Knight Variation\t1. e4 e5 2. Nc3 Nc6 3. f4 exf4 4. Nf3\nC25\tVienna Gambit, with Max Lange Defense: Quelle Gambit\t1. e4 e5 2. Nc3 Nc6 3. f4 Bc5 4. fxe5 d6\nC25\tVienna Gambit, with Max Lange Defense: Steinitz Gambit\t1. e4 e5 2. Nc3 Nc6 3. f4 exf4 4. d4\nC25\tVienna Game\t1. e4 e5 2. Nc3\nC25\tVienna Game: Anderssen Defense\t1. e4 e5 2. Nc3 Bc5\nC25\tVienna Game: Fyfe Gambit\t1. e4 e5 2. Nc3 Nc6 3. d4\nC25\tVienna Game: Giraffe Attack\t1. e4 e5 2. Nc3 Bc5 3. Qg4\nC25\tVienna Game: Hamppe-Meitner Variation\t1. e4 e5 2. Nc3 Bc5 3. Na4\nC25\tVienna Game: Max Lange Defense\t1. e4 e5 2. Nc3 Nc6\nC25\tVienna Game: Omaha Gambit\t1. e4 e5 2. Nc3 d6 3. f4\nC25\tVienna Game: Paulsen Variation\t1. e4 e5 2. Nc3 Nc6 3. g3\nC25\tVienna Game: Philidor Countergambit\t1. e4 e5 2. Nc3 Nc6 3. d4 f5\nC25\tVienna Game: Zhuravlev Countergambit\t1. e4 e5 2. Nc3 Bb4 3. Qg4 Nf6\nC26\tBishop's Opening: Horwitz Gambit\t1. e4 e5 2. Bc4 Nf6 3. Nc3 b5\nC26\tBishop's Opening: Vienna Hybrid, Spielmann Attack\t1. e4 e5 2. Nc3 Nf6 3. Bc4 Bc5 4. d3\nC26\tVienna Game: Falkbeer Variation\t1. e4 e5 2. Nc3 Nf6\nC26\tVienna Game: Mengarini Variation\t1. e4 e5 2. Nc3 Nf6 3. a3\nC26\tVienna Game: Mieses Variation\t1. e4 e5 2. Nc3 Nf6 3. g3\nC26\tVienna Game: Mieses Variation, Erben Gambit\t1. e4 e5 2. Nc3 Nf6 3. g3 d5 4. exd5 c6\nC26\tVienna Game: Stanley Variation\t1. e4 e5 2. Nc3 Nf6 3. Bc4\nC26\tVienna Game: Stanley Variation, Eifel Gambit\t1. e4 e5 2. Nc3 Nf6 3. Bc4 Bc5 4. Nge2 b5\nC26\tVienna Game: Stanley Variation, Reversed Spanish\t1. e4 e5 2. Nc3 Nf6 3. Bc4 Bb4\nC27\tBishop's Opening: Boden-Kieseritzky Gambit\t1. e4 e5 2. Nf3 Nf6 3. Bc4 Nxe4 4. Nc3\nC27\tBishop's Opening: Boden-Kieseritzky Gambit, Lichtenhein Defense\t1. e4 e5 2. Nf3 Nf6 3. Bc4 Nxe4 4. Nc3 d5\nC27\tVienna Game: Frankenstein-Dracula Variation\t1. e4 e5 2. Nc3 Nf6 3. Bc4 Nxe4\nC28\tVienna Game: Stanley Variation, Three Knights Variation\t1. e4 e5 2. Nc3 Nc6 3. Bc4 Nf6\nC29\tVienna Game: Vienna Gambit\t1. e4 e5 2. Nc3 Nf6 3. f4\nC29\tVienna Game: Vienna Gambit, Main Line\t1. e4 e5 2. Nc3 Nf6 3. f4 d5\nC29\tVienna Game: Vienna Gambit, Steinitz Variation\t1. e4 e5 2. Nc3 Nf6 3. f4 d5 4. d3\nC30\tKing's Gambit\t1. e4 e5 2. f4\nC30\tKing's Gambit Declined: Classical Variation\t1. e4 e5 2. f4 Bc5\nC30\tKing's Gambit Declined: Classical Variation\t1. e4 e5 2. f4 Bc5 3. Nf3 d6 4. c3\nC30\tKing's Gambit Declined: Classical Variation, Rotlewi Countergambit\t1. e4 e5 2. f4 Bc5 3. Nf3 d6 4. b4\nC30\tKing's Gambit Declined: Classical Variation, Rubinstein Countergambit\t1. e4 e5 2. f4 Bc5 3. Nf3 d6 4. c3 f5\nC30\tKing's Gambit Declined: Classical Variation, Walthoffen Attack\t1. e4 e5 2. f4 Bc5 3. Qh5\nC30\tKing's Gambit Declined: Classical, Hanham Variation\t1. e4 e5 2. f4 Bc5 3. Nf3 d6 4. Nc3 Nd7\nC30\tKing's Gambit Declined: Classical, Soldatenkov Variation\t1. e4 e5 2. f4 Bc5 3. Nf3 d6 4. fxe5\nC30\tKing's Gambit Declined: Hobbs-Zilbermints Gambit\t1. e4 e5 2. f4 Nc6 3. Nf3 g5 4. fxg5 h6\nC30\tKing's Gambit Declined: Keene Defense\t1. e4 e5 2. f4 Qh4+ 3. g3 Qe7\nC30\tKing's Gambit Declined: Keene's Defense\t1. e4 e5 2. f4 Qh4+\nC30\tKing's Gambit Declined: Keene's Defense\t1. e4 e5 2. f4 Qh4+ 3. g3\nC30\tKing's Gambit Declined: Mafia Defense\t1. e4 c5 2. f4 e5\nC30\tKing's Gambit Declined: Miles Defense\t1. e4 e5 2. f4 Nc6 3. Nf3 f5\nC30\tKing's Gambit Declined: Norwalde Variation\t1. e4 e5 2. f4 Qf6\nC30\tKing's Gambit Declined: Norwalde Variation, Schubert Variation\t1. e4 e5 2. f4 Qf6 3. Nc3 Qxf4 4. d4\nC30\tKing's Gambit Declined: Panteldakis Countergambit\t1. e4 e5 2. f4 f5\nC30\tKing's Gambit Declined: Panteldakis Countergambit, Greco Variation\t1. e4 e5 2. f4 f5 3. exf5 Qh4+\nC30\tKing's Gambit Declined: Panteldakis Countergambit, Schiller's Defense\t1. e4 e5 2. f4 f5 3. exf5 Bc5\nC30\tKing's Gambit Declined: Panteldakis Countergambit, Shirazi Line\t1. e4 e5 2. f4 f5 3. exf5 exf4 4. Qh5+ Ke7\nC30\tKing's Gambit Declined: Petrov's Defense\t1. e4 e5 2. f4 Nf6\nC30\tKing's Gambit Declined: Queen's Knight Defense\t1. e4 e5 2. f4 Nc6\nC30\tKing's Gambit Declined: Senechaud Countergambit\t1. e4 e5 2. f4 Bc5 3. Nf3 g5\nC30\tKing's Gambit Declined: Soller-Zilbermints Gambit\t1. e4 e5 2. f4 f6 3. fxe5 Nc6\nC30\tKing's Gambit Declined: Zilbermints Double Countergambit\t1. e4 e5 2. f4 g5\nC30\tKing's Gambit Declined: Zilbermints Double Gambit\t1. e4 e5 2. f4 Nc6 3. Nf3 g5\nC31\tKing's Gambit Declined: Falkbeer Countergambit\t1. e4 e5 2. f4 d5\nC31\tKing's Gambit Declined: Falkbeer Countergambit Accepted\t1. e4 e5 2. f4 d5 3. exd5\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Anderssen Attack\t1. e4 e5 2. f4 d5 3. exd5 e4 4. Bb5+\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Blackburne Attack\t1. e4 e5 2. f4 d5 3. Nf3\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Charousek Gambit\t1. e4 e5 2. f4 d5 3. exd5 e4 4. d3\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Hinrichsen Gambit\t1. e4 e5 2. f4 d5 3. d4\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Miles Gambit\t1. e4 e5 2. f4 d5 3. exd5 Bc5\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Milner-Barry Variation\t1. e4 e5 2. f4 d5 3. Nc3\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Modern Transfer\t1. e4 e5 2. f4 d5 3. exd5 exf4\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Nimzowitsch-Marshall Countergambit\t1. e4 e5 2. f4 d5 3. exd5 c6\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Pickler Gambit\t1. e4 e5 2. f4 d5 3. exd5 c6 4. dxc6 Bc5\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Staunton Line\t1. e4 e5 2. f4 d5 3. exd5 e4\nC31\tVan Geet Opening: Grünfeld Defense, Steiner Gambit\t1. e4 e5 2. f4 d5 3. Nc3 dxe4 4. Nxe4\nC33\tKing's Gambit Accepted\t1. e4 e5 2. f4 exf4\nC33\tKing's Gambit Accepted: Basman Gambit\t1. e4 e5 2. f4 exf4 3. Qe2\nC33\tKing's Gambit Accepted: Bishop's Gambit\t1. e4 e5 2. f4 exf4 3. Bc4\nC33\tKing's Gambit Accepted: Bishop's Gambit, Anderssen Defense\t1. e4 e5 2. f4 exf4 3. Bc4 g5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Anderssen Variation\t1. e4 e5 2. f4 exf4 3. Bc4 d5 4. Bxd5 c6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Bledow Countergambit\t1. e4 e5 2. f4 exf4 3. Bc4 d5 4. Bxd5 Nf6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Bledow Variation\t1. e4 e5 2. f4 exf4 3. Bc4 d5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Boden Variation\t1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 Nc6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Bogoljubow Defense\t1. e4 e5 2. f4 exf4 3. Bc4 Nf6 4. Nc3 c6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Bogoljubow Variation\t1. e4 e5 2. f4 exf4 3. Bc4 Nf6 4. Nc3\nC33\tKing's Gambit Accepted: Bishop's Gambit, Bryan Countergambit\t1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Cozio Defense\t1. e4 e5 2. f4 exf4 3. Bc4 Nf6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Cozio Variation\t1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 d6\nC33\tKing's Gambit Accepted: Bishop's Gambit, First Jaenisch Variation\t1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 Nf6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Gianutio Gambit\t1. e4 e5 2. f4 exf4 3. Bc4 f5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Greco Variation\t1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 Bc5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Kieseritzky Gambit\t1. e4 e5 2. f4 exf4 3. Bc4 b5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Lopez Defense\t1. e4 e5 2. f4 exf4 3. Bc4 c6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Lopez Variation\t1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 g5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Maurian Defense\t1. e4 e5 2. f4 exf4 3. Bc4 Nc6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Steinitz Defense\t1. e4 e5 2. f4 exf4 3. Bc4 Ne7\nC33\tKing's Gambit Accepted: Breyer Gambit\t1. e4 e5 2. f4 exf4 3. Qf3\nC33\tKing's Gambit Accepted: Carrera Gambit\t1. e4 e5 2. f4 exf4 3. Qh5\nC33\tKing's Gambit Accepted: Dodo Variation\t1. e4 e5 2. f4 exf4 3. Qg4\nC33\tKing's Gambit Accepted: Eisenberg Variation\t1. e4 e5 2. f4 exf4 3. Nh3\nC33\tKing's Gambit Accepted: Gaga Gambit\t1. e4 e5 2. f4 exf4 3. g3\nC33\tKing's Gambit Accepted: Mason-Keres Gambit\t1. e4 e5 2. f4 exf4 3. Nc3\nC33\tKing's Gambit Accepted: Orsini Gambit\t1. e4 e5 2. f4 exf4 3. b3\nC33\tKing's Gambit Accepted: Paris Gambit\t1. e4 e5 2. f4 exf4 3. Ne2\nC33\tKing's Gambit Accepted: Schurig Gambit, with Bb5\t1. e4 e5 2. f4 exf4 3. Bb5\nC33\tKing's Gambit Accepted: Schurig Gambit, with Bd3\t1. e4 e5 2. f4 exf4 3. Bd3\nC33\tKing's Gambit Accepted: Stamma Gambit\t1. e4 e5 2. f4 exf4 3. h4\nC33\tKing's Gambit Accepted: Tartakower Gambit\t1. e4 e5 2. f4 exf4 3. Be2\nC33\tKing's Gambit Accepted: Tartakower Gambit, Weiss Defense\t1. e4 e5 2. f4 exf4 3. Be2 f5 4. exf5 d6\nC33\tKing's Gambit Accepted: Tumbleweed\t1. e4 e5 2. f4 exf4 3. Kf2\nC33\tKing's Gambit Accepted: Villemson Gambit\t1. e4 e5 2. f4 exf4 3. d4\nC34\tKing's Gambit Accepted: Becker Defense\t1. e4 e5 2. f4 exf4 3. Nf3 h6\nC34\tKing's Gambit Accepted: Bonsch-Osmolovsky Variation\t1. e4 e5 2. f4 exf4 3. Nf3 Ne7\nC34\tKing's Gambit Accepted: Fischer Defense\t1. e4 e5 2. f4 exf4 3. Nf3 d6\nC34\tKing's Gambit Accepted: Fischer Defense, Schulder Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 d6 4. b4\nC34\tKing's Gambit Accepted: Gianutio Countergambit\t1. e4 e5 2. f4 exf4 3. Nf3 f5\nC34\tKing's Gambit Accepted: King's Knight's Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 g5\nC34\tKing's Gambit Accepted: King's Knight's Gambit\t1. e4 e5 2. f4 exf4 3. Nf3\nC34\tKing's Gambit Accepted: MacLeod Defense\t1. e4 e5 2. f4 exf4 3. Nf3 Nc6\nC34\tKing's Gambit Accepted: Schallopp Defense\t1. e4 e5 2. f4 exf4 3. Nf3 Nf6\nC34\tKing's Gambit Accepted: Wagenbach Defense\t1. e4 e5 2. f4 exf4 3. Nf3 h5\nC35\tKing's Gambit Accepted: Cunningham Defense\t1. e4 e5 2. f4 exf4 3. Nf3 Be7\nC35\tKing's Gambit Accepted: Cunningham Defense, McCormick Defense\t1. e4 e5 2. f4 exf4 3. Nf3 Be7 4. Bc4 Nf6\nC36\tKing's Gambit Accepted: Abbazia Defense\t1. e4 e5 2. f4 exf4 3. Nf3 d5 4. exd5 Nf6\nC36\tKing's Gambit Accepted: Modern Defense\t1. e4 e5 2. f4 exf4 3. Nf3 d5\nC36\tKing's Gambit Accepted: Modern Defense\t1. e4 e5 2. f4 exf4 3. Nf3 d5 4. exd5\nC37\tKing's Gambit Accepted: Blachly Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 Nc6 4. Bc4 g5\nC37\tKing's Gambit Accepted: King's Knight's Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 g5 4. Bc4\nC37\tKing's Gambit Accepted: Quaade Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 g5 4. Nc3\nC37\tKing's Gambit Accepted: Rosentreter Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 g5 4. d4\nC38\tKing's Gambit Accepted: Traditional Variation\t1. e4 e5 2. f4 exf4 3. Nf3 g5 4. Bc4 Bg7\nC39\tKing's Gambit Accepted: King's Knight's Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 g5 4. h4\nC40\tElephant Gambit\t1. e4 e5 2. Nf3 d5\nC40\tElephant Gambit: Maróczy Gambit\t1. e4 e5 2. Nf3 d5 3. exd5 Bd6\nC40\tElephant Gambit: Paulsen Countergambit\t1. e4 e5 2. Nf3 d5 3. exd5 e4\nC40\tElephant Gambit: Wasp Variation\t1. e4 e5 2. Nf3 d5 3. Nxe5 dxe4 4. Bc4 Qg5\nC40\tGunderam Defense\t1. e4 e5 2. Nf3 Qe7\nC40\tKing's Knight Opening\t1. e4 e5 2. Nf3\nC40\tKing's Pawn Game: Busch-Gass Gambit\t1. e4 e5 2. Nf3 Bc5\nC40\tKing's Pawn Game: Busch-Gass Gambit, Chiodini Gambit\t1. e4 e5 2. Nf3 Bc5 3. Nxe5 Nc6\nC40\tKing's Pawn Game: Damiano Defense\t1. e4 e5 2. Nf3 f6\nC40\tKing's Pawn Game: Damiano Defense, Damiano Gambit, Chigorin Gambit\t1. e4 e5 2. Nf3 f6 3. Nxe5 Qe7 4. Nf3 d5\nC40\tKing's Pawn Game: Gunderam Defense, Gunderam Gambit\t1. e4 e5 2. Nf3 Qe7 3. Bc4 f5\nC40\tKing's Pawn Game: Gunderam Gambit\t1. e4 e5 2. Nf3 c6\nC40\tKing's Pawn Game: La Bourdonnais Gambit\t1. e4 e5 2. Nf3 Qf6 3. Bc4 Qg6 4. O-O\nC40\tKing's Pawn Game: McConnell Defense\t1. e4 e5 2. Nf3 Qf6\nC40\tLatvian Gambit\t1. e4 e5 2. Nf3 f5\nC40\tLatvian Gambit Accepted\t1. e4 e5 2. Nf3 f5 3. exf5\nC40\tLatvian Gambit Accepted: Foltys-Leonhardt Variation\t1. e4 e5 2. Nf3 f5 3. Nxe5 Qf6 4. Nc4\nC40\tLatvian Gambit Accepted: Main Line\t1. e4 e5 2. Nf3 f5 3. Nxe5 Qf6 4. d4\nC40\tLatvian Gambit: Corkscrew Countergambit\t1. e4 e5 2. Nf3 f5 3. Bc4 fxe4 4. Nxe5 Nf6\nC40\tLatvian Gambit: Diepstraten Countergambit\t1. e4 e5 2. Nf3 f5 3. c4\nC40\tLatvian Gambit: Fraser Defense\t1. e4 e5 2. Nf3 f5 3. Nxe5 Nc6\nC40\tLatvian Gambit: Greco Variation\t1. e4 e5 2. Nf3 f5 3. Nxe5 Qe7\nC40\tLatvian Gambit: Lobster Gambit\t1. e4 e5 2. Nf3 f5 3. g4\nC40\tLatvian Gambit: Mason Countergambit\t1. e4 e5 2. Nf3 f5 3. d4\nC40\tLatvian Gambit: Mayet Attack\t1. e4 e5 2. Nf3 f5 3. Bc4\nC40\tLatvian Gambit: Mayet Attack, Morgado Defense\t1. e4 e5 2. Nf3 f5 3. Bc4 Nf6\nC40\tLatvian Gambit: Mayet Attack, Polerio-Svedenborg Variation\t1. e4 e5 2. Nf3 f5 3. Bc4 fxe4 4. Nxe5 d5\nC40\tLatvian Gambit: Mayet Attack, Strautins Gambit\t1. e4 e5 2. Nf3 f5 3. Bc4 b5\nC40\tLatvian Gambit: Mlotkowski Variation\t1. e4 e5 2. Nf3 f5 3. Nc3\nC40\tLatvian Gambit: Senechaud Gambit\t1. e4 e5 2. Nf3 f5 3. b4\nC41\tPhilidor Defense\t1. e4 e5 2. Nf3 d6\nC41\tPhilidor Defense\t1. e4 e5 2. Nf3 d6 3. d4\nC41\tPhilidor Defense\t1. e4 e5 2. Nf3 d6 3. Bc4\nC41\tPhilidor Defense\t1. e4 e5 2. Nf3 d6 3. Bc4 Be7\nC41\tPhilidor Defense: Albin-Blackburne Gambit\t1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Nd7\nC41\tPhilidor Defense: Bird Gambit\t1. e4 e5 2. Nf3 d6 3. d4 exd4 4. c3\nC41\tPhilidor Defense: Boden Variation\t1. e4 e5 2. Nf3 d6 3. d4 exd4 4. Qxd4 Bd7\nC41\tPhilidor Defense: Exchange Variation\t1. e4 e5 2. Nf3 d6 3. d4 exd4\nC41\tPhilidor Defense: Exchange Variation\t1. e4 e5 2. Nf3 d6 3. d4 exd4 4. Nxd4\nC41\tPhilidor Defense: Exchange Variation\t1. e4 e5 2. Nf3 d6 3. d4 exd4 4. Nxd4 Nf6\nC41\tPhilidor Defense: Hanham Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nd7\nC41\tPhilidor Defense: Hanham Variation, Sharp Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nd7 4. Bc4 Nb6\nC41\tPhilidor Defense: Larsen Variation\t1. e4 e5 2. Nf3 d6 3. d4 exd4 4. Nxd4 g6\nC41\tPhilidor Defense: Lion Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Nc3 Nbd7\nC41\tPhilidor Defense: Lopez Countergambit\t1. e4 e5 2. Nf3 d6 3. Bc4 f5\nC41\tPhilidor Defense: Morphy Gambit\t1. e4 e5 2. Nf3 d6 3. d4 exd4 4. Bc4\nC41\tPhilidor Defense: Nimzowitsch Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nf6\nC41\tPhilidor Defense: Nimzowitsch Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. dxe5\nC41\tPhilidor Defense: Nimzowitsch Variation, Klein Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Bc4\nC41\tPhilidor Defense: Nimzowitsch, Locock Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Ng5\nC41\tPhilidor Defense: Philidor Countergambit\t1. e4 e5 2. Nf3 d6 3. d4 f5\nC41\tPhilidor Defense: Philidor Countergambit, Zukertort Variation\t1. e4 e5 2. Nf3 d6 3. d4 f5 4. Nc3\nC41\tPhilidor Defense: Philidor Gambit\t1. e4 e5 2. Nf3 d6 3. d4 Bd7\nC41\tPhilidor Defense: Steinitz Variation\t1. e4 e5 2. Nf3 d6 3. Bc4 Be7 4. c3\nC42\tPetrov's Defense\t1. e4 e5 2. Nf3 Nf6\nC42\tPetrov's Defense\t1. e4 e5 2. Nf3 Nf6 3. Nxe5\nC42\tPetrov's Defense\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6\nC42\tPetrov's Defense\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3\nC42\tPetrov's Defense\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4\nC42\tPetrov's Defense: Cochrane Gambit\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nxf7\nC42\tPetrov's Defense: Damiano Variation\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nxe4\nC42\tPetrov's Defense: Damiano Variation, Kholmov Gambit\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nxe4 4. Qe2 Qe7\nC42\tPetrov's Defense: Italian Variation\t1. e4 e5 2. Nf3 Nf6 3. Bc4\nC42\tPetrov's Defense: Karklins-Martinovsky Variation\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nd3\nC42\tPetrov's Defense: Moody Gambit\t1. e4 e5 2. Nf3 Nf6 3. Qe2 Nc6 4. d4\nC42\tPetrov's Defense: Paulsen Attack\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nc4\nC42\tPetrov's Defense: Stafford Gambit\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nc6\nC42\tPetrov's Defense: Stafford Gambit Accepted\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nc6 4. Nxc6 dxc6\nC42\tPetrov's Defense: Three Knights Game\t1. e4 e5 2. Nf3 Nf6 3. Nc3\nC43\tBishop's Opening: Urusov Gambit\t1. e4 e5 2. Bc4 Nf6 3. d4 exd4 4. Nf3\nC43\tPetrov's Defense: Modern Attack\t1. e4 e5 2. Nf3 Nf6 3. d4\nC43\tPetrov's Defense: Modern Attack\t1. e4 e5 2. Nf3 Nf6 3. d4 exd4\nC43\tPetrov's Defense: Modern Attack, Center Variation\t1. e4 e5 2. Nf3 Nf6 3. d4 Nxe4 4. Bd3\nC43\tPetrov's Defense: Modern Attack, Murrey Variation\t1. e4 e5 2. Nf3 Nf6 3. d4 Nxe4 4. Bd3 Nc6\nC43\tPetrov's Defense: Modern Attack, Symmetrical Variation\t1. e4 e5 2. Nf3 Nf6 3. d4 d5\nC44\tDresden Opening: The Goblin\t1. e4 e5 2. Nf3 Nc6 3. c4 Nf6 4. Nxe5\nC44\tIrish Gambit\t1. e4 e5 2. Nf3 Nc6 3. Nxe5\nC44\tKing's Knight Opening: Konstantinopolsky\t1. e4 e5 2. Nf3 Nc6 3. g3\nC44\tKing's Knight Opening: Normal Variation\t1. e4 e5 2. Nf3 Nc6\nC44\tKing's Pawn Game: Dresden Opening\t1. e4 e5 2. Nf3 Nc6 3. c4\nC44\tKing's Pawn Game: Pachman Wing Gambit\t1. e4 e5 2. Nf3 Nc6 3. b4\nC44\tKing's Pawn Game: Schulze-Müller Gambit\t1. e4 e5 2. Nf3 Nc6 3. Nxe5 Nxe5 4. d4\nC44\tKing's Pawn Game: Tayler Opening\t1. e4 e5 2. Nf3 Nc6 3. Be2\nC44\tKing's Pawn Game: Tayler Opening\t1. e4 e5 2. Nf3 Nc6 3. Be2 Nf6 4. d4\nC44\tLatvian Gambit: Clam Gambit\t1. e4 e5 2. Nf3 Nc6 3. d3 f5 4. exf5\nC44\tPonziani Opening\t1. e4 e5 2. Nf3 Nc6 3. c3\nC44\tPonziani Opening: Caro Gambit\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4 Bd7\nC44\tPonziani Opening: Jaenisch Counterattack\t1. e4 e5 2. Nf3 Nc6 3. c3 Nf6\nC44\tPonziani Opening: Jaenisch Counterattack\t1. e4 e5 2. Nf3 Nc6 3. c3 Nf6 4. d3\nC44\tPonziani Opening: Jaenisch Counterattack\t1. e4 e5 2. Nf3 Nc6 3. c3 Nf6 4. d3 d5\nC44\tPonziani Opening: Leonhardt Variation\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4 Nf6\nC44\tPonziani Opening: Neumann Gambit\t1. e4 e5 2. Nf3 Nc6 3. c3 Nf6 4. Bc4\nC44\tPonziani Opening: Ponziani Countergambit\t1. e4 e5 2. Nf3 Nc6 3. c3 f5\nC44\tPonziani Opening: Romanishin Variation\t1. e4 e5 2. Nf3 Nc6 3. c3 Be7\nC44\tPonziani Opening: Réti Variation\t1. e4 e5 2. Nf3 Nc6 3. c3 Nge7\nC44\tPonziani Opening: Spanish Variation\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Bb5\nC44\tPonziani Opening: Steinitz Variation\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4 f6\nC44\tScotch Game\t1. e4 e5 2. Nf3 Nc6 3. d4\nC44\tScotch Game\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4\nC44\tScotch Game: Benima Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Be7 4. d4 exd4\nC44\tScotch Game: Göring Gambit\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. c3\nC44\tScotch Game: Haxo Gambit\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Bc4 Bc5\nC44\tScotch Game: Lolli Variation\t1. e4 e5 2. Nf3 Nc6 3. d4 Nxd4\nC44\tScotch Game: Relfsson Gambit\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Bb5\nC44\tScotch Game: Scotch Gambit\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Bc4\nC44\tScotch Game: Scotch Gambit, Dubois Réti Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4 exd4\nC44\tScotch Game: Scotch Gambit, Göring Gambit Declined\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. c3 d5\nC44\tScotch Game: Scotch Gambit, London Defense\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Bc4 Bb4+\nC45\tScotch Game\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4\nC45\tScotch Game: Classical Variation\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Bc5\nC45\tScotch Game: Malaniuk Variation\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Bb4+\nC45\tScotch Game: Schmidt Variation\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6\nC45\tScotch Game: Steinitz Variation\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Qh4\nC46\tThree Knights Opening\t1. e4 e5 2. Nf3 Nc6 3. Nc3\nC46\tThree Knights Opening\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Bb4\nC46\tThree Knights Opening: Schlechter Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Bb4 4. Nd5 Nf6\nC46\tThree Knights Opening: Steinitz Defense\t1. e4 e5 2. Nf3 Nc6 3. Nc3 g6\nC46\tThree Knights Opening: Winawer Defense\t1. e4 e5 2. Nf3 Nc6 3. Nc3 f5\nC47\tFour Knights Game\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6\nC47\tFour Knights Game: Glek System\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. g3\nC47\tFour Knights Game: Gunsberg Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. a3\nC47\tFour Knights Game: Halloween Gambit\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Nxe5\nC47\tFour Knights Game: Italian Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Nc3\nC47\tFour Knights Game: Naroditsky Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Nd5\nC47\tFour Knights Game: Scotch Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. d4\nC47\tFour Knights Game: Scotch Variation Accepted\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. d4 exd4\nC48\tFour Knights Game: Spanish Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5\nC48\tFour Knights Game: Spanish Variation, Classical Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Bc5\nC48\tFour Knights Game: Spanish Variation, Rubinstein Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Nd4\nC49\tFour Knights Game: Spanish Variation, Double Spanish\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Bb4\nC50\tFour Knights Game: Italian Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. Nc3 Nf6\nC50\tItalian Game\t1. e4 e5 2. Nf3 Nc6 3. Bc4\nC50\tItalian Game: Anti-Fried Liver Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 h6\nC50\tItalian Game: Blackburne-Kostić Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4\nC50\tItalian Game: Giuoco Pianissimo\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3\nC50\tItalian Game: Giuoco Pianissimo, Lucchini Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 f5\nC50\tItalian Game: Giuoco Pianissimo, Normal\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 Bc5\nC50\tItalian Game: Giuoco Piano\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5\nC50\tItalian Game: Hungarian Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Be7\nC50\tItalian Game: Jerome Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. Bxf7+\nC50\tItalian Game: Paris Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 d6\nC50\tItalian Game: Rosentreter Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d4\nC50\tItalian Game: Rousseau Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 f5\nC51\tItalian Game: Evans Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4\nC51\tItalian Game: Evans Gambit Accepted\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4\nC51\tItalian Game: Evans Gambit Declined\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bb6\nC51\tItalian Game: Evans Gambit, Fontaine Countergambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 b5\nC51\tItalian Game: Evans Gambit, Hein Countergambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 d5\nC53\tItalian Game: Classical Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3\nC53\tItalian Game: Classical Variation, Closed Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Qe7\nC54\tItalian Game: Classical Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6\nC55\tItalian Game: Two Knights Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6\nC55\tItalian Game: Two Knights Defense, Modern Bishop's Opening\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3\nC55\tItalian Game: Two Knights Defense, Modern Bishop's Opening\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 Be7\nC56\tItalian Game: Scotch Invitation Declined\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4 d6\nC56\tItalian Game: Two Knights Defense, Open Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4\nC57\tItalian Game: Two Knights Defense, Knight Attack\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5\nC57\tItalian Game: Two Knights Defense, Knight Attack, Normal Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5\nC57\tItalian Game: Two Knights Defense, Ponziani-Steinitz Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 Nxe4\nC57\tItalian Game: Two Knights Defense, Traxler Counterattack\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 Bc5\nC60\tRuy Lopez\t1. e4 e5 2. Nf3 Nc6 3. Bb5\nC60\tRuy Lopez: Alapin Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bb4\nC60\tRuy Lopez: Brentano Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 g5\nC60\tRuy Lopez: Bulgarian Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a5\nC60\tRuy Lopez: Cozio Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nge7\nC60\tRuy Lopez: Cozio Defense, Paulsen Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nge7 4. Nc3 g6\nC60\tRuy Lopez: Fianchetto Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 g6\nC60\tRuy Lopez: Fianchetto Defense, Kevitz Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 g6 4. c3 f5\nC60\tRuy Lopez: Lucena Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Be7\nC60\tRuy Lopez: Nürnberg Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f6\nC60\tRuy Lopez: Pollock Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Na5\nC60\tRuy Lopez: Retreat Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nb8\nC60\tRuy Lopez: Rotary-Albany Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 b6\nC60\tRuy Lopez: Spanish Countergambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 d5\nC60\tRuy Lopez: Vinogradov Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Qe7\nC61\tRuy Lopez: Bird Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nd4\nC62\tRuy Lopez: Steinitz Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 d6\nC62\tRuy Lopez: Steinitz Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 d6 4. d4\nC63\tRuy Lopez: Schliemann Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f5\nC63\tRuy Lopez: Schliemann Defense, Dyckhoff Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f5 4. Nc3\nC63\tRuy Lopez: Schliemann Defense, Exchange Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f5 4. Bxc6\nC63\tRuy Lopez: Schliemann Defense, Jaenisch Gambit Accepted\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f5 4. exf5\nC63\tRuy Lopez: Schliemann Defense, Schönemann Attack\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f5 4. d4\nC64\tRuy Lopez: Classical Defense, Boden Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5 4. c3 Qe7\nC64\tRuy Lopez: Classical Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5\nC64\tRuy Lopez: Classical Variation, Central Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5 4. c3\nC64\tRuy Lopez: Classical Variation, Charousek Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5 4. c3 Bb6\nC64\tRuy Lopez: Classical Variation, Cordel Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5 4. c3 f5\nC64\tRuy Lopez: Classical Variation, Konikowski Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5 4. c3 d5\nC64\tRuy Lopez: Classical Variation, Spanish Wing Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5 4. b4\nC65\tRuy Lopez: Berlin Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6\nC65\tRuy Lopez: Berlin Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O\nC65\tRuy Lopez: Berlin Defense, Anti-Berlin Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. d3\nC65\tRuy Lopez: Berlin Defense, Anti-Berlin Variation, Mortimer Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. d3 Ne7\nC65\tRuy Lopez: Berlin Defense, Beverwijk Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O Bc5\nC65\tRuy Lopez: Berlin Defense, Fishing Pole Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O Ng4\nC65\tRuy Lopez: Halloween Attack\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. Nxe5\nC66\tRuy Lopez: Berlin Defense, Improved Steinitz Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O d6\nC67\tRuy Lopez: Berlin Defense, Rio Gambit Accepted\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O Nxe4\nC68\tRuy Lopez: Exchange Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6\nC68\tRuy Lopez: Exchange Variation, Lutikov Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 bxc6\nC70\tRuy Lopez: Bird's Defense Deferred\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nd4\nC70\tRuy Lopez: Morphy Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6\nC70\tRuy Lopez: Morphy Defense, Alapin's Defense Deferred\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Bb4\nC70\tRuy Lopez: Morphy Defense, Caro Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 b5\nC70\tRuy Lopez: Morphy Defense, Classical Defense Deferred\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Bc5\nC70\tRuy Lopez: Morphy Defense, Cozio Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nge7\nC70\tRuy Lopez: Morphy Defense, Fianchetto Defense Deferred\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 g6\nC70\tRuy Lopez: Morphy Defense, Schliemann Defense Deferred\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 f5\nC71\tRuy Lopez: Morphy Defense, Modern Steinitz Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 d6\nD00\tAmazon Attack\t1. d4 d5 2. Qd3\nD00\tBlackmar-Diemer Gambit\t1. d4 d5 2. e4\nD00\tBlackmar-Diemer Gambit\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6\nD00\tBlackmar-Diemer Gambit Accepted\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 exf3\nD00\tBlackmar-Diemer Gambit Declined: Brombacher Countergambit\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 c5\nD00\tBlackmar-Diemer Gambit Declined: Elbert Countergambit\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 e5\nD00\tBlackmar-Diemer Gambit Declined: Gedult Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 a6\nD00\tBlackmar-Diemer Gambit Declined: Lamb Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 Nc6\nD00\tBlackmar-Diemer Gambit Declined: Langeheinicke Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 e3\nD00\tBlackmar-Diemer Gambit Declined: O'Kelly Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 c6\nD00\tBlackmar-Diemer Gambit Declined: Vienna Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 Bf5\nD00\tBlackmar-Diemer Gambit Declined: Weinsbach Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 e6\nD00\tBlackmar-Diemer Gambit: Blackmar Gambit\t1. d4 d5 2. e4 dxe4 3. f3\nD00\tBlackmar-Diemer Gambit: Diemer-Rosenberg Attack\t1. d4 d5 2. e4 dxe4 3. Be3\nD00\tBlackmar-Diemer Gambit: Fritz Attack\t1. d4 d5 2. e4 dxe4 3. Bc4\nD00\tBlackmar-Diemer Gambit: Lemberger Countergambit\t1. d4 d5 2. e4 dxe4 3. Nc3 e5\nD00\tBlackmar-Diemer Gambit: Lemberger Countergambit, Endgame Variation\t1. d4 d5 2. e4 dxe4 3. Nc3 e5 4. dxe5\nD00\tBlackmar-Diemer Gambit: Lemberger Countergambit, Lange Gambit\t1. d4 d5 2. e4 dxe4 3. Nc3 e5 4. Nxe4\nD00\tBlackmar-Diemer Gambit: Lemberger Countergambit, Rasmussen Attack\t1. d4 d5 2. e4 dxe4 3. Nc3 e5 4. Nge2\nD00\tBlackmar-Diemer Gambit: Lemberger Countergambit, Sneiders Attack\t1. d4 d5 2. e4 dxe4 3. Nc3 e5 4. Qh5\nD00\tBlackmar-Diemer Gambit: Lemberger Countergambit, Soller Attack\t1. d4 d5 2. e4 dxe4 3. Nc3 e5 4. Be3\nD00\tBlackmar-Diemer Gambit: Netherlands Variation\t1. d4 d5 2. e4 dxe4 3. Nc3 f5\nD00\tBlackmar-Diemer Gambit: Rasa-Studier Gambit\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. Be3\nD00\tBlackmar-Diemer Gambit: Reversed Albin Countergambit\t1. d4 d5 2. e4 dxe4 3. Nc3 c5\nD00\tBlackmar-Diemer Gambit: Zeller Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Bf5\nD00\tBlackmar-Diemer Gambit: von Popiel Gambit\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. Bg5\nD00\tQueen's Pawn Game\t1. d4 d5\nD00\tQueen's Pawn Game\t1. d4 d5 2. e3\nD00\tQueen's Pawn Game\t1. d4 d5 2. e3 Nf6\nD00\tQueen's Pawn Game: Accelerated London System\t1. d4 d5 2. Bf4\nD00\tQueen's Pawn Game: Accelerated London System, Steinitz Countergambit\t1. d4 d5 2. Bf4 c5\nD00\tQueen's Pawn Game: Accelerated London System, Steinitz Countergambit Accepted\t1. d4 d5 2. Bf4 c5 3. dxc5\nD00\tQueen's Pawn Game: Accelerated London System, Steinitz Countergambit, Morris Countergambit\t1. d4 d5 2. Bf4 c5 3. e4\nD00\tQueen's Pawn Game: Accelerated London System, Steinitz Countergambit, Morris Countergambit Accepted\t1. d4 d5 2. Bf4 c5 3. e4 dxe4\nD00\tQueen's Pawn Game: Chigorin Variation\t1. d4 d5 2. Nc3\nD00\tQueen's Pawn Game: Chigorin Variation\t1. d4 d5 2. Nc3 e6\nD00\tQueen's Pawn Game: Chigorin Variation, Alburt Defense\t1. d4 d5 2. Nc3 Bf5\nD00\tQueen's Pawn Game: Chigorin Variation, Anti-Veresov\t1. d4 d5 2. Nc3 Bg4\nD00\tQueen's Pawn Game: Chigorin Variation, Fianchetto Defense\t1. d4 g6 2. Nf3 Bg7 3. Nc3 d5\nD00\tQueen's Pawn Game: Chigorin Variation, Irish Gambit\t1. d4 d5 2. Nc3 c5\nD00\tQueen's Pawn Game: Chigorin Variation, Shaviliuk Gambit\t1. d4 d5 2. Nc3 e5\nD00\tQueen's Pawn Game: Chigorin Variation, Shropshire Defense\t1. d4 d5 2. Nc3 h5\nD00\tQueen's Pawn Game: Hübsch Gambit\t1. d4 Nf6 2. Nc3 d5 3. e4\nD00\tQueen's Pawn Game: Levitsky Attack\t1. d4 d5 2. Bg5\nD00\tQueen's Pawn Game: Levitsky Attack, Welling Variation\t1. d4 d5 2. Bg5 Bg4\nD00\tQueen's Pawn Game: Mason Attack\t1. d4 d5 2. f4\nD00\tQueen's Pawn Game: Stonewall Attack\t1. d4 d5 2. e3 Nf6 3. Bd3\nD00\tQueen's Pawn Game: Zurich Gambit\t1. d4 d5 2. g4\nD01\tRapport-Jobava System\t1. d4 d5 2. Nc3 Nf6 3. Bf4\nD01\tRapport-Jobava System\t1. d4 d5 2. Nc3 Nf6 3. Bf4 e6\nD01\tRapport-Jobava System\t1. d4 d5 2. Nc3 Nf6 3. Bf4 g6\nD01\tRapport-Jobava System, with e6\t1. d4 d5 2. Nc3 e6 3. Bf4\nD01\tRichter-Veresov Attack\t1. d4 Nf6 2. Nc3 d5 3. Bg5\nD01\tRichter-Veresov Attack\t1. d4 Nf6 2. Nc3 d5 3. Bg5 Bf5\nD01\tRichter-Veresov Attack: Boyce Defense\t1. d4 Nf6 2. Nc3 d5 3. Bg5 Ne4\nD01\tRichter-Veresov Attack: Richter Variation\t1. d4 Nf6 2. Nc3 d5 3. Bg5 Bf5 4. f3\nD01\tRichter-Veresov Attack: Two Knights System\t1. d4 Nf6 2. Nc3 d5 3. Bg5 Nbd7 4. Nf3\nD01\tRichter-Veresov Attack: Two Knights System, Grünfeld Defense\t1. d4 Nf6 2. Nc3 d5 3. Bg5 Nbd7 4. Nf3 g6\nD01\tRichter-Veresov Attack: Veresov Variation\t1. d4 Nf6 2. Nc3 d5 3. Bg5 Bf5 4. Bxf6\nD02\tQueen's Gambit Declined: Baltic Defense, Pseudo-Slav\t1. d4 d5 2. Nf3 Bf5 3. c4 e6 4. Nc3 c6\nD02\tQueen's Pawn Game: Anti-Torre\t1. Nf3 d5 2. d4 Bg4\nD02\tQueen's Pawn Game: Chandler Gambit\t1. d4 d5 2. Nf3 c5 3. g3 cxd4 4. Bg2\nD02\tQueen's Pawn Game: Chigorin Variation\t1. d4 d5 2. Nf3 Nc6\nD02\tQueen's Pawn Game: Krause Variation\t1. d4 d5 2. Nf3 c5\nD02\tQueen's Pawn Game: Levitsky Attack, Euwe Variation, Modern Line\t1. d4 d5 2. Nf3 c6 3. Bg5 h6 4. Bh4 Qb6\nD02\tQueen's Pawn Game: London System\t1. d4 d5 2. Nf3 Nf6 3. Bf4\nD02\tQueen's Pawn Game: London System\t1. d4 d5 2. Nf3 Nf6 3. Bf4 c5 4. e3\nD02\tQueen's Pawn Game: London System, with e6\t1. d4 d5 2. Nf3 e6 3. Bf4\nD02\tQueen's Pawn Game: London System, with e6\t1. d4 d5 2. Nf3 e6 3. Bf4 Nf6\nD02\tQueen's Pawn Game: Symmetrical Variation\t1. d4 d5 2. Nf3 Nf6\nD02\tQueen's Pawn Game: Symmetrical Variation, Pseudo-Catalan\t1. d4 d5 2. Nf3 Nf6 3. g3\nD02\tQueen's Pawn Game: Symmetrical Variation, Pseudo-Catalan\t1. d4 d5 2. Nf3 Nf6 3. g3 c6 4. Bg2 Bg4\nD02\tQueen's Pawn Game: Zilbermints Countergambit\t1. d4 d5 2. Nf3 Nf6 3. c4 b5\nD02\tQueen's Pawn Game: Zukertort Variation\t1. d4 d5 2. Nf3\nD03\tQueen's Pawn Game: Torre Attack\t1. d4 d5 2. Nf3 Nf6 3. Bg5\nD03\tQueen's Pawn Game: Torre Attack, Gossip Variation\t1. d4 d5 2. Nf3 Nf6 3. Bg5 Ne4\nD03\tQueen's Pawn Game: Torre Attack, Grünfeld Variation\t1. d4 d5 2. Nf3 Nf6 3. Bg5 g6\nD04\tQueen's Pawn Game: Colle System\t1. d4 d5 2. Nf3 Nf6 3. e3\nD04\tQueen's Pawn Game: Colle System, Anti-Colle\t1. d4 d5 2. Nf3 Nf6 3. e3 Bf5\nD04\tQueen's Pawn Game: Colle System, Grünfeld Formation\t1. d4 d5 2. Nf3 Nf6 3. e3 g6 4. Bd3 Bg7\nD05\tQueen's Pawn Game: Colle System\t1. d4 d5 2. Nf3 Nf6 3. e3 e6\nD05\tQueen's Pawn Game: Colle System\t1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3\nD05\tQueen's Pawn Game: Colle System\t1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. b3\nD06\tQueen's Gambit\t1. d4 d5 2. c4\nD06\tQueen's Gambit Declined: Austrian Attack, Salvio Countergambit\t1. d4 d5 2. c4 c5 3. dxc5 d4\nD06\tQueen's Gambit Declined: Austrian Defense\t1. d4 d5 2. c4 c5\nD06\tQueen's Gambit Declined: Austrian Defense, Gusev Countergambit\t1. d4 d5 2. c4 c5 3. cxd5 Nf6\nD06\tQueen's Gambit Declined: Baltic Defense\t1. d4 d5 2. c4 Bf5\nD06\tQueen's Gambit Declined: Baltic Defense, Pseudo-Chigorin\t1. d4 d5 2. c4 Bf5 3. Nc3 e6 4. Nf3 Nc6\nD06\tQueen's Gambit Declined: Baltic Defense, Queen Attack\t1. d4 d5 2. c4 Bf5 3. Qb3\nD06\tQueen's Gambit Declined: Baltic Defense, Queen Attack Deferred\t1. d4 d5 2. c4 Bf5 3. Nc3 e6 4. Qb3\nD06\tQueen's Gambit Declined: Marshall Defense\t1. d4 d5 2. c4 Nf6\nD06\tQueen's Gambit Declined: Marshall Defense, Tan Gambit\t1. d4 d5 2. c4 Nf6 3. cxd5 c6\nD06\tQueen's Gambit Declined: Zilbermints Gambit\t1. d4 d5 2. c4 b5\nD07\tQueen's Gambit Declined: Chigorin Defense\t1. d4 d5 2. c4 Nc6\nD07\tQueen's Gambit Declined: Chigorin Defense\t1. d4 d5 2. c4 Nc6 3. Nc3\nD07\tQueen's Gambit Declined: Chigorin Defense\t1. d4 d5 2. c4 Nc6 3. Nc3 dxc4\nD07\tQueen's Gambit Declined: Chigorin Defense, Exchange Variation\t1. d4 d5 2. c4 Nc6 3. cxd5 Qxd5\nD07\tQueen's Gambit Declined: Chigorin Defense, Janowski Variation\t1. d4 d5 2. c4 Nc6 3. Nc3 dxc4 4. Nf3\nD07\tQueen's Gambit Declined: Chigorin Defense, Lazard Gambit\t1. d4 d5 2. c4 Nc6 3. Nf3 e5\nD07\tQueen's Gambit Declined: Chigorin Defense, Main Line\t1. d4 d5 2. c4 Nc6 3. Nf3 Bg4\nD07\tQueen's Gambit Declined: Chigorin Defense, Main Line, Alekhine Variation\t1. d4 d5 2. c4 Nc6 3. Nf3 Bg4 4. Qa4\nD07\tQueen's Gambit Declined: Chigorin Defense, Modern Gambit\t1. d4 d5 2. c4 Nc6 3. Nc3 dxc4 4. Nf3 Nf6\nD07\tQueen's Gambit Declined: Chigorin Defense, Tartakower Gambit\t1. d4 d5 2. c4 Nc6 3. Nc3 e5\nD08\tQueen's Gambit Declined: Albin Countergambit\t1. d4 d5 2. c4 e5\nD08\tQueen's Gambit Declined: Albin Countergambit, Normal Line\t1. d4 d5 2. c4 e5 3. dxe5 d4 4. Nf3\nD08\tQueen's Gambit Declined: Albin Countergambit, Spassky Variation\t1. d4 d5 2. c4 e5 3. dxe5 d4 4. e4\nD08\tQueen's Gambit Declined: Albin Countergambit, Tartakower Defense\t1. d4 d5 2. c4 e5 3. dxe5 d4 4. Nf3 c5\nD10\tSlav Defense\t1. d4 d5 2. c4 c6\nD10\tSlav Defense\t1. d4 d5 2. c4 c6 3. Nc3\nD10\tSlav Defense\t1. d4 d5 2. c4 c6 3. Nc3 dxc4\nD10\tSlav Defense: Diemer Gambit\t1. d4 d5 2. c4 c6 3. e4\nD10\tSlav Defense: Exchange Variation\t1. d4 d5 2. c4 c6 3. cxd5\nD10\tSlav Defense: Slav Gambit, Alekhine Attack\t1. d4 d5 2. c4 c6 3. Nc3 dxc4 4. e4\nD10\tSlav Defense: Winawer Countergambit\t1. d4 d5 2. c4 c6 3. Nc3 e5\nD10\tSlav Defense: Winawer Countergambit, Anti-Winawer Gambit\t1. d4 d5 2. c4 c6 3. Nc3 e5 4. e4\nD11\tSlav Defense: Bonet Gambit\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Bg5\nD11\tSlav Defense: Breyer Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nbd2\nD11\tSlav Defense: Modern Line\t1. d4 d5 2. c4 c6 3. Nf3\nD11\tSlav Defense: Quiet Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. e3\nD11\tSlav Defense: Quiet Variation, Pin Defense\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. e3 Bg4\nD12\tSlav Defense: Quiet Variation, Schallopp Defense\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. e3 Bf5\nD13\tSlav Defense: Exchange Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. cxd5 cxd5\nD15\tSlav Defense: Chebanenko Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 a6\nD15\tSlav Defense: Schlechter Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 g6\nD15\tSlav Defense: Süchting Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 Qb6\nD15\tSlav Defense: Three Knights Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3\nD15\tSlav Defense: Two Knights Attack\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 dxc4\nD20\tQueen's Gambit Accepted\t1. d4 d5 2. c4 dxc4\nD20\tQueen's Gambit Accepted: Accelerated Mannheim Variation\t1. d4 d5 2. c4 dxc4 3. Qa4+\nD20\tQueen's Gambit Accepted: Central Variation, Alekhine System\t1. d4 d5 2. c4 dxc4 3. e4 Nf6\nD20\tQueen's Gambit Accepted: Central Variation, Greco Variation\t1. d4 d5 2. c4 dxc4 3. e4 b5\nD20\tQueen's Gambit Accepted: Central Variation, McDonnell Defense\t1. d4 d5 2. c4 dxc4 3. e4 e5\nD20\tQueen's Gambit Accepted: Central Variation, McDonnell Defense, Somov Gambit\t1. d4 d5 2. c4 dxc4 3. e4 e5 4. Bxc4\nD20\tQueen's Gambit Accepted: Central Variation, Modern Defense\t1. d4 d5 2. c4 dxc4 3. e4 Nc6\nD20\tQueen's Gambit Accepted: Central Variation, Rubinstein Defense\t1. d4 d5 2. c4 dxc4 3. e4 c5\nD20\tQueen's Gambit Accepted: Central Variation, Rubinstein Defense, Yefimov Gambit\t1. d4 d5 2. c4 dxc4 3. e4 c5 4. d5 b5\nD20\tQueen's Gambit Accepted: Old Variation\t1. d4 d5 2. c4 dxc4 3. e3\nD20\tQueen's Gambit Accepted: Saduleto Variation\t1. d4 d5 2. c4 dxc4 3. e4\nD20\tQueen's Gambit Accepted: Schwartz Defense\t1. d4 d5 2. c4 dxc4 3. e4 f5\nD21\tQueen's Gambit Accepted: Alekhine Defense, Borisenko-Furman Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 a6 4. e4\nD21\tQueen's Gambit Accepted: Godes Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nd7\nD21\tQueen's Gambit Accepted: Gunsberg Defense\t1. d4 d5 2. c4 dxc4 3. Nf3 c5\nD21\tQueen's Gambit Accepted: Normal Variation\t1. d4 d5 2. c4 dxc4 3. Nf3\nD21\tQueen's Gambit Accepted: Rosenthal Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 e6\nD21\tQueen's Gambit Accepted: Slav Gambit\t1. d4 d5 2. c4 dxc4 3. Nf3 b5\nD22\tQueen's Gambit Accepted: Alekhine Defense\t1. d4 d5 2. c4 dxc4 3. Nf3 a6\nD22\tQueen's Gambit Accepted: Alekhine Defense, Haberditz Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 a6 4. e3 b5\nD23\tQueen's Gambit Accepted\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6\nD23\tQueen's Gambit Accepted: Mannheim Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. Qa4+\nD24\tQueen's Gambit Accepted: Showalter Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. Nc3\nD25\tQueen's Gambit Accepted: Janowski-Larsen Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 Bg4\nD25\tQueen's Gambit Accepted: Normal Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3\nD25\tQueen's Gambit Accepted: Smyslov Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 g6\nD25\tQueen's Gambit Accepted: Winawer Defense\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 Be6\nD26\tQueen's Gambit Accepted: Normal Variation, Traditional System\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 e6\nD30\tQueen's Gambit Declined\t1. d4 d5 2. c4 e6\nD30\tQueen's Gambit Declined: Capablanca Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Bg5 h6\nD30\tQueen's Gambit Declined: Tarrasch Defense, Pseudo-Tarrasch\t1. d4 d5 2. c4 e6 3. Nf3 c5\nD30\tQueen's Gambit Declined: Traditional Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Bg5\nD30\tQueen's Gambit Declined: Vienna Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Bg5 Bb4+\nD31\tQueen's Gambit Declined: Alapin Variation\t1. d4 e6 2. c4 b6 3. Nc3 d5\nD31\tQueen's Gambit Declined: Charousek Variation\t1. d4 d5 2. c4 e6 3. Nc3 Be7\nD31\tQueen's Gambit Declined: Janowski Variation\t1. d4 d5 2. c4 e6 3. Nc3 a6\nD31\tQueen's Gambit Declined: Queen's Knight Variation\t1. d4 d5 2. c4 e6 3. Nc3\nD31\tSemi-Slav Defense: Accelerated Move Order\t1. d4 d5 2. c4 e6 3. Nc3 c6\nD31\tSemi-Slav Defense: Marshall Gambit\t1. d4 d5 2. c4 e6 3. Nc3 c6 4. e4\nD31\tSemi-Slav Defense: Noteboom Variation\t1. d4 d5 2. c4 e6 3. Nc3 c6 4. Nf3 dxc4\nD32\tQueen's Gambit Declined: Tarrasch Defense\t1. d4 d5 2. c4 e6 3. Nc3 c5 4. cxd5 exd5\nD32\tTarrasch Defense\t1. d4 d5 2. c4 e6 3. Nc3 c5\nD32\tTarrasch Defense: Schara Gambit\t1. d4 d5 2. c4 e6 3. Nc3 c5 4. cxd5 cxd4\nD35\tQueen's Gambit Declined: Exchange Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 d5 4. cxd5\nD35\tQueen's Gambit Declined: Harrwitz Attack\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bf4\nD35\tQueen's Gambit Declined: Normal Defense\t1. d4 d5 2. c4 e6 3. Nc3 Nf6\nD37\tQueen's Gambit Declined: Barmen Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3 Nbd7\nD37\tQueen's Gambit Declined: Three Knights Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3\nD37\tQueen's Gambit Declined: Three Knights, Vienna Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3 dxc4\nD38\tQueen's Gambit Declined: Ragozin Defense\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3 Bb4\nD40\tQueen's Gambit Declined: Semi-Tarrasch Defense\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3 c5\nD43\tSemi-Slav Defense\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6\nD50\tQueen's Gambit Declined: Been-Koomen Variation\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 c5\nD50\tQueen's Gambit Declined: Modern Variation\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5\nD51\tQueen's Gambit Declined: Modern Variation, Knight Defense\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Nbd7\nD53\tQueen's Gambit Declined\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7\nD70\tNeo-Grünfeld Defense: Goglidze Attack\t1. d4 Nf6 2. c4 g6 3. f3 d5\nD70\tNeo-Grünfeld Defense: with Nf3\t1. d4 Nf6 2. c4 g6 3. Nf3 d5\nD70\tNeo-Grünfeld Defense: with g3\t1. d4 Nf6 2. c4 g6 3. g3 d5\nD80\tGrünfeld Defense\t1. d4 Nf6 2. c4 g6 3. Nc3 d5\nD80\tGrünfeld Defense: Gibbon Gambit\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. g4\nD80\tGrünfeld Defense: Lutikov Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. f3\nD80\tGrünfeld Defense: Stockholm Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Bg5\nD80\tGrünfeld Defense: Zaitsev Gambit\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. h4\nD81\tGrünfeld Defense: Russian Variation, Accelerated Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Qb3\nD82\tGrünfeld Defense: Brinckmann Attack\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Bf4\nD85\tGrünfeld Defense: Exchange Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5\nD90\tGrünfeld Defense: Three Knights Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Nf3\nD90\tGrünfeld Defense: Three Knights Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Nf3 Bg7\nE00\tCatalan Opening\t1. d4 Nf6 2. c4 e6 3. g3\nE00\tCatalan Opening\t1. d4 Nf6 2. c4 e6 3. g3 d5\nE00\tCatalan Opening: Hungarian Gambit\t1. d4 Nf6 2. c4 e6 3. g3 e5\nE00\tIndian Defense\t1. d4 Nf6 2. c4 e6 3. Qb3\nE00\tIndian Defense: Devin Gambit\t1. d4 Nf6 2. c4 e6 3. g4\nE00\tIndian Defense: Seirawan Attack\t1. d4 Nf6 2. c4 e6 3. Bg5\nE01\tCatalan Opening: Closed\t1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2\nE02\tCatalan Opening: Open Defense\t1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 dxc4\nE10\tBlumenfeld Countergambit\t1. d4 Nf6 2. c4 e6 3. Nf3 c5 4. d5 b5\nE10\tIndian Defense: Anti-Nimzo-Indian\t1. d4 Nf6 2. c4 e6 3. Nf3\nE10\tIndian Defense: Dzindzi-Indian Defense\t1. d4 Nf6 2. c4 e6 3. Nf3 a6\nE10\tIndian Defense: Döry Indian\t1. d4 Nf6 2. c4 e6 3. Nf3 Ne4\nE11\tBogo-Indian Defense\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+\nE11\tBogo-Indian Defense: Exchange Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 Bxd2+\nE11\tBogo-Indian Defense: Grünfeld Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Nbd2\nE11\tBogo-Indian Defense: Haiti Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 Nc6\nE11\tBogo-Indian Defense: New England Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Nfd2\nE11\tBogo-Indian Defense: Nimzowitsch Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 Qe7\nE11\tBogo-Indian Defense: Retreat Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 Be7\nE11\tBogo-Indian Defense: Vitolins Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 c5\nE11\tBogo-Indian Defense: Wade-Smyslov Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 a5\nE12\tQueen's Indian Defense\t1. d4 Nf6 2. c4 e6 3. Nf3 b6\nE12\tQueen's Indian Defense: Kasparov Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. Nc3\nE12\tQueen's Indian Defense: Miles Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. Bf4\nE12\tQueen's Indian Defense: Petrosian Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. a3\nE14\tQueen's Indian Defense: Spassky System\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. e3\nE14\tQueen's Indian Defense: Spassky System\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. e3 Bb7\nE15\tQueen's Indian Defense: Fianchetto Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3\nE15\tQueen's Indian Defense: Fianchetto Variation, Nimzowitsch Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Ba6\nE15\tQueen's Indian Defense: Fianchetto Variation, Traditional Line\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Bb7\nE20\tNimzo-Indian Defense\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4\nE20\tNimzo-Indian Defense: Dilworth Gambit\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e4\nE20\tNimzo-Indian Defense: Kmoch Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. f3\nE20\tNimzo-Indian Defense: Mikenas Attack\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qd3\nE20\tNimzo-Indian Defense: Romanishin Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. g3\nE21\tNimzo-Indian Defense: Three Knights Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Nf3\nE22\tNimzo-Indian Defense: Spielmann Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qb3\nE24\tNimzo-Indian Defense: Sämisch Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. a3\nE30\tNimzo-Indian Defense: Leningrad Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Bg5\nE32\tNimzo-Indian Defense: Classical Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qc2\nE33\tNimzo-Indian Defense: Classical Variation, Zurich Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qc2 Nc6\nE34\tNimzo-Indian Defense: Classical Variation, Noa Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qc2 d5\nE38\tNimzo-Indian Defense: Classical Variation, Berlin Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qc2 c5\nE40\tNimzo-Indian Defense: Rubinstein System\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3\nE40\tNimzo-Indian Defense: Rubinstein System, Taimanov Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 Nc6\nE41\tNimzo-Indian Defense: Rubinstein System\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 c5\nE43\tNimzo-Indian Defense: St. Petersburg Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 b6\nE46\tNimzo-Indian Defense: Normal Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 O-O\nE60\tGrünfeld Defense: Counterthrust Variation\t1. d4 Nf6 2. c4 g6 3. g3 Bg7 4. Bg2 d5\nE60\tIndian Defense: Anti-Grünfeld, Adorjan Gambit\t1. d4 Nf6 2. c4 g6 3. d5 b5\nE60\tIndian Defense: Anti-Grünfeld, Advance Variation\t1. d4 Nf6 2. c4 g6 3. d5\nE60\tIndian Defense: Anti-Grünfeld, Alekhine Variation\t1. d4 Nf6 2. c4 g6 3. f3\nE60\tIndian Defense: Anti-Grünfeld, Alekhine Variation, Leko Gambit\t1. d4 Nf6 2. c4 g6 3. f3 e5\nE60\tIndian Defense: Anti-Grünfeld, Basman-Williams Attack\t1. d4 Nf6 2. c4 g6 3. h4\nE60\tIndian Defense: West Indian Defense\t1. d4 Nf6 2. c4 g6\nE60\tKing's Indian Defense: Fianchetto Variation\t1. d4 Nf6 2. c4 g6 3. Nf3 Bg7 4. g3\nE60\tKing's Indian Defense: Fianchetto Variation, Immediate Fianchetto\t1. d4 Nf6 2. c4 g6 3. g3\nE60\tKing's Indian Defense: Normal Variation, King's Knight Variation\t1. d4 Nf6 2. Nf3 g6 3. c4\nE60\tKing's Indian Defense: Santasiere Variation\t1. d4 Nf6 2. c4 g6 3. Nf3 Bg7 4. b4\nE60\tQueen's Pawn, Mengarini Attack\t1. d4 Nf6 2. c4 g6 3. Qc2\nE61\tKing's Indian Defense\t1. d4 Nf6 2. c4 g6 3. Nc3\nE70\tKing's Indian Defense: Normal Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4\nE70\tKing's Indian Defense: Normal Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6";
function parsePacked(packed) {
  return packed.split("\n").map((l) => l.split("\t")).filter((r) => r.length >= 3 && r[0] && r[2]);
}
async function loadFullEco() {
  const cached = await loadStore("ct-eco-full", null);
  if (cached && cached.length > 2000) return cached;
  try {
    const urls = ["a", "b", "c", "d", "e"].map(
      (x) => `https://raw.githubusercontent.com/lichess-org/chess-openings/master/${x}.tsv`);
    const texts = await Promise.all(urls.map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error(); return r.text(); })));
    const rows = [];
    for (const t of texts)
      for (const line of t.split("\n").slice(1)) {
        const p = line.split("\t");
        if (p.length >= 3 && p[0] && p[2]) rows.push([p[0], p[1].trim(), p[2].trim()]);
      }
    if (rows.length > 2000) { saveStore("ct-eco-full", rows); return rows; }
  } catch (e) {}
  return null;
}

/* ---------- tactics puzzle database ----------
   413 puzzles curated from the real Lichess puzzle database (millions of
   community-rated, community-solved positions), filtered for popularity
   and play count, spread across 17 tactical themes and 5 difficulty tiers,
   then re-verified move-for-move with python-chess during the build. */
const PUZZLE_EMBED = "18Oqb\thangingPiece\thard\t1826\tb\t2r2r2/3qbppk/p1n2N1p/1p2pP2/4n3/P3BN2/1PP1B1K1/R2Q3R b - - 1 22\te4f6 d1d7 f6d7\n1XjT9\thangingPiece\thard\t1771\tw\t6k1/p1q2pp1/1r2b2p/8/4PP2/b1pQ2P1/1P4BP/1RB4K w - - 0 29\tb2a3 e6c4 d3c2 b6b1 c2b1\n0JblX\thangingPiece\thard\t1712\tw\t3r1k1r/p1p2ppp/8/1B6/6P1/2q5/PPPR2PP/2K4n w - - 0 20\td2d8 f8e7 d8d7 e7e6 b2c3\n1iIHX\thangingPiece\thard\t1941\tw\t8/5p2/6kp/4b1p1/2N1P3/r4P1P/5n2/3R2K1 w - - 0 42\tc4e5 g6f6 e5d7 f6e7 g1f2\n0vxB2\thangingPiece\thard\t1805\tb\tr4rk1/pb3ppp/1pn1p3/3q4/1b1N4/6P1/PP1BPPBP/R2Q1RK1 b - - 1 13\td5d4 d2b4 d4b4\n1q4El\tfork\tmedium\t1362\tb\tr5k1/p6p/6p1/2N5/2p5/4nN1P/PRP1rRP1/6K1 b - - 4 23\te2f2 g1f2 e3d1 f2e2 d1b2\n1HVAi\tfork\tmedium\t1453\tb\tr5k1/bbpp1pNp/pq6/1p1P4/1P2Q3/P4N2/1B3RPP/R5K1 b - - 0 21\tb6f2 g1h1 f2b2 a1e1 b2g7\n05jmH\tfork\tmedium\t1533\tb\t3r4/ppp1kp1p/4np2/7R/8/2N5/PPPrRPPP/5K2 b - - 9 21\td2e2 f1e2 e6f4 e2e3 f4h5\n1WMKY\tfork\tmedium\t1439\tb\t3r1rk1/pp3pp1/5q2/6Qp/3nPB2/2N5/PP3P1P/R3K2R b KQ - 1 18\td4f3 e1e2 f3g5\n1oEt1\tfork\tmedium\t1441\tw\t3k4/pb3Q1N/1pq1p1p1/8/2Pr4/P4P2/1P4PP/6K1 w - - 1 29\tf7f6 d8c8 f6d4\n1kwiX\tmateIn2\tmedium\t1354\tw\t2k2r2/p6p/2P3p1/5p2/8/8/PP3P1b/K2Q1Bq1 w - - 1 32\td1d7 c8b8 d7b7\n1M0ex\tmateIn2\tmedium\t1409\tw\t1r4nr/3N1pkp/2B1p1p1/8/Pp3N2/3P2P1/1bPQKP1P/q7 w - - 3 24\tf4h5 g6h5 d2g5\n0rEgR\tmateIn2\tmedium\t1470\tw\trn1qkbnr/pp3ppp/3p4/2p1N3/2B1P3/2N5/PPPP1PPP/R1BbK2R w KQkq - 0 6\tc4f7 e8e7 c3d5\n0jFaq\tmateIn2\tmedium\t1355\tw\t3r3R/p1rk1pp1/2pb4/6P1/3p1P2/1PnP4/PB4B1/K3R3 w - - 9 32\tg2h3 f7f5 g5f6\n0VwT4\tmateIn2\tmedium\t1431\tb\t4brk1/7p/p2Qp1p1/3p4/3q4/7R/PPP1B1PP/7K b - - 2 29\td4d1 e2d1 f8f1\n05010\thangingPiece\tmedium\t1493\tb\tr1b1r1k1/pp3ppp/1bq5/8/3N1Q2/1PN2P2/P1P3PP/R1B2R1K b - - 0 16\tc6c3 c1d2 c3d4\n1fnHn\thangingPiece\tmedium\t1554\tw\tr4rk1/pp2bppp/3pbn2/3Np1B1/2PpP3/3P4/PP1qBPPP/RR4K1 w - - 0 13\td5e7 g8h8 g5d2\n11f6q\thangingPiece\tmedium\t1506\tw\tr2qkbnr/pQp3pp/2n2p2/3p3b/3P4/2P1P1BP/PP3Pp1/RN2KB1R w KQkq - 0 10\tb7c6 e8f7 f1g2\n1mUyd\thangingPiece\tmedium\t1541\tw\t4r1k1/pp3p1p/1n3p2/8/5bb1/1PN5/1PP3PP/4RK2 w - - 0 22\te1e8 g8g7 e8e4 g4f5 e4f4\n0Cz4W\thangingPiece\tmedium\t1625\tw\t1k5r/1qr4p/5Qp1/3P4/8/b4P2/1PP3PP/3R2K1 w - - 0 32\tf6h8 b7c8 h8c8 b8c8 b2a3\n0I0k1\tskewer\texpert\t2153\tb\t8/ppp3rk/8/4R2p/2Q2KP1/P4P2/1P6/6q1 b - - 0 38\tg7g4 f3g4 g1g4 f4e3 g4c4\n1Hiy5\tskewer\texpert\t2115\tb\t2k3nr/ppp5/4p3/2b5/3rP3/2N3P1/PP1B2P1/R2R1K2 b - - 2 19\td4d2 d1d2 h8h1 f1e2 h1a1\n1f713\tskewer\texpert\t2230\tw\tr4r2/2p1qpk1/p2p2pR/1p6/4PPP1/2P1B3/P1P1K1P1/7R w - - 3 25\te3d4 f7f6 h6h7 g7g8 h7e7\n0Sg2t\tskewer\texpert\t2128\tb\t8/4k2p/1pb1p3/p4p2/2PB4/1PN1KP2/P5Pb/8 b - - 3 31\te6e5 d4b6 h2g1 e3d2 g1b6\n1hiyu\tskewer\texpert\t2190\tb\tr3r1k1/1Q3ppp/2p2nn1/3p4/1B6/pP1BPP2/1qP2P1P/R5RK b - - 2 24\ta8b8 b7c6 b8b4\n13lvP\tmateIn1\tbeginner\t886\tw\trn1qk2r/ppp2ppp/3p4/2b1p1P1/2B5/5Q2/PPPP3P/RNB1K1Nn w Qkq - 0 9\tf3f7\n1Nt5I\tmateIn1\tbeginner\t860\tw\t5k2/pb3r1p/p2N4/2p2r2/2pB4/4R2P/PP4P1/6K1 w - - 0 39\te3e8\n1Q8Ck\tmateIn1\tbeginner\t855\tw\t6k1/1p3qp1/p1p2rN1/2bp3Q/6P1/2P4P/PP6/4R2K w - - 3 29\th5h8\n1Jqzh\tmateIn1\tbeginner\t759\tw\t3r2k1/5ppp/p5q1/1p1Q4/8/P1b4P/1P3PP1/4R1K1 w - - 0 34\td5d8\n13YPA\tmateIn1\tbeginner\t840\tb\tr4rk1/2q3p1/p3pPb1/2Pp3p/6n1/1P6/PBPN2PP/R3QRK1 b - - 0 18\tc7h2\n14TtR\tpin\texpert\t2115\tb\tr4r1k/1Q1p2pp/p2P4/2P5/7q/5p2/1P3PPP/RN2R1K1 b - - 0 22\th4g4 b7f3 f8f3\n0vFnj\tpin\texpert\t2101\tw\trnbq4/pp1kp2Q/2p5/3pP3/8/2N5/PPP2PP1/2KR4 w - - 3 20\tc3d5 c6d5 d1d5 d7c7 d5d8\n1ewl2\tpin\texpert\t2132\tw\t7r/p1qr1pk1/1p2p1p1/2p1P2Q/7P/2P3R1/PP4P1/5RK1 w - - 1 27\tf1f7 d7f7 g3g6 g7f8 h5h8\n08GkN\tpin\texpert\t2106\tb\t8/p1p3pk/b6p/P3p3/2P2r1b/8/2PR1P1P/2Q3K1 b - - 3 31\tf4g4 g1f1 a6c4 d2d3 e5e4\n1MqgE\tpin\texpert\t2210\tw\tr2q1rk1/pp2bppp/2b1p3/3p2Bn/8/P1NB2R1/1P1Q1PPP/2R3K1 w - - 7 19\tg5e7 d8e7 d2h6 g7g6 h6h5\n1hdGX\tdiscoveredAttack\tmedium\t1418\tb\t2r3k1/1b3pp1/1p2pn1p/1B2N3/Pq2p3/2b3QP/4R1PB/2R3K1 b - - 2 29\tc3d4 g1f1 c8c1\n0U4gN\tdiscoveredAttack\tmedium\t1453\tw\t3rr1k1/3bRp2/p2p1pp1/1p1P4/8/3B3P/P1P2KP1/4R3 w - - 6 26\te7d7 d8d7 e1e8\n1MnWE\tdiscoveredAttack\tmedium\t1504\tb\tr2qk1nr/pppbppbp/3p2p1/1B1Pn3/4P3/2N1BN2/PPP2PPP/R2QK2R b KQkq - 2 7\te5f3 d1f3 g7c3 b2c3 d7b5\n0MwUh\tdiscoveredAttack\tmedium\t1323\tw\t2kr1bnr/pp3ppp/1np5/4P3/3QB2q/8/PPP2PPP/R1B2RK1 w - - 4 12\te4f5 c8b8 d4h4\n0FHVA\tdiscoveredAttack\tmedium\t1556\tb\t4r1k1/R2n1pp1/1p1B2qp/2pP4/2P5/1Q3N1P/1b3PP1/6K1 b - - 1 26\tg6b1 g1h2 b2e5 f3e5 b1b3\n1hboI\thangingPiece\texpert\t2110\tw\tr1bqr1k1/pp3ppp/2p2n2/3p2B1/8/1B1P1Q2/PPP1NPPb/R3R1K1 w - - 0 13\tg1h2 f6g4 f3g4 c8g4 g5d8\n1cvKk\thangingPiece\texpert\t2136\tb\t8/8/1p2p2k/BP1pP2p/P2P1K1P/8/1n6/8 b - - 0 52\tb6a5 b5b6 b2d3 f4f3 d3b4\n1ZurT\thangingPiece\texpert\t2167\tb\t2rk1b1r/Bp1q1ppp/3p1n2/3P4/Q7/3B1P2/PP1N1P1P/R3R1K1 b - - 0 18\td7a4 a7b6 c8c7 a1c1 f6d5\n073LS\thangingPiece\texpert\t2237\tw\tR4bk1/8/6P1/1p3r2/5K2/p7/8/8 w - - 0 48\tf4f5 b5b4 f5f6 a3a2 a8a2\n1U0Lu\thangingPiece\texpert\t2101\tb\t1nb1kb1r/1p3ppp/Bq2pn2/2pp4/8/P3P1P1/1BPP1P1P/RN1QK1NR b KQk - 0 8\tb6b2 b1c3 b8a6 d1b1 b2b1\n1mAGC\tmateIn1\tmedium\t1671\tw\t5rk1/p1p1qp2/1r1p1n2/4b1p1/PPB2p2/7R/2QN2PK/2B5 w - - 2 23\tc2g6\n0n8HL\tmateIn1\tmedium\t1478\tw\t8/5rp1/p4r2/6R1/3Kpk1P/8/P5R1/8 w - - 0 39\tg2f2\n0vqHt\tmateIn1\tmedium\t1432\tw\tr2qkb2/pbpnp1pr/1p1p1p2/8/3P4/3BPNP1/PPP2PP1/RN1QK3 w Qq - 0 10\td3g6\n0SMB8\tmateIn1\tmedium\t1346\tw\t3R4/p1R5/4kB2/6Kp/P5b1/7r/6r1/8 w - - 3 46\tc7e7\n1SEtU\tmateIn1\tmedium\t1317\tw\tr1b2rk1/p5np/2pQ2p1/2p3q1/4P1pb/2NP4/PPP4P/R3rR1K w - - 0 24\td6f8\n1iEHl\tdeflection\thard\t1760\tw\tr4br1/ppQqk2p/2n5/3p3n/3P3P/2P5/PP3KP1/RNB4R w - - 1 17\th1e1 e7f7 c7d7\n13XCK\tdeflection\thard\t1706\tw\tr5k1/2pqp3/2Np1r1p/1P1n2p1/8/P4p1P/5PPB/Q3R1K1 w - - 0 26\tc6e7 d5e7 a1f6\n1dKJS\tdeflection\thard\t1728\tb\t2r3k1/1p3pp1/1Q3n1p/q2Pp3/4P3/r5P1/P4PBP/RR4K1 b - - 0 25\tc8c1 b1c1 a5b6\n0YDRD\tdeflection\thard\t1766\tb\t8/6r1/8/P1R3PP/5p2/3k3K/2p5/8 b - - 0 54\tg7g5 c5g5 c2c1q\n0re5p\tdeflection\thard\t1775\tb\t8/2p3k1/5p2/2p1P1p1/1p1P4/1KP2N2/1Q4P1/1q6 b - - 4 44\tc5c4 b3c4 b1b2\n0KE1r\tpin\thard\t1982\tb\tr3k2r/pp1b1p1p/2n1pp2/q2p3N/1b1P4/1QN1P3/PP3PPP/R3KB1R b KQkq - 7 11\tc6d4 e3d4 d7a4 b3a4 a5a4\n0V6WR\tpin\thard\t1870\tw\tr2k3r/1b2q3/p5Qp/1pp5/3b4/P2PB2P/B1P2PP1/4R1K1 w - - 2 24\te3g5 h6g5 e1e7\n1nUO4\tpin\thard\t1865\tw\t1b1r1qk1/1p2rppp/p7/5P2/Q5R1/4PN1P/PP2R3/5K2 w - - 13 29\tf5f6 e7e6 g4g7 f8g7 f6g7\n0VbSQ\tpin\thard\t1780\tb\tr5k1/pp3pp1/2p1r2p/3p1q2/3Nn3/P1PQP2P/1P2RPP1/4RK2 b - - 11 23\te4g3 f1g1 f5d3\n12inZ\tpin\thard\t1770\tb\tr1b1r1k1/pppp1p1p/5qp1/3P4/8/1PB2BP1/P3NP1P/R2QK2R b KQ - 0 14\tf6c3 e1f1 c3f3\n1DU9r\tskewer\tmedium\t1509\tb\t2k5/p2p2p1/3B4/4N2p/6nP/2PP4/r7/3K2R1 b - - 0 32\ta2a1 d1e2 a1g1\n141wP\tskewer\tmedium\t1419\tw\t7r/R4pp1/1p2k3/1B2p3/1P2n1n1/2r2N1p/P4PP1/5RK1 w - - 0 32\tb5d7 e6f6 d7g4\n15xNM\tskewer\tmedium\t1498\tb\t6k1/p1p2pp1/2p3rp/8/3PbB1P/1PP5/P4P1P/R4K2 b - - 4 27\te4d3 f1e1 g6g1 e1d2 g1a1\n02KwH\tskewer\tmedium\t1469\tw\tr5k1/6pR/3prPP1/8/1pp1P3/p7/2P5/1K6 w - - 0 39\tf6f7 g8f8 h7h8 f8e7 h8a8\n1HtCL\tskewer\tmedium\t1318\tw\t8/8/2b3p1/2k1Bp2/5P2/r7/P7/3RK3 w - - 0 39\te5d6 c5c4 d6a3\n18Gb1\tmateIn2\teasy\t1231\tb\t8/5kpR/1p2p1r1/5p2/8/1P2Qn2/P4PBP/3q1N1K b - - 23 40\td1f1 g2f1 g6g1\n02kCY\tmateIn2\teasy\t1291\tw\t8/8/8/7p/p1b4k/P6P/2p3P1/2B3K1 w - - 8 47\tg1h2 c4f1 g2g3\n0Nwlm\tmateIn2\teasy\t1240\tb\t4r2k/3p1p2/p1b2R1p/1pQ5/8/1B4rP/PP3PP1/6K1 b - - 0 29\te8e1 g1h2 g3g2\n0RpxK\tmateIn2\teasy\t1294\tw\tr4r1k/pp5p/2qp4/2pn1pQ1/2P5/2PP2P1/P5K1/R6R w - - 2 24\th1h7 h8h7 a1h1\n1kTIe\tmateIn2\teasy\t1277\tb\t6k1/p4p2/2p4p/5qp1/1PPb4/P7/3Q1RPP/6K1 b - - 0 31\tf5b1 d2e1 b1e1\n11mtr\tmateIn3\teasy\t1171\tb\t8/pbq2pk1/8/2p5/8/2N2P1P/PPP2N2/3RR2K b - - 0 28\tb7f3 h1g1 c7g3 g1f1 g3g2\n1ZyRT\tmateIn3\teasy\t1265\tw\t6k1/4p3/4Nrp1/8/2q5/2b1QPK1/P1Pr4/7R w - - 7 31\th1h8 g8h8 e3h6 h8g8 h6g7\n0Snoe\tmateIn3\teasy\t1199\tw\tr5k1/p2bQ1pp/2p5/1p1p4/3P2q1/3B4/PP5P/1K3R2 w - - 2 22\te7f7 g8h8 f7f8 a8f8 f1f8\n0e2Fb\tmateIn3\teasy\t1263\tw\t4r1rk/pp1b4/2p2pPq/3p4/1P1P3R/P2BP2P/6P1/6K1 w - - 0 42\th4h6 h8g7 h6h7 g7f8 h7f7\n0QnqT\tmateIn3\teasy\t1295\tb\tr7/5kpp/5r2/3N4/p3p2q/4P3/PP1BQbPP/R4R1K b - - 0 25\th4h2 h1h2 f6h6 e2h5 h6h5\n1eGAG\tmateIn1\teasy\t1257\tw\t4rk2/pp1R1r2/2p2Q2/5Pp1/1Pq5/P5P1/6PK/8 w - - 1 39\tf6h8\n0XIsH\tmateIn1\teasy\t1169\tw\tr4bkr/pp4p1/2nq1PBp/3p4/3P3P/2N1Bp2/PPP2P2/R3K2R w KQ - 0 17\tf6f7\n08jJr\tmateIn1\teasy\t1161\tb\t1r1r2k1/2p3pp/2P1Np2/p1n2P2/P1P1b3/2K5/4B2P/R5R1 b - - 1 29\tb8b3\n1DZfz\tmateIn1\teasy\t1107\tw\t7k/2p2R1p/1p2pN2/p4p2/4b3/1P6/1PPK1Pr1/8 w - - 5 33\tf7h7\n0Pxcy\tmateIn1\teasy\t1247\tw\t6k1/pp4r1/7p/2p1Q3/2P1P2q/1PP2r1P/P6K/6R1 w - - 0 28\te5g7\n1SRTe\tfork\teasy\t1295\tb\t1k3r2/pp4p1/2pp2r1/4P3/7b/1BP5/P3K2B/RN3R2 b - - 8 30\tg6g2 e2d3 f8f1\n07X3h\tfork\teasy\t1273\tw\trn2k2r/1b1p1pbp/pp2p3/1N1n4/4q3/1Q6/PP2NPPP/R3KB1R w KQkq - 0 13\tb5d6 e8d8 d6e4\n0hWDC\tfork\teasy\t1292\tb\tr5k1/1q3ppp/1p2p3/2n5/1P1N4/r3P3/1Q2RPPP/2R3K1 b - - 0 25\tc5d3 b2a3 a8a3\n0zwNg\tfork\teasy\t1265\tb\t4nk2/p2pR1p1/1p1P3p/4Q1q1/5n2/5P1P/PB3P2/5K2 b - - 6 27\tg5g2 f1e1 f4d3 e1e2 d3e5\n0f9QF\tfork\teasy\t1286\tw\t8/1R5p/2k5/5B2/3b1P2/8/1p1K3P/7r w - - 10 49\tf5e4 c6c5 e4h1\n1Zhky\tsacrifice\thard\t1964\tw\t1r4k1/1N5p/3nP1p1/p7/P7/8/1R5P/7K w - - 1 40\tb7d6 b8b2 e6e7\n0nGLj\tsacrifice\thard\t1714\tb\tr3r1k1/ppp1b2p/3p2pB/8/4PQ2/3P3q/PPP4P/2K2RR1 b - - 2 19\te8f8 h6f8 a8f8\n0TPHM\tsacrifice\thard\t1722\tb\tr5k1/5p2/p1q1bbpp/Qp1pp3/PP6/1N1P2P1/4PPBP/2R3K1 b - - 4 25\tc6c1 b3c1 f6d8 a5d8 a8d8\n1WR96\tsacrifice\thard\t1815\tb\t4r1k1/1p4pp/6r1/1P1qpp2/P2n4/3Q4/1B1P1RPP/R5K1 b - - 2 25\tg6g2 f2g2 d4f3 d3f3 d5f3\n1InM2\tsacrifice\thard\t1833\tw\t2rr2k1/pp1b2p1/1qn1pb1p/3p1p2/3P1B2/2n2N1P/PP2QPP1/1R1BRNK1 w - - 0 18\tb2c3 b6b1 d1b3 b1e4 e2d2\n1IWKC\tskewer\teasy\t1261\tw\t3r4/1p1r3p/pRp1pkp1/5p2/2PP1B1P/P3P3/4KPP1/8 w - - 1 39\tf4g5 f6f7 g5d8\n0LmWt\tskewer\teasy\t1261\tw\t5n2/r5p1/4pk2/p2p4/3P1N2/2P2PR1/Pr6/6RK w - - 2 32\tf4h5 f6e7 g3g7 e7d6 g7a7\n1iJJo\tskewer\teasy\t1290\tw\t8/8/8/7B/5p2/3k4/2r2PK1/8 w - - 10 55\th5g6 d3c3 g6c2 c3c2 g2f3\n0WC3o\tskewer\teasy\t1284\tw\t6rk/pppq4/6R1/4p1NP/2P1P1p1/P2P2K1/1P6/8 w - - 1 34\tg6h6 h8g7 h6h7 g7f6 h7d7\n1g8lk\tskewer\teasy\t1276\tb\t4r3/8/1p6/2p5/3p1Kp1/7k/5N1P/6R1 b - - 5 38\th3h2 g1g4 e8f8 f4e4 f8f2\n0yxuY\thangingPiece\teasy\t1278\tb\tr1b1kb1r/1pp2Npp/p1p5/3q4/4N3/8/PPPP1PPP/R1BQK2R b KQkq - 0 8\td5e4 d1e2 e4e2 e1e2 e8f7\n1nOiC\thangingPiece\teasy\t1296\tb\t1r1R4/q5p1/p1k2b1p/2p1p3/P1Q1P3/4B2P/5PP1/1R4K1 b - - 0 26\tb8b1 g1h2 f6d8\n0MqY4\thangingPiece\teasy\t1199\tb\t1R5r/1pp1k3/4n1p1/2P3Pp/4q3/4B3/3Q2PP/1R4K1 b - - 0 37\te4b1 d2c1 b1c1 e3c1 h8b8\n0ICJl\thangingPiece\teasy\t1265\tw\tr5k1/6p1/2p2p2/1pNp2p1/1P6/1B3P2/1Bb2KPP/8 w - - 6 29\tb3c2 a8a2 c5d3\n1Hc8x\thangingPiece\teasy\t1251\tb\t4r2k/1p3p1p/p4rN1/2B2n2/8/P1P4P/1P3R2/4R1K1 b - - 0 30\tf6g6 g1h2 e8e1\n026QC\tsacrifice\texpert\t2285\tw\t8/R1r5/1p5p/1kq1pr2/1N1p4/P2P1p2/1PP4P/2K2Q2 w - - 1 37\ta3a4 b5b4 f1e1 c5c3 b2c3\n1HaiE\tsacrifice\texpert\t2212\tb\tr3r1k1/pp3qpp/2pp4/2b2b2/2P1BP2/1P1Q2P1/PB3P1P/1R2R1K1 b - - 2 19\te8e4 e1e4 d6d5 c4d5 c6d5\n1p6Ue\tsacrifice\texpert\t2125\tw\t4q2k/pp4p1/5r1p/1P2N3/PP2Qp2/4n3/5KPP/2R5 w - - 11 43\te5f7 e8f7 c1c8 f7g8 c8g8\n1glRg\tsacrifice\texpert\t2171\tw\t8/8/8/P7/1pK2pkp/2b1B3/7P/8 w - - 0 50\te3f4 g4f4 a5a6\n0UWoJ\tsacrifice\texpert\t2137\tw\t5rk1/ppp3pp/2q1p3/8/6Q1/P1nr4/1B3PPP/2R2RK1 w - - 2 20\tc1c3 d3c3 g4d4\n1JCfN\tpin\tmedium\t1383\tb\t8/2R1nk1p/1p3pb1/3pq3/8/5QPB/1r5P/2R3K1 b - - 5 41\te5d4 g1h1 g6e4\n1EuFZ\tpin\tmedium\t1424\tw\t1r4k1/p3Pp1p/2n3p1/3P1b2/8/2P5/P2R2PP/5K2 w - - 0 27\td5c6 b8e8 d2d8\n0aOPI\tpin\tmedium\t1428\tb\t4k3/4P2p/6p1/6P1/1K2R2P/2pr4/8/8 b - - 1 50\tc3c2 e4c4 d3d4 c4d4 c2c1q\n1cyms\tpin\tmedium\t1367\tw\tr1bqrbk1/ppp2ppp/3p1n2/2n2N2/4PP2/1BN3Q1/PPP3PP/R1B2RK1 w - - 7 13\tf5h6 g8h8 h6f7\n1Hutq\tpin\tmedium\t1418\tw\t2kr3r/1ppqppb1/p6p/4n1p1/2NP4/4P1P1/PP2QPP1/2R1K2R w K - 0 16\tc4b6 c8b8 b6d7\n1SZZV\tadvancedPawn\thard\t1854\tw\t6R1/p4p2/4pk2/5p1P/r7/6PK/2r5/7R w - - 5 37\th5h6 a4g4 h6h7\n1fpto\tadvancedPawn\thard\t1708\tb\t8/Pk6/8/4K3/4Pppp/5P2/6PP/8 b - - 0 45\th4h3 e5f4 h3g2\n12Wu8\tadvancedPawn\thard\t1791\tb\t2k3QK/2p5/R7/8/8/1p4r1/8/8 b - - 0 48\tg3g8 h8g8 b3b2\n06e9g\tadvancedPawn\thard\t1800\tw\tr4rk1/pppqb1pp/2Pp3n/4Pp2/7P/P5B1/1PP1b1P1/RN1QK2R w KQ - 0 13\td1d5 g8h8 c6d7\n1aBxZ\tadvancedPawn\thard\t1767\tb\t8/p5k1/3R4/1N4pp/1P6/P3p1PP/2r5/6K1 b - - 0 44\tc2c1 g1g2 e3e2\n1mMxc\tadvancedPawn\teasy\t1288\tw\t3k4/6p1/p1KP2p1/8/PP6/8/7n/8 w - - 0 48\tb4b5 a6a5 b5b6 h2f3 b6b7\n0QyOo\tadvancedPawn\teasy\t1296\tw\t4r1k1/1p1b1p2/3P2p1/p6p/3N4/P1P1Q3/1P4q1/1K2R3 w - - 1 41\te3e8 d7e8 e1e8 g8g7 d6d7\n12Uye\tadvancedPawn\teasy\t1284\tb\t8/8/1Qnk4/2pp1n2/3q3p/6pP/1P3PP1/3R1RK1 b - - 7 43\tg3f2 f1f2 d4d1\n1UPyy\tadvancedPawn\teasy\t1197\tb\t4r3/6KP/3p4/4k3/1R6/P1P1p3/1P6/8 b - - 0 54\te3e2 h7h8q e8h8\n0pHwk\tadvancedPawn\teasy\t1211\tb\t5k2/1p6/p2p1Q2/3N3P/2P5/1P3p2/1q4PK/8 b - - 5 48\tb2f6 d5f6 f3f2\n0KHJe\tmateIn2\tbeginner\t888\tw\t5bk1/3R3p/4n1p1/5p2/6N1/7P/5KP1/2r5 w - - 0 43\tg4f6 g8h8 d7h7\n07uNx\tmateIn2\tbeginner\t875\tb\t3Q4/5Pkp/6p1/8/7P/6P1/rr3n2/5RK1 b - - 0 34\tf2h3 g1h1 b2h2\n0JqYd\tmateIn2\tbeginner\t684\tb\tr1b1r1k1/4qppp/p2N4/1ppn4/8/2PP4/PPB2PPP/R1BQR1K1 b - - 0 19\te7e1 d1e1 e8e1\n1OPjK\tmateIn2\tbeginner\t865\tb\t5r1k/6pp/4Q3/8/1p4B1/8/P4qPP/4R2K b - - 1 32\tf2f1 e1f1 f8f1\n13GPl\tmateIn2\tbeginner\t736\tb\t3r2k1/p5pp/8/4p3/N5Q1/1P6/P2qnPPP/R6K b - - 8 30\td2d1 a1d1 d8d1\n1VD7w\tdeflection\teasy\t1089\tb\t2r3k1/2r3bp/p5p1/1p2pp1n/5P2/1PP2qPP/P1RQB2K/2R2N2 b - - 1 33\tf3f2 h2h1 h5g3 f1g3 f2g3\n1ZE6U\tdeflection\teasy\t1250\tb\trn2k2r/pp2pp2/2p2pbb/3p3p/2PP3P/2N2Pq1/PP2P3/R1BKQBNR b kq - 3 11\tg6c2 d1c2 g3e1\n0dIJR\tdeflection\teasy\t1280\tw\tr3r1k1/p4pp1/1p5p/4b3/7q/2P2Q2/P2B1PP1/2R1R1K1 w - - 0 23\te1e5 e8e5 f3a8\n1OsOa\tdeflection\teasy\t1223\tw\t2kr4/1pp3p1/p3b2p/4N3/1nP5/1P4P1/5PBP/3R2K1 w - - 3 23\tg2b7 c8b7 d1d8\n0D4lq\tdeflection\teasy\t1261\tw\t2R5/3b1pkp/Q4qp1/3p4/8/1p3N1P/1r3PP1/6K1 w - - 4 29\tc8g8 g7g8 a6f6\n1gp2Z\tfork\thard\t1873\tb\tr2q2k1/3n1pp1/R1Q4p/8/2P1p3/4B3/1P3PPP/6K1 b - - 0 28\td7b8 c6e8 d8e8\n0VH9x\tfork\thard\t1948\tb\t2rqkbnr/4pppp/p2p4/1p1Pn3/P3P3/1B3P2/1P3P1P/RNBQK2R b KQk - 0 11\tc8c1 d1c1 e5d3 e1e2 d3c1\n0cvM3\tfork\thard\t1992\tw\t8/pppb2kr/2n1ppp1/6P1/3PN3/2P1P3/P3KPP1/7R w - - 0 22\th1h7 g7h7 e4f6 h7g7 f6d7\n0jpyZ\tfork\thard\t1966\tb\trn2kb1r/ppp2ppp/8/7b/1qB1n3/4PNBP/PPPN1PP1/R2Q1RK1 b kq - 6 11\te4d2 d1d2 b4c4\n1gaCv\tfork\thard\t1946\tb\t8/8/p3B3/Pp2P3/1P1P2nk/2Pp3r/1B4K1/3R4 b - - 5 52\tg4e3 g2g1 h3g3\n0402R\tpromotion\texpert\t2160\tw\t7k/p6p/1p1rrp2/3P4/2P5/1P2R1P1/P4pbP/K4R2 w - - 2 38\td5e6 g2f1 e6e7 f1c4 e7e8q\n0KlgQ\tpromotion\texpert\t2170\tb\t7k/R3b2P/7B/3pPp2/3P4/5KP1/p1r5/8 b - - 4 50\tc2c3 f3f4 c3a3 a7e7 a2a1q\n0sQZg\tpromotion\texpert\t2216\tw\t2Rr4/pp1Pk1pp/8/1P1Q4/P3p1qr/5pP1/5P2/5RK1 w - - 6 37\td5e5 e7f7 e5e8 d8e8 d7e8q\n1r3h2\tpromotion\texpert\t2184\tb\t8/8/1p2B3/1N4p1/Pkp5/3p2K1/8/8 b - - 3 48\tc4c3 e6f5 c3c2 f5d3 c2c1q\n0w5qa\tpromotion\texpert\t2172\tw\t5k2/7R/3KP3/6p1/8/8/5r1p/8 w - - 2 51\te6e7 f8g8 h7h2 f2h2 e7e8q\n0ICTk\tmateIn3\thard\t1830\tb\t6k1/1b3rp1/pbB1Q3/8/3q1P2/1P4P1/P4R1P/2R3K1 b - - 0 40\td4f2 g1h1 f2f3 c6f3 b7f3\n1RT0X\tmateIn3\thard\t1914\tb\t2kr1b1r/pppb1ppp/3q4/1B2P3/4Q3/P7/1PP2PPP/R1B1K2R b KQ - 0 11\td6d1 e1d1 d7g4 d1e1 d8d1\n0KuxT\tmateIn3\thard\t2064\tw\t3q2r1/1b1nbp1k/4p2p/3pP2Q/2pP1PPN/1pP5/1P6/rNKR3R w - - 1 26\th5h6 h7h6 h4f5 h6g6 h1h6\n0z9Wy\tmateIn3\thard\t2088\tb\t6k1/p4pp1/7p/5q2/7K/1PP3P1/P3QP1P/5B2 b - - 0 38\tg7g5 h4h5 g5g4 h5h6 f5g6\n1HV02\tmateIn3\thard\t1910\tw\t2k5/ppp4p/3r4/7Q/1P2p3/P1P1q3/6r1/5R1K w - - 0 34\tf1f8 d6d8 h5f5 c8b8 f8d8\n1C0l6\tdeflection\tmedium\t1342\tw\t2k2r1r/pppq2p1/1b2p3/4p1Bp/Q2n4/3P2P1/PP2PPBP/2R2RK1 w - - 6 17\tg2b7 c8b7 a4d7\n0pT9G\tdeflection\tmedium\t1378\tw\trn1qkbnr/1b2pppp/p7/1P6/2B5/2p1PN2/1P3PPP/R1BQK2R w KQkq - 0 9\tc4f7 e8f7 d1d8\n1CO6V\tdeflection\tmedium\t1497\tw\tr1bqkb1r/1p2ppp1/p4n1p/4p3/2BQ1P2/8/PPP3PP/RNB2RK1 w kq - 0 10\tc4f7 e8f7 d4d8\n1n1yr\tdeflection\tmedium\t1506\tb\tr7/P2R3p/4p3/8/8/3p1P2/2k3PP/4K3 b - - 6 47\ta8a7 d7a7 d3d2 e1f2 d2d1q\n0WMOr\tdeflection\tmedium\t1454\tb\t6k1/5p2/pq5p/R5p1/1P6/2P1r2P/1P3QPK/8 b - - 2 31\te3h3 h2g1 h3h1 g1h1 b6f2\n0nBV9\tdiscoveredAttack\thard\t1780\tw\tr3k1nr/pp5p/4p1p1/5p2/1q2N1Q1/8/PP3PPP/3R1K1R w kq - 0 18\te4f6 g8f6 g4b4\n0AWEW\tdiscoveredAttack\thard\t1781\tw\t1rB4k/pPp3p1/1q3p1p/8/8/5P2/PP5P/4RR1K w - - 2 26\te1e8 h8h7 c8f5 g7g6 e8b8\n16fji\tdiscoveredAttack\thard\t1759\tb\t2k1r3/pppr1ppp/2pb3n/8/4PP2/2PB1QqP/PP4P1/R1B2RK1 b - - 4 17\td6c5 g1h1 d7d3 f3g3 d3g3\n1qonS\tdiscoveredAttack\thard\t1752\tb\t1k6/1p3pb1/pP1N4/2rPp3/P3P1Pq/3K1P2/1Q6/R7 b - - 0 30\tc5d5 e4d5 e5e4 d6e4 g7b2\n1mKf5\tdiscoveredAttack\thard\t1724\tw\t1k6/1pp1nQ2/p4Nr1/n2pP3/3P4/P1P2r2/1PK5/8 w - - 2 40\tf6d7 b8a7 f7f3\n1evT3\tfork\tbeginner\t896\tb\t8/2n5/4P1k1/3p4/p2P1KBP/2p5/Pn6/2B5 b - - 1 53\tb2d3 f4e3 d3c1\n0N5pR\tfork\tbeginner\t899\tb\tr2qkb1r/1p3ppp/p2p1n2/2nPp3/NQ2P3/5N2/PP3PPP/R1B1K2R b KQkq - 3 12\tc5d3 e1e2 d3b4\n1QqIa\tfork\tbeginner\t885\tb\t1r6/2k1p3/p2p4/1p1Bb1R1/4P3/P4P2/1PP2P2/2K5 b - - 0 28\te5f4 c1b1 f4g5\n0yg5v\tfork\tbeginner\t839\tb\t2kr3r/ppp3p1/2n5/4pp2/7P/2NP3R/PPK1Q3/8 b - - 3 25\tc6d4 c2d1 d4e2\n1ABgf\tfork\tbeginner\t866\tb\t7k/2R4p/5b1B/8/8/7P/P4PPK/1r6 b - - 2 35\tf6e5 g2g3 e5c7\n1l8V0\tdiscoveredAttack\teasy\t1296\tw\t1rr2k2/pbR2ppp/8/3p4/P2P4/1P2PP2/3K2PP/2R5 w - - 1 22\tc7b7 b8b7 c1c8\n1qPNC\tdiscoveredAttack\teasy\t1242\tw\t2b3k1/8/4p2p/1p1r4/pPnQBr2/P5P1/2R3K1/8 w - - 2 42\te4h7 g8h7 d4f4\n1jX9w\tdiscoveredAttack\teasy\t1191\tw\t1k3r2/p5r1/Pp1nq3/3pN3/1P1QppPp/8/7P/3R1RK1 w - - 0 34\te5c6 b8c7 d4g7\n1WyVm\tdiscoveredAttack\teasy\t1269\tw\t8/pp4k1/2b4p/5rPR/8/4K3/P2P4/8 w - - 0 40\tg5h6 g7g6 h5f5 g6f5 h6h7\n1GvLP\tdiscoveredAttack\teasy\t1298\tb\t1r2rk2/6p1/3p3p/p2Qb2q/8/P3BN2/1P3PP1/R3R1K1 b - - 1 28\te5h2 f3h2 h5d5\n1hs2B\ttrappedPiece\texpert\t2115\tb\t2rqk2r/p2b1pp1/1b3n1p/3pp3/1P4P1/3P3P/P3PPB1/RNBQK1NR b KQk - 2 14\tb6d4 c1e3 d4a1\n0JDno\ttrappedPiece\texpert\t2145\tw\tr1b2r1k/pp2p1bp/5pp1/4P3/5q2/1P2NN2/1P2Q1PP/2R2RK1 w - - 0 20\tc1c4 f4h6 c4h4 h6h4 f3h4\n1okom\ttrappedPiece\texpert\t2291\tw\t3r1rk1/p5bp/5n2/3Np3/1P2Pp2/q7/4QNPP/2R2R1K w - - 1 30\tc1a1 a3b3 f1b1 b3b1 a1b1\n17sly\ttrappedPiece\texpert\t2106\tw\tr3k2r/p3npp1/1p2p2p/3pP1b1/3N4/4B3/PP3PPP/2R1R1K1 w kq - 6 18\tf2f4 g5h4 g2g3 h4g3 h2g3\n0mAlX\ttrappedPiece\texpert\t2213\tb\t5r2/2kn2q1/4Qp1r/1ppBp2p/p3P2P/P2P1R2/1PP3P1/5RK1 b - - 6 30\tf6f5 f3g3 g7h7 f1f5 h6e6\n0SvwE\tadvancedPawn\texpert\t2152\tb\t4R3/2p3kp/3b1p2/pr6/2R2P2/2p3P1/P6P/6K1 b - - 1 31\tb5c5 c4c5 d6c5 g1g2 c3c2\n0pWM4\tadvancedPawn\texpert\t2223\tw\trnbq1rk1/pp2bppp/4pn2/2pPp3/5P2/2N2N2/PPP3PP/R1BQKB1R w KQ - 0 8\td5d6 e5e4 d6e7\n0bzK2\tadvancedPawn\texpert\t2187\tw\t2q4k/8/3P4/5r1p/1P2QB2/6PK/8/8 w - - 4 58\te4d4 h8h7 d6d7\n0nozX\tadvancedPawn\texpert\t2102\tw\t8/8/6pp/P4p2/1p6/1Pkp2PP/8/4K3 w - - 1 47\te1d1 c3b3 a5a6 b3c3 a6a7\n0Smlf\tadvancedPawn\texpert\t2105\tb\t8/8/6pk/2P5/2R3P1/p7/r7/6K1 b - - 1 41\ta2b2 c4a4 a3a2 c5c6 b2b1\n0WPYk\ttrappedPiece\tmedium\t1551\tw\t8/1p3p1p/p2p1kp1/r2Pp3/P1r5/2P4P/1P1R1KP1/R7 w - - 7 34\tb2b4 a5a4 a1a4\n198eP\ttrappedPiece\tmedium\t1622\tw\t8/6kp/p3p1pb/1p2P3/1PpP2P1/P3BK1P/8/8 w - - 1 43\tg4g5 h6g5 e3g5\n0zMdF\ttrappedPiece\tmedium\t1512\tb\t3rr3/Qp3ppk/2q1p2p/8/3R4/2P3P1/1P3P1P/5RK1 b - - 3 29\td8a8 a7a8 e8a8\n1r5Zh\ttrappedPiece\tmedium\t1424\tw\tr3kb1r/pp3ppp/2npp1b1/2p5/4N1Pq/3P3P/PPP2PB1/R1BQK2R w KQkq - 0 11\tc1g5 g6e4 g5h4\n1ltSO\ttrappedPiece\tmedium\t1365\tw\tr3rqk1/2R3pp/1B2bp2/4p3/pQ1p4/P7/P4PPP/1R4K1 w - - 4 32\tb6c5 f8f7 c7f7\n0BlI4\tintermezzo\thard\t1985\tb\t2R5/2p2p2/3p1kp1/2n4p/R4P2/P1p3P1/1P3K1P/8 b - - 0 40\tc3b2 c8b8 c5a4\n0BoYj\tintermezzo\thard\t1787\tb\tr1k5/ppp1q1p1/8/3p4/3np2Q/3B1N2/PPP2PPP/R3K2R b KQ - 0 20\td4f3 g2f3 e7h4\n18Gjp\tintermezzo\thard\t1869\tw\tr1r3k1/p3p2p/4Pp2/8/2q5/8/P1Q3PP/3R1R1K w - - 0 25\td1d8 g8g7 c2c4 c8c4 d8a8\n1r5n6\tintermezzo\thard\t1791\tb\tr3r1k1/pp3p2/3q2pp/4Bn2/8/8/PP3PPP/R2QR1K1 b - - 0 21\te8e5 d1d6 e5e1 a1e1 f5d6\n0UaKd\tintermezzo\thard\t1741\tw\t4r3/pkp2ppp/2Nr4/3b4/3R4/1P5P/P2R2P1/2K5 w - - 0 29\tc6a5 b7b6 d4d5\n0qEHc\tadvancedPawn\tbeginner\t823\tw\t8/5p2/3p4/2nP1PPp/2P5/1k6/4K3/8 w - - 0 43\tg5g6 f7g6 f5g6 b3c4 g6g7\n0dtiN\tadvancedPawn\tbeginner\t727\tw\t5rk1/7p/P1p1p1p1/3p4/3P1R2/q1P2Q1P/P5P1/2r2BK1 w - - 0 25\tf4f8 a3f8 f3f8 g8f8 a6a7\n0ym99\tadvancedPawn\tbeginner\t579\tw\t8/n7/8/1PK3k1/8/8/8/8 w - - 1 62\tb5b6 a7c8 b6b7\n0bOYd\tadvancedPawn\tbeginner\t858\tw\t1k6/pppq4/4b2P/4p3/4P3/7P/6B1/5R1K w - - 1 38\tf1f8 d7c8 f8c8 b8c8 h6h7\n0Ec3E\tadvancedPawn\tbeginner\t884\tw\t8/8/6pk/Pq5p/2KP4/8/8/8 w - - 0 60\tc4b5 h5h4 a5a6 h4h3 a6a7\n0SbHv\tclearance\teasy\t1261\tb\tR7/8/5p2/5pk1/1n6/5KPP/p2R4/r7 b - - 0 41\ta1f1 f3g2 a2a1q a8a1 f1a1\n1mXvm\tclearance\teasy\t1135\tb\tr1q2rk1/pp2ppbp/3p2p1/2p5/4P1b1/1PPP1N2/PB1N1P2/R3QRK1 b - - 1 14\tg4f3 d2f3 c8g4\n0DKW0\tclearance\teasy\t1158\tb\tr1r3k1/p4ppp/Q1Rnp3/3p4/N7/1P6/P4PPP/6K1 b - - 0 19\tc8c6 a6c6 a8c8 c6c8 d6c8\n1588x\tclearance\teasy\t1231\tw\tr1bq1r2/pp2ppkp/2n3p1/2np4/3N4/1P2P3/P1P1BPPP/RN1Q1RK1 w - - 0 11\td4c6 b7c6 d1d4\n02wKw\tclearance\teasy\t940\tw\t6R1/ppp3P1/4k3/2qp4/8/1P6/PK6/8 w - - 1 45\tg8e8 e6d7 g7g8q\n1nqe1\ttrappedPiece\teasy\t1199\tb\trnbqk2r/ppp3pp/3bp3/3p1p2/1P1Pn3/P4NP1/2PNPPBP/R1BQK2R b KQkq - 2 7\te4c3 e1g1 c3d1\n0T1Jg\ttrappedPiece\teasy\t1223\tb\t5r2/2k4p/1pp1Rp2/4p3/4P3/6P1/PP3P1P/6K1 b - - 0 27\tc7d7 e6c6 d7c6\n1jjzA\ttrappedPiece\teasy\t1214\tw\trnb2rk1/ppp1ppbp/6p1/4N3/3P4/7P/PPP1BPq1/R1BQK2R w KQ - 0 10\te2f3 g2h1 f3h1\n10EEx\ttrappedPiece\teasy\t1292\tw\tr3kbnr/p4ppp/b3p1q1/2p1P3/3p4/1P2BN2/P1PN1PPP/R2QK2R w KQkq - 2 14\tf3h4 d4e3 h4g6\n123Kg\ttrappedPiece\teasy\t1272\tw\t1k1r3r/1pp2p2/p1nbp2p/3p2pq/3P2R1/2PB1P2/PP1N1P2/2K2QR1 w - - 4 19\tg1h1 h5h1 f1h1\n0XqV2\tclearance\thard\t1854\tb\t3r2rk/ppq2p1p/2p1p3/4Rp2/3P1Q2/2P4P/PP3PP1/4R1K1 b - - 6 23\tf7f6 e5f5 c7g7 g2g3 e6f5\n1qsIY\tclearance\thard\t1938\tw\trn3rk1/3b1ppp/p3pn2/1p1q4/4N3/2PB1Q2/PP3PPP/R4RK1 w - - 2 16\te4f6 g7f6 d3e4\n0zUh5\tclearance\thard\t1907\tw\t8/8/4k3/P4RKp/6p1/6Pr/8/8 w - - 1 40\ta5a6 h3g3 f5a5 g3f3 a6a7\n1Temx\tclearance\thard\t1737\tb\t6k1/5pp1/3r2np/2q5/4Q3/1P2P1P1/3pBP1P/R1rR2K1 b - - 2 38\tc1a1 d1a1 c5c1 a1c1 d2c1q\n0xsTR\tclearance\thard\t1874\tb\tQ4b1r/p2qkpp1/4pn1p/2p5/3n3B/2N5/PPP2PPP/R4RK1 b - - 1 14\tg7g5 h4g3 f8g7 g3b8 d4c6\n0eX2g\tpromotion\tmedium\t1615\tw\t8/1p2KP2/8/2p4p/7P/3r2P1/2kp4/3R4 w - - 1 50\td1d2 c2d2 f7f8q\n0KZ21\tpromotion\tmedium\t1512\tw\t1B6/3r4/1P5K/5p2/1P2k1p1/P7/8/8 w - - 1 48\tb8c7 f5f4 b6b7 d7c7 b7b8q\n1Us8C\tpromotion\tmedium\t1632\tw\t8/2p3pk/1pppP2p/8/6R1/1P2Q2P/1Pq2rPK/8 w - - 6 32\te6e7 f2e2 e7e8q e2e3 e8e3\n1EeiO\tpromotion\tmedium\t1524\tb\t8/8/1k4n1/6PP/PP4K1/5p2/8/8 b - - 0 45\tf3f2 h5g6 f2f1q\n1EhNn\tpromotion\tmedium\t1480\tw\t8/P6R/8/r1k5/2np4/8/2K5/8 w - - 2 87\th7h5 c5b6 h5a5 c4a5 a7a8q\n18gGo\tattraction\teasy\t1264\tb\t1r4k1/3R1p1p/6p1/p1P1N3/P3P1P1/4P3/2p4P/3R2K1 b - - 0 29\tb8b1 d1f1 b1f1 g1f1 c2c1q\n16Ioh\tattraction\teasy\t1299\tw\t6k1/2p3qp/r1n3pQ/p1Ppn1N1/5r1P/P4P2/3N2P1/R3R1K1 w - - 1 24\th6g7 g8g7 g5e6\n1YEnx\tattraction\teasy\t1224\tw\t2kr2r1/ppp3Pp/4p2B/8/4q1P1/3R4/PP3P1P/3Q2K1 w - - 1 22\td3d8 g8d8 d1d8 c8d8 g7g8q\n1GIhm\tattraction\teasy\t1189\tb\t8/7p/2k2P2/4P3/3P2P1/2P4P/2rp4/5RK1 b - - 0 61\tc2c1 f6f7 c1f1 g1f1 d2d1q\n0Z7F5\tattraction\teasy\t1261\tb\t4r1k1/1n1r3p/8/p1pn1N2/R4PP1/6BP/4RK2/8 b - - 0 39\te8e2 f2e2 d5c3\n0ArJV\tmateIn2\thard\t1755\tb\t1r3k1r/p1b3p1/3qBB2/1p6/8/5Q2/PP3PP1/RN2R1K1 b - - 0 21\th8h1 g1h1 d6h2\n1qnBM\tmateIn2\thard\t1900\tw\trnb2knr/4q2p/2p1p3/p4pQB/1p1Bp3/2N1K3/P1P2PPP/3R4 w - - 4 26\td4g7 e7g7 g5d8\n0pJPD\tmateIn2\thard\t1970\tw\tr1b5/4q3/p2b4/1p2p1pn/3pP1k1/3P1NP1/PP3PKR/R7 w - - 4 28\tf3e5 e7e5 f2f3\n1CTnE\tmateIn2\thard\t1915\tb\t6R1/pp3pR1/2p1P2k/7p/6P1/2P4K/Pr1r3P/8 b - - 0 40\td2d3 h3h4 b2h2\n17zHs\tmateIn2\thard\t2001\tw\trr6/p3p2k/3pNpp1/1pp5/2q1P3/5R2/P2Q2PP/6K1 w - - 0 27\td2h6 h7h6 f3h3\n04ahy\tsacrifice\tmedium\t1526\tb\t3r3k/6pp/4Qp2/1Pq5/P7/1P1r1n2/5PPP/R1R4K b - - 4 34\tc5c1 a1c1 d3d1\n13A8M\tsacrifice\tmedium\t1364\tw\tr7/5p2/R1b1pp1p/2k5/8/3B1P2/2P2K1P/8 w - - 1 34\ta6c6 c5c6 d3e4\n1ePgy\tsacrifice\tmedium\t1348\tb\t3b4/8/2N5/1K1p3p/3Pk1P1/2P5/P4P2/8 b - - 0 45\th5h4 c6d8 h4h3 a2a4 h3h2\n1QlPF\tsacrifice\tmedium\t1529\tw\t2r5/p6p/1p2bk2/2p5/4R3/P3KB2/2P3PP/8 w - - 2 31\te4e6 f6e6 f3g4\n1kto1\tsacrifice\tmedium\t1504\tb\t8/8/8/8/6k1/2R3pp/2r1B3/5K2 b - - 3 56\tc2e2 f1e2 h3h2\n0Ourf\tfork\texpert\t2120\tb\tr3r1k1/p5pp/2p1p3/4P3/P1qP1P2/4n1P1/1BPQ3P/R3R2K b - - 0 28\te3c2 e1c1 c4d5\n0x9Yt\tfork\texpert\t2112\tw\tr4rk1/pp3ppp/2n2q2/3np3/6b1/2PB1N2/P1PBQPPP/R4RK1 w - - 4 15\te2e4 f6g6 e4d5\n1236I\tfork\texpert\t2101\tw\tr7/pp2Q3/3p4/2p5/3P1r2/2P2k2/P1P5/7K w - - 6 36\te7b7 f3f2 b7g2 f2e3 g2a8\n18Dft\tfork\texpert\t2217\tw\tr1b1k2r/ppp1nppp/8/2bpq3/3n4/2P1B3/PP1NBPPP/R2QK2R w KQkq - 0 10\tc3d4 c5d4 d2f3\n1Ziml\tfork\texpert\t2237\tw\t1r2k3/4q1p1/8/p3N3/5Q2/6K1/1P6/8 w - - 9 61\tf4a4 e8f8 e5g6 f8f7 g6e7\n1rN1f\tintermezzo\teasy\t1180\tb\t2r5/4k2p/4p3/p7/3Rp1P1/2b5/P1R2P1P/1K6 b - - 0 31\tc8b8 b1c1 c3d4\n0ktVx\tintermezzo\teasy\t1252\tw\trn1qr1k1/pppb1ppp/3p4/8/3P1b2/2N5/PPPQ2PP/2K1RBNR w - - 0 12\te1e8 d8e8 d2f4\n0Xp26\tintermezzo\teasy\t1238\tb\t3rr1k1/1q3pb1/2p2npp/p3B3/Pp2P3/1B3Q1P/1PPR1PP1/3R2K1 b - - 0 22\td8d2 d1d2 e8e5\n1kIbI\tintermezzo\teasy\t1164\tw\t4r3/1k6/2R3p1/2B5/3r4/6P1/5P2/6K1 w - - 0 37\tc6b6 b7c8 c5d4\n1NXaw\tintermezzo\teasy\t1171\tb\t3r2k1/pp4pp/8/8/2b1P3/2PN2qP/PPK2QP1/3R3R b - - 0 28\tc4d3 c2b3 g3f2\n1FhTV\tmateIn3\tmedium\t1460\tw\t2r3k1/pbqn1Npn/1p5p/2ppN3/3P4/2P3P1/PPQ2PP1/4R1K1 w - - 0 22\tf7h6 g7h6 c2g6 g8h8 e5f7\n0GekT\tmateIn3\tmedium\t1318\tb\t1knr3r/p1p2p2/Qp1p4/3P4/3qP1p1/2R3P1/PPRN2KP/8 b - - 8 28\th8h2 g2h2 d4f2 h2h1 d8h8\n0ZAVd\tmateIn3\tmedium\t1422\tb\t6r1/1pp2p1k/1p4rp/4pq2/2Q5/2P3PP/PP3P2/3R1RK1 b - - 0 27\tg6g3 f2g3 g8g3 g1h1 f5h3\n0zkIX\tmateIn3\tmedium\t1464\tw\t5rk1/pp2Qppp/4R3/2p5/8/1P5P/2q3P1/3r1R1K w - - 1 26\te7f7 f8f7 e6e8 f7f8 e8f8\n0MaZV\tmateIn3\tmedium\t1433\tw\t4r1k1/1p2rppp/2p5/p7/2Pq4/1P3Q2/1P4PP/4RR1K w - - 2 22\tf3f7 e7f7 e1e8 f7f8 f1f8\n15xkp\tpromotion\teasy\t1272\tb\t6B1/8/4P3/1k3n2/7p/5P2/3K4/8 b - - 2 53\th4h3 g8h7 h3h2 h7f5 h2h1q\n0WjLI\tpromotion\teasy\t1135\tb\t8/2p2R2/2kp4/P7/8/P1r1Nb2/1R4p1/6K1 b - - 10 45\tc3c1 g1f2 g2g1q\n092FX\tpromotion\teasy\t1281\tb\t8/6p1/8/P1Kp4/8/4Bkp1/5P2/8 b - - 1 73\tg3g2 a5a6 g2g1q\n10zlp\tpromotion\teasy\t1147\tb\t8/8/p5p1/1pk5/3R4/2pRn1P1/P6P/6K1 b - - 8 35\tc3c2 g1f2 c2c1q\n1QIgE\tpromotion\teasy\t1155\tw\t8/8/3k1KP1/5B2/3n4/1p6/8/8 w - - 0 62\tg6g7 d4f5 g7g8q\n1bZ8N\tadvancedPawn\tmedium\t1643\tw\t6k1/5pp1/p1b2P1p/2p5/P7/5PbP/1Br3P1/3R1K2 w - - 3 32\td1d8 g8h7 f6g7 c2c1 b2c1\n19EzZ\tadvancedPawn\tmedium\t1374\tb\t8/6R1/2p1N3/1pr2p1k/8/3p4/5PK1/8 b - - 1 41\td3d2 g7h7 h5g6 h7d7 c5d5\n0mp4e\tadvancedPawn\tmedium\t1481\tw\t8/8/5P2/1Pbp4/3p2k1/8/4K3/8 w - - 0 49\tf6f7 g4f5 b5b6 c5d6 b6b7\n1KecX\tadvancedPawn\tmedium\t1468\tb\t4r2k/1p4b1/p1p4p/3p4/3P4/2P1pRqb/PPB1Q1NN/6K1 b - - 3 31\tg3g2 e2g2 h3g2 g1g2 e3e2\n07n7R\tadvancedPawn\tmedium\t1440\tw\t2R5/1p5p/1k6/2pP4/2K5/4rP2/8/8 w - - 4 47\td5d6 e3f3 d6d7\n1nraB\tsacrifice\teasy\t1169\tw\t6k1/p2p1ppp/1prPr1q1/3Q4/2P5/8/P4PPP/2RR2K1 w - - 1 25\td5c6 d7c6 d6d7\n1ojl6\tsacrifice\teasy\t902\tw\t8/8/4k3/P3p1b1/3p4/2B5/2P5/K7 w - - 0 45\ta5a6 d4c3 a6a7\n0EMHY\tsacrifice\teasy\t1277\tb\t8/N1b5/8/1PK2p2/P3k3/8/8/8 b - - 0 46\tf5f4 b5b6 c7b6 c5b6 f4f3\n024CA\tsacrifice\teasy\t1249\tb\tr5k1/p3prb1/4BnP1/3p4/q1nP1B2/1p2PPN1/PRp4R/K3Q3 b - - 0 26\tc4b2 g6f7 g8f8 a1b2 a4a2\n1pDhS\tsacrifice\teasy\t1204\tw\t3Q4/5pkp/4p1pr/P7/3bq3/6P1/2R1BPKP/8 w - - 13 37\te2f3 e4c2 d8d4 e6e5 d4e5\n1T38C\tdiscoveredAttack\texpert\t2142\tb\tr1bqr1k1/pp3p1p/1np3p1/8/2Pb4/1PNQ2P1/PB3PBP/R3R1K1 b - - 1 18\te8e1 a1e1 d4f2 g1f2 d8d3\n0o1ww\tdiscoveredAttack\texpert\t2216\tw\t4R3/pR3pkp/6p1/3n4/2p1B3/6P1/4qP1P/6K1 w - - 5 29\tb7f7 g7f7 e4g6 h7g6 e8e2\n1bi1N\tdiscoveredAttack\texpert\t2131\tw\t5Q2/1r6/4p1p1/4B1k1/P2P1p2/5bqP/1P4P1/6K1 w - - 2 39\te5f6 g5f5 f6h4 f5e4 h4g3\n1gb4M\tdiscoveredAttack\texpert\t2118\tb\t2B2rR1/4krR1/2ppb2p/8/p3N3/P7/1PP5/2K5 b - - 0 32\tf8g8 g7g8 f7f1 c1d2 e6g8\n0yqQZ\tdiscoveredAttack\texpert\t2263\tb\tr1b2rk1/pp1q1ppp/1b3B2/5P2/2Bp4/2P5/PP4PP/RN1Q1RK1 b - - 0 14\td4c3 g1h1 d7d1 f1d1 c3c2\n1hI5m\tclearance\tmedium\t1590\tb\t1r4k1/6b1/2Np1pp1/1q1Pp2p/4PP1P/2Q3P1/6K1/2R5 b - - 4 36\tb5e2 g2g1 b8b2 c3b2 e2b2\n0wKRe\tclearance\tmedium\t1421\tb\t7R/8/8/7P/1b3P2/pk3P2/4K3/8 b - - 0 53\ta3a2 h8a8 b4a3\n1GrLW\tclearance\tmedium\t1388\tb\t8/7R/8/8/2b2PPP/1pk1K3/8/8 b - - 0 44\tb3b2 h7b7 c4b3\n1LRuJ\tclearance\tmedium\t1360\tw\t8/p1p2rk1/1pP2q2/3PQ1p1/8/8/P7/4R1K1 w - - 6 41\te5f6 f7f6 e1e7 g7g6 e7c7\n0RrIX\tclearance\tmedium\t1454\tb\tr5k1/5pb1/pnQP2Pp/2p5/2Pq3P/3B4/2R3PB/7K b - - 4 38\td4a1 h2g1 g7d4\n1m4wD\tpin\teasy\t1286\tb\t3r3k/pp4pp/6r1/2p5/2Bn3Q/7P/PP3PP1/R5K1 b - - 5 22\td4f3 g1f1 f3h4\n0D3Pa\tpin\teasy\t1247\tb\tr1b1k2r/pppp1ppp/1qn2n2/2P5/2B1P3/2PPBQ2/P4PPP/RN2K1R1 b Qkq - 0 12\tb6b2 f3e2 b2a1\n0BTSu\tpin\teasy\t1138\tb\trn2kb1r/1b3ppp/p1p1pn2/qp2N3/3P4/1P2PN2/PB1Q1PPP/R3KB1R b KQkq - 5 10\tf8b4 a2a3 b4d2\n1V941\tpin\teasy\t1296\tb\t5rk1/1p3ppp/pp2pq2/8/PPP1Q2n/3R1P2/5P1P/5RK1 b - - 4 23\tf6g5 e4g4 h4f3 d3f3 g5g4\n1dVAL\tpin\teasy\t1242\tb\tr3kb2/pp4p1/2p3p1/8/4Npn1/1Q1P3q/PP2PPR1/R4K2 b q - 3 21\th3h1 g2g1 g4h2 f1e1 h1g1\n00VIe\tmateIn1\thard\t1709\tb\t8/8/8/P6p/8/2Rnk3/r7/3KN3 b - - 2 60\ta2d2\n09nQI\tmateIn1\thard\t1914\tb\t6k1/8/4p2p/2b1P3/1p6/5qNp/PR3Q1B/6K1 b - - 4 36\tf3g2\n0e3Xk\tmateIn1\thard\t1817\tb\t8/p3Rp1k/5n2/4K1B1/2p5/2Pr3P/P4r2/6R1 b - - 8 35\td3d5\n0bM7v\tmateIn1\thard\t1759\tw\t8/7p/7k/p4Q2/1p4P1/1q6/5PK1/8 w - - 0 39\tf5f6\n1AbgT\tmateIn1\thard\t2007\tw\t5b2/4Np1p/p4k2/1p6/3Pp1QP/4P3/q4PPK/8 w - - 6 30\te7g8\n1Roux\tattraction\thard\t2008\tb\t2Rr2k1/5pp1/7p/p1Q5/1p1P2P1/P3P2P/KP3P2/7q b - - 1 36\tb4b3 a2b3 h1b7\n0zPBD\tattraction\thard\t1801\tb\t2k5/p1p2ppp/2p2p2/b7/2PN2P1/1KN1r3/PP4r1/R3R3 b - - 9 27\tg2b2 b3b2 a5c3\n0aX6a\tattraction\thard\t1723\tb\t6k1/pp3r2/3pNb2/3Pn2p/1P2Pp2/5PqP/P4QB1/2R3K1 b - - 4 34\tg3f2 g1f2 e5d3\n1SJqh\tattraction\thard\t1937\tb\t2b1r3/5k1p/p2r2p1/3R1pP1/2pK1P1P/P1B5/1P6/3R4 b - - 0 40\td6d5 d4d5 e8d8\n0Igue\tattraction\thard\t1818\tb\tr2q1rk1/pp2bppp/2p1pn2/3nNbB1/1P6/P1NP4/2PQBPPP/1R3RK1 b - - 4 13\td5c3 d2c3 f6d5 g5e7 d5c3\n0Xwih\tintermezzo\tmedium\t1491\tb\tr3r1k1/p1n2p1p/3q1pp1/2pP4/2B2QP1/2N5/PP6/2K2R1R b - - 0 25\te8e1 c1c2 d6f4 f1f4 e1h1\n1DiZ9\tintermezzo\tmedium\t1510\tb\trn2k2r/ppq2ppp/3b1nN1/3p4/3P4/8/PPP1BPPP/RNBQ1RK1 b kq - 0 11\td6h2 g1h1 h7g6\n0JZ3N\tintermezzo\tmedium\t1337\tw\tr7/1ppnk3/p3p2p/4r1p1/4R3/6N1/PPP3PP/3R2K1 w - - 0 23\td1d7 e7d7 e4e5\n1Wr5b\tintermezzo\tmedium\t1395\tb\trn1qk1nr/ppp2ppp/8/8/2BP1pbR/2N2N2/PPP3P1/R1BQK3 b Qkq - 0 9\tg4f3 d1f3 d8h4\n0mPCd\tintermezzo\tmedium\t1310\tw\t5k2/2p3pp/4p3/2P5/p2P2qP/P3p1P1/1r2R2K/3Q4 w - - 0 38\td1f1 f8e7 e2b2\n1pZe2\tmateIn3\texpert\t2114\tw\tr2r3k/4BBbp/p1p2pp1/4P3/5P2/1P5b/P1PQNqPP/3R3K w - - 6 26\td2d8 a8d8 d1d8 g7f8 e7f6\n00dt1\tmateIn3\texpert\t2166\tb\tQ7/8/3B4/2p5/1rkn4/K7/8/8 b - - 2 54\td4b5 a3a2 b5c3 a2a1 b4b1\n1oPtF\tmateIn3\texpert\t2152\tw\t7R/p3rp2/1p2p1kp/4Q1p1/2P2P2/6P1/2q4P/6K1 w - - 2 36\th8g8 g6h5 g8g5 h6g5 e5g5\n0556F\tmateIn3\texpert\t2141\tw\t5rk1/5ppb/1pN5/3P1P1P/1PP1n3/4q2P/rQK5/5BR1 w - - 7 32\tg1g7 g8h8 g7g8 h8g8 c6e7\n1NJYL\tmateIn3\texpert\t2190\tb\t7R/p1Q1bkpp/4bp2/8/8/2N2K2/P1q2P1P/5R2 b - - 4 23\tc2d3 f3g2 e6h3 g2g1 d3f1\n1D10g\tdeflection\texpert\t2217\tb\t8/5p2/8/4Pkp1/P3R3/5KP1/7P/r7 b - - 2 42\tg5g4 e4g4 a1a3 f3g2 f5g4\n1eczR\tdeflection\texpert\t2216\tw\t5r1k/4q3/3pQ2p/p1p2rb1/P1B2p2/1P1R2P1/2P3K1/7R w - - 0 30\th1h6 g5h6 e6e7\n1hWgv\tdeflection\texpert\t2130\tb\t7k/pp5p/4p1p1/3p1p1n/1P1P1P2/P3PP1P/3RqbQ1/5N1K b - - 4 29\th5g3 f1g3 e2d2\n0wJd5\tdeflection\texpert\t2169\tb\t7k/1Q4pp/pb6/5Ppr/1P6/P2R1K2/2r5/8 b - - 2 42\th5h3 f3e4 c2e2 e4d5 h3d3\n0sGau\tdeflection\texpert\t2317\tw\tr2qkr2/1Qp1bp1p/p4p2/1p2n3/4N3/1bP4P/PP3PP1/R3R1K1 w q - 0 19\tb7c6 d8d7 c6a8\n07a30\tmateIn3\tbeginner\t894\tb\t5rk1/p5b1/bq4pB/8/4Q2R/2P5/PP3PPP/3R2K1 b - - 16 27\tb6f2 g1h1 f2f1 d1f1 f8f1\n1J549\tmateIn3\tbeginner\t731\tw\tr1b4k/pp4pp/2p5/4rp2/1q6/P5P1/4PPBP/1R1R2K1 w - - 0 22\td1d8 e5e8 d8e8 b4f8 e8f8\n1ErA5\tmateIn3\tbeginner\t896\tw\t7k/6p1/1pp3r1/4p1r1/P3Pp2/2P2Pqp/Q2R2P1/5RK1 w - - 2 35\td2d8 h8h7 a2g8 h7h6 g8h8\n0ary2\tmateIn3\tbeginner\t898\tb\t5r1k/2pQ2p1/7p/2qp4/8/8/PP3PPP/3R2K1 b - - 0 26\tc5f2 g1h1 f2f1 d1f1 f8f1\n1o5cE\tmateIn3\tbeginner\t892\tw\t1r5k/5Qpp/4R3/3n4/1q1P4/1P4P1/1q3PKP/8 w - - 0 36\te6e8 b8e8 f7e8 b4f8 e8f8\n1TtdG\tdiscoveredAttack\tbeginner\t804\tw\tr1b2rk1/pp3ppp/3qpn2/2n5/8/2PB1N2/PP3PPP/R1BQR1K1 w - - 0 13\td3h7 f6h7 d1d6\n0pc2w\tdiscoveredAttack\tbeginner\t808\tb\tr3r3/pp4pp/3p4/5k2/3P4/2P5/PP2nPPP/R1B1R2K b - - 0 20\te2g3 h2g3 e8e1\n0FyKe\tdiscoveredAttack\tbeginner\t612\tb\tr1bq4/p2n2k1/1ppNprpp/8/3P3Q/P3P3/1PB3PP/R4RK1 b - - 1 24\tf6f1 a1f1 d8h4\n0Q1bE\tdiscoveredAttack\tbeginner\t893\tb\t2r1r1k1/pR3ppp/1p6/1Pb5/2B5/2P1P2P/6P1/5RK1 b - - 0 28\tc5e3 g1h1 c8c4\n09qMn\tdiscoveredAttack\tbeginner\t781\tw\tr4rk1/p2b1p2/2p2n1p/3p2p1/3q4/3B2PP/PPP3P1/R2Q1R1K w - - 0 18\td3h7 g8h7 d1d4\n0YuLu\tskewer\tbeginner\t726\tw\t8/8/1q2k3/3p1p1P/6Q1/6P1/r4PK1/8 w - - 0 48\tg4g6 e6e7 g6b6\n0CX8a\tskewer\tbeginner\t885\tw\t8/3r4/4k2p/KP4p1/4B1P1/5P2/8/8 w - - 1 49\te4f5 e6e7 f5d7\n11bqZ\tskewer\tbeginner\t870\tw\t6r1/7R/p2p4/1p1Ppk1B/8/8/PPP5/1K1N1q2 w - - 0 38\th7f7 f5g5 f7f1\n078kF\tskewer\tbeginner\t791\tb\tr7/5ppp/8/1pk5/2b5/5P2/PK1R2PP/2R5 b - - 3 32\ta8a2 b2b1 a2d2\n1hjue\tskewer\tbeginner\t844\tw\t3r4/8/p5pp/3k4/1p6/2R2P1P/P5K1/8 w - - 0 43\tc3d3 d5c4 d3d8\n07clM\tintermezzo\texpert\t2108\tw\t7k/pp4r1/8/8/4r1qb/4QR1p/PP2R3/5B1K w - - 0 36\tf3f8 h8h7 e3e4 g4e4 e2e4\n0Ymg9\tintermezzo\texpert\t2157\tb\t7k/1p1Qq1rP/3p4/p1p1p3/P1P5/3B4/1P4P1/5R1K b - - 0 40\tg7h7 d3h7 e7d7\n1eUF5\tintermezzo\texpert\t2167\tw\t6k1/5pbp/3q2p1/2RPp3/rQ2P3/1p6/1P3PPP/6K1 w - - 0 29\tc5c8 g7f8 b4a4\n1oAcL\tintermezzo\texpert\t2106\tw\t8/pp3pp1/2k5/4pbP1/3rRbR1/1PpP1P2/P1P5/1K6 w - - 4 36\te4d4 f5g4 d4c4 c6d7 f3g4\n1Ycmt\tintermezzo\texpert\t2308\tw\t2r2rk1/ppq2pp1/4p2p/3p3n/3n3N/P1PB3P/1PQ2PP1/R3R1K1 w - - 0 17\tc2d1 h5f4 c3d4 f4d3 d1d3\n14Bfy\tskewer\thard\t1795\tb\t7r/4n3/p1p1Pk2/1q1p4/3P4/3Q4/5P2/2RR1K2 b - - 2 34\tb5d3 d1d3 h8h1 f1e2 h1c1\n0gabV\tskewer\thard\t1745\tb\tr5qk/pp1b3p/3p3B/4p3/3Rp3/8/P1P2P2/3QRK2 b - - 0 27\td7h3 f1e2 h3g4 e2e3 g4d1\n0lcrj\tskewer\thard\t1850\tw\t2k1r3/1pn1Rp1r/3p2pp/2p5/8/RPB5/1P3PPP/6K1 w - - 1 25\ta3a8 c7a8 e7e8 c8d7 e8a8\n1HHHU\tskewer\thard\t1788\tw\t8/3r3p/r3k3/6p1/2P5/p1K2R1P/R7/8 w - - 0 46\ta2e2 e6d6 f3f6 d6c7 f6a6\n1lzg9\tskewer\thard\t1812\tb\t1r6/2q1bk2/Q2p1p1p/1R2p1p1/4P3/1NP2P2/1P3P1P/2K5 b - - 2 30\tc7c4 b5b6 c4a6 b6a6 b8b3\n15nb5\tmateIn2\texpert\t2121\tw\tR2r3r/1kpq4/2n5/1B1b3p/3b2pP/6P1/1Q3R2/6K1 w - - 0 32\tb5a6 b7a8 b2b7\n1g3Up\tmateIn2\texpert\t2135\tw\tr4r2/p1p2pk1/4bNp1/8/2PQ4/qP6/P4nPP/1K5R w - - 2 31\tf6e8 g7h6 d4h4\n1pfE6\tmateIn2\texpert\t2144\tw\t8/8/pR3R1p/5p1k/6p1/7P/1P2r1PK/r7 w - - 0 35\tf6f5 h5h4 b6h6\n1DD6W\tmateIn2\texpert\t2126\tw\t4R3/1B3pkp/6p1/2q2n2/2b2N2/6P1/r4P1P/2Q3K1 w - - 4 24\tf4h5 g6h5 c1g5\n0TQxz\tmateIn2\texpert\t2135\tw\t1r5k/4b2p/6p1/p1p1N3/4B3/1r1P2PP/qB1R4/1RK5 w - - 0 32\te5g6 h8g8 e4d5\n0xRjt\tpin\tbeginner\t875\tw\t1r3rk1/p5pp/8/3q4/4R3/3B2PP/P1PQ1PK1/b7 w - - 2 24\td3c4 d5c4 e4c4\n0QwwK\tpin\tbeginner\t854\tw\tr4rk1/pb3qpp/1n6/3p2B1/2pNn1B1/4P3/P4PPP/1R1Q1RK1 w - - 6 21\tg4e6 e4g5 e6f7\n1RgcQ\tpin\tbeginner\t860\tw\tr3k3/2p4r/1pq1p1p1/p2p1p1p/P2P1P1P/1Pb1P3/R1P1BKP1/3Q3R w q - 0 20\te2b5 c6b5 a4b5\n1doNR\tpin\tbeginner\t801\tb\trnbq1rk1/1p2bppp/p2p4/8/4PQ2/1NN5/PPP3PP/2KR1B1R b - - 0 12\te7g5 f4g5 d8g5\n0aGr2\tpin\tbeginner\t894\tw\t8/4k3/1B1r2pp/8/1P6/2P1KP2/7P/8 w - - 1 34\tb6c5 e7d7 c5d6\n1gugM\tclearance\texpert\t2380\tw\t1r4k1/p4pp1/7p/1Bp5/4Pqb1/2P2P2/PP1r2PP/1KQ1N2R w - - 3 22\te1d3 f4e3 h1e1\n16iL1\tclearance\texpert\t2106\tw\tr1bq1rk1/4bppp/p1np1n2/1p1Np3/2B1P3/4BN1P/PP3PP1/2RQ1RK1 w - - 0 12\td5f6 e7f6 c4d5 c6e7 d5a8\n1k4nx\tclearance\texpert\t2141\tw\t7k/pp4p1/2p3Pp/3p1P2/3Prr1P/P7/1P6/1K3RR1 w - - 3 35\tf1f4 e4f4 g1e1 f4e4 e1e4\n0zkqy\tclearance\texpert\t2365\tw\t1r5k/4q2p/p4N2/2ppr1pQ/4p3/P1P1P1PP/1P6/5RK1 w - - 5 30\tf6g4 e5e6 f1f7 e7f7 h5f7\n0MzuM\tclearance\texpert\t2355\tb\t1n4k1/r1q1bpp1/p3p2p/1N2P3/1p6/2N1Q3/PP3PPP/3R2K1 b - - 1 22\ta6b5 c3b5 c7c2 d1c1 a7d7\n1mv4J\tattraction\tmedium\t1306\tw\t1rr3k1/1pRb1qpp/p3p3/3pR2Q/7B/1P5P/P5P1/7K w - - 7 28\th5f7 g8f7 c7d7\n08QJS\tattraction\tmedium\t1554\tw\t5r1k/pp4bp/3qp2p/3p4/b2n4/3BQP2/PP3P1P/2R3RK w - - 4 22\tg1g7 h8g7 e3d4\n0dlBu\tattraction\tmedium\t1508\tb\t5rk1/1b2q1b1/p1n1p1BB/1p1pP2Q/3P4/2P5/PP4PP/5RK1 b - - 0 22\tf8f1 g1f1 e7f8 f1e2 g7h6\n0NQ3I\tattraction\tmedium\t1663\tw\t2rkr3/6pp/3p1b2/p2Pp3/4N2P/3b4/PB6/K1R1R3 w - - 0 29\tc1c8 d8c8 e4d6\n06tGZ\tattraction\tmedium\t1545\tw\t4r3/4Pk2/p3rbpp/1p1N1p2/8/5KPP/PP2R3/3R4 w - - 3 34\te2e6 f7e6 d5c7\n1TmTO\tpromotion\thard\t1917\tb\t8/R5pk/6pp/8/KQ3PP1/1pq4P/8/8 b - - 1 47\tc3b4 a4b4 b3b2 b4c3 b2b1q\n0zDTQ\tpromotion\thard\t1936\tb\t8/8/4B3/8/1Rp3pk/2Pb1p2/3K4/8 b - - 1 55\tf3f2 e6c4 d3c4 b4c4 f2f1q\n1V5wp\tpromotion\thard\t1911\tw\t5r1k/4P1p1/2p4p/2Pp4/1P6/4q2P/6P1/q4R1K w - - 0 36\te7f8q h8h7 f1a1\n1iQx4\tpromotion\thard\t1882\tw\t6k1/1p2R3/2p2P1p/p2q4/6P1/P3B3/5K1P/8 w - - 5 41\tf6f7 g8f8 e3h6 f8e7 f7f8q\n0Z3KE\tpromotion\thard\t1720\tb\t7k/2p1PR1p/p7/8/1P2K3/P4P2/2pr3P/8 b - - 0 29\td2e2 e4d3 e2e7 f7e7 c2c1q\n0tYas\tdiscoveredCheck\teasy\t1244\tw\tr3k2r/p1pp2pp/1pn1Pn2/8/1bPPQ3/2N2N2/PP1K1P1P/R1B4q w kq - 1 13\te6d7 e8f8 e4c6\n0PWJd\tdiscoveredCheck\teasy\t1212\tb\tr4Bk1/ppp2ppp/4q3/4n3/5Q2/3P2P1/P1P4P/R3KR2 b Q - 0 18\te5d3 e1d2 d3f4\n1hZFn\tdiscoveredCheck\teasy\t1112\tb\t8/1pk1p3/p2p4/3q4/3Pn3/1P5Q/P7/3N2RK b - - 0 37\te4f2 h1h2 f2h3\n0UONO\tdiscoveredCheck\teasy\t1070\tw\tr1q1kb1r/5pp1/p2p3p/1N2p3/Q6P/P5P1/4N3/R4nK1 w kq - 0 23\tb5d6 e8e7 d6c8\n1XL2s\tdiscoveredCheck\teasy\t1219\tb\t2r1k2r/1p3ppp/p3p3/2qpP3/3n1PPQ/N2B3P/PPP5/R4RK1 b k - 0 17\td4f3 g1h1 f3h4\n0kLi9\ttrappedPiece\thard\t1706\tw\tr3k2r/p2p1ppp/bbp2n2/q3p3/P3P3/2PB1QP1/1P3P1P/R1B2K1R w kq - 1 13\tb2b4 a5d5 e4d5\n0MtOl\ttrappedPiece\thard\t1721\tb\trn2k1r1/pp1q1p1Q/2pp1bn1/6B1/4P3/2N2N2/PPP2PPP/R3K2R b KQq - 0 12\tg8h8 h7h8 f6h8\n0rDpu\ttrappedPiece\thard\t1853\tw\t3r1rk1/pppnQppp/3p4/3P3q/1PP1R2N/8/P2B2PP/6K1 w - - 7 24\tg2g4 h5e5 e4e5\n0yIfp\ttrappedPiece\thard\t1906\tb\t4kbnr/pb2pppp/8/1p6/1npP2q1/P3PN2/1P3PPP/RQB1KB1R b KQk - 0 11\tb7e4 b1e4 g4e4\n1Ck4Y\ttrappedPiece\thard\t1720\tb\tr2qkn2/pp2bp2/2p1p1p1/3pPn1r/3P1PQp/2PB1N1P/PP3BP1/R4RK1 b q - 9 17\tf5h6 g4h5 g6h5\n1Nar1\thangingPiece\tbeginner\t845\tb\t3r2k1/p4ppp/B7/4P3/3r4/3bR3/PP4PP/3R2K1 b - - 3 26\td3a6 d1d4 d8d4\n0I481\thangingPiece\tbeginner\t891\tw\t5rk1/pp3q1p/6p1/8/P1p1r3/1R1p1P1P/1P4P1/3Q1RK1 w - - 0 28\tf3e4 f7f1 d1f1 f8f1 g1f1\n0J3yV\thangingPiece\tbeginner\t853\tb\tr1bq1rk1/pp1nppbp/5np1/1BP1N3/8/2N5/PPP2PPP/R1BQ1RK1 b - - 0 9\td7e5 d1d8 f8d8\n1Nw8u\thangingPiece\tbeginner\t769\tw\t1r4k1/p4pbp/4p1p1/q1rp1b2/3P4/1B2B1Q1/PP3PPP/5RK1 w - - 0 21\tg3b8 c5c8 b8c8\n08dpJ\thangingPiece\tbeginner\t834\tb\t5k2/4n1p1/p1N2pP1/2Pp3P/1P1K4/8/1P6/8 b - - 0 54\te7c6 d4d5 c6b4\n0mvoH\tdeflection\tbeginner\t839\tb\t8/7p/8/5pk1/5R2/5PKP/r5P1/8 b - - 3 47\ta2g2 g3g2 g5f4\n1c2v3\tdeflection\tbeginner\t887\tb\t8/4k3/6R1/4p1p1/Kp1pP1P1/1B1n1P1P/3b4/8 b - - 0 56\td3c5 a4b5 c5b3\n0ldhh\tdeflection\tbeginner\t864\tw\tr4bnr/pkp3pp/2np1q2/3Qp3/4P3/8/PPP2PPP/RNB1K2R w KQ - 0 12\td5b5 b7c8 b5c6\n1TcKI\tdeflection\tbeginner\t817\tw\tr1b3k1/p2n1p2/1pp2p1p/2Ppr2N/1P1K4/5PP1/P6P/R4B1R w - - 1 24\th5f6 d7f6 d4e5\n0CNzD\tdeflection\tbeginner\t889\tb\t8/4kp2/3Rb3/4K1p1/6P1/5P2/8/8 b - - 7 49\tf7f6 e5d4 e7d6\n1bXwF\tpromotion\tbeginner\t879\tb\t7Q/6k1/4B3/3Pp1p1/8/pb6/P4KP1/8 b - - 0 51\tg7h8 a2b3 a3a2 d5d6 a2a1q\n1rOFB\tpromotion\tbeginner\t761\tw\t1k6/pp5p/3p1P2/3P4/8/1q6/2p3PP/5R1K w - - 0 31\tf6f7 b8c7 f7f8q\n0XWZb\tpromotion\tbeginner\t853\tw\t5R2/P7/8/8/4ppp1/6k1/r5P1/5K2 w - - 0 48\ta7a8q a2a8 f8a8\n0Ls4E\tpromotion\tbeginner\t488\tw\t8/2p5/3p4/pp3P2/8/2k5/6K1/8 w - - 0 46\tf5f6 b5b4 f6f7 b4b3 f7f8q\n1kgQs\tpromotion\tbeginner\t822\tb\t8/8/8/3KP3/5pk1/4p3/4N3/8 b - - 0 72\tf4f3 e5e6 f3e2 e6e7 e2e1q\n1SXt5\tsacrifice\tbeginner\t847\tw\t6k1/2n1r3/p1R1Pr2/7p/2P3pP/2KP4/PP6/4R3 w - - 3 35\tc6c7 e7c7 e6e7 c7e7 e1e7\n1ZBB9\tsacrifice\tbeginner\t748\tw\t8/8/6K1/7P/3p4/3Bk3/1b6/8 w - - 2 64\th5h6 e3d3 h6h7 d3c2 h7h8q\n03TxG\tsacrifice\tbeginner\t845\tb\t6k1/8/3B1pp1/2PP4/3p2pP/p2K4/r2N1P2/8 b - - 0 41\ta2d2 d3d2 a3a2 c5c6 a2a1q\n0ZFzv\tsacrifice\tbeginner\t886\tw\t3rk3/ppQ2p2/4pnp1/8/8/2P5/PP2RPqr/1K2R3 w - - 0 23\te2e6 f7e6 e1e6\n0vOCM\tattraction\texpert\t2136\tw\t4k3/q4r2/2p4Q/p2p3P/3P4/4r3/6P1/5RK1 w - - 1 50\th6h8 e8e7 f1f7 e7f7 h8h7\n1BpoW\tattraction\texpert\t2145\tw\tr2q1rk1/ppp2pp1/2np3p/4P1N1/2BP2b1/8/PP1Q1PPP/R3R1K1 w - - 0 14\tg5f7 f8f7 c4f7 g8f7 d2f4\n0cfMM\tattraction\texpert\t2485\tw\tr2q1rk1/pp5p/3p2p1/2pP4/3bpB2/3P3Q/P5PP/1R3R1K w - - 0 18\tb1b7 d4g7 b7g7 g8g7 f4h6\n0Nlv1\tattraction\texpert\t2195\tb\t2r3k1/4p1bp/p2p1pp1/q2P4/3BP3/1Q3P2/PP4PP/1KR5 b - - 1 22\tc8c1 b1c1 g7h6 d4e3 a5e1\n15dK0\tattraction\texpert\t2303\tw\t8/1k6/p1pp4/1p1P1p1p/P1P2Pp1/1KP3P1/7P/8 w - - 0 52\td5c6 b7c6 c4b5 a6b5 a4a5\n10zfK\tdiscoveredCheck\tmedium\t1535\tw\t8/p2rk2p/1p3pp1/4P3/2r5/6P1/P2R3P/4R1K1 w - - 0 30\te5f6 e7f6 d2d7\n1jxa4\tdiscoveredCheck\tmedium\t1410\tw\t4r1k1/1r3p2/6P1/2pPq2p/4p3/2N3QP/1P4PK/1R6 w - - 1 36\tg6f7 g8f7 b1f1\n0iFvS\tdiscoveredCheck\tmedium\t1530\tb\t1k1r3r/p5pp/8/1Pb2p2/3n1P2/3p1BN1/P2B2PP/1RR3K1 b - - 4 24\td4f3 g1h1 f3d2\n0B4Lr\tdiscoveredCheck\tmedium\t1615\tw\t5rk1/pb2qNbp/1p2Q1p1/7n/1Pr2P2/2P5/P5PP/2B2RK1 w - - 0 26\tf7h6 g8h8 e6e7\n15kq1\tdiscoveredCheck\tmedium\t1624\tw\tr7/pp1k1ppp/2p5/3PP3/1n5P/1P1R1BP1/8/6K1 w - - 1 24\td5c6 d7e8 c6b7\n0SC89\tdiscoveredCheck\thard\t1778\tb\t8/3b1pk1/2p3q1/3p1N1p/3P3P/2P2Qb1/8/5RK1 b - - 1 34\td7f5 f3f5 g3f2 g1f2 g6f5\n0bPMu\tdiscoveredCheck\thard\t1853\tw\t2rqr1kb/4p2p/p2p3B/5pN1/1p6/2N5/PPP3B1/2K2R2 w - - 0 25\tg2d5 e7e6 g5e6 g8f7 e6d8\n0uiCA\tdiscoveredCheck\thard\t1828\tb\tr4b1r/ppkb2pp/1q4B1/6Q1/3nN3/1P5N/PBPPp1PP/R3R1K1 b - - 0 17\td4f3 g1h1 f3g5\n0Vne9\tdiscoveredCheck\thard\t1818\tw\tk7/2P1R3/ppq5/2p2r2/N7/P1P2p2/1P2nP2/1K6 w - - 0 39\ta4b6 a8b7 c7c8q\n1XO0w\tdiscoveredCheck\thard\t1978\tb\t5rk1/p1p3pp/4b3/2b5/5p1N/1P1BP1P1/P4K1P/B2R4 b - - 0 20\tf4e3 f2e1 c5b4 e1e2 e6g4\n1BeO0\tdiscoveredCheck\texpert\t2122\tb\t4r1k1/8/2p3p1/1p1rp2p/p2P1p2/P1PK1P1P/1BPR2P1/6R1 b - - 3 29\te5d4 d2d1 e8e3 d3d2 d4c3\n1BKA5\tdiscoveredCheck\texpert\t2763\tw\t3rr1k1/pp3p2/2p3PR/4Pp2/3P4/5P2/PP2q3/1K4R1 w - - 0 28\tg6f7 g8f8 h6h7 e2d3 b1a1\n0XYhM\tdiscoveredCheck\texpert\t2741\tb\t6k1/5p1p/1q2pPpP/p2pP3/1p1n3P/1P3Q2/P1RBN3/6K1 b - - 0 31\td4f3 g1g2 b6a6\n0TWRT\tdiscoveredCheck\texpert\t2290\tb\t6r1/1b1kN3/p4Bn1/Pp1pP3/1P1P1pK1/2PB4/5RPr/2R5 b - - 0 39\tg6e5 g4f5 h2h5 f5f4 e5d3\n1V1J3\tdiscoveredCheck\texpert\t2315\tw\t8/4B2k/p1r2pnp/5Q2/2p4q/P1Pp3P/1P2R1P1/6K1 w - - 0 32\tf5d7 d3e2 e7f6\n11Zkj\tintermezzo\tbeginner\t894\tb\tr1bq1rk1/pp3pp1/2n2b1p/3Q4/8/P1N1PN1P/1P3PP1/R3KB1R b KQ - 0 13\tf6c3 b2c3 d8d5\n0rIa4\tintermezzo\tbeginner\t866\tw\tr2q2k1/1pp2p1p/6pB/p7/1br3P1/8/PPP1B2P/2KR3R w - - 0 20\td1d8 a8d8 e2c4\n0IC0n\tintermezzo\tbeginner\t835\tw\tr4rk1/pp3pp1/2p1pn1p/7q/3PN3/2P5/PP2QPP1/R4RK1 w - - 0 19\te4f6 g7f6 e2h5\n1giyd\ttrappedPiece\tbeginner\t818\tw\t8/8/2p1kp1p/p3r1pP/Pp1pP1P1/1PP5/3KR3/8 w - - 0 48\tc3d4 e5e4 e2e4\n1cJ8l\ttrappedPiece\tbeginner\t827\tw\tr3b1k1/3P1pp1/6np/1p6/2pqN3/5P2/6PP/3R1BK1 w - - 0 38\td1d4 e8d7 d4d7\n1oL78\ttrappedPiece\tbeginner\t730\tb\t8/pp2kR2/2p2n1Q/7r/5P2/4r3/1P6/5RK1 b - - 0 35\te7f7 h6h5 f6h5\n1QA6g\ttrappedPiece\tbeginner\t892\tb\trnb3k1/p1p2p2/1p1p1N1p/3Pr3/4p3/2P1P3/P1P2PPP/2KR1B1R b - - 0 14\tg8g7 f6e4 e5e4\n0T1h6\ttrappedPiece\tbeginner\t879\tw\t1b6/6p1/1PPkp3/3p1p2/3P3p/4KP1B/5P2/8 w - - 2 36\tc6c7 b8c7 b6c7\n0jbFz\tmateIn1\texpert\t2376\tw\t8/pBP3q1/1pR1b3/3k1p2/3P2p1/P2KP1P1/r7/8 w - - 0 31\tc6b6\n1nech\tmateIn1\texpert\t2332\tw\tr1b5/3n3R/2p2p2/p4P2/qp1P4/1k2P3/5PQ1/1NK5 w - - 0 33\tg2g8\n1eCxe\tmateIn1\texpert\t2121\tw\tr6r/5p2/p2N1Rp1/4k1B1/1q2n1p1/1Pp4P/P1P3P1/1K1R4 w - - 0 30\td6f7\n1FiHK\tmateIn1\texpert\t2229\tw\tr4rk1/ppq2pBp/2pbp3/8/2B5/2nP3P/PPPnRP2/6RK w - - 0 19\tg7e5\n11GLn\tattraction\tbeginner\t812\tw\t6k1/8/5rPP/3p4/p3p3/8/1p2K3/7R w - - 3 59\th6h7 g8h8 g6g7 h8g7 h7h8q\n1ltzz\tattraction\tbeginner\t678\tw\t2kr1b1r/1bpn1p2/Bp6/8/3pP1pq/2P3N1/4Q1PP/R1B1K2R w KQ - 0 19\ta6b7 c8b7 e2a6\n1RDnA\tattraction\tbeginner\t646\tw\t2k5/pppq2rp/8/3pn3/4p2r/P1P1P3/1P3RP1/R1BQ2K1 w - - 0 23\tf2f8 d7d8 f8d8 c8d8 d1d5\n1R1i0\tattraction\tbeginner\t819\tb\t8/7Q/8/P4rp1/4k3/4pp2/8/4K3 b - - 1 52\tf3f2 e1f1 e3e2 f1e2 f2f1q\n1aiXh\tattraction\tbeginner\t736\tb\t8/8/8/3k4/8/5R2/2p5/2r1BK2 b - - 0 75\tc1e1 f1e1 c2c1q\n1r00F\tclearance\tbeginner\t825\tw\t3rk2r/3b1ppp/4p3/1B1pP3/3q4/8/2P1QPPP/1R3RK1 w k - 1 19\tb5d7 d8d7 b1b8\n192GF\tclearance\tbeginner\t655\tb\t1r4k1/6pp/2R5/p4p2/Pb1Pp3/2BbP1P1/5PBP/6K1 b - - 2 26\tb4c3 c6c3 b8b1";
function parsePuzzles(packed) {
  return packed.split("\n").map((l) => l.split("\t")).filter((r) => r.length >= 7).map((r) => ({
    id: r[0], theme: r[1], tier: r[2], rating: parseInt(r[3], 10) || 1200,
    side: r[4], fen: r[5], solution: r[6].split(" "),
  }));
}
const PUZZLE_FLAVOR = {
  mateIn1: ["Oops — I blundered! Can you find checkmate?", "One good move ends it. Do you see the mate?"],
  mateIn2: ["I'm in real trouble here. Force checkmate in two.", "Calculate carefully — mate is two moves away."],
  mateIn3: ["This one's tougher — mate in three. Take your time.", "A deeper combination — find the forced mate."],
  fork: ["Watch out, my pieces are about to collide!", "One move hits two targets at once — find it."],
  pin: ["Something on this board can't move safely.", "Look for a pin that wins material."],
  skewer: ["Line something up and win big.", "X-ray tactics — find the skewer."],
  discoveredAttack: ["Moving one piece can unleash another.", "There's a hidden attack waiting to be revealed."],
  discoveredCheck: ["A discovered check can be devastating — find it.", "Step aside and deliver check from behind."],
  deflection: ["Distract a defender and the position falls apart.", "Remove the guard, win the piece."],
  hangingPiece: ["Something is hanging — go grab it!", "Free material, if you spot it."],
  backRankMate: ["The back rank is looking shaky...", "Watch that first or eighth rank."],
  sacrifice: ["Sometimes you have to give material to win big.", "A sacrifice unlocks the position — find it."],
  attraction: ["Lure the king, or a piece, to the wrong square.", "Sometimes you have to invite trouble in."],
  trappedPiece: ["Something over there has nowhere left to run.", "Trap a piece and win it outright."],
  clearance: ["Clear a square or line to unleash your attack.", "Move something out of your own way."],
  intermezzo: ["Don't recapture yet — there's a stronger move first!", "An in-between move changes everything."],
  promotion: ["A pawn is close to greatness — help it along.", "Push toward promotion with the right tactic."],
  advancedPawn: ["That advanced pawn is more dangerous than it looks.", "Use the far-advanced pawn to your advantage."],
};
function flavorFor(theme) {
  const arr = PUZZLE_FLAVOR[theme] || ["Find the best move in this position."];
  return arr[Math.floor(Math.random() * arr.length)];
}
const THEME_LABEL = {
  mateIn1: "Mate in 1", mateIn2: "Mate in 2", mateIn3: "Mate in 3", fork: "Fork", pin: "Pin",
  skewer: "Skewer", discoveredAttack: "Discovered Attack", discoveredCheck: "Discovered Check",
  deflection: "Deflection", hangingPiece: "Hanging Piece", backRankMate: "Back Rank Mate",
  sacrifice: "Sacrifice", attraction: "Attraction", trappedPiece: "Trapped Piece",
  clearance: "Clearance", intermezzo: "In-Between Move", promotion: "Promotion", advancedPawn: "Advanced Pawn",
};

/* ---------- coached opening library (40 mains: 20 White repertoires, 20 Black defenses) ---------- */
const RAW_MAINS = [{"id": "italian", "side": "w", "name": "Italian Game", "tag": "Classical & Aggressive", "blurb": "Fast development aimed straight at f7, a great first opening.", "pfx": 5, "main": [["e4", "Claims the center and frees the bishop and queen."], ["e5", "Black meets the center claim symmetrically."], ["Nf3", "Develops with tempo, attacking the e5 pawn."], ["Nc6", "Defends e5 and develops toward the center."], ["Bc4", "The Italian bishop, eyeing the weak f7 square."], ["Bc5", "Mirrors White and eyes f2 in return."], ["c3", "Prepares d4 to seize a bigger center."], ["Nf6", "Counterattacks e4 while finishing development."], ["d3", "Quiet, solid setup avoiding early tactics."], ["d6", "Solidifies e5 and opens the light bishop."], ["O-O", "Tucks the king away before deeper plans."], ["O-O", "Black castles too, matching White's safety."]]}, {"id": "ruy", "side": "w", "name": "Ruy Lopez", "tag": "The Spanish Torture", "blurb": "Pressures the knight defending e5, patient but very dangerous.", "pfx": 5, "main": [["e4", "Grabs the center immediately."], ["e5", "Black takes equal central space."], ["Nf3", "Attacks e5 and develops with tempo."], ["Nc6", "Guards e5 while developing."], ["Bb5", "Pins the knight that defends e5."], ["a6", "Asks the bishop to declare its intentions."], ["Ba4", "Keeps the pin alive, maintaining pressure."], ["Nf6", "Counterattacks e4 while developing."], ["O-O", "Castles before Black can win the e4 pawn."], ["Be7", "Solid and flexible, preparing to castle."], ["Re1", "Reinforces e4 in anticipation of ...b5."], ["b5", "Gains space and kicks the bishop."], ["Bb3", "Retreats to a safe, still-active diagonal."], ["d6", "Solidifies e5 and frees the bishop."]]}, {"id": "scotch", "side": "w", "name": "Scotch Game", "tag": "Open & Direct", "blurb": "Trades center pawns early for quick piece activity.", "pfx": 5, "main": [["e4", "Central pawn push."], ["e5", "Symmetrical reply."], ["Nf3", "Develops and attacks e5."], ["Nc6", "Defends the pawn."], ["d4", "Strikes the center at once."], ["exd4", "Captures, opening the position."], ["Nxd4", "Recaptures with great central control."], ["Bc5", "Develops actively, eyeing the knight."], ["Be3", "Guards the knight and eyes queenside castling."], ["Qf6", "Attacks d4 and defends against threats."], ["c3", "Shores up the center and prepares Nd2."], ["Nge7", "Flexible development, preparing to castle."]]}, {"id": "vienna", "side": "w", "name": "Vienna Game", "tag": "Tricky Transpositions", "blurb": "Flexible setup that can transpose into sharp king's-side play.", "pfx": 3, "main": [["e4", "Central space."], ["e5", "Mirrors the center claim."], ["Nc3", "Supports e4 and eyes d5 without committing the f-pawn yet."], ["Nf6", "Develops and pressures e4."], ["f4", "Strikes at the center in gambit style."], ["d5", "Counters immediately in the center."], ["fxe5", "Wins a pawn while opening lines."], ["Nxe4", "Recaptures actively, centralizing the knight."], ["Nf3", "Develops and prepares to challenge the knight."], ["Be7", "Solid development, preparing to castle."], ["d4", "Builds a strong pawn center."], ["O-O", "Castles into safety."]]}, {"id": "kingsgambit", "side": "w", "name": "King's Gambit", "tag": "Romantic Attacker", "blurb": "Sacrifices a pawn for rapid development and open lines.", "pfx": 3, "main": [["e4", "Central claim."], ["e5", "Symmetrical response."], ["f4", "Offers a pawn to open the f-file and center."], ["exf4", "Accepts, grabbing the extra pawn."], ["Nf3", "Prevents ...Qh4+ and develops with tempo."], ["g5", "Defends the extra pawn, gaining kingside space."], ["h4", "Strikes the pawn chain immediately."], ["g4", "Pushes on, kicking the knight."], ["Ne5", "Centralizes actively despite being attacked."], ["Nf6", "Develops and eyes the center."], ["d4", "Builds a huge pawn center."], ["d6", "Challenges the advanced knight."], ["Nd3", "Retreats while keeping central control."], ["Nxe4", "Grabs a pawn back with activity."]]}, {"id": "fourknights", "side": "w", "name": "Four Knights Game", "tag": "Solid & Symmetrical", "blurb": "Extremely sound development scheme with balanced chances.", "pfx": 6, "main": [["e4", "Central pawn."], ["e5", "Mirrors it."], ["Nf3", "Develops, attacks e5."], ["Nc6", "Defends the pawn."], ["Nc3", "Adds a second defender of e4 and develops."], ["Nf6", "Mirrors the knight development."], ["Bb5", "Pins the c6 knight, Spanish-style."], ["Bb4", "Mirrors the pin for full symmetry."], ["O-O", "Castles into safety first."], ["O-O", "Black castles too, keeping balance."], ["d3", "Solid, unpretentious central support."], ["d6", "Matches White's solid setup."]]}, {"id": "qg", "side": "w", "name": "Queen's Gambit", "tag": "Classical Positional", "blurb": "Offers a wing pawn to gain central control and open lines.", "pfx": 3, "main": [["d4", "Central queen pawn advance."], ["d5", "Symmetrical central reply."], ["c4", "Offers the c-pawn to undermine d5."], ["e6", "Declines, supporting d5 solidly."], ["Nc3", "Develops naturally, adding pressure on d5."], ["Nf6", "Develops and eyes e4."], ["Bg5", "Pins the knight, classical development."], ["Be7", "Breaks the pin and prepares to castle."], ["e3", "Frees the light bishop's diagonal later and supports d4."], ["O-O", "Castles into safety."], ["Nf3", "Completes kingside development."], ["Nbd7", "Prepares ...c6 or ...dxc4 flexibly."]]}, {"id": "catalan", "side": "w", "name": "Catalan", "tag": "Fianchetto Pressure", "blurb": "Combines queen's pawn solidity with long-diagonal bishop pressure.", "pfx": 5, "main": [["d4", "Central control."], ["Nf6", "Develops, eyeing e4."], ["c4", "Expands and offers queenside space."], ["e6", "Solid, flexible central setup."], ["g3", "Prepares the long diagonal fianchetto."], ["d5", "Stakes a claim in the center."], ["Bg2", "The Catalan bishop, aiming at d5 and b7."], ["Be7", "Solid development, preparing to castle."], ["Nf3", "Develops and supports the center."], ["O-O", "Castles into safety."], ["O-O", "White castles too."], ["dxc4", "Grabs the pawn, testing White's compensation."], ["Qc2", "Prepares to recapture the pawn smoothly."], ["a6", "Guards b5, preparing to keep the extra pawn."], ["Qxc4", "Regains the pawn with a strong position."], ["b5", "Gains space and gains a tempo on the queen."]]}, {"id": "london", "side": "w", "name": "London System", "tag": "Easy & Reliable", "blurb": "Same setup versus almost anything, very low-maintenance for White.", "pfx": 3, "main": [["d4", "Central pawn."], ["d5", "Mirrors the center."], ["Bf4", "Develops the bishop before it gets blocked in."], ["Nf6", "Natural development."], ["e3", "Supports the bishop and prepares Bd3."], ["e6", "Solid, flexible reply."], ["Nf3", "Develops toward the center."], ["Bd6", "Challenges the bishop on f4."], ["Bg3", "Retreats, keeping the bishop safe and active."], ["O-O", "Castles into safety."], ["Bd3", "Aims at the kingside, trading off Black's good bishop."], ["c5", "Strikes at White's center."], ["c3", "Solidifies d4 against the pressure."], ["Nc6", "Develops with pressure on d4."]]}, {"id": "english", "side": "w", "name": "English Opening", "tag": "Flexible Flank", "blurb": "Flank opening that can flow into many different pawn structures.", "pfx": 1, "main": [["c4", "Flank control of d5, flexible setup."], ["e5", "Claims the center in reversed-Sicilian style."], ["Nc3", "Develops and pressures the center."], ["Nf6", "Develops and attacks e4... well, c4 area."], ["Nf3", "Continues natural development."], ["Nc6", "Adds central support."], ["g3", "Prepares the long-diagonal fianchetto."], ["d5", "Grabs central space."], ["cxd5", "Trades to disrupt Black's center."], ["Nxd5", "Recaptures, centralizing the knight."], ["Bg2", "Completes the fianchetto, eyeing d5."], ["Nb6", "Repositions away from future attacks."], ["O-O", "Castles into safety."], ["Be7", "Prepares to castle as well."]]}, {"id": "reti", "side": "w", "name": "Reti Opening", "tag": "Hypermodern Flexibility", "blurb": "Delays central pawns, controlling the center with pieces first.", "pfx": 3, "main": [["Nf3", "Develops first, keeping pawn structure flexible."], ["d5", "Black stakes a central claim."], ["c4", "Challenges d5 from the flank."], ["e6", "Solidly supports the center pawn."], ["g3", "Prepares to fianchetto and pressure d5."], ["Nf6", "Develops naturally."], ["Bg2", "Long diagonal aimed at the center."], ["Be7", "Solid development, ready to castle."], ["O-O", "Castles into safety."], ["O-O", "Black castles too."], ["b3", "Prepares a second fianchetto for extra pressure."], ["c5", "Gains queenside space and central counterplay."], ["Bb2", "Completes the double fianchetto setup."], ["Nc6", "Develops with central pressure."]]}, {"id": "kia", "side": "w", "name": "King's Indian Attack", "tag": "Universal System", "blurb": "Same setup against almost any Black defense, very easy to learn.", "pfx": 3, "main": [["Nf3", "Flexible development first."], ["d5", "Black takes the center."], ["g3", "Prepares the kingside fianchetto."], ["Nf6", "Natural development."], ["Bg2", "Long diagonal, eyeing the center."], ["e6", "Solid central support."], ["O-O", "Castles early for safety."], ["Be7", "Prepares to castle."], ["d3", "Keeps the center flexible and modest."], ["O-O", "Black castles too."], ["Nbd2", "Prepares e4 with extra support."], ["c5", "Gains queenside space."], ["e4", "Finally claims the center with all pieces ready."], ["Nc6", "Develops with pressure on the center."]]}, {"id": "trompowsky", "side": "w", "name": "Trompowsky Attack", "tag": "Sneaky Sideline", "blurb": "Avoids mainstream theory while still fighting for the center.", "pfx": 3, "main": [["d4", "Central control."], ["Nf6", "Develops naturally."], ["Bg5", "Pins the knight immediately, sidestepping normal theory."], ["Ne4", "Counterattacks the bishop at once."], ["Bf4", "Retreats to an active square, keeping the bishop."], ["c5", "Strikes at the center."], ["f3", "Kicks the knight while building the center."], ["Qa5+", "Checks before the knight is forced to retreat."], ["c3", "Blocks the check solidly."], ["Nf6", "Retreats the knight, having gained a tempo."], ["d5", "Grabs more central space with tempo."], ["Qb6", "Eyes the b2 pawn and queenside."]]}, {"id": "torre", "side": "w", "name": "Torre Attack", "tag": "Solid Pinning System", "blurb": "Similar pin idea to the Trompowsky, but more positional.", "pfx": 5, "main": [["d4", "Central pawn."], ["Nf6", "Develops toward the center."], ["Nf3", "Supports d4 and develops."], ["e6", "Flexible, solid setup."], ["Bg5", "Pins the knight, Torre-style."], ["c5", "Strikes at the center immediately."], ["e3", "Supports d4 and prepares development."], ["Be7", "Breaks the pin, prepares to castle."], ["Nbd2", "Develops flexibly, supporting the center."], ["b6", "Prepares to fianchetto the light bishop."], ["c3", "Solidifies the center further."], ["Bb7", "Completes the fianchetto, eyeing e4."]]}, {"id": "colle", "side": "w", "name": "Colle System", "tag": "Beginner-Friendly Plan", "blurb": "Simple pawn triangle setup, easy to learn and very solid.", "pfx": 5, "main": [["d4", "Central pawn."], ["d5", "Mirrors it."], ["Nf3", "Develops toward the center."], ["Nf6", "Mirrors the development."], ["e3", "Prepares Bd3, the Colle's key idea."], ["e6", "Solid, symmetrical reply."], ["Bd3", "Aims at h7 for a future kingside attack."], ["c5", "Strikes at White's center."], ["c3", "Supports d4 firmly."], ["Nc6", "Develops with central pressure."], ["Nbd2", "Prepares e4, the thematic Colle break."], ["Bd6", "Mirrors the bishop development."], ["O-O", "Castles before breaking with e4."], ["O-O", "Black castles too."]]}, {"id": "larsen", "side": "w", "name": "Larsen's Opening", "tag": "Offbeat Flank", "blurb": "Fianchettoes early to fight for the long diagonal from move one.", "pfx": 1, "main": [["b3", "Prepares an immediate fianchetto."], ["e5", "Black takes the center."], ["Bb2", "Aims the bishop straight at e5."], ["Nc6", "Defends the e5 pawn."], ["e3", "Supports future development and controls d4."], ["Nf6", "Develops naturally."], ["Bb5", "Pins the knight, adding pressure on e5."], ["Bd6", "Solid development, defending e5 again."], ["Nf3", "Adds another attacker on e5."], ["Qe7", "Defends e5 once more, preparing to castle."], ["c4", "Gains queenside space and central influence."], ["O-O", "Castles into safety."]]}, {"id": "bird", "side": "w", "name": "Bird's Opening", "tag": "Reversed Dutch", "blurb": "Stakes kingside space early, like a Dutch Defense with an extra tempo.", "pfx": 1, "main": [["f4", "Kingside space, controls e5."], ["d5", "Black claims the center."], ["Nf3", "Develops, guards e5 and prepares kingside safety."], ["Nf6", "Mirrors the development."], ["e3", "Solid support for future development."], ["g6", "Prepares to fianchetto the dark bishop."], ["Be2", "Modest development, aiming to castle quickly."], ["Bg7", "Completes the fianchetto."], ["O-O", "Castles into safety."], ["O-O", "Black castles too."], ["d3", "Keeps the center flexible."], ["c5", "Gains queenside space."]]}, {"id": "alapin", "side": "w", "name": "Alapin Sicilian", "tag": "Anti-Sicilian System", "blurb": "Avoids the sharpest Sicilian lines with a solid center-grabbing setup.", "pfx": 3, "main": [["e4", "Central claim."], ["c5", "The Sicilian counter-thrust."], ["c3", "The Alapin's key idea, preparing d4 unopposed."], ["Nf6", "Attacks e4 immediately."], ["e5", "Pushes forward, gaining space and tempo."], ["Nd5", "Retreats the knight to a central outpost."], ["d4", "Builds a big pawn center."], ["cxd4", "Captures, challenging the center."], ["Nf3", "Develops while eyeing the d4 pawn."], ["Nc6", "Develops with pressure on d4."], ["cxd4", "Recaptures, restoring the strong center."], ["d6", "Strikes back at the e5 pawn."], ["Bc4", "Develops actively, eyeing f7."], ["Nb6", "Repositions the knight away from attack."]]}, {"id": "morra", "side": "w", "name": "Smith-Morra Gambit", "tag": "Sharp Sicilian Gambit", "blurb": "Sacrifices a pawn for fast development and open lines vs. the Sicilian.", "pfx": 5, "main": [["e4", "Central claim."], ["c5", "Sicilian counter-thrust."], ["d4", "Offers the center pawn immediately."], ["cxd4", "Accepts the first pawn."], ["c3", "Offers a second pawn for rapid development."], ["dxc3", "Accepts, grabbing a second pawn."], ["Nxc3", "Recaptures with a big lead in development."], ["Nc6", "Develops, contesting the center."], ["Nf3", "Continues rapid development."], ["d6", "Solid, prepares kingside development."], ["Bc4", "Aims at f7, classic gambit pressure."], ["e6", "Blunts the bishop's diagonal."], ["O-O", "Castles, keeping development lead and safety."], ["Nf6", "Develops and challenges e4."], ["Qe2", "Prepares Rd1 to pressure the d-file."], ["Be7", "Completes development, preparing to castle."]]}, {"id": "evans", "side": "w", "name": "Evans Gambit", "tag": "Aggressive Pawn Sac", "blurb": "Sacrifices a wing pawn for a massive center and attack.", "pfx": 7, "main": [["e4", "Central claim."], ["e5", "Symmetrical reply."], ["Nf3", "Develops, attacks e5."], ["Nc6", "Defends the pawn."], ["Bc4", "The Italian bishop setup."], ["Bc5", "Mirrors the development."], ["b4", "Offers the b-pawn to gain time and center."], ["Bxb4", "Accepts the gambit pawn."], ["c3", "Kicks the bishop while building the center."], ["Ba5", "Retreats, keeping the extra pawn and the pin idea."], ["d4", "Seizes a huge pawn center with tempo."], ["exd4", "Challenges the center pawn."], ["O-O", "Castles, prioritizing development and king safety over material."], ["Nge7", "Develops, preparing to meet the coming initiative."]]}, {"id": "najdorf", "side": "b", "name": "Najdorf Sicilian", "tag": "The Grandmaster Choice", "blurb": "The most respected Sicilian line, flexible and razor-sharp.", "pfx": 10, "main": [["e4", "White claims the center."], ["c5", "The sharp Sicilian counter-thrust."], ["Nf3", "Develops toward the center."], ["d6", "Prepares ...Nf6 without allowing e5."], ["d4", "Strikes the center directly."], ["cxd4", "Captures, opening the c-file."], ["Nxd4", "Recaptures with strong central control."], ["Nf6", "Develops, attacking e4."], ["Nc3", "Defends e4 and develops."], ["a6", "The Najdorf move, preparing ...e5 or ...b5 safely."], ["Be3", "A flexible, popular main-line setup."], ["e5", "Grabs central space, the key Najdorf break."], ["Nb3", "Retreats, avoiding the fork on c6."], ["Be6", "Develops, eyeing the a2-g8 diagonal."]]}, {"id": "dragon", "side": "b", "name": "Sicilian Dragon", "tag": "Fire on the Board", "blurb": "Fianchetto setup leading to opposite-side attacking races.", "pfx": 10, "main": [["e4", "Central claim."], ["c5", "Sicilian counterplay."], ["Nf3", "Natural development."], ["d6", "Prepares flexible development."], ["d4", "Central strike."], ["cxd4", "Opens the position."], ["Nxd4", "Strong central knight."], ["Nf6", "Attacks e4."], ["Nc3", "Defends e4 and develops."], ["g6", "Prepares the Dragon fianchetto."], ["Be2", "A calm, positional try against the Dragon."], ["Bg7", "Completes the fianchetto, eyeing the long diagonal."], ["O-O", "Castles into safety before the middlegame battle begins."], ["O-O", "Castles into the coming battle, mirroring White."]]}, {"id": "sveshnikov", "side": "b", "name": "Sveshnikov Sicilian", "tag": "Dynamic Imbalance", "blurb": "Accepts a backward pawn for piece activity and dynamic chances.", "pfx": 10, "main": [["e4", "Central claim."], ["c5", "Sicilian counter."], ["Nf3", "Develops toward the center."], ["Nc6", "Develops, defending toward e5."], ["d4", "Central strike."], ["cxd4", "Opens the position."], ["Nxd4", "Strong central control."], ["Nf6", "Attacks e4."], ["Nc3", "Defends e4."], ["e5", "The Sveshnikov break, gaining space despite the hole on d5."], ["Ndb5", "Jumps to the strong outpost, eyeing d6."], ["d6", "Guards against the knight's incursion."], ["Bg5", "Pins the f6 knight, adding pressure."], ["a6", "Kicks the knight, gaining a tempo."], ["Na3", "Retreats to a slightly awkward but safe square."], ["b5", "Gains space and prepares ...Bb7 or ...Rb8."]]}, {"id": "taimanov", "side": "b", "name": "Taimanov Sicilian", "tag": "Flexible & Modern", "blurb": "Delays committing pawns, keeping maximum flexibility for Black.", "pfx": 8, "main": [["e4", "Central claim."], ["c5", "Sicilian counter."], ["Nf3", "Develops toward the center."], ["e6", "Flexible, solid setup."], ["d4", "Central strike."], ["cxd4", "Opens the position."], ["Nxd4", "Strong central control."], ["Nc6", "Develops, pressuring d4."], ["Nc3", "Defends e4 and develops."], ["Qc7", "Prepares ...a6 and ...Nf6 flexibly, eyeing c-file."], ["Be3", "A common flexible setup against the Taimanov."], ["a6", "Prevents Nb5 ideas and prepares expansion."], ["Qd2", "Connects rooks and prepares queenside castling."], ["Nf6", "Develops, attacking e4."]]}, {"id": "french", "side": "b", "name": "French Defense", "tag": "Solid Counterattack", "blurb": "Locks the center then strikes back with ...c5 and ...f6 breaks.", "pfx": 4, "main": [["e4", "Central claim."], ["e6", "Prepares ...d5 with solid support."], ["d4", "Builds a bigger center."], ["d5", "Challenges the center at once."], ["Nc3", "Defends e4, develops."], ["Nf6", "Pressures e4 further."], ["Bg5", "Pins the knight, classical main line."], ["Be7", "Breaks the pin, prepares to castle."], ["e5", "Advances, gaining space and hitting the knight."], ["Nfd7", "Retreats, preparing ...c5 to strike the base."], ["Bxe7", "Trades off the dark bishop."], ["Qxe7", "Recaptures, keeping a solid structure."]]}, {"id": "carokann", "side": "b", "name": "Caro-Kann Defense", "tag": "Rock-Solid", "blurb": "Extremely resilient structure that avoids weaknesses while staying active.", "pfx": 4, "main": [["e4", "Central claim."], ["c6", "Prepares ...d5 with a pawn already supporting it."], ["d4", "Builds a bigger center."], ["d5", "Challenges the center immediately."], ["Nc3", "Defends e4, develops."], ["dxe4", "Trades, avoiding a cramped position."], ["Nxe4", "Recaptures, centralizing the knight."], ["Bf5", "Develops the bishop before playing ...e6."], ["Ng3", "Kicks the bishop while developing."], ["Bg6", "Retreats, keeping the bishop safely developed."], ["h4", "Gains space and prepares to trap ideas on g6."], ["h6", "Prevents h5 from being annoying."], ["Nf3", "Continues natural development."], ["Nd7", "Prepares ...Ngf6 and ...e6 flexibly."]]}, {"id": "kid", "side": "b", "name": "King's Indian Defense", "tag": "Hypermodern Counterattack", "blurb": "Lets White build a big center, then strikes it down later.", "pfx": 6, "main": [["d4", "Central claim."], ["Nf6", "Develops, controlling e4."], ["c4", "Expands further in the center."], ["g6", "Prepares the King's Indian fianchetto."], ["Nc3", "Develops, adds central control."], ["Bg7", "Completes the fianchetto, eyeing the long diagonal."], ["e4", "Builds a huge classical center."], ["d6", "Prepares ...e5 or ...Nbd7 flexibly."], ["Nf3", "Develops and defends the center."], ["O-O", "Castles into safety before striking back."], ["Be2", "Modest, solid development."], ["e5", "The key King's Indian central counter-strike."]]}, {"id": "nimzo", "side": "b", "name": "Nimzo-Indian Defense", "tag": "Positional Pressure", "blurb": "Pins the knight early to disrupt White's central plans.", "pfx": 6, "main": [["d4", "Central claim."], ["Nf6", "Develops, controlling e4."], ["c4", "Expands in the center."], ["e6", "Prepares ...Bb4, flexible setup."], ["Nc3", "Develops, allows the coming pin."], ["Bb4", "Pins the knight, pressuring e4 indirectly."], ["e3", "Solid, prepares Bd3 and keeps options open."], ["O-O", "Castles into safety."], ["Bd3", "Aims at the kingside, natural development."], ["d5", "Challenges the center at once."], ["Nf3", "Develops, defends the center."], ["c5", "Strikes at d4 from the other side."]]}, {"id": "qid", "side": "b", "name": "Queen's Indian Defense", "tag": "Solid Fianchetto", "blurb": "A calm, resilient setup that fights for the e4 square.", "pfx": 6, "main": [["d4", "Central claim."], ["Nf6", "Develops, controlling e4."], ["c4", "Expands in the center."], ["e6", "Flexible, prepares ...Bb4 or a fianchetto."], ["Nf3", "Develops, avoiding the Nimzo pin idea."], ["b6", "Prepares to fianchetto the light bishop."], ["g3", "Mirrors with a fianchetto of its own."], ["Ba6", "Pressures c4 from the flank."], ["b3", "Defends c4 solidly."], ["Bb4+", "Checks, gaining a tempo before completing development."], ["Bd2", "Blocks the check, offering a trade."], ["Be7", "Retreats, keeping the bishop pair option open."]]}, {"id": "grunfeld", "side": "b", "name": "Grunfeld Defense", "tag": "Hypermodern Counter-strike", "blurb": "Gives up the center immediately to attack it with pieces later.", "pfx": 6, "main": [["d4", "Central claim."], ["Nf6", "Develops, eyeing e4."], ["c4", "Expands the center further."], ["g6", "Prepares the Grunfeld fianchetto."], ["Nc3", "Develops, adds central pressure."], ["d5", "Strikes the center immediately, Grunfeld-style."], ["cxd5", "Trades, testing Black's setup."], ["Nxd5", "Recaptures, centralizing the knight."], ["e4", "Builds a huge pawn center."], ["Nxc3", "Trades off the knight before retreating."], ["bxc3", "Recaptures, keeping the big center but weakening pawns."], ["Bg7", "Completes the fianchetto, targeting the center."], ["Nf3", "Develops and defends the center."], ["c5", "Strikes immediately at the newly built center."]]}, {"id": "slav", "side": "b", "name": "Slav Defense", "tag": "Solid & Resilient", "blurb": "Keeps the light bishop free while supporting the center firmly.", "pfx": 4, "main": [["d4", "Central claim."], ["d5", "Symmetrical reply."], ["c4", "Offers to undermine d5."], ["c6", "Supports d5 without blocking the light bishop."], ["Nf3", "Develops toward the center."], ["Nf6", "Develops, adds central pressure."], ["Nc3", "Develops, defends c4."], ["dxc4", "Grabs the pawn, testing compensation."], ["a4", "Prevents ...b5 to keep the pawn easily."], ["Bf5", "Develops the bishop actively before ...e6."], ["e3", "Prepares to recapture the pawn safely."], ["e6", "Solidifies the position, ready to develop further."], ["Bxc4", "Regains the pawn with a healthy position."], ["Bb4", "Pins the knight, adding pressure of its own."]]}, {"id": "semislav", "side": "b", "name": "Semi-Slav Defense", "tag": "Complex & Rich", "blurb": "One of the most theoretically dense and fighting openings in chess.", "pfx": 8, "main": [["d4", "Central claim."], ["d5", "Symmetrical reply."], ["c4", "Offers to undermine d5."], ["c6", "Supports d5, Slav-style."], ["Nf3", "Develops toward e4."], ["Nf6", "Develops, mirroring White's setup."], ["Nc3", "Develops, defends c4."], ["e6", "Adds a second defender of d5, the Semi-Slav idea."], ["e3", "Solid, prepares Bd3."], ["Nbd7", "Prepares ...dxc4 and ...b5 with support."], ["Bd3", "Aims at the kingside."], ["dxc4", "Grabs the pawn while Black is well developed."], ["Bxc4", "Recaptures, keeping a strong position."], ["b5", "Gains space and kicks the bishop."], ["Bd3", "Retreats, keeping development and central presence."], ["a6", "Secures the b5 pawn and prepares ...c5."]]}, {"id": "tartakower", "side": "b", "name": "Tartakower Defense", "tag": "Flexible QGD", "blurb": "A flexible Queen's Gambit Declined setup with active piece play.", "pfx": 4, "main": [["d4", "Central claim."], ["d5", "Symmetrical reply."], ["c4", "Offers the wing pawn."], ["e6", "Declines, supporting d5."], ["Nc3", "Develops, pressures d5."], ["Nf6", "Develops, defends d5."], ["Bg5", "Pins the knight."], ["Be7", "Breaks the pin, prepares to castle."], ["e3", "Supports the center."], ["O-O", "Castles into safety."], ["Nf3", "Completes development."], ["h6", "Asks the bishop to decide, a useful prophylactic move."], ["Bh4", "Maintains the pin, keeping options open."], ["b6", "Prepares to fianchetto, the Tartakower's signature idea."]]}, {"id": "dutch", "side": "b", "name": "Dutch Defense", "tag": "Aggressive & Sharp", "blurb": "Grabs kingside space early, fighting for the initiative from move one.", "pfx": 2, "main": [["d4", "Central claim."], ["f5", "Immediately fights for e4 and kingside space."], ["g3", "Prepares to fianchetto against the coming setup."], ["Nf6", "Develops, adds central control."], ["Bg2", "Long diagonal, eyeing the center."], ["g6", "Prepares a Leningrad-style fianchetto of its own."], ["Nf3", "Develops toward the center."], ["Bg7", "Completes the fianchetto."], ["O-O", "Castles into safety."], ["O-O", "Black castles too."], ["c4", "Expands in the center."], ["d6", "Solid, flexible central support."], ["Nc3", "Develops, adds pressure."], ["Qe8", "Prepares ...Qh5 or ...e5 with extra support."]]}, {"id": "scandinavian", "side": "b", "name": "Scandinavian Defense", "tag": "Immediate & Simple", "blurb": "Trades the center at once and develops the queen actively.", "pfx": 2, "main": [["e4", "Central claim."], ["d5", "Strikes the center immediately."], ["exd5", "Captures, accepting the trade."], ["Qxd5", "Recaptures with the queen, developing early."], ["Nc3", "Develops with tempo, attacking the queen."], ["Qa5", "Retreats to a safe, active square."], ["d4", "Builds a strong center."], ["Nf6", "Develops, adds pressure."], ["Nf3", "Develops toward the center."], ["c6", "Prepares ...Bf5 and solidifies the queenside."], ["Bc4", "Develops actively, eyeing f7."], ["Bf5", "Develops the bishop before ...e6."], ["Bd2", "Prepares queenside castling, connects the queen to safety."], ["e6", "Solidifies the position, ready to develop further."]]}, {"id": "pirc", "side": "b", "name": "Pirc Defense", "tag": "Flexible Fianchetto", "blurb": "Lets White build a center then undermines it with pieces.", "pfx": 6, "main": [["e4", "Central claim."], ["d6", "Flexible, prepares ...Nf6 and ...g6."], ["d4", "Builds a bigger center."], ["Nf6", "Develops, pressures e4."], ["Nc3", "Defends e4, develops."], ["g6", "Prepares the Pirc fianchetto."], ["f4", "Gains extra space, the Austrian Attack setup."], ["Bg7", "Completes the fianchetto, eyeing the long diagonal."], ["Nf3", "Develops, defends the big center."], ["O-O", "Castles into safety before counterattacking."], ["Bd3", "Aims at the kingside."], ["Na6", "Prepares ...c5, adding pressure on the center."]]}, {"id": "modern", "side": "b", "name": "Modern Defense", "tag": "Ultra-Flexible", "blurb": "Delays central pawn moves entirely, fianchettoing before committing.", "pfx": 2, "main": [["e4", "Central claim."], ["g6", "Prepares the fianchetto before anything else."], ["d4", "Builds a bigger center."], ["Bg7", "Completes the fianchetto immediately."], ["Nc3", "Develops, adds central control."], ["d6", "Flexible support, keeping options open."], ["Be3", "A common, solid setup against the Modern."], ["a6", "Prepares ...b5, gaining queenside space."], ["Qd2", "Connects rooks, prepares queenside castling."], ["b5", "Gains space on the queenside."], ["f3", "Solidifies the center, supports future e5 or g4."], ["Bb7", "Completes the fianchetto, eyeing the long diagonal."]]}, {"id": "alekhine", "side": "b", "name": "Alekhine's Defense", "tag": "Provocative Hypermodern", "blurb": "Invites White's pawns forward, then attacks them as targets.", "pfx": 2, "main": [["e4", "Central claim."], ["Nf6", "Invites White's pawns forward as targets."], ["e5", "Advances, gaining space and tempo."], ["Nd5", "Retreats to a central outpost."], ["d4", "Builds a huge classical center."], ["d6", "Strikes back at the extended center."], ["Nf3", "Develops, defends the center."], ["g6", "Prepares a fianchetto to pressure the center."], ["Bc4", "Develops actively, eyeing the knight on d5."], ["Nb6", "Repositions away from the attack."], ["Bb3", "Retreats to a safe, still-active diagonal."], ["Bg7", "Completes the fianchetto."], ["exd6", "Resolves the central tension by capturing."], ["cxd6", "Recaptures, keeping a slightly open but sound position."]]}, {"id": "petrov", "side": "b", "name": "Petrov Defense", "tag": "Symmetrical & Safe", "blurb": "Mirrors White's first moves to neutralize the initiative early.", "pfx": 4, "main": [["e4", "Central claim."], ["e5", "Symmetrical reply."], ["Nf3", "Develops, attacks e5."], ["Nf6", "Counterattacks e4 instead of defending e5."], ["Nxe5", "Grabs the pawn, testing Black's idea."], ["d6", "Kicks the knight before recapturing."], ["Nf3", "Retreats, having traded off central tension."], ["Nxe4", "Recaptures the pawn, restoring material balance."], ["d4", "Builds a center with a lead in development."], ["d5", "Solidifies the extra central control."], ["Bd3", "Aims at the kingside, natural development."], ["Nc6", "Develops with pressure on d4."], ["O-O", "Castles into safety."], ["Be7", "Prepares to castle as well."]]}, {"id": "benko", "side": "b", "name": "Benko Gambit", "tag": "Positional Pawn Sac", "blurb": "Sacrifices a queenside pawn for long-term pressure on the open files.", "pfx": 6, "main": [["d4", "Central claim."], ["Nf6", "Develops, controlling e4."], ["c4", "Expands in the center."], ["c5", "Strikes at the center immediately."], ["d5", "Advances, gaining space."], ["b5", "Offers the b-pawn to open the a- and b-files."], ["cxb5", "Accepts the gambit pawn."], ["a6", "Offers a second pawn to open lines further."], ["bxa6", "Accepts again, grabbing the second pawn."], ["Bxa6", "Recaptures, developing with pressure on the long diagonal."], ["Nc3", "Develops, defends against the coming pressure."], ["d6", "Solidifies the center, prepares ...g6."], ["e4", "Builds a big center, giving back some initiative."], ["Bxf1", "Trades off the bishop for the rook, gaining structure."], ["Kxf1", "Recaptures, losing castling rights."], ["g6", "Prepares the long-term fianchetto pressure on the queenside files."]]}];
/* Converts a verified [san, comment] main line into the {from,to,c} shape
   the existing LearnMode / PlayMode components already consume — reuses
   the same sanToMove/makeSAN engine plumbing that powers the ECO viewer. */
function mainToLine(main) {
  let s = startState();
  const out = [];
  for (const [san, c] of main) {
    const mv = sanToMove(s, san);
    if (!mv) break;
    out.push({ from: mv.from, to: mv.to, c });
    const res = makeSAN(s, mv.from, mv.to);
    s = res.state;
  }
  return out;
}
const OPENINGS = RAW_MAINS.map((o) => ({
  id: o.id, side: o.side, name: o.name, tag: o.tag, blurb: o.blurb, pfx: o.pfx,
  line: mainToLine(o.main),
}));

/* ---------- lessons (unchanged) ---------- */
const FUNDAMENTALS = [
  { id: "values", title: "The board & piece values",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    body: [
      "Every trade decision starts with piece values: pawn = 1, knight = 3, bishop = 3, rook = 5, queen = 9. The king is priceless — losing it loses the game.",
      "These numbers are a guide, not law. A knight buried in the corner is worth less than an active one in the center. Activity bends the math.",
      "Rule of thumb: never trade a piece for one of lower value without a concrete reason — checkmate, winning material back, or destroying the king's shelter.",
    ] },
  { id: "center", title: "Control the center",
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
    body: [
      "The four center squares — d4, d5, e4, e5 — are the high ground. Pieces placed there reach the most squares: a knight in the center hits 8 squares; in the corner, only 2.",
      "Control the center with pawns when you can, with pieces when you must. That's the difference between classical openings (occupy it) and hypermodern ones (attack it from afar).",
      "In this position both sides fight for the center: White's e4 pawn and c4 bishop versus Black's e5 pawn and c6 knight.",
    ] },
  { id: "development", title: "Development & tempo",
    fen: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 5",
    body: [
      "The opening is a race to bring pieces to useful squares. Each move is one unit of time — a tempo. Wasting tempi loses the race.",
      "Order of business: knights and bishops out, castle, connect the rooks. Bring the queen out late — an early queen becomes a target that develops your opponent for free.",
      "Development with a threat is best of all: your opponent must respond, so your move was free.",
    ] },
  { id: "kingsafety", title: "King safety",
    fen: "r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 6",
    body: [
      "Castle early — usually within the first ten moves. It does two jobs at once: hides the king behind a pawn wall and activates a rook.",
      "After castling, think twice before moving the pawns in front of your king. Every pawn move creates a permanent hole.",
      "The most common beginner disaster: opening the center while your king still stands on its starting square. Open lines point straight at an uncastled king.",
    ] },
  { id: "fork", title: "Tactics: the fork",
    fen: "8/2r1k3/8/3N4/8/8/8/4K3 w - - 0 1",
    body: [
      "A fork is one piece attacking two targets at once. The defender can only save one.",
      "Knights are the fork champions — their jump can't be blocked, and they attack squares of one color while sitting safe on the other. Here the knight on d5 hits BOTH the king on e7 and the rook on c7. The king must move; the rook falls.",
      "Training habit: on every move, ask whether any knight jump reaches two of your big pieces — and ask the same about your opponent's.",
    ] },
  { id: "pin", title: "Tactics: the pin",
    fen: "rn1qkb1r/ppp1pppp/5n2/3p2B1/3P4/8/PPP1PPPP/RN1QKBNR b KQkq - 2 3",
    body: [
      "A pin freezes a piece because moving it would expose something more valuable behind it. Here White's bishop on g5 pins the f6 knight to the queen on d8.",
      "A pinned piece is half a piece: it can't defend, can't capture, can't join the fight. Pile attackers onto a pinned piece — it can't run.",
      "Absolute pin: the piece behind is the king, so moving the pinned piece is literally illegal. Relative pin: it's merely disastrous.",
    ] },
  { id: "skewer", title: "Tactics: the skewer",
    fen: "4q3/8/8/4k3/8/8/8/4RK2 w - - 0 1",
    body: [
      "A skewer is a pin in reverse: the MORE valuable piece stands in front and must move, exposing the piece behind it.",
      "Here the rook on e1 gives check. The Black king must step off the e-file — and the rook captures the queen on e8.",
      "Kings and queens standing on the same line are a standing invitation for a skewer. Notice those alignments — yours and theirs.",
    ] },
  { id: "endgame", title: "Endgame: the opposition",
    fen: "4k3/8/4K3/4P3/8/8/8/8 b - - 0 1",
    body: [
      "In king-and-pawn endings, the kings duel for squares. The opposition means the kings face off with one square between them — and the player NOT to move wins the duel, forcing the other king to give way.",
      "Golden rule for the attacker: put your king IN FRONT of your pawn, not behind it. The king clears the path; the pawn walks in its shadow.",
      "Here White's king already stands proudly in front of the pawn with the opposition. Black's king must step aside, and the pawn marches through to promote.",
    ] },
];
const STRATEGY = [
  { id: "pawnstructure", title: "Pawn structure — the skeleton",
    fen: "r1bq1rk1/pp3ppp/2n1pn2/2pp4/3P4/2PBPN2/PP3PPP/RNBQ1RK1 w - - 0 8",
    body: [
      "Pawns can't move backward, so every pawn move is permanent. The pawn structure is the skeleton of the position — it decides where pieces belong and where the play happens.",
      "Weak pawns: isolated (no friendly pawn on adjacent files), doubled (two on one file), backward (can't advance safely, can't be defended by a pawn). Weak pawns need pieces to babysit them.",
      "Strong pawns: passed pawns and protected chains. Rule: attack a pawn chain at its base.",
    ] },
  { id: "openfiles", title: "Open files & rooks",
    fen: "3r1rk1/pp3ppp/2n1bn2/8/8/2N1BN2/PP3PPP/3R1RK1 w - - 0 14",
    body: [
      "Rooks are useless behind their own pawns. They need open files — files with no pawns — like a cannon needs a clear line of fire.",
      "The plan is always three steps: seize the open file with a rook, double rooks on it, invade the 7th rank, where the rook eats pawns and traps the king.",
      "When one file is open, whoever controls it usually controls the game. Fight for it immediately — the first rook there often keeps it.",
    ] },
  { id: "outposts", title: "Outposts — a knight's dream",
    fen: "r2q1rk1/pp2bppp/2n1pn2/3pN3/3P4/2NBP3/PP3PPP/R2Q1RK1 b - - 5 10",
    body: [
      "An outpost is a square in enemy territory that no enemy pawn can ever attack — protected by one of your own pawns. Plant a knight there and it's a permanent thorn.",
      "Here White's knight on e5 sits on a perfect outpost: supported by the d4 pawn, and no Black pawn can ever chase it away.",
      "A knight on a central outpost on the 5th or 6th rank is often worth more than its three points suggest. Creating and occupying outposts is a complete middlegame plan by itself.",
    ] },
  { id: "bishoppair", title: "Good bishop, bad bishop, bishop pair",
    fen: "2r2rk1/1b3ppp/pq2p3/1p1n4/3P4/1BN1P3/PP3PPP/R2Q1RK1 w - - 0 15",
    body: [
      "A bishop is bad when its own pawns stand on its color and cage it in. Fix it by trading it off, or by moving the pawns to the other color.",
      "The bishop pair is a real advantage in open positions — together the two bishops cover every square color and slice across the whole board.",
      "Matchup rule: bishops love open positions; knights love closed positions and fixed targets. Trade toward the minor piece your pawn structure favors.",
    ] },
  { id: "trading", title: "When to trade pieces",
    fen: "r2q1rk1/ppp2ppp/2npbn2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 4 7",
    body: [
      "Trade when: you're ahead in material (simplification magnifies your edge), you're cramped (fewer pieces need less room), or the enemy piece is better than yours.",
      "Avoid trades when: you're behind in material, you're the one attacking, or your pieces are the active ones.",
      "Never trade on autopilot. Before every exchange ask: whose remaining pieces get better? That question alone will win you games.",
    ] },
  { id: "planning", title: "Making a plan",
    fen: "r1bq1rk1/pp2ppbp/2np1np1/8/2PNP3/2N1B3/PP2BPPP/R2Q1RK1 b - - 6 8",
    body: [
      "A plan doesn't need to be deep — it needs to exist. Weak players move pieces; strong players move pieces toward something.",
      "Read the position for clues: Where are the open files? Which side do my pawns point toward? Attack that side. What's my worst piece? Improve it. What's their weakest pawn or square? Target it.",
      "The improvement loop that never fails: find your worst-placed piece and give it a better home. Repeat. When every piece stands proudly, tactics appear on their own.",
    ] },
];

/* ---------- board themes ---------- */
const THEMES = {
  green:  { label: "Classic Green", lt: "#EBECD0", dk: "#739552", hlL: "#F5F682", hlD: "#B9CA43" },
  walnut: { label: "Walnut",        lt: "#F0D9B5", dk: "#B58863", hlL: "#F7EC74", hlD: "#DBC34A" },
  ice:    { label: "Glacier",       lt: "#DEE3E6", dk: "#8CA2AD", hlL: "#F5F682", hlD: "#BFCB6B" },
};
const THEME_ORDER = ["green", "walnut", "ice"];

/* ---------- styles ---------- */
const CSS = `
  .ct-root { min-height:100vh; background:#2c2a27; color:#ECEBE9; font-family:-apple-system,"Segoe UI",Roboto,sans-serif; display:flex; flex-direction:column; }
  .ct-head { display:flex; align-items:center; gap:7px; padding:12px 12px; background:#22201d; position:sticky; top:0; z-index:5; }
  .ct-head h1 { font-size:17px; font-weight:800; margin:0; flex:1; letter-spacing:.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ct-back { background:none; border:none; color:#b9b7b4; font-size:24px; padding:0 4px; cursor:pointer; line-height:1; }
  .ct-tgl { background:#3a3733; border:1px solid #4a463f; border-radius:9px; color:#ECEBE9; font-size:15px; padding:6px 8px; cursor:pointer; }
  .ct-tgl.off { opacity:.4; }
  .ct-settingsrow { display:flex; gap:8px; flex-wrap:wrap; margin:2px 0 14px; }
  .ct-settingsrow .ct-tgl { padding:9px 12px; font-size:13px; font-weight:600; }
  .ct-puzzletop { display:flex; gap:8px; justify-content:flex-end; margin-bottom:8px; }
  .ct-tgl.small { padding:6px 10px; font-size:14px; }
  .ct-body { flex:1; padding:12px; max-width:560px; width:100%; margin:0 auto; box-sizing:border-box; }
  .ct-card { background:#3a3733; border-radius:14px; padding:15px; margin-bottom:11px; cursor:pointer; border:1px solid #47443f; }
  .ct-card:active { background:#454138; }
  .ct-card h3 { margin:0 0 4px; font-size:16.5px; }
  .ct-card p { margin:0; color:#b6b3ae; font-size:13.5px; line-height:1.45; }
  .ct-tag { display:inline-block; font-size:11px; font-weight:700; color:#e8ab24; margin-bottom:6px; letter-spacing:.4px; text-transform:uppercase; }
  .ct-bubblewrap { display:flex; gap:10px; align-items:flex-start; margin-bottom:10px; }
  .ct-avatar { width:48px; height:48px; border-radius:50%; background:#4c6b3c; flex:none; display:flex; align-items:center; justify-content:center; font-size:27px; box-shadow:0 2px 6px rgba(0,0,0,.4); }
  .ct-bubble { background:#fff; color:#1c1b1a; border-radius:16px; border-top-left-radius:4px; padding:11px 13px; font-size:14px; line-height:1.45; flex:1; box-shadow:0 2px 8px rgba(0,0,0,.35); }
  .ct-boardout { margin:0 -12px; }
  .ct-boardwrap { position:relative; width:100%; aspect-ratio:1; overflow:hidden; box-shadow:0 6px 24px rgba(0,0,0,.55), inset 0 0 0 1px rgba(0,0,0,.35), inset 0 0 30px rgba(0,0,0,.25); }
  .ct-board { display:grid; grid-template-columns:repeat(8,1fr); grid-template-rows:repeat(8,1fr); width:100%; height:100%; }
  .ct-sq { position:relative; display:flex; align-items:center; justify-content:center; user-select:none; -webkit-tap-highlight-color:transparent; background-repeat:no-repeat; }
  .ct-sq.light { background-color:var(--lt); background-image:radial-gradient(circle at 32% 26%, rgba(255,255,255,.4), rgba(255,255,255,0) 62%); }
  .ct-sq.dark { background-color:var(--dk); background-image:radial-gradient(circle at 32% 26%, rgba(255,255,255,.14), rgba(255,255,255,0) 62%); }
  .ct-sq.light.hl, .ct-sq.light.sel { background-color:var(--hlL); }
  .ct-sq.dark.hl, .ct-sq.dark.sel { background-color:var(--hlD); }
  .ct-sq.chk { background:radial-gradient(circle, #ff5a52 20%, #d9453e 70%) !important; }
  /* Heavy wood grain (walnut theme): one continuous grain texture behind the
     whole board, with light/dark squares as semi-transparent tints over it —
     this is what makes the grain read as flowing under the squares, like a
     real inlaid wood board, rather than each square having its own patch. */
  [data-theme="walnut"] .ct-board {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='800'%3E%3Cfilter id='wood'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.004 0.09' numOctaves='5' seed='7' result='n'/%3E%3CfeDisplacementMap in='n' in2='n' scale='40'/%3E%3CfeColorMatrix type='matrix' values='0.55 0 0 0 0.12 0.32 0 0 0 0.06 0.15 0 0 0 0.02 0 0 0 1 0'/%3E%3C/filter%3E%3Crect width='800' height='800' filter='url(%23wood)'/%3E%3C/svg%3E");
    background-size: cover;
  }
  [data-theme="walnut"] .ct-sq.light { background-color: rgba(222,184,135,.55); background-image: none; }
  [data-theme="walnut"] .ct-sq.dark { background-color: rgba(80,45,25,.62); background-image: none; }
  [data-theme="walnut"] .ct-sq.light.hl, [data-theme="walnut"] .ct-sq.light.sel { background-color: var(--hlL); background-image: none; }
  [data-theme="walnut"] .ct-sq.dark.hl, [data-theme="walnut"] .ct-sq.dark.sel { background-color: var(--hlD); background-image: none; }
  .ct-dot { width:26%; height:26%; border-radius:50%; background:rgba(20,20,20,.22); position:absolute; z-index:2; }
  .ct-ring { position:absolute; inset:0; border:4px solid rgba(20,20,20,.25); border-radius:50%; box-sizing:border-box; margin:3%; z-index:2; }
  .ct-coord { position:absolute; font-size:11px; font-weight:800; opacity:.95; z-index:1; letter-spacing:.2px; }
  .ct-coord.f { bottom:2px; right:4px; } .ct-coord.r { top:2px; left:4px; }
  .ct-coord.onlight { color:var(--dk); text-shadow:0 1px 1px rgba(255,255,255,.25); }
  .ct-coord.ondark { color:var(--lt); text-shadow:0 1px 1px rgba(0,0,0,.35); }
  .ct-vignette { position:absolute; inset:0; pointer-events:none; z-index:2;
    box-shadow: inset 0 0 6vw rgba(0,0,0,.22); }
  .ct-pw { position:relative; width:100%; height:100%; display:flex; align-items:center; justify-content:center; }
  .ct-pw::before { content:""; position:absolute; bottom:6%; left:50%; transform:translateX(-50%);
    width:58%; height:14%; border-radius:50%; background:radial-gradient(ellipse, rgba(0,0,0,.4), rgba(0,0,0,0) 72%); z-index:0; }
  .ct-pw svg { position:relative; z-index:1; }
  .ct-pw.dragging { opacity:.28; }
  .ct-ghost { position:fixed; width:13vw; height:13vw; max-width:84px; max-height:84px; min-width:48px; min-height:48px;
    transform:translate(-50%,-50%); pointer-events:none; z-index:9999; filter:drop-shadow(0 8px 12px rgba(0,0,0,.55)); }
  .ct-pop { animation:ctpop .18s ease-out; }
  @keyframes ctpop { 0%{transform:scale(.7)} 70%{transform:scale(1.08)} 100%{transform:scale(1)} }
  .ct-controls { display:flex; gap:9px; justify-content:center; margin-top:12px; flex-wrap:wrap; }
  .ct-btn { background:#3a3733; color:#ECEBE9; border:1px solid #4a463f; border-radius:10px; padding:11px 15px; font-size:14px; font-weight:700; cursor:pointer; }
  .ct-btn:disabled { opacity:.35; }
  .ct-btn.primary { background:#81B64C; border-color:#6d9c40; color:#fff; box-shadow:0 3px 0 #5d8a35; }
  .ct-btn.orange { background:#e8871e; border-color:#c9720f; color:#fff; box-shadow:0 3px 0 #b06209; }
  .ct-progress { height:9px; background:#22201d; border-radius:6px; margin-top:12px; overflow:hidden; }
  .ct-progress > div { height:100%; background:#e8871e; border-radius:6px; transition:width .25s; }
  .ct-moves { margin-top:8px; font-size:13px; color:#cfccc6; line-height:1.7; word-spacing:2px; min-height:18px; }
  .ct-body.ct-compact { padding:8px 8px 12px; }
  .ct-body.ct-compact .ct-bubblewrap { margin-bottom:6px; }
  .ct-body.ct-compact .ct-avatar { width:34px; height:34px; font-size:18px; }
  .ct-body.ct-compact .ct-bubble { padding:7px 10px; font-size:12.5px; border-radius:12px; border-top-left-radius:3px; }
  .ct-body.ct-compact .ct-toprow { font-size:11.5px; margin-bottom:4px; }
  .ct-body.ct-compact .ct-moves { font-size:11px; margin-top:6px; max-height:40px; overflow-y:auto; }
  .ct-body.ct-compact .ct-controls { margin-top:8px; gap:7px; }
  .ct-body.ct-compact .ct-btn { padding:9px 12px; font-size:13px; }
  .ct-body.ct-compact .ct-elochip { padding:8px; margin-bottom:6px; }
  .ct-body.ct-compact .ct-elochip .num { font-size:24px; }
  .ct-body.ct-compact .ct-puzzlebar { margin-top:6px; }
  .ct-body.ct-compact .ct-progress { margin-top:6px; }
  .ct-lesson p { font-size:14.5px; line-height:1.6; color:#dedcd7; margin:0 0 12px; }
  .ct-modal { position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:flex-end; justify-content:center; z-index:20; }
  .ct-sheet { background:#33312d; width:100%; max-width:560px; border-radius:18px 18px 0 0; padding:18px; box-sizing:border-box; max-height:82vh; overflow:auto; }
  .ct-input { width:100%; box-sizing:border-box; background:#22201d; border:1px solid #4a463f; color:#ECEBE9; border-radius:10px; padding:12px; font-size:14px; font-family:inherit; }
  textarea.ct-input { min-height:60px; }
  .ct-chips { display:flex; gap:8px; flex-wrap:wrap; margin:10px 0; }
  .ct-chip { background:#3f3c37; border:1px solid #55514a; color:#dbd8d2; border-radius:999px; padding:7px 12px; font-size:12.5px; cursor:pointer; }
  .ct-chip.on { background:#e8ab24; color:#231f10; border-color:#c99417; font-weight:800; }
  .ct-home-hero { text-align:center; padding:16px 8px 8px; }
  .ct-home-hero .crown { font-size:46px; }
  .ct-home-hero h2 { margin:8px 0 4px; font-size:22px; font-weight:800; }
  .ct-home-hero p { color:#b6b3ae; margin:0; font-size:13.5px; }
  .ct-streak { display:inline-block; margin-top:10px; background:#3a3733; border:1px solid #55514a; border-radius:999px; padding:6px 14px; font-size:13px; font-weight:800; color:#e8ab24; }
  .ct-status { text-align:center; margin-top:10px; font-weight:800; color:#e8ab24; }
  .ct-toprow { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; font-size:12.5px; color:#b6b3ae; }
  .ct-tray { display:flex; align-items:center; min-height:22px; margin:3px 0; flex-wrap:wrap; }
  .ct-tray .cap { width:20px; height:20px; margin-right:-6px; }
  .ct-tray .diff { margin-left:12px; font-size:12px; font-weight:800; color:#9fd06a; }
  .ct-elochip { background:#22201d; border-radius:12px; padding:14px; text-align:center; margin-bottom:12px; border:1px solid #47443f; }
  .ct-elochip .num { font-size:34px; font-weight:900; color:#e8ab24; }
  .ct-elochip .lbl { font-size:12px; color:#b6b3ae; letter-spacing:1px; }
  .ct-puzzlebar { display:flex; align-items:center; justify-content:space-between; margin-top:10px; }
  .ct-puzzlestat { display:flex; align-items:baseline; gap:10px; }
  .ct-puzzlestat .num { font-size:26px; font-weight:900; color:#e8ab24; }
  .ct-puzzlestat .lbl { font-size:14px; color:#f0b93d; font-weight:700; }
  .ct-puzzletimer { font-size:14px; color:#b6b3ae; font-weight:700; font-variant-numeric:tabular-nums; }
  .ct-evalbar { height:10px; border-radius:6px; overflow:hidden; margin-top:10px; background:#332f2b; display:flex; }
  .ct-evalbar .white { background:#e8e6e1; transition:width .35s ease; }
  .ct-evalbar .black { flex:1; }
  .ct-evallabel { text-align:center; font-size:12px; color:#b6b3ae; margin-top:4px; font-weight:700; font-variant-numeric:tabular-nums; }
  .ct-badge { display:inline-block; min-width:22px; text-align:center; border-radius:6px; font-size:11px; font-weight:900; padding:3px 6px; margin-right:8px; }
  .b-best { background:#1f7a3d; color:#fff; } .b-good { background:#3a7ca5; color:#fff; }
  .b-inac { background:#d9b02f; color:#231f10; } .b-mist { background:#e8871e; color:#fff; } .b-blun { background:#c93b3b; color:#fff; }
  .ct-reviewsticky { position:sticky; top:0; z-index:5; background:#2c2a27; padding-bottom:10px; margin:0 -12px; padding-left:12px; padding-right:12px; }
  .ct-revrow { display:flex; align-items:flex-start; padding:9px 10px; border-radius:10px; margin-bottom:6px; background:#3a3733; cursor:pointer; border:1px solid #47443f; }
  .ct-revrow.on { border-color:#e8ab24; }
  .ct-revrow .san { font-weight:800; width:74px; flex:none; }
  .ct-revrow .cmt { font-size:12.5px; color:#c9c6c0; line-height:1.4; }
  .ct-ecorow { display:flex; align-items:center; gap:10px; padding:11px 12px; border-radius:11px; margin-bottom:7px; background:#3a3733; cursor:pointer; border:1px solid #47443f; }
  .ct-ecorow:active { background:#454138; }
  .ct-eco { flex:none; background:#22201d; color:#e8ab24; font-weight:900; font-size:12px; border-radius:7px; padding:5px 7px; }
  .ct-ecorow .nm { font-size:14px; font-weight:700; line-height:1.25; }
  .ct-ecorow .pg { font-size:11.5px; color:#a3a09a; margin-top:2px; }
  .ct-count { font-size:12px; color:#b6b3ae; margin:8px 2px 10px; }
  @media (prefers-reduced-motion: reduce) { .ct-progress > div { transition:none; } .ct-pop{animation:none;} }
`;

/* ---------- settings context ---------- */
const Settings = createContext({ sound: true, voice: false, theme: "walnut" });

/* ---------- shared UI ---------- */
/* ---------- live evaluation bar ---------- */
function EvalBar({ state }) {
  const scoreForWhite = useMemo(() => {
    const raw = evaluate(state);
    return (state.turn === "w" ? raw : -raw) / 100;
  }, [state]);
  const clamped = Math.max(-6, Math.min(6, scoreForWhite));
  const whitePct = 50 + (clamped / 6) * 50;
  const label = Math.abs(scoreForWhite) < 0.15 ? "Equal"
    : scoreForWhite > 0 ? `White +${scoreForWhite.toFixed(1)}` : `Black +${(-scoreForWhite).toFixed(1)}`;
  return (
    <>
      <div className="ct-evalbar"><div className="white" style={{ width: whitePct + "%" }} /><div className="black" /></div>
      <div className="ct-evallabel">{label}</div>
    </>
  );
}

function Board({ board, flipped, onTap, selected, targets, lastMove, checkSq }) {
  const order = [...Array(64).keys()];
  const disp = flipped ? order.map((i) => 63 - i) : order;
  const wrapRef = useRef(null);
  const [drag, setDrag] = useState(null); // { from, piece, x, y } while a piece is being dragged

  const squareFromPoint = (clientX, clientY) => {
    const el = wrapRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    let f = Math.floor(((clientX - rect.left) / rect.width) * 8);
    let r = Math.floor(((clientY - rect.top) / rect.height) * 8);
    f = Math.max(0, Math.min(7, f));
    r = Math.max(0, Math.min(7, r));
    const vis = r * 8 + f;
    return flipped ? 63 - vis : vis;
  };

  const handlePointerDown = (e, i) => {
    if (!onTap) return;
    const isTargetSq = targets && targets.includes(i);
    const p = board[i];
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    onTap(i);
    if (!isTargetSq && p) setDrag({ from: i, piece: p, x: e.clientX, y: e.clientY });
    else setDrag(null);
  };
  const handlePointerMove = (e) => {
    if (!drag) return;
    setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
  };
  const handlePointerUp = (e) => {
    if (!drag) return;
    const dest = squareFromPoint(e.clientX, e.clientY);
    if (dest != null && dest !== drag.from && onTap) onTap(dest);
    setDrag(null);
  };

  return (
    <div className="ct-boardout">
    <div
      className="ct-boardwrap" ref={wrapRef}
      onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={() => setDrag(null)}
    >
      <div className="ct-board">
        {disp.map((i, vis) => {
          const r = Math.floor(i / 8), f = i % 8;
          const isLight = (r + f) % 2 === 0;
          const p = board[i];
          const cls = "ct-sq " + (isLight ? "light" : "dark") +
            (lastMove && (lastMove.from === i || lastMove.to === i) ? " hl" : "") +
            (selected === i ? " sel" : "") + (checkSq === i ? " chk" : "");
          const isTarget = targets && targets.includes(i);
          const visR = Math.floor(vis / 8), visF = vis % 8;
          return (
            <div
              key={i} className={cls}
              style={onTap ? { touchAction: "none" } : undefined}
              onPointerDown={onTap ? (e) => handlePointerDown(e, i) : undefined}
            >
              {isTarget && !p && <div className="ct-dot" />}
              {isTarget && p && <div className="ct-ring" />}
              {p && (
                <div className={"ct-pw" + (lastMove && lastMove.to === i ? " ct-pop" : "") + (drag && drag.from === i ? " dragging" : "")}>
                  <PieceSVG code={p} />
                </div>
              )}
              {visF === 0 && <span className={"ct-coord r " + (isLight ? "onlight" : "ondark")}>{8 - r}</span>}
              {visR === 7 && <span className={"ct-coord f " + (isLight ? "onlight" : "ondark")}>{FILESTR[f]}</span>}
            </div>
          );
        })}
      </div>
      <div className="ct-vignette" />
    </div>
    {drag && (
      <div className="ct-ghost" style={{ left: drag.x, top: drag.y }}>
        <PieceSVG code={drag.piece} size="100%" />
      </div>
    )}
    </div>
  );
}

function CapturedTray({ board, color }) {
  const startCount = { P: 8, N: 2, B: 2, R: 2, Q: 1, K: 1 };
  const cur = { P: 0, N: 0, B: 0, R: 0, Q: 0, K: 0 };
  let myMat = 0, oppMat = 0;
  for (const p of board) {
    if (!p) continue;
    if (p[0] === color) cur[p[1]]++;
    if (p[1] !== "K") (p[0] === color ? (myMat += VAL[p[1]]) : (oppMat += VAL[p[1]]));
  }
  const caps = [];
  for (const t of ["P", "N", "B", "R", "Q"])
    for (let i = 0; i < startCount[t] - cur[t]; i++) caps.push(color + t);
  const diff = oppMat - myMat;
  return (
    <div className="ct-tray">
      {caps.map((c, i) => <span key={i} className="cap"><PieceSVG code={c} size="100%" /></span>)}
      {diff < 0 && <span className="diff">+{-diff}</span>}
    </div>
  );
}

function Coach({ text }) {
  const { voice } = useContext(Settings);
  const last = useRef("");
  useEffect(() => {
    if (text && text !== last.current) { last.current = text; speak(text, voice); }
  }, [text, voice]);
  return (
    <div className="ct-bubblewrap">
      <div className="ct-avatar">🧔</div>
      <div className="ct-bubble">{text}</div>
    </div>
  );
}

/* Board theme / sound / voice controls, surfaced on game-setup screens now
   that the persistent header hides them once play begins (more room for
   the board, chess.com-style). */
function SettingsRow() {
  const { theme, sound, voice, updateSettings } = useContext(Settings);
  const T = THEMES[theme] || THEMES.green;
  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    updateSettings({ theme: next, sound, voice });
    playFX("move", sound);
  };
  return (
    <div className="ct-settingsrow">
      <button className="ct-tgl" onClick={cycleTheme}>🎨 {T.label}</button>
      <button className={"ct-tgl" + (sound ? "" : " off")}
        onClick={() => { const s = !sound; updateSettings({ theme, sound: s, voice }); if (s) playFX("move", true); }}>
        {sound ? "🔊 Sound on" : "🔇 Sound off"}
      </button>
      <button className={"ct-tgl" + (voice ? "" : " off")}
        onClick={() => { const v = !voice; updateSettings({ theme, sound, voice: v }); speak(v ? "Voice coach on." : "", v); if (!v && window.speechSynthesis) window.speechSynthesis.cancel(); }}>
        {voice ? "🗣 Voice on" : "🗣 Voice off"}
      </button>
    </div>
  );
}

/* ---------- Ask Coach (AI) ---------- */
function AskCoach({ context, onClose }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [err, setErr] = useState(null);
  const { voice } = useContext(Settings);

  const ask = async (question) => {
    const finalQ = question || q;
    if (!finalQ.trim()) return;
    setBusy(true); setErr(null); setAnswer(null);
    try {
      const prompt =
        `You are a friendly chess coach inside a training app. Answer in 3-6 short sentences, plain English, no headers, encouraging tone.\n\n` +
        `Context: ${context.mode}. Opening being studied: ${context.opening || "none"}.\n` +
        `Current position (FEN): ${context.fen}\n` +
        `Moves so far: ${context.moves || "(start position)"}\n\n` +
        `Student's question: ${finalQ}`;
      const body = JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      });
      /* This file runs in two different homes: as a Claude.ai artifact
         (where requests to api.anthropic.com are transparently proxied,
         no key needed) and as this standalone build hosted on a
         Cloudflare Worker (which exposes its own /api/coach route backed
         by Workers AI — see src/worker.js). Try the self-hosted route
         first since it's same-origin and fast; if it 404s (i.e. we're
         running as a bare Claude artifact with no such route), fall back
         to Anthropic's proxied endpoint. Either path returns the same
         { content: [{ type: "text", text }] } shape, so nothing below
         this needs to know which one answered. */
      let r;
      try {
        r = await fetch("/api/coach", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        if (!r.ok) throw new Error("no worker route");
      } catch (e) {
        r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json" }, body,
        });
      }
      const data = await r.json();
      const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      if (text) { setAnswer(text); speak(text, voice); }
      else setErr("The coach didn't answer — please try again.");
    } catch (e) {
      setErr("Couldn't reach the coach. Check your connection and try again.");
    } finally { setBusy(false); }
  };

  return (
    <div className="ct-modal" onClick={onClose}>
      <div className="ct-sheet" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>🧔 Ask the coach</h3>
        <div className="ct-chips">
          {(context.chips || ["Why is this move good?", "What's the plan from here?", "What should I watch out for?", "What's my worst piece?"]).map((c) => (
            <button key={c} className="ct-chip" onClick={() => { setQ(c); ask(c); }}>{c}</button>
          ))}
        </div>
        <textarea className="ct-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything about this position..." />
        <div className="ct-controls">
          <button className="ct-btn primary" disabled={busy} onClick={() => ask()}>{busy ? "Thinking…" : "Ask"}</button>
          <button className="ct-btn" onClick={onClose}>Close</button>
        </div>
        {answer && <div style={{ marginTop: 12 }}><Coach text={answer} /></div>}
        {err && <p style={{ color: "#ff9c9c", fontSize: 13 }}>{err}</p>}
        {busy && <p style={{ color: "#b6b3ae", fontSize: 13, textAlign: "center" }}>The coach is studying the board…</p>}
      </div>
    </div>
  );
}

/* ---------- Openings database explorer ---------- */
function EcoExplorer({ rows, full, onOpen }) {
  const [q, setQ] = useState("");
  const [letter, setLetter] = useState("");
  const [limit, setLimit] = useState(80);

  const matches = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) =>
      (!letter || r[0][0] === letter) &&
      (!qq || r[1].toLowerCase().includes(qq) || r[0].toLowerCase().includes(qq) || r[2].toLowerCase().startsWith(qq)));
  }, [rows, q, letter]);

  return (
    <>
      <Coach text={`The complete opening encyclopedia — ${rows.length.toLocaleString()} named openings and defenses${full ? ", full Lichess database loaded" : " (core set; the full database loads automatically when online)"}. Search by name, ECO code, or first moves — try "Sicilian", "B90", or "1. d4".`} />
      <input className="ct-input" value={q} onChange={(e) => { setQ(e.target.value); setLimit(80); }}
        placeholder='Search openings… e.g. "Caro-Kann", "King&apos;s Indian", "C50"' />
      <div className="ct-chips">
        {["", "A", "B", "C", "D", "E"].map((L) => (
          <button key={L || "all"} className={"ct-chip" + (letter === L ? " on" : "")}
            onClick={() => { setLetter(L); setLimit(80); }}>
            {L === "" ? "All" : `ECO ${L}`}
          </button>
        ))}
      </div>
      <div className="ct-count">{matches.length.toLocaleString()} openings found</div>
      {matches.slice(0, limit).map((r, i) => (
        <div key={i} className="ct-ecorow" onClick={() => onOpen(r)}>
          <span className="ct-eco">{r[0]}</span>
          <div>
            <div className="nm">{r[1]}</div>
            <div className="pg">{r[2]}</div>
          </div>
        </div>
      ))}
      {matches.length > limit && (
        <div className="ct-controls">
          <button className="ct-btn" onClick={() => setLimit(limit + 150)}>Show more ({matches.length - limit} left)</button>
        </div>
      )}
    </>
  );
}

function EcoViewer({ row }) {
  const [eco, name, pgn] = row;
  const tokens = useMemo(() => pgnTokens(pgn), [pgn]);
  const [step, setStep] = useState(0);
  const [ask, setAsk] = useState(false);
  const { sound } = useContext(Settings);

  const built = useMemo(() => {
    let s = startState();
    const out = [{ state: s, san: null, lm: null }];
    for (const tok of tokens) {
      const mv = sanToMove(s, tok);
      if (!mv) break;
      const res = makeSAN(s, mv.from, mv.to);
      s = res.state;
      out.push({ state: s, san: res.san, lm: { from: mv.from, to: mv.to } });
    }
    return out;
  }, [tokens]);

  const maxStep = built.length - 1;
  const cur = built[Math.min(step, maxStep)];
  const goTo = (n) => { playFX("move", sound); setStep(n); };
  const moveList = built.slice(1, step + 1).map((h, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${h.san}` : h.san)).join("  ");
  const blackOpening = /defen[cs]e|indian|sicilian|caro|grunfeld|grünfeld|benoni|dutch|scandinavian|pirc|alekhine/i.test(name);

  return (
    <>
      <Coach text={step === 0
        ? `${name} (ECO ${eco}) — a ${maxStep}-move line from the encyclopedia. Step through it, then ask me about the ideas, plans, and traps.`
        : `Move ${step} of ${maxStep}: ${cur.san}. Curious why? Tap Ask and I'll explain the idea.`} />
      <Board board={cur.state.board} flipped={blackOpening} lastMove={cur.lm} />
      <div className="ct-progress"><div style={{ width: (step / Math.max(1, maxStep)) * 100 + "%" }} /></div>
      <div className="ct-moves">{moveList || pgn}</div>
      <div className="ct-controls">
        <button className="ct-btn" disabled={step === 0} onClick={() => goTo(step - 1)}>‹ Back</button>
        <button className="ct-btn primary" disabled={step === maxStep} onClick={() => goTo(step + 1)}>
          {step === maxStep ? "End of line ✓" : "Next ›"}
        </button>
        <button className="ct-btn orange" onClick={() => setAsk(true)}>🧔 Ask</button>
      </div>
      {ask && (
        <AskCoach onClose={() => setAsk(false)} context={{
          mode: "Exploring an opening from the ECO encyclopedia",
          opening: `${name} (ECO ${eco}), full line: ${pgn}`,
          fen: toFEN(cur.state), moves: moveList,
          chips: ["What's the main idea of this opening?", "What are White's plans?", "What are Black's plans?", "Any traps I should know?"],
        }} />
      )}
    </>
  );
}

/* ---------- Learn mode (coached lines) ---------- */
function LearnMode({ opening }) {
  const [step, setStep] = useState(0);
  const [ask, setAsk] = useState(false);
  const { sound } = useContext(Settings);
  const flipped = opening.side === "b";

  const { state, sans, lastMove } = useMemo(() => {
    let s = startState();
    const sans = [];
    let lm = null;
    for (let i = 0; i < step; i++) {
      const mv = opening.line[i];
      const res = makeSAN(s, mv.from, mv.to);
      sans.push(res.san);
      s = res.state;
      lm = { from: mv.from, to: mv.to };
    }
    return { state: s, sans, lastMove: lm };
  }, [step, opening]);

  const goTo = (n) => {
    if (n > step) {
      const mv = opening.line[step];
      const res = makeSAN(state, mv.from, mv.to);
      moveSound(res, gameStatus(res.state), sound);
    } else playFX("move", sound);
    setStep(n);
  };

  const cur = step > 0 ? opening.line[step - 1] : null;
  const moveList = sans.map((s, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${s}` : s)).join("  ");
  const coachText = step === 0
    ? `${opening.name}. ${opening.blurb} Tap Next and I'll walk you through it move by move.`
    : `${sans[sans.length - 1]} — ${cur.c}`;

  return (
    <>
      <Coach text={coachText} />
      <Board board={state.board} flipped={flipped} lastMove={lastMove} />
      <div className="ct-progress"><div style={{ width: (step / opening.line.length) * 100 + "%" }} /></div>
      <div className="ct-moves">{moveList || "Starting position"}</div>
      <div className="ct-controls">
        <button className="ct-btn" disabled={step === 0} onClick={() => goTo(step - 1)}>‹ Back</button>
        <button className="ct-btn primary" disabled={step === opening.line.length} onClick={() => goTo(step + 1)}>
          {step === opening.line.length ? "Line complete ✓" : "Next ›"}
        </button>
        <button className="ct-btn orange" onClick={() => setAsk(true)}>🧔 Ask</button>
      </div>
      {step === opening.line.length && <div className="ct-status">Line learned! Now try it in Play vs Coach.</div>}
      {ask && (
        <AskCoach onClose={() => setAsk(false)} context={{
          mode: "Studying an opening line step by step",
          opening: opening.name, fen: toFEN(state), moves: moveList,
        }} />
      )}
    </>
  );
}

/* ---------- Review mode ---------- */
function classify(drop, isBest) {
  if (isBest || drop <= 25) return { badge: "★", cls: "b-best", word: "Best" };
  if (drop <= 80) return { badge: "✓", cls: "b-good", word: "Good" };
  if (drop <= 200) return { badge: "?!", cls: "b-inac", word: "Inaccuracy" };
  if (drop <= 500) return { badge: "?", cls: "b-mist", word: "Mistake" };
  return { badge: "??", cls: "b-blun", word: "Blunder" };
}
function ReviewMode({ history, userColor, result, onExit }) {
  const [notes, setNotes] = useState([]);
  const [analyzing, setAnalyzing] = useState(true);
  const [cursor, setCursor] = useState(history.length);
  const [ask, setAsk] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    (async () => {
      const out = [];
      for (let i = 0; i < history.length; i++) {
        const h = history[i];
        if (h.mover !== userColor) { out.push(null); setNotes(out.slice()); continue; }
        const before = i === 0 ? startState() : history[i - 1].state;
        const scored = rootSearchTimed(before, 2, false);
        const best = scored[0];
        const played = scored.find((m) => m.from === h.from && m.to === h.to);
        const drop = best && played ? Math.max(0, best.score - played.score) : 0;
        const isBest = played && best && played.from === best.from && played.to === best.to;
        const grade = classify(drop, isBest);
        let comment;
        if (grade.word === "Best") comment = "The strongest move in the position. Well spotted.";
        else if (grade.word === "Good") comment = "A healthy move — nothing wrong with it.";
        else {
          const bestSan = makeSAN(before, best.from, best.to).san;
          const pts = (drop / 100).toFixed(1);
          comment = `${grade.word}: this gave back about ${pts} points. Stronger was ${bestSan}.`;
        }
        out.push({ grade, comment });
        setNotes(out.slice());
        await new Promise((r) => setTimeout(r, 0));
        if (cancelRef.current) return;
      }
      setAnalyzing(false);
    })();
    return () => { cancelRef.current = true; };
  }, []); // eslint-disable-line

  const shownState = cursor === 0 ? startState() : history[cursor - 1].state;
  const lastMove = cursor === 0 ? null : { from: history[cursor - 1].from, to: history[cursor - 1].to };
  const moveList = history.map((h, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${h.san}` : h.san)).join("  ");
  const cursNote = cursor > 0 ? notes[cursor - 1] : null;

  const summary = useMemo(() => {
    const counts = { Best: 0, Good: 0, Inaccuracy: 0, Mistake: 0, Blunder: 0 };
    notes.forEach((n) => { if (n) counts[n.grade.word]++; });
    return counts;
  }, [notes]);

  return (
    <>
      <Coach text={
        analyzing ? "Analyzing your game move by move — grades will appear as I work…"
        : `Review complete. ${result} You played ${summary.Best} best moves, ${summary.Good} good, ${summary.Inaccuracy} inaccuracies, ${summary.Mistake} mistakes, and ${summary.Blunder} blunders. Tap any move to jump to it, or ask me for a deep review.`
      } />
      <div className="ct-reviewsticky">
        <Board board={shownState.board} flipped={userColor === "b"} lastMove={lastMove}
          checkSq={inCheck(shownState) ? kingIdx(shownState.board, shownState.turn) : null} />
        <div className="ct-controls">
          <button className="ct-btn" disabled={cursor === 0} onClick={() => setCursor(cursor - 1)}>‹ Back</button>
          <button className="ct-btn" disabled={cursor === history.length} onClick={() => setCursor(cursor + 1)}>Forward ›</button>
          <button className="ct-btn orange" onClick={() => setAsk(true)}>🧔 Deep review</button>
          <button className="ct-btn primary" onClick={onExit}>Done</button>
        </div>
        {cursNote && (
          <div style={{ marginTop: 10 }}>
            <span className={"ct-badge " + cursNote.grade.cls}>{cursNote.grade.badge}</span>
            <span style={{ fontSize: 13.5 }}>{cursNote.comment}</span>
          </div>
        )}
      </div>
      <div style={{ marginTop: 14 }}>
        {history.map((h, i) => {
          const n = notes[i];
          return (
            <div key={i} className={"ct-revrow" + (cursor === i + 1 ? " on" : "")} onClick={() => setCursor(i + 1)}>
              <span className="san">{i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ""}{h.san}</span>
              {n ? (<><span className={"ct-badge " + n.grade.cls}>{n.grade.badge}</span><span className="cmt">{n.comment}</span></>)
                 : (<span className="cmt" style={{ opacity: .55 }}>{h.mover === userColor ? "…" : "Coach's move"}</span>)}
            </div>
          );
        })}
      </div>
      {ask && (
        <AskCoach onClose={() => setAsk(false)} context={{
          mode: `Post-game review. Result: ${result} Student played ${userColor === "w" ? "White" : "Black"}.`,
          opening: null, fen: toFEN(shownState), moves: moveList,
          chips: ["Review my whole game", "What was my biggest mistake?", "What should I study next?", "How was my opening?"],
        }} />
      )}
    </>
  );
}

/* ---------- Play vs Coach ---------- */
function PlayMode({ opening }) {
  const userColor = opening.side;
  const flipped = userColor === "b";
  const { sound, voice } = useContext(Settings);
  const [state, setState] = useState(startState);
  const [selected, setSelected] = useState(null);
  const [targets, setTargets] = useState([]);
  const [lastMove, setLastMove] = useState(null);
  const [bookStep, setBookStep] = useState(0);
  const [offBook, setOffBook] = useState(false);
  const [msg, setMsg] = useState(null);
  const [history, setHistory] = useState([]);
  const [over, setOver] = useState(null);
  const [ask, setAsk] = useState(false);
  const [review, setReview] = useState(false);
  const [pendingUndo, setPendingUndo] = useState(null);
  const timer = useRef(null);

  const inBook = !offBook && bookStep < opening.line.length;
  const bookMove = inBook ? opening.line[bookStep] : null;

  const doMove = (st, from, to) => {
    const res = makeSAN(st, from, to);
    const status = gameStatus(res.state);
    moveSound(res, status, sound);
    setHistory((h) => [...h, { state: res.state, san: res.san, from, to, mover: st.turn }]);
    setLastMove({ from, to });
    if (st.turn !== userColor) speak(sanSpeech(res.san), voice);
    if (status === "checkmate") {
      const userWon = res.state.turn !== userColor;
      setOver(userWon ? "Checkmate — you win! 🎉" : "Checkmate — the coach wins this one.");
      playFX(userWon ? "win" : "lose", sound);
    } else if (status === "stalemate") setOver("Stalemate — a draw.");
    return res.state;
  };

  useEffect(() => {
    if (over || state.turn === userColor) return;
    timer.current = setTimeout(() => {
      let from, to, comment = null;
      if (inBook && bookMove) { from = bookMove.from; to = bookMove.to; comment = bookMove.c; setBookStep((b) => b + 1); }
      else {
        const m = enginePick(state, 2, 60);
        if (!m) return;
        from = m.from; to = m.to;
      }
      setState(doMove(state, from, to));
      if (comment) setMsg(comment);
    }, 550);
    return () => clearTimeout(timer.current);
  }, [state, over]); // eslint-disable-line

  const handleTap = (i) => {
    if (over || state.turn !== userColor) return;
    const p = state.board[i];
    if (selected != null && targets.includes(i)) {
      const from = selected, to = i;
      if (inBook && bookMove) {
        if (from === bookMove.from && to === bookMove.to) {
          setState(doMove(state, from, to)); setSelected(null); setTargets([]);
          setBookStep((b) => b + 1);
          setMsg("Book move! " + bookMove.c);
          setPendingUndo(null);
          return;
        }
        const snap = { state: cloneState(state), history: history.slice(), lastMove, bookStep };
        setState(doMove(state, from, to)); setSelected(null); setTargets([]);
        setPendingUndo(snap);
        const bookSAN = makeSAN(snap.state, bookMove.from, bookMove.to).san;
        setMsg(`That's playable, but the book move here is ${bookSAN} — ${bookMove.c} Take it back, or keep playing and we'll continue as a free game.`);
        setOffBook(true);
        return;
      }
      setState(doMove(state, from, to)); setSelected(null); setTargets([]);
      return;
    }
    if (p && p[0] === userColor) { setSelected(i); setTargets(legalMoves(state, i)); }
    else { setSelected(null); setTargets([]); }
  };

  const takeBack = () => {
    if (!pendingUndo) return;
    setState(pendingUndo.state); setHistory(pendingUndo.history);
    setLastMove(pendingUndo.lastMove); setBookStep(pendingUndo.bookStep);
    setOffBook(false); setPendingUndo(null);
    setMsg("Good instinct — let's try the book move. Tap Hint if you want me to show it.");
  };
  const hint = () => {
    if (inBook && bookMove && state.turn === userColor) {
      setSelected(bookMove.from); setTargets([bookMove.to]);
      setMsg("Here's the book move — the highlighted piece to the marked square.");
    } else setMsg("We're past the book line now — play what looks most active, and ask me anything!");
  };
  const restart = () => {
    setState(startState()); setSelected(null); setTargets([]); setLastMove(null);
    setBookStep(0); setOffBook(false); setHistory([]); setOver(null); setPendingUndo(null); setMsg(null); setReview(false);
  };

  if (review) return <ReviewMode history={history} userColor={userColor} result={over || "Game in progress."} onExit={() => setReview(false)} />;

  const moveList = history.map((h, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${h.san}` : h.san)).join("  ");
  const lineDone = bookStep >= opening.line.length && !offBook;
  const checkSq = !over && inCheck(state) ? kingIdx(state.board, state.turn) : null;
  const coachText = over ? over : msg ? msg + (lineDone ? " You've completed the whole book line — we're in a real game now. Show me a plan!" : "") :
    userColor === "w"
      ? `You have the White pieces. Play the ${opening.name} — start with the first move. Tap a piece, then tap where it goes. Stuck? Tap Hint.`
      : `You have the Black pieces in the ${opening.name}. I'll open for White — answer with the book moves. Tap Hint any time.`;

  return (
    <>
      <Coach text={coachText} />
      <div className="ct-toprow">
        <span>{offBook ? "Free play" : `Book: move ${Math.min(bookStep + 1, opening.line.length)} of ${opening.line.length}`}</span>
        <span>{over ? "Game over" : state.turn === userColor ? "Your move" : "Coach is thinking…"}</span>
      </div>
      <CapturedTray board={state.board} color={userColor === "w" ? "b" : "w"} />
      <Board board={state.board} flipped={flipped} onTap={handleTap} selected={selected} targets={targets} lastMove={lastMove} checkSq={checkSq} />
      <CapturedTray board={state.board} color={userColor} />
      <div className="ct-moves">{moveList || "Game start"}</div>
      <div className="ct-controls">
        <button className="ct-btn" onClick={hint}>💡 Hint</button>
        {pendingUndo && <button className="ct-btn orange" onClick={takeBack}>↩ Take back</button>}
        <button className="ct-btn" onClick={restart}>⟲ Restart</button>
        {over && history.length > 1 && <button className="ct-btn primary" onClick={() => setReview(true)}>📊 Review game</button>}
        <button className="ct-btn orange" onClick={() => setAsk(true)}>🧔 Ask</button>
      </div>
      {ask && (
        <AskCoach onClose={() => setAsk(false)} context={{
          mode: "Playing a training game against the coach",
          opening: opening.name, fen: toFEN(state), moves: moveList,
        }} />
      )}
    </>
  );
}

/* ---------- Free Play with Elo ---------- */
function eloUpdate(elo, oppElo, score) {
  const expected = 1 / (1 + Math.pow(10, (oppElo - elo) / 400));
  return Math.round(elo + 32 * (score - expected));
}
function FreePlay({ profile, updateProfile, ecoRows }) {
  const { sound, voice } = useContext(Settings);
  const [setup, setSetup] = useState(true);
  const [level, setLevel] = useState(LEVELS[0]);
  const [userColor, setUserColor] = useState("w");
  const [state, setState] = useState(startState);
  const [selected, setSelected] = useState(null);
  const [targets, setTargets] = useState([]);
  const [lastMove, setLastMove] = useState(null);
  const [history, setHistory] = useState([]);
  const [over, setOver] = useState(null);
  const [review, setReview] = useState(false);
  const [ask, setAsk] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [flipOverride, setFlipOverride] = useState(false);
  const scoredRef = useRef(false);
  const timer = useRef(null);

  const finish = (text, score) => {
    if (!scoredRef.current) {
      scoredRef.current = true;
      const newElo = eloUpdate(profile.elo, level.elo, score);
      const delta = newElo - profile.elo;
      updateProfile({ ...profile, elo: newElo, games: profile.games + 1, wins: profile.wins + (score === 1 ? 1 : 0) });
      setOver(text + ` Your rating: ${newElo} (${delta >= 0 ? "+" : ""}${delta}).`);
      playFX(score === 1 ? "win" : score === 0 ? "lose" : "move", sound);
    } else setOver(text);
  };

  const doMove = (st, from, to) => {
    const res = makeSAN(st, from, to);
    const status = gameStatus(res.state);
    moveSound(res, status, sound);
    setHistory((h) => [...h, { state: res.state, san: res.san, from, to, mover: st.turn }]);
    setLastMove({ from, to });
    if (st.turn !== userColor) speak(sanSpeech(res.san), voice);
    if (status === "checkmate") {
      const userWon = res.state.turn !== userColor;
      finish(userWon ? "Checkmate — you win! 🎉" : "Checkmate — the engine got you this time.", userWon ? 1 : 0);
    } else if (status === "stalemate") finish("Stalemate — a draw.", 0.5);
    return res.state;
  };

  useEffect(() => {
    if (setup || over || state.turn === userColor) return;
    setThinking(true);
    timer.current = setTimeout(() => {
      let m = null;
      if (level.book) {
        const bookSan = bookMoveFromEco(ecoRows, history.map((h) => h.san));
        if (bookSan) m = sanToMove(state, bookSan);
      }
      if (!m) m = enginePick(state, level.depth, level.margin, level.qs);
      setThinking(false);
      if (!m) return;
      setState(doMove(state, m.from, m.to));
    }, 350);
    return () => clearTimeout(timer.current);
  }, [state, setup, over]); // eslint-disable-line

  const handleTap = (i) => {
    if (setup || over || state.turn !== userColor || thinking) return;
    const p = state.board[i];
    if (selected != null && targets.includes(i)) {
      setState(doMove(state, selected, i)); setSelected(null); setTargets([]);
      return;
    }
    if (p && p[0] === userColor) { setSelected(i); setTargets(legalMoves(state, i)); }
    else { setSelected(null); setTargets([]); }
  };

  const startGame = (lvl, colorPick) => {
    const col = colorPick === "r" ? (Math.random() < 0.5 ? "w" : "b") : colorPick;
    setLevel(lvl); setUserColor(col);
    setState(startState()); setHistory([]); setOver(null); setLastMove(null);
    setSelected(null); setTargets([]); scoredRef.current = false;
    setSetup(false); setReview(false);
  };
  const resign = () => {
    if (over || history.length < 2) { setSetup(true); return; }
    finish("You resigned.", 0);
  };
  const takeback = () => {
    if (over || !history.length) return;
    clearTimeout(timer.current); setThinking(false);
    setHistory((h) => {
      if (!h.length) return h;
      const lastMover = h[h.length - 1].mover; // color that made the most recent move
      const pliesToUndo = lastMover === userColor ? 1 : 2; // if engine just moved, also undo the user's move before it
      const newH = h.slice(0, Math.max(0, h.length - pliesToUndo));
      const newState = newH.length ? newH[newH.length - 1].state : startState();
      setState(newState);
      setLastMove(newH.length ? { from: newH[newH.length - 1].from, to: newH[newH.length - 1].to } : null);
      setSelected(null); setTargets([]);
      return newH;
    });
  };

  if (setup) {
    return (
      <>
        <div className="ct-elochip">
          <div className="num">{profile.elo}</div>
          <div className="lbl">YOUR ELO RATING • {profile.games} games • {profile.wins} wins</div>
        </div>
        <Coach text="Pick an opponent and a color. Win and your rating climbs; lose and it dips — just like real rated chess. Every game gets a full move-by-move review afterward." />
        <SettingsRow />
        {LEVELS.map((l) => (
          <div key={l.id} className="ct-card" onClick={() => setLevel(l)} style={level.id === l.id ? { borderColor: "#e8ab24" } : {}}>
            <span className="ct-tag">~{l.elo} Elo</span>
            <h3>{l.name} {level.id === l.id ? "✓" : ""}</h3>
            <p>{l.desc}</p>
          </div>
        ))}
        <div className="ct-controls">
          <button className="ct-btn primary" onClick={() => startGame(level, "w")}>Play White</button>
          <button className="ct-btn primary" onClick={() => startGame(level, "b")}>Play Black</button>
          <button className="ct-btn" onClick={() => startGame(level, "r")}>Random</button>
        </div>
      </>
    );
  }

  if (review) return <ReviewMode history={history} userColor={userColor} result={over || ""} onExit={() => setReview(false)} />;

  const moveList = history.map((h, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${h.san}` : h.san)).join("  ");
  const checkSq = !over && inCheck(state) ? kingIdx(state.board, state.turn) : null;

  return (
    <>
      <Coach text={over ? over :
        history.length === 0
          ? `Rated game vs ${level.name} (~${level.elo}). You're ${userColor === "w" ? "White — your move" : "Black — the engine opens"}. Good luck!`
          : thinking ? "Hmm, let me think…" : "Your move."} />
      <div className="ct-toprow">
        <span>vs {level.name} (~{level.elo})</span>
        <span>{over ? "Game over" : state.turn === userColor ? "Your move" : "Engine thinking…"}</span>
      </div>
      <CapturedTray board={state.board} color={userColor === "w" ? "b" : "w"} />
      <Board board={state.board} flipped={(userColor === "b") !== flipOverride} onTap={handleTap} selected={selected} targets={targets} lastMove={lastMove} checkSq={checkSq} />
      <EvalBar state={state} />
      <CapturedTray board={state.board} color={userColor} />
      <div className="ct-moves">{moveList || "Game start"}</div>
      <div className="ct-controls">
        <button className="ct-btn" onClick={() => setFlipOverride((f) => !f)}>⇅ Flip</button>
        {!over && <button className="ct-btn" onClick={takeback} disabled={!history.length}>⏪ Takeback</button>}
        {!over && <button className="ct-btn" onClick={resign}>🏳 Resign</button>}
        {over && history.length > 1 && <button className="ct-btn primary" onClick={() => setReview(true)}>📊 Review game</button>}
        {over && <button className="ct-btn" onClick={() => setSetup(true)}>New game</button>}
        <button className="ct-btn orange" onClick={() => setAsk(true)}>🧔 Ask</button>
      </div>
      {ask && (
        <AskCoach onClose={() => setAsk(false)} context={{
          mode: "Playing a rated free-play game against the engine",
          opening: null, fen: toFEN(state), moves: moveList,
        }} />
      )}
    </>
  );
}

/* ---------- Lesson viewer ---------- */
function Lesson({ lesson, onAsk }) {
  return (
    <div className="ct-lesson">
      <Board board={fenBoard(lesson.fen)} flipped={false} />
      <div style={{ height: 14 }} />
      {lesson.body.map((p, i) => <p key={i}>{p}</p>)}
      <div className="ct-controls">
        <button className="ct-btn orange" onClick={onAsk}>🧔 Ask coach about this</button>
      </div>
    </div>
  );
}

/* ---------- Puzzle trainer ---------- */
function uciToSquares(u) {
  return { from: sqIdx(u.slice(0, 2)), to: sqIdx(u.slice(2, 4)) };
}
function PuzzleMode({ profile, updateProfile }) {
  const { sound, voice } = useContext(Settings);
  const puzzles = useMemo(() => parsePuzzles(PUZZLE_EMBED), []);
  const ratingRef = useRef(profile.puzzleRating || 1200);

  const pickPuzzle = (excludeId) => {
    const r = ratingRef.current;
    let pool = puzzles.filter((p) => Math.abs(p.rating - r) <= 200 && p.id !== excludeId);
    if (pool.length < 8) pool = puzzles.filter((p) => Math.abs(p.rating - r) <= 400 && p.id !== excludeId);
    if (pool.length < 8) pool = puzzles.filter((p) => p.id !== excludeId);
    if (!pool.length) pool = puzzles;
    return pool[Math.floor(Math.random() * pool.length)];
  };

  const [puzzle, setPuzzle] = useState(() => pickPuzzle(null));
  const [state, setState] = useState(() => fenToState(puzzle.fen));
  const [solveIdx, setSolveIdx] = useState(0);
  const [selected, setSelected] = useState(null);
  const [targets, setTargets] = useState([]);
  const [lastMove, setLastMove] = useState(null);
  const [status, setStatus] = useState("solving"); // solving | wrong | done
  const [msg, setMsg] = useState(() => flavorFor(puzzle.theme));
  const [seconds, setSeconds] = useState(0);
  const [sessionSolved, setSessionSolved] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [puzzleFlip, setPuzzleFlip] = useState(false);
  const advanceTimer = useRef(null);

  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [puzzle.id]);
  useEffect(() => () => clearTimeout(advanceTimer.current), []);

  const userSide = puzzle.side;
  const checkSq = inCheck(state) ? kingIdx(state.board, state.turn) : null;

  const loadPuzzle = (p) => {
    setPuzzle(p); setState(fenToState(p.fen)); setSolveIdx(0);
    setSelected(null); setTargets([]); setLastMove(null);
    setStatus("solving"); setMsg(flavorFor(p.theme)); setSeconds(0);
  };

  const nextPuzzle = (won) => {
    const r = ratingRef.current;
    const delta = won ? Math.round(8 + Math.random() * 12) : -Math.round(6 + Math.random() * 10);
    ratingRef.current = Math.max(400, r + delta);
    const streak = won ? (profile.puzzleStreak || 0) + 1 : 0;
    updateProfile({
      ...profile, puzzleRating: ratingRef.current,
      puzzlesSolved: (profile.puzzlesSolved || 0) + (won ? 1 : 0),
      puzzleStreak: streak, puzzleBest: Math.max(profile.puzzleBest || 0, streak),
    });
    if (won) setSessionSolved((n) => n + 1);
    loadPuzzle(pickPuzzle(puzzle.id));
  };

  const playOpponentReply = (st, sIdx) => {
    const uci = puzzle.solution[sIdx];
    if (!uci) return;
    const { from, to } = uciToSquares(uci);
    const res = makeSAN(st, from, to);
    moveSound(res, gameStatus(res.state), sound);
    setState(res.state);
    setLastMove({ from, to });
    setSolveIdx(sIdx + 1);
  };

  const finishSolved = (finalState) => {
    const mated = gameStatus(finalState) === "checkmate";
    setStatus("done");
    setMsg(mated ? "Checkmate! Beautifully solved. 🎉" : "Solved! Nicely done. 🎉");
    speak(mated ? "Checkmate! Well solved." : "Solved! Nicely done.", voice);
    playFX("win", sound);
    advanceTimer.current = setTimeout(() => nextPuzzle(true), 1400);
  };

  const handleTap = (i) => {
    if (status !== "solving" || state.turn !== userSide) return;
    const p = state.board[i];
    if (selected != null && targets.includes(i)) {
      const expected = uciToSquares(puzzle.solution[solveIdx]);
      if (selected === expected.from && i === expected.to) {
        const res = makeSAN(state, selected, i);
        moveSound(res, gameStatus(res.state), sound);
        setState(res.state);
        setLastMove({ from: selected, to: i });
        setSelected(null); setTargets([]);
        const nextIdx = solveIdx + 1;
        if (nextIdx >= puzzle.solution.length) { setSolveIdx(nextIdx); finishSolved(res.state); }
        else {
          setMsg("Yes! Now find the follow-up...");
          setSolveIdx(nextIdx);
          setTimeout(() => playOpponentReply(res.state, nextIdx), 550);
        }
      } else {
        setStatus("wrong");
        setMsg("Not quite — that's not the winning idea here. Try again.");
        playFX("lose", sound);
        setSelected(null); setTargets([]);
        setTimeout(() => setStatus("solving"), 900);
      }
      return;
    }
    if (p && p[0] === userSide) { setSelected(i); setTargets(legalMoves(state, i)); }
    else { setSelected(null); setTargets([]); }
  };

  const giveUp = () => {
    const { from, to } = uciToSquares(puzzle.solution[solveIdx]);
    const res = makeSAN(state, from, to);
    moveSound(res, gameStatus(res.state), sound);
    setState(res.state);
    setLastMove({ from, to });
    setStatus("done");
    setMsg("Here's the move — study the idea, then move on.");
    advanceTimer.current = setTimeout(() => nextPuzzle(false), 1800);
  };

  const hint = () => {
    if (status !== "solving") return;
    const { from } = uciToSquares(puzzle.solution[solveIdx]);
    setSelected(from); setTargets(legalMoves(state, from));
    setMsg("Here's the piece to move — find the right square.");
  };

  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <>
      <div className="ct-puzzletop">
        <button className="ct-tgl small" onClick={() => setShowSettings((s) => !s)}>⚙</button>
        <button className="ct-tgl small" onClick={() => setPuzzleFlip((f) => !f)}>⇅</button>
      </div>
      {showSettings && <SettingsRow />}
      <Coach text={`${userSide === "w" ? "White" : "Black"} to move. ${msg}`} />
      <Board board={state.board} flipped={(userSide === "b") !== puzzleFlip} onTap={handleTap}
        selected={selected} targets={targets} lastMove={lastMove} checkSq={checkSq} />
      <div className="ct-puzzlebar">
        <div className="ct-puzzlestat"><div className="num">{ratingRef.current}</div><div className="lbl">🔥 {profile.puzzleStreak || 0}</div></div>
        <div className="ct-puzzletimer">⏱ {mm}:{ss}</div>
      </div>
      <div className="ct-progress"><div style={{ width: Math.min(100, (sessionSolved % 10) * 10 || (sessionSolved ? 100 : 0)) + "%" }} /></div>
      <div className="ct-controls">
        <button className="ct-btn" onClick={hint} disabled={status !== "solving"}>💡 Hint</button>
        <button className="ct-btn" onClick={giveUp} disabled={status !== "solving"}>⏭ Skip</button>
        <button className="ct-btn primary" onClick={() => nextPuzzle(status === "done")} disabled={status === "solving"}>Next ›</button>
      </div>
      <p style={{ textAlign: "center", color: "#8a8783", fontSize: 12, marginTop: 6 }}>
        {THEME_LABEL[puzzle.theme] || puzzle.theme} · {puzzle.tier} · rated ~{puzzle.rating} · {sessionSolved} solved this session
      </p>
    </>
  );
}

/* ---------- Opening Recall (spaced-repetition-style quiz) ----------
   Weighted-random picks openings you're weakest on (or haven't tried),
   plays the OTHER side automatically, and asks you to recall your side's
   moves from memory. Tracks per-opening mastery in the profile. */
function QuizMode({ profile, updateProfile }) {
  const { sound, voice } = useContext(Settings);
  const mastery = profile.quizMastery || {};

  const pickOpening = (excludeId) => {
    const pool = OPENINGS.filter((o) => o.id !== excludeId && o.line && o.line.length >= 4);
    const weighted = pool.map((o) => {
      const m = mastery[o.id];
      const score = !m || !m.attempts ? 0 : m.correct / m.attempts;
      return { o, w: (1 - score) + 0.15 };
    });
    const total = weighted.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    for (const x of weighted) { r -= x.w; if (r <= 0) return x.o; }
    return weighted[weighted.length - 1].o;
  };

  const [opening, setOpening] = useState(() => pickOpening(null));
  const [state, setState] = useState(startState);
  const [ply, setPly] = useState(0);
  const [selected, setSelected] = useState(null);
  const [targets, setTargets] = useState([]);
  const [lastMove, setLastMove] = useState(null);
  const [status, setStatus] = useState("quizzing"); // quizzing | done
  const [msg, setMsg] = useState("Get ready…");
  const [sessionCount, setSessionCount] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const wrongRef = useRef(0);

  const flipped = opening.side === "b";
  const checkSq = inCheck(state) ? kingIdx(state.board, state.turn) : null;

  const recordResult = (o, passedClean) => {
    const m = { ...mastery };
    const prev = m[o.id] || { correct: 0, attempts: 0 };
    m[o.id] = { correct: prev.correct + (passedClean ? 1 : 0), attempts: prev.attempts + 1, lastSeen: Date.now() };
    updateProfile({ ...profile, quizMastery: m, quizCount: (profile.quizCount || 0) + (passedClean ? 1 : 0) });
  };

  const advance = (o, st, nextPly) => {
    setState(st); setPly(nextPly);
    if (nextPly >= o.line.length) {
      setStatus("done");
      const passed = wrongRef.current === 0;
      setMsg(passed
        ? `Perfect! You recalled the full ${o.name} without a slip. 🎉`
        : `Line complete — you got there. A couple of slips, worth another look.`);
      speak(passed ? "Perfect recall!" : "Line complete.", voice);
      recordResult(o, passed);
      setSessionCount((n) => n + 1);
      return;
    }
    const nextMv = o.line[nextPly];
    const isUserMove = (nextPly % 2 === 0) === (o.side === "w");
    if (!isUserMove) {
      setTimeout(() => {
        const res = makeSAN(st, nextMv.from, nextMv.to);
        moveSound(res, gameStatus(res.state), sound);
        setLastMove({ from: nextMv.from, to: nextMv.to });
        setMsg(`${nextMv.c} Your move — recall the book continuation.`);
        advance(o, res.state, nextPly + 1);
      }, 550);
    } else {
      setMsg(`Move ${Math.floor(nextPly / 2) + 1}${nextPly % 2 === 0 ? "." : "..."} — what's next in the ${o.name}?`);
    }
  };

  useEffect(() => { advance(opening, startState(), 0); }, []); // eslint-disable-line

  const nextLine = () => {
    const o = pickOpening(opening.id);
    wrongRef.current = 0;
    setOpening(o); setSelected(null); setTargets([]); setLastMove(null); setStatus("quizzing");
    advance(o, startState(), 0);
  };

  const handleTap = (i) => {
    if (status !== "quizzing") return;
    const isUserMove = (ply % 2 === 0) === (opening.side === "w");
    if (!isUserMove) return;
    const p = state.board[i];
    if (selected != null && targets.includes(i)) {
      const expected = opening.line[ply];
      if (selected === expected.from && i === expected.to) {
        const res = makeSAN(state, selected, i);
        moveSound(res, gameStatus(res.state), sound);
        setLastMove({ from: selected, to: i });
        setSelected(null); setTargets([]);
        advance(opening, res.state, ply + 1);
      } else {
        wrongRef.current += 1;
        setMsg("Not the book move here — take another look.");
        playFX("lose", sound);
        setSelected(null); setTargets([]);
      }
      return;
    }
    if (p && p[0] === state.turn) { setSelected(i); setTargets(legalMoves(state, i)); }
    else { setSelected(null); setTargets([]); }
  };

  const giveUp = () => {
    const expected = opening.line[ply];
    const res = makeSAN(state, expected.from, expected.to);
    moveSound(res, gameStatus(res.state), sound);
    setLastMove({ from: expected.from, to: expected.to });
    wrongRef.current += 1;
    advance(opening, res.state, ply + 1);
  };

  const m = mastery[opening.id];
  const masteryPct = m && m.attempts ? Math.round((m.correct / m.attempts) * 100) : 0;

  return (
    <>
      <div className="ct-puzzletop">
        <button className="ct-tgl small" onClick={() => setShowSettings((s) => !s)}>⚙</button>
      </div>
      {showSettings && <SettingsRow />}
      <Coach text={msg} />
      <Board board={state.board} flipped={flipped} onTap={handleTap}
        selected={selected} targets={targets} lastMove={lastMove} checkSq={checkSq} />
      <div className="ct-toprow">
        <span>{opening.name} · {opening.side === "w" ? "White" : "Black"}</span>
        <span>Mastery {masteryPct}%</span>
      </div>
      <div className="ct-controls">
        <button className="ct-btn" onClick={giveUp} disabled={status !== "quizzing"}>💡 Show move</button>
        <button className="ct-btn primary" onClick={nextLine} disabled={status === "quizzing"}>Next line ›</button>
      </div>
      <p style={{ textAlign: "center", color: "#8a8783", fontSize: 12, marginTop: 6 }}>
        {sessionCount} lines completed this session · {profile.quizCount || 0} clean recalls all-time
      </p>
    </>
  );
}

/* ---------- App shell ---------- */
export default function ChessTrainer() {
  const [screen, setScreen] = useState({ name: "home" });
  const [ask, setAsk] = useState(null);
  const [settings, setSettings] = useState({ sound: true, voice: false, theme: "walnut" });
  const [profile, setProfile] = useState({ elo: 800, games: 0, wins: 0, streak: 0, lastDay: null, puzzleRating: 1200, puzzlesSolved: 0, puzzleStreak: 0, puzzleBest: 0, quizMastery: {}, quizCount: 0 });
  const [ecoRows, setEcoRows] = useState(() => parsePacked(ECO_EMBED));
  const [ecoFull, setEcoFull] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await loadStore("ct-settings", { sound: true, voice: false, theme: "walnut" });
      const p = await loadStore("ct-profile", { elo: 800, games: 0, wins: 0, streak: 0, lastDay: null, puzzleRating: 1200, puzzlesSolved: 0, puzzleStreak: 0, puzzleBest: 0, quizMastery: {}, quizCount: 0 });
      setSettings({ theme: "walnut", ...s });
      setProfile({ streak: 0, lastDay: null, puzzleRating: 1200, puzzlesSolved: 0, puzzleStreak: 0, puzzleBest: 0, quizMastery: {}, quizCount: 0, ...p });
      const full = await loadFullEco();
      if (full) { setEcoRows(full); setEcoFull(true); }
    })();
  }, []);
  const updateSettings = (s) => { setSettings(s); saveStore("ct-settings", s); };
  const updateProfile = (p) => { setProfile(p); saveStore("ct-profile", p); };

  const touchStreak = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (profile.lastDay === today) return;
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const streak = profile.lastDay === yest ? (profile.streak || 0) + 1 : 1;
    updateProfile({ ...profile, streak, lastDay: today });
  };
  const TRAINING = new Set(["learn", "play", "free", "lesson", "ecoview", "puzzle", "quiz"]);
  const go = (s) => { if (TRAINING.has(s.name)) touchStreak(); setScreen(s); };

  const title =
    screen.name === "home" ? "♟ Chess Trainer" :
    screen.name === "openings" ? (screen.play ? "Play vs Coach" : "Coached Openings") :
    screen.name === "learn" || screen.name === "play" ? screen.opening.name :
    screen.name === "explorer" ? "Openings Database" :
    screen.name === "ecoview" ? screen.row[0] + " · " + screen.row[1] :
    screen.name === "free" ? "Free Play (Rated)" :
    screen.name === "puzzle" ? "Puzzles" :
    screen.name === "quiz" ? "Opening Recall" :
    screen.name === "fundamentals" ? "Fundamentals" :
    screen.name === "strategy" ? "Strategy" :
    screen.name === "lesson" ? screen.lesson.title : "Chess Trainer";

  const backTarget = () => {
    if (screen.name === "learn" || screen.name === "play") return { name: "openings", play: screen.name === "play" };
    if (screen.name === "ecoview") return { name: "explorer" };
    if (screen.name === "lesson") return { name: screen.from };
    return { name: "home" };
  };

  const T = THEMES[settings.theme] || THEMES.green;
  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(settings.theme) + 1) % THEME_ORDER.length];
    updateSettings({ ...settings, theme: next });
    playFX("move", settings.sound);
  };
  const compactHeader = screen.name === "free" || screen.name === "puzzle" || screen.name === "quiz";

  return (
    <Settings.Provider value={{ ...settings, updateSettings }}>
      <div className="ct-root" data-theme={settings.theme} style={{ "--lt": T.lt, "--dk": T.dk, "--hlL": T.hlL, "--hlD": T.hlD }}>
        <style>{CSS}</style>
        <div className="ct-head">
          {screen.name !== "home" && <button className="ct-back" onClick={() => setScreen(backTarget())}>‹</button>}
          <h1>{title}</h1>
          {!compactHeader && (
            <>
              <button className="ct-tgl" title={"Board theme: " + T.label} onClick={cycleTheme}>🎨</button>
              <button className={"ct-tgl" + (settings.sound ? "" : " off")} title="Move sounds"
                onClick={() => { const s = { ...settings, sound: !settings.sound }; updateSettings(s); if (s.sound) playFX("move", true); }}>
                {settings.sound ? "🔊" : "🔇"}
              </button>
              <button className={"ct-tgl" + (settings.voice ? "" : " off")} title="Coach voice"
                onClick={() => { const s = { ...settings, voice: !settings.voice }; updateSettings(s); speak(s.voice ? "Voice coach on. Let's train!" : "", s.voice); if (!s.voice && window.speechSynthesis) window.speechSynthesis.cancel(); }}>
                🗣
              </button>
            </>
          )}
        </div>
        <div className={"ct-body" + (compactHeader ? " ct-compact" : "")}>

          {screen.name === "home" && (
            <>
              <div className="ct-home-hero">
                <div className="crown">🧔</div>
                <h2>Your coach is ready</h2>
                <p>Openings, strategy, fundamentals, rated games, and full game reviews.</p>
                <div className="ct-streak">🔥 {profile.streak || 0}-day training streak</div>
              </div>
              <div className="ct-card" onClick={() => go({ name: "puzzle" })}>
                <span className="ct-tag">Rated • Puzzle {profile.puzzleRating || 1200}</span>
                <h3>🧩 Puzzles</h3>
                <p>413 hand-picked tactics from real games — forks, pins, skewers, mates, and more. Solve, build a streak, climb the puzzle rating.</p>
              </div>
              <div className="ct-card" onClick={() => go({ name: "quiz" })}>
                <span className="ct-tag">{profile.quizCount || 0} clean recalls</span>
                <h3>🧠 Opening recall</h3>
                <p>The coach plays the other side; you recall your repertoire from memory, move by move. Weaker lines come up more often.</p>
              </div>
              <div className="ct-card" onClick={() => go({ name: "explorer" })}>
                <span className="ct-tag">{ecoRows.length.toLocaleString()} openings{ecoFull ? " • full database" : ""}</span>
                <h3>🔍 Openings database</h3>
                <p>Every named opening and defense in the encyclopedia — searchable by name, ECO code, or first moves. Step through any line and ask the coach about it.</p>
              </div>
              <div className="ct-card" onClick={() => go({ name: "openings", play: false })}>
                <span className="ct-tag">Step-by-step</span>
                <h3>📖 Coached openings</h3>
                <p>40 full repertoires — 20 for White, 20 for Black — with a coach explanation for every single move.</p>
              </div>
              <div className="ct-card" onClick={() => go({ name: "openings", play: true })}>
                <span className="ct-tag">Interactive</span>
                <h3>♟ Play vs coach</h3>
                <p>Play the opening yourself. The coach cheers book moves and explains better ones when you stray.</p>
              </div>
              <div className="ct-card" onClick={() => go({ name: "free" })}>
                <span className="ct-tag">Rated • Elo {profile.elo}</span>
                <h3>⚔️ Free play</h3>
                <p>Rated games across 16 levels, 600 to 2500 — with an opening book and sharper search at the top end. Every game gets a full review.</p>
              </div>
              <div className="ct-card" onClick={() => go({ name: "fundamentals" })}>
                <span className="ct-tag">Foundations</span>
                <h3>🎓 Fundamentals</h3>
                <p>Piece values, the center, development, king safety, forks, pins, skewers, endgame basics.</p>
              </div>
              <div className="ct-card" onClick={() => go({ name: "strategy" })}>
                <span className="ct-tag">Middlegame</span>
                <h3>🧠 Strategy</h3>
                <p>Pawn structure, open files, outposts, the bishop pair, trading, and making a plan.</p>
              </div>
            </>
          )}

          {screen.name === "explorer" && (
            <EcoExplorer rows={ecoRows} full={ecoFull} onOpen={(row) => go({ name: "ecoview", row })} />
          )}
          {screen.name === "ecoview" && <EcoViewer key={screen.row[1] + screen.row[2]} row={screen.row} />}

          {screen.name === "openings" && (
            <>
              <Coach text={screen.play
                ? "Pick an opening and we'll play it out together — you make the moves, I'll respond and coach you."
                : "Pick an opening to study. White repertoires first, then Black defenses."} />
              <p style={{ color: "#b6b3ae", fontSize: 12, fontWeight: 800, letterSpacing: 1, margin: "6px 0" }}>PLAY AS WHITE</p>
              {OPENINGS.filter((o) => o.side === "w").map((o) => (
                <div key={o.id} className="ct-card" onClick={() => go({ name: screen.play ? "play" : "learn", opening: o })}>
                  <span className="ct-tag">{o.tag}</span><h3>{o.name}</h3><p>{o.blurb}</p>
                </div>
              ))}
              <p style={{ color: "#b6b3ae", fontSize: 12, fontWeight: 800, letterSpacing: 1, margin: "14px 0 6px" }}>PLAY AS BLACK</p>
              {OPENINGS.filter((o) => o.side === "b").map((o) => (
                <div key={o.id} className="ct-card" onClick={() => go({ name: screen.play ? "play" : "learn", opening: o })}>
                  <span className="ct-tag">{o.tag}</span><h3>{o.name}</h3><p>{o.blurb}</p>
                </div>
              ))}
            </>
          )}

          {screen.name === "learn" && <LearnMode key={screen.opening.id} opening={screen.opening} />}
          {screen.name === "play" && <PlayMode key={screen.opening.id} opening={screen.opening} />}
          {screen.name === "free" && <FreePlay profile={profile} updateProfile={updateProfile} ecoRows={ecoRows} />}
          {screen.name === "puzzle" && <PuzzleMode profile={profile} updateProfile={updateProfile} />}
          {screen.name === "quiz" && <QuizMode profile={profile} updateProfile={updateProfile} />}

          {screen.name === "fundamentals" && (
            <>
              <Coach text="Master these eight ideas and you'll beat most casual players without memorizing a single line." />
              {FUNDAMENTALS.map((l) => (
                <div key={l.id} className="ct-card" onClick={() => go({ name: "lesson", lesson: l, from: "fundamentals" })}>
                  <h3>{l.title}</h3><p>{l.body[0].slice(0, 90)}…</p>
                </div>
              ))}
            </>
          )}
          {screen.name === "strategy" && (
            <>
              <Coach text="Openings get you to a good middlegame — strategy tells you what to do once you're there." />
              {STRATEGY.map((l) => (
                <div key={l.id} className="ct-card" onClick={() => go({ name: "lesson", lesson: l, from: "strategy" })}>
                  <h3>{l.title}</h3><p>{l.body[0].slice(0, 90)}…</p>
                </div>
              ))}
            </>
          )}
          {screen.name === "lesson" && (
            <Lesson lesson={screen.lesson} onAsk={() => setAsk({
              mode: "Studying a lesson: " + screen.lesson.title,
              opening: null, fen: screen.lesson.fen, moves: "",
            })} />
          )}
        </div>
        {ask && <AskCoach context={ask} onClose={() => setAsk(null)} />}
      </div>
    </Settings.Provider>
  );
}
