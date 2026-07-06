import React, { useState, useMemo, useEffect, useRef, createContext, useContext } from "react";

/* ============================================================
   CHESS TRAINER v3
   • Searchable openings database (ECO A00–E99, Lichess dataset:
     1,751 lines embedded + live-fetch of all 3,733, cached)
   • Competition clock-click move sounds
   • Board themes (green / walnut / ice)
   • Daily training streak
   • Everything from v2: coached openings, rated free play with
     Elo, move-by-move review, voice coach, lessons
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
function negamax(state, depth, alpha, beta) {
  const moves = allLegalMoves(state);
  if (!moves.length) return inCheck(state) ? -99999 - depth : 0;
  if (depth <= 0) return evaluate(state);
  moves.sort((a, b) =>
    (state.board[b.to] ? VAL[state.board[b.to][1]] : 0) - (state.board[a.to] ? VAL[state.board[a.to][1]] : 0));
  let best = -Infinity;
  for (const m of moves) {
    const { state: ns } = applyMove(state, m.from, m.to);
    const v = -negamax(ns, depth - 1, -beta, -alpha);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}
function rootSearch(state, depth) {
  const moves = allLegalMoves(state);
  const scored = moves.map((m) => {
    const { state: ns } = applyMove(state, m.from, m.to);
    return { ...m, score: -negamax(ns, depth - 1, -Infinity, Infinity) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
function enginePick(state, depth, margin) {
  const scored = rootSearch(state, depth);
  if (!scored.length) return null;
  const top = scored[0].score;
  const pool = scored.filter((m) => top - m.score <= margin);
  return pool[Math.floor(Math.random() * pool.length)];
}
const LEVELS = [
  { id: "beginner", name: "Beginner", elo: 600, depth: 1, margin: 220, desc: "Sees one move ahead and gets distracted. Great for learning." },
  { id: "casual", name: "Casual", elo: 1000, depth: 2, margin: 70, desc: "Solid club-night opponent. Punishes hanging pieces." },
  { id: "club", name: "Club Player", elo: 1400, depth: 3, margin: 15, desc: "Calculates real lines. Bring your best chess." },
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

/* ---------- SVG piece set ---------- */
function PieceSVG({ code, size = "90%" }) {
  const white = code[0] === "w";
  const fill = white ? "url(#ctgw)" : "url(#ctgb)";
  const stroke = white ? "#3C3A36" : "#1f1d1a";
  const detail = white ? "#3C3A36" : "#E8E6E1";
  const sw = 1.5;
  const common = { fill, stroke, strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" };
  const line = { fill: "none", stroke: detail, strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" };
  const t = code[1];
  return (
    <svg viewBox="0 0 45 45" style={{ width: size, height: size, filter: "drop-shadow(0 2px 2px rgba(0,0,0,.35))" }}>
      <defs>
        <linearGradient id="ctgw" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#e3e1dc" />
        </linearGradient>
        <linearGradient id="ctgb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#57534e" /><stop offset="1" stopColor="#332f2b" />
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
/* The click of a hand slapping the button on a tournament chess clock:
   a hard plastic transient (bandpassed noise) + a faint case resonance. */
function clockClick(gain = 0.55, when = 0, freq = 2300) {
  const c = actx(), t = c.currentTime + when;
  const len = Math.floor(c.sampleRate * 0.014);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
  const n = c.createBufferSource(); n.buffer = buf;
  const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = 1.1;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
  n.connect(bp).connect(g).connect(c.destination); n.start(t);
  const o = c.createOscillator(); o.type = "triangle";
  o.frequency.setValueAtTime(freq * 0.32, t);
  o.frequency.exponentialRampToValueAtTime(freq * 0.2, t + 0.04);
  const og = c.createGain();
  og.gain.setValueAtTime(gain * 0.22, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  o.connect(og).connect(c.destination); o.start(t); o.stop(t + 0.06);
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
    if (kind === "move") clockClick(0.55);
    else if (kind === "capture") { clockClick(0.6, 0, 1500); clockClick(0.5, 0.05, 2500); }
    else if (kind === "castle") { clockClick(0.5); clockClick(0.5, 0.11); }
    else if (kind === "check") { clockClick(0.55); tone(880, 0.16, 0.22, 0.03); }
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
    window.speechSynthesis.cancel();
    const clean = String(text).replace(/[🧔♟📖🎓🧠💡⟲↩✓🎉🔊🗣›‹🔍⚔️📊🏳🎨🔥★]/g, "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.02; u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  } catch (e) {}
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
const ECO_EMBED = "A00\tAmar Opening\t1. Nh3\nA00\tAmar Opening: Paris Gambit\t1. Nh3 d5 2. g3 e5 3. f4\nA00\tAmsterdam Attack\t1. e3 e5 2. c4 d6 3. Nc3 Nc6 4. b3 Nf6\nA00\tAnderssen's Opening\t1. a3\nA00\tAnderssen's Opening: Polish Gambit\t1. a3 a5 2. b4\nA00\tBarnes Opening\t1. f3\nA00\tBarnes Opening: Fool's Mate\t1. f3 e5 2. g4 Qh4#\nA00\tBarnes Opening: Gedult Gambit\t1. f3 d5 2. e4 g6 3. d4 dxe4 4. c3\nA00\tBarnes Opening: Gedult Gambit\t1. f3 f5 2. e4 fxe4 3. Nc3\nA00\tBarnes Opening: Hammerschlag\t1. f3 e5 2. Kf2\nA00\tClemenz Opening\t1. h3\nA00\tClemenz Opening: Spike Lee Gambit\t1. h3 h5 2. g4\nA00\tCreepy Crawly Formation: Classical Defense\t1. h3 d5 2. a3 e5\nA00\tGlobal Opening\t1. h3 e5 2. a3\nA00\tGrob Opening\t1. g4\nA00\tGrob Opening: Alessi Gambit\t1. g4 f5\nA00\tGrob Opening: Double Grob\t1. g4 g5\nA00\tGrob Opening: Double Grob, Coca-Cola Gambit\t1. g4 g5 2. f4\nA00\tGrob Opening: Grob Gambit\t1. g4 d5 2. Bg2\nA00\tGrob Opening: Grob Gambit Declined\t1. g4 d5 2. Bg2 c6\nA00\tGrob Opening: Grob Gambit, Basman Gambit\t1. g4 d5 2. Bg2 h5 3. gxh5\nA00\tGrob Opening: Grob Gambit, Fritz Gambit\t1. g4 d5 2. Bg2 Bxg4 3. c4\nA00\tGrob Opening: Grob Gambit, Keres Gambit\t1. g4 d5 2. Bg2 e5 3. d4 exd4 4. c3\nA00\tGrob Opening: Grob Gambit, Richter-Grob Gambit\t1. g4 d5 2. Bg2 c6 3. c4 dxc4 4. b3\nA00\tGrob Opening: Keene Defense\t1. g4 d5 2. h3 e5 3. Bg2 c6\nA00\tGrob Opening: London Defense\t1. g4 e5 2. h3 Nc6\nA00\tGrob Opening: Romford Countergambit\t1. g4 d5 2. Bg2 Bxg4 3. c4 d4\nA00\tGrob Opening: Spike Attack\t1. g4 d5 2. Bg2 c6 3. g5\nA00\tGrob Opening: Spike, Hurst Attack\t1. g4 e5 2. Bg2 d5 3. c4\nA00\tGrob Opening: Zilbermints Gambit\t1. g4 d5 2. e4 dxe4 3. Nc3\nA00\tGrob Opening: Zilbermints Gambit, Schiller Defense\t1. g4 d5 2. e4 dxe4 3. Nc3 h5\nA00\tGrob Opening: Zilbermints Gambit, Zilbermints-Hartlaub Gambit\t1. g4 d5 2. e4 dxe4 3. Nc3 e5 4. d3\nA00\tHungarian Opening\t1. g3\nA00\tHungarian Opening: B\u00fccker Gambit\t1. g3 d5 2. Bg2 e5 3. b4\nA00\tHungarian Opening: Catalan Formation\t1. g3 d5 2. Bg2 e6\nA00\tHungarian Opening: Dutch Defense\t1. g3 f5\nA00\tHungarian Opening: Indian Defense\t1. g3 Nf6\nA00\tHungarian Opening: Myers Defense\t1. g3 g5\nA00\tHungarian Opening: Pachman Gambit\t1. g3 f5 2. e4 fxe4 3. Qh5+ g6\nA00\tHungarian Opening: Reversed Alekhine\t1. g3 e5 2. Nf3\nA00\tHungarian Opening: Reversed Brooklyn Defense, Brooklyn Benko Gambit\t1. g3 e5 2. Nf3 e4 3. Ng1 Nf6 4. b4\nA00\tHungarian Opening: Reversed Modern Defense\t1. g3 d5 2. Bg2 c5\nA00\tHungarian Opening: Reversed Norwegian Defense\t1. g3 e5 2. Nf3 e4 3. Nh4\nA00\tHungarian Opening: Sicilian Invitation\t1. g3 c5\nA00\tHungarian Opening: Slav Formation\t1. g3 d5 2. Bg2 c6\nA00\tHungarian Opening: Symmetrical Variation\t1. g3 g6\nA00\tHungarian Opening: Van Kuijk Gambit\t1. g3 h5 2. Nf3 h4\nA00\tHungarian Opening: Winterberg Gambit\t1. g3 d5 2. Bg2 e5 3. c4 dxc4 4. b3\nA00\tK\u00e1das Opening\t1. h4\nA00\tK\u00e1das Opening: Beginner's Trap\t1. h4 d5 2. Rh3\nA00\tK\u00e1das Opening: Koola-Koola Variation\t1. h4 a5\nA00\tK\u00e1das Opening: K\u00e1das Gambit\t1. h4 c5 2. b4\nA00\tK\u00e1das Opening: K\u00e1das Gambit\t1. h4 d5 2. d4 c5 3. Nf3 cxd4 4. c3\nA00\tK\u00e1das Opening: K\u00e1das Gambit\t1. h4 e5 2. d4 exd4 3. c3\nA00\tK\u00e1das Opening: Myers Variation\t1. h4 d5 2. d4 c5 3. e4\nA00\tK\u00e1das Opening: Schneider Gambit\t1. h4 g5\nA00\tK\u00e1das Opening: Steinbok Gambit\t1. h4 f5 2. e4 fxe4 3. d3\nA00\tLasker Simul Special\t1. g3 h5\nA00\tMieses Opening\t1. d3\nA00\tMieses Opening: Myers Spike Attack\t1. d3 g6 2. g4\nA00\tMieses Opening: Reversed Rat\t1. d3 e5\nA00\tMieses Opening: Venezolana Variation\t1. d3 c5 2. Nc3 Nc6 3. g3\nA00\tPolish Opening\t1. b4\nA00\tPolish Opening, with d5\t1. b4 d5\nA00\tPolish Opening, with d5\t1. b4 d5 2. Bb2 Nf6 3. Nf3\nA00\tPolish Opening: Baltic Defense\t1. b4 d5 2. Bb2 Bf5\nA00\tPolish Opening: Birmingham Gambit\t1. b4 c5\nA00\tPolish Opening: Bugayev Advance Variation\t1. b4 e5 2. Bb2 f6 3. b5\nA00\tPolish Opening: Bugayev Attack\t1. b4 e5 2. a3\nA00\tPolish Opening: Czech Defense\t1. b4 e5 2. Bb2 d6\nA00\tPolish Opening: Dutch Defense\t1. b4 f5\nA00\tPolish Opening: German Defense\t1. b4 d5 2. Bb2 Qd6\nA00\tPolish Opening: Grigorian Variation\t1. b4 Nc6\nA00\tPolish Opening: Karniewski Variation\t1. b4 Nh6\nA00\tPolish Opening: King's Indian Variation\t1. b4 Nf6 2. Bb2 g6\nA00\tPolish Opening: King's Indian Variation, Schiffler Attack\t1. b4 Nf6 2. Bb2 g6 3. e4\nA00\tPolish Opening: Myers Variation\t1. b4 d5 2. Bb2 c6 3. a4\nA00\tPolish Opening: Outflank Variation\t1. b4 c6\nA00\tPolish Opening: Outflank Variation, Schuehler Gambit\t1. b4 c6 2. Bb2 a5 3. b5\nA00\tPolish Opening: Queen's Indian Variation\t1. b4 e6 2. Bb2 Nf6 3. b5 b6\nA00\tPolish Opening: Queenside Defense\t1. b4 e6 2. Bb2 Nf6 3. b5 a6\nA00\tPolish Opening: Schiffler-Sokolsky Variation\t1. b4 e6 2. Bb2 Nf6 3. b5 d5 4. e3\nA00\tPolish Opening: Schuehler Gambit\t1. b4 c6 2. Bb2 a5 3. b5 cxb5 4. e4\nA00\tPolish Opening: Symmetrical Variation\t1. b4 b5\nA00\tPolish Opening: Tartakower Gambit\t1. b4 e5 2. Bb2 f6 3. e4\nA00\tPolish Opening: Wolferts Gambit\t1. b4 e5 2. Bb2 c5\nA00\tSaragossa Opening\t1. c3\nA00\tSodium Attack\t1. Na3\nA00\tSodium Attack: Chenoboskion Variation\t1. Na3 g6 2. g4\nA00\tSodium Attack: Durkin Gambit\t1. Na3 e5 2. Nc4 Nc6 3. e4 f5\nA00\tValencia Opening\t1. d3 e5 2. Nd2\nA00\tVan Geet Opening\t1. Nc3\nA00\tVan Geet Opening: Battambang Variation\t1. a3 e5 2. Nc3\nA00\tVan Geet Opening: Billockus-Johansen Gambit\t1. Nc3 e5 2. Nf3 Bc5\nA00\tVan Geet Opening: Damhaug Gambit\t1. Nc3 d5 2. f4 e5\nA00\tVan Geet Opening: Dougherty Gambit\t1. Nc3 d5 2. e4 dxe4 3. f3\nA00\tVan Geet Opening: Dunst-Perrenet Gambit\t1. Nc3 d5 2. e4 dxe4 3. d3\nA00\tVan Geet Opening: D\u00fcsseldorf Gambit\t1. Nc3 c5 2. b4\nA00\tVan Geet Opening: Gladbacher Gambit\t1. Nc3 e5 2. b3 d5 3. e4 dxe4 4. d3\nA00\tVan Geet Opening: Hector Gambit\t1. Nc3 d5 2. e4 dxe4 3. Bc4\nA00\tVan Geet Opening: Hergert Gambit\t1. Nc3 d6 2. f4 e5 3. fxe5 Nc6\nA00\tVan Geet Opening: Hulsemann Gambit\t1. Nc3 e5 2. e3 d5 3. Qh5 Be6\nA00\tVan Geet Opening: Kluever Gambit\t1. Nc3 f5 2. e4 fxe4 3. d3\nA00\tVan Geet Opening: Laroche Gambit\t1. Nc3 b5\nA00\tVan Geet Opening: Liebig Gambit\t1. Nc3 e5 2. e3 d5 3. Qh5 Nf6\nA00\tVan Geet Opening: Melleby Gambit\t1. Nc3 d5 2. f4 d4 3. Ne4 c5\nA00\tVan Geet Opening: Myers Attack\t1. Nc3 g6 2. h4\nA00\tVan Geet Opening: Napoleon Attack\t1. Nc3 e5 2. Nf3 Nc6 3. d4\nA00\tVan Geet Opening: Novosibirsk Variation\t1. Nc3 c5 2. d4 cxd4 3. Qxd4 Nc6 4. Qh4\nA00\tVan Geet Opening: Nowokunski Gambit\t1. Nc3 e5 2. f4 exf4 3. e4\nA00\tVan Geet Opening: Pfeiffer Gambit\t1. Nc3 d5 2. f4 d4 3. Ne4 e5\nA00\tVan Geet Opening: Pfeiffer Gambit, Sleipnir Countergambit\t1. Nc3 d5 2. f4 d4 3. Ne4 e5 4. Nf3\nA00\tVan Geet Opening: Reversed Nimzowitsch\t1. Nc3 e5\nA00\tVan Geet Opening: Reversed Scandinavian\t1. Nc3 e5 2. d4 exd4 3. Qxd4 Nc6 4. Qa4\nA00\tVan Geet Opening: Sicilian Two Knights\t1. Nc3 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4\nA00\tVan Geet Opening: Sleipnir Gambit\t1. Nc3 d5 2. e3 e5 3. d4 Bb4\nA00\tVan Geet Opening: Twyble Attack\t1. Nc3 c5 2. Rb1\nA00\tVan Geet Opening: T\u00fcbingen Gambit\t1. Nc3 Nf6 2. g4\nA00\tVan Geet Opening: Venezolana Variation\t1. Nc3 d5 2. d3 Nf6 3. g3\nA00\tVan Geet Opening: Warsteiner Gambit\t1. Nc3 d5 2. f4 g5\nA00\tVan't Kruijs Opening\t1. e3\nA00\tVan't Kruijs Opening: Bouncing Bishop Variation\t1. e3 e5 2. Bc4 b5 3. Bb3\nA00\tVan't Kruijs Opening: Keoni-Hiva Gambit, Akahi Variation\t1. e3 e5 2. Nc3 Nf6 3. f4 exf4 4. Nf3\nA00\tVan't Kruijs Opening: Keoni-Hiva Gambit, Alua Variation\t1. e3 e5 2. Nc3 Nc6 3. f4 exf4 4. Nf3\nA00\tVan't Kruijs Opening: Keoni-Hiva Gambit, Ekolu Variation\t1. e3 e5 2. Nc3 d5 3. f4 exf4 4. Nf3\nA00\tWare Opening\t1. a4\nA00\tWare Opening: Cologne Gambit\t1. a4 b6 2. d4 d5 3. Nc3 Nd7\nA00\tWare Opening: Crab Variation\t1. a4 e5 2. h4\nA00\tWare Opening: Meadow Hay Trap\t1. a4 e5 2. Ra3\nA00\tWare Opening: Symmetric Variation\t1. a4 a5\nA00\tWare Opening: Ware Gambit\t1. a4 e5 2. a5 d5 3. e3 f5 4. a6\nA00\tWare Opening: Wing Gambit\t1. a4 b5 2. axb5 Bb7\nA01\tNimzo-Larsen Attack\t1. b3\nA01\tNimzo-Larsen Attack: Classical Variation\t1. b3 d5\nA01\tNimzo-Larsen Attack: Dutch Variation\t1. b3 f5\nA01\tNimzo-Larsen Attack: English Variation\t1. b3 c5\nA01\tNimzo-Larsen Attack: Graz Attack\t1. b3 d5 2. Ba3\nA01\tNimzo-Larsen Attack: Indian Variation\t1. b3 Nf6\nA01\tNimzo-Larsen Attack: Modern Variation\t1. b3 e5\nA01\tNimzo-Larsen Attack: Modern Variation\t1. b3 e5 2. Bb2 Nc6\nA01\tNimzo-Larsen Attack: Modern Variation\t1. b3 e5 2. Bb2 Nc6 3. e3\nA01\tNimzo-Larsen Attack: Modern Variation\t1. b3 e5 2. Bb2 Nc6 3. c4 Nf6\nA01\tNimzo-Larsen Attack: Pachman Gambit\t1. b3 e5 2. Bb2 Nc6 3. f4\nA01\tNimzo-Larsen Attack: Polish Variation\t1. b3 b5\nA01\tNimzo-Larsen Attack: Ringelbach Gambit\t1. b3 f5 2. Bb2 e6 3. e4\nA01\tNimzo-Larsen Attack: Spike Variation\t1. b3 Nf6 2. Bb2 g6 3. g4\nA01\tNimzo-Larsen Attack: Symmetrical Variation\t1. b3 b6\nA02\tBird Opening\t1. f4\nA02\tBird Opening: Batavo-Polish Attack\t1. f4 Nf6 2. Nf3 g6 3. b4\nA02\tBird Opening: Double Duck Formation\t1. f4 f5 2. d4 d5\nA02\tBird Opening: From's Gambit\t1. f4 e5\nA02\tBird Opening: From's Gambit, Bahr Gambit\t1. f4 e5 2. Nc3\nA02\tBird Opening: From's Gambit, Langheld Gambit\t1. f4 e5 2. fxe5 d6 3. exd6 Nf6\nA02\tBird Opening: From's Gambit, Lasker Variation\t1. f4 e5 2. fxe5 d6 3. exd6 Bxd6 4. Nf3 g5\nA02\tBird Opening: Hobbs Gambit\t1. f4 g5\nA02\tBird Opening: Hobbs-Zilbermints Gambit\t1. f4 h6 2. Nf3 g5\nA02\tBird Opening: Horsefly Defense\t1. f4 Nh6\nA02\tBird Opening: Lasker Gambit\t1. f4 e5 2. fxe5 f6\nA02\tBird Opening: Mujannah\t1. f4 Nf6 2. c4\nA02\tBird Opening: Myers Defense\t1. f4 b5\nA02\tBird Opening: Platz Gambit\t1. f4 e5 2. fxe5 Ne7\nA02\tBird Opening: Schlechter Gambit\t1. f4 e5 2. fxe5 Nc6\nA02\tBird Opening: Siegener Gambit\t1. f4 e5 2. d4 exd4 3. Nf3 c5 4. c3\nA02\tBird Opening: Swiss Gambit\t1. f4 f5 2. e4 fxe4 3. Nc3 Nf6 4. g4\nA02\tBird Opening: Wagner-Zwitersch Gambit\t1. f4 f5 2. e4\nA03\tBird Opening: Dutch Variation\t1. f4 d5\nA03\tBird Opening: Dutch Variation, Dudweiler Gambit\t1. f4 d5 2. g4\nA03\tBird Opening: Lasker Variation\t1. f4 d5 2. Nf3 Nf6 3. e3 c5\nA03\tBird Opening: Sturm Gambit\t1. f4 d5 2. c4\nA03\tBird Opening: Williams Gambit\t1. f4 d5 2. e4\nA03\tBird Opening: Williams Gambit\t1. f4 d5 2. e4 dxe4 3. Nc3 Nf6 4. Qe2\nA03\tBird Opening: Williams-Zilbermints Gambit\t1. f4 d5 2. e4 dxe4 3. Nc3 Nf6 4. Nge2\nA04\tColle System: Rhamphorhynchus Variation\t1. Nf3 c5 2. e3 g6 3. d4 Bg7 4. dxc5 Qa5+\nA04\tModern Defense: Semi-Averbakh Variation, Polish Variation\t1. Nf3 c5 2. c4 g6 3. d4 Bg7 4. e4 Qb6\nA04\tModern Defense: Semi-Averbakh Variation, Pterodactyl Variation\t1. Nf3 c5 2. c4 g6 3. d4 Bg7 4. e4 Qa5+\nA04\tZukertort Defense: Kingside Variation\t1. Nf3 Nh6 2. d4 g6\nA04\tZukertort Defense: Sicilian Knight Variation\t1. Nf3 Na6 2. e4 c5\nA04\tZukertort Opening\t1. Nf3\nA04\tZukertort Opening: Arctic Defense\t1. Nf3 f6\nA04\tZukertort Opening: Arctic Defense, Drunken Knight Variation\t1. Nf3 f6 2. e4 Nh6 3. d4 Nf7\nA04\tZukertort Opening: Basman Defense\t1. Nf3 h6\nA04\tZukertort Opening: Black Mustang Defense\t1. Nf3 Nc6\nA04\tZukertort Opening: Drunken Cavalry Variation\t1. Nf3 Na6 2. e4 Nh6\nA04\tZukertort Opening: Dutch Variation\t1. Nf3 f5\nA04\tZukertort Opening: Herrstrom Gambit\t1. Nf3 g5\nA04\tZukertort Opening: Kingside Fianchetto\t1. Nf3 g6\nA04\tZukertort Opening: Lisitsyn Gambit\t1. Nf3 f5 2. e4\nA04\tZukertort Opening: Lisitsyn Gambit Deferred\t1. Nf3 f5 2. d3 Nf6 3. e4\nA04\tZukertort Opening: Pirc Invitation\t1. Nf3 d6\nA04\tZukertort Opening: Polish Defense\t1. Nf3 b5\nA04\tZukertort Opening: Queen's Gambit Invitation\t1. Nf3 e6\nA04\tZukertort Opening: Queenside Fianchetto Variation\t1. Nf3 b6\nA04\tZukertort Opening: Ross Gambit\t1. Nf3 e5\nA04\tZukertort Opening: Shabalov Gambit\t1. Nf3 e6 2. c4 a6 3. Nc3 c5 4. g3 b5\nA04\tZukertort Opening: Sicilian Invitation\t1. Nf3 c5\nA04\tZukertort Opening: Slav Invitation\t1. Nf3 c6\nA04\tZukertort Opening: Speelsmet Gambit\t1. Nf3 c5 2. d4 cxd4 3. e3\nA04\tZukertort Opening: St. George Defense\t1. Nf3 a6\nA04\tZukertort Opening: The Walrus\t1. Nf3 e5 2. Nxe5 Nc6 3. Nxc6 dxc6\nA04\tZukertort Opening: Vos Gambit\t1. Nf3 d6 2. d4 e5\nA04\tZukertort Opening: Wade Defense\t1. Nf3 d6 2. e4 Bg4\nA04\tZukertort Opening: Ware Defense\t1. Nf3 a5\nA05\tKing's Indian Attack\t1. Nf3 Nf6 2. g3 d5\nA05\tKing's Indian Attack: Smyslov Variation\t1. Nf3 Nf6 2. g3 g6 3. b4\nA05\tKing's Indian Attack: Spassky Variation\t1. Nf3 Nf6 2. g3 b5\nA05\tKing's Indian Attack: Symmetrical Defense\t1. Nf3 Nf6 2. g3 g6\nA05\tPolish Opening: Zukertort System\t1. Nf3 Nf6 2. b4 g6 3. Bb2\nA05\tZukertort Opening\t1. Nf3 Nf6\nA05\tZukertort Opening\t1. Nf3 Nf6 2. Nc3 Nc6\nA05\tZukertort Opening: Lemberger Gambit\t1. Nf3 Nf6 2. e4\nA05\tZukertort Opening: Myers Polish Attack\t1. Nf3 Nf6 2. a4 g6 3. b4\nA05\tZukertort Opening: Nimzo-Larsen Variation\t1. Nf3 Nf6 2. b3\nA05\tZukertort Opening: Quiet System\t1. Nf3 Nf6 2. e3\nA06\tNimzo-Larsen Attack: Classical Variation\t1. Nf3 d5 2. b3\nA06\tNimzo-Larsen Attack: Norfolk Gambit\t1. Nf3 d5 2. b3 c5 3. e4\nA06\tNimzo-Larsen Attack: Norfolk Gambit\t1. Nf3 d5 2. b3 Nf6 3. Bb2 c5 4. e4\nA06\tZukertort Opening\t1. Nf3 d5\nA06\tZukertort Opening: Ampel Variation\t1. Nf3 d5 2. Rg1\nA06\tZukertort Opening: Old Indian Attack\t1. Nf3 d5 2. d3\nA06\tZukertort Opening: Pachman Gambit\t1. Nf3 d5 2. e3 c5 3. c4 dxc4 4. b3\nA06\tZukertort Opening: Regina-Nu Gambit\t1. Nf3 d5 2. b3 c5 3. c4 dxc4 4. Nc3\nA06\tZukertort Opening: Reversed Mexican Defense\t1. Nf3 d5 2. Nc3\nA06\tZukertort Opening: Santasiere's Folly\t1. b4 d5 2. Nf3\nA06\tZukertort Opening: Tennison Gambit\t1. e4 d5 2. Nf3\nA06\tZukertort Opening: The Potato\t1. Nf3 d5 2. a4\nA07\tHungarian Opening: Wiedenhagen-Beta Gambit\t1. g3 d5 2. Nf3 g5\nA07\tKing's Indian Attack\t1. Nf3 d5 2. g3\nA07\tKing's Indian Attack, with Bf5\t1. Nf3 Nf6 2. g3 d5 3. Bg2 c6 4. O-O Bf5\nA07\tKing's Indian Attack, with e6\t1. Nf3 Nf6 2. g3 d5 3. Bg2 e6\nA07\tKing's Indian Attack, with e6\t1. Nf3 Nf6 2. g3 d5 3. Bg2 e6 4. O-O Be7\nA07\tKing's Indian Attack: Double Fianchetto\t1. Nf3 d5 2. g3 g6\nA07\tKing's Indian Attack: Keres Variation\t1. Nf3 d5 2. g3 Bg4\nA07\tKing's Indian Attack: Keres Variation\t1. Nf3 d5 2. g3 Bg4 3. Bg2 Nd7\nA07\tKing's Indian Attack: Keres Variation\t1. Nf3 d5 2. g3 c6 3. Bg2 Bg4 4. O-O Nd7\nA07\tKing's Indian Attack: Omega-Delta Gambit\t1. Nf3 d5 2. g3 e5\nA07\tKing's Indian Attack: Sicilian Variation\t1. Nf3 d5 2. g3 c5\nA07\tKing's Indian Attack: Yugoslav Variation\t1. Nf3 Nf6 2. g3 d5 3. Bg2 c6 4. O-O Bg4\nA08\tKing's Indian Attack: French Variation\t1. Nf3 d5 2. g3 c5 3. Bg2 Nc6\nA08\tKing's Indian Attack: Sicilian Variation\t1. Nf3 d5 2. g3 c5 3. Bg2\nA08\tZukertort Opening: Reversed Gr\u00fcnfeld\t1. Nf3 d5 2. g3 c5 3. Bg2 Nc6 4. d4\nA08\tZukertort Opening: Reversed Gr\u00fcnfeld\t1. Nf3 d5 2. g3 c5 3. Bg2 Nc6 4. d4 Nf6\nA09\tR\u00e9ti Opening\t1. Nf3 d5 2. c4\nA09\tR\u00e9ti Opening: Advance Variation\t1. Nf3 d5 2. c4 d4\nA09\tR\u00e9ti Opening: Advance Variation, Michel Gambit\t1. Nf3 d5 2. c4 d4 3. b4 c5\nA09\tR\u00e9ti Opening: Advance Variation, Navara Gambit\t1. Nf3 d5 2. c4 d4 3. b4 g5\nA09\tR\u00e9ti Opening: Penguin Variation\t1. Nf3 d5 2. c4 d4 3. Rg1\nA09\tR\u00e9ti Opening: Reversed Blumenfeld Gambit\t1. Nf3 d5 2. c4 d4 3. e3 c5 4. b4\nA09\tR\u00e9ti Opening: R\u00e9ti Accepted\t1. Nf3 d5 2. c4 dxc4\nA09\tR\u00e9ti Opening: R\u00e9ti Gambit, Keres Variation\t1. Nf3 d5 2. c4 dxc4 3. e3 Be6\nA09\tR\u00e9ti Opening: Zilbermints Gambit\t1. Nf3 d5 2. c4 b5\nA10\tEnglish Opening\t1. c4\nA10\tEnglish Opening: Achilles-Omega Gambit\t1. c4 Nf6 2. e4\nA10\tEnglish Opening: Adorjan Defense\t1. c4 g6 2. e4 e5\nA10\tEnglish Opening: Anglo-Dutch Defense\t1. c4 f5\nA10\tEnglish Opening: Anglo-Dutch Defense, Hickmann Gambit\t1. c4 f5 2. e4\nA10\tEnglish Opening: Anglo-Dutch Variation, Chabanon Gambit\t1. c4 f5 2. Nf3 d6 3. e4\nA10\tEnglish Opening: Anglo-Dutch Variation, Ferenc Gambit\t1. c4 f5 2. Nc3 Nf6 3. e4\nA10\tEnglish Opening: Anglo-Lithuanian Variation\t1. c4 Nc6\nA10\tEnglish Opening: Anglo-Scandinavian Defense\t1. c4 d5\nA10\tEnglish Opening: Anglo-Scandinavian Defense, L\u00f6hn Gambit\t1. c4 d5 2. cxd5 e6\nA10\tEnglish Opening: Anglo-Scandinavian Defense, Malvinas Variation\t1. c4 d5 2. cxd5 Qxd5 3. Nc3 Qa5\nA10\tEnglish Opening: Anglo-Scandinavian Defense, Schulz Gambit\t1. c4 d5 2. cxd5 Nf6\nA10\tEnglish Opening: Great Snake Variation\t1. c4 g6\nA10\tEnglish Opening: Jaenisch Gambit\t1. c4 b5\nA10\tEnglish Opening: Myers Defense\t1. c4 g5\nA10\tEnglish Opening: Myers Gambit\t1. c4 g5 2. d4 Bg7\nA10\tEnglish Opening: Porcupine Variation\t1. c4 f5 2. Nc3 Nf6 3. e4 fxe4 4. g4\nA10\tEnglish Opening: Wade Gambit\t1. c4 f5 2. g4\nA10\tEnglish Opening: Zilbermints Gambit\t1. c4 g5 2. d4 e5\nA11\tEnglish Opening: Caro-Kann Defensive System\t1. c4 c6\nA11\tR\u00e9ti Opening: Anglo-Slav Variation, Gurevich System\t1. c4 c6 2. Nf3 d5 3. e3\nA11\tR\u00e9ti Opening: Anglo-Slav Variation, Gurevich System\t1. c4 c6 2. Nf3 d5 3. e3 Nf6 4. Qc2\nA11\tR\u00e9ti Opening: Anglo-Slav Variation, with g3\t1. c4 c6 2. Nf3 d5 3. g3 Nf6 4. b3 g6\nA11\tR\u00e9ti Opening: Anglo-Slav Variation, with g3\t1. c4 c6 2. Nf3 d5 3. g3 Nf6 4. Bg2\nA11\tR\u00e9ti Opening: Anglo-Slav Variation, with g3\t1. c4 c6 2. Nf3 d5 3. g3 Nf6 4. Bg2 dxc4\nA11\tR\u00e9ti Opening: Anglo-Slav Variation, with g3\t1. c4 c6 2. Nf3 d5 3. g3 Nf6 4. Bg2 Bf5\nA12\tR\u00e9ti Opening: Anglo-Slav Variation\t1. c4 Nf6 2. g3 c6 3. Nf3 d5 4. b3\nA12\tR\u00e9ti Opening: Anglo-Slav Variation, Bled Variation\t1. Nf3 d5 2. b3 Nf6 3. Bb2 g6 4. c4 c6\nA12\tR\u00e9ti Opening: Anglo-Slav Variation, Bogoljubow Variation\t1. Nf3 d5 2. c4 c6 3. b3\nA12\tR\u00e9ti Opening: Anglo-Slav Variation, Bogoljubow Variation\t1. Nf3 d5 2. c4 c6 3. b3 Bg4\nA12\tR\u00e9ti Opening: Anglo-Slav Variation, Bogoljubow Variation\t1. Nf3 d5 2. c4 c6 3. b3 Bf5\nA12\tR\u00e9ti Opening: Anglo-Slav Variation, Bogoljubow Variation\t1. Nf3 d5 2. c4 c6 3. b3 Bf5 4. Bb2\nA12\tR\u00e9ti Opening: Anglo-Slav Variation, Capablanca Variation\t1. c4 Nf6 2. Nf3 c6 3. b3 d5 4. Bb2 Bg4\nA12\tR\u00e9ti Opening: Anglo-Slav Variation, London Defensive System\t1. c4 Nf6 2. g3 c6 3. Nf3 d5 4. b3 Bf5\nA12\tR\u00e9ti Opening: Anglo-Slav Variation, New York System\t1. Nf3 Nf6 2. c4 c6 3. b3 d5 4. Bb2 Bf5\nA12\tR\u00e9ti Opening: Anglo-Slav Variation, Torre System\t1. c4 Nf6 2. g3 c6 3. Nf3 d5 4. b3 Bg4\nA12\tR\u00e9ti Opening: Anglo-Slav Variation, with dxc4\t1. c4 Nf6 2. g3 c6 3. Nf3 d5 4. b3 dxc4\nA13\tEnglish Opening: Agincourt Defense\t1. c4 e6\nA13\tEnglish Opening: Agincourt Defense\t1. c4 e6 2. Nf3\nA13\tEnglish Opening: Agincourt Defense\t1. c4 e6 2. Nf3 d5\nA13\tEnglish Opening: Agincourt Defense, Bogoljubow Defense\t1. c4 e6 2. Nf3 d5 3. g3 Nf6 4. Bg2 Bd6\nA13\tEnglish Opening: Agincourt Defense, Catalan Defense\t1. c4 e6 2. Nf3 d5 3. g3 c5\nA13\tEnglish Opening: Agincourt Defense, Catalan Defense Accepted\t1. c4 e6 2. Nf3 Nf6 3. g3 d5 4. Bg2 dxc4\nA13\tEnglish Opening: Agincourt Defense, Catalan Defense, Semi-Slav Defense\t1. c4 e6 2. Nf3 Nf6 3. g3 d5 4. Bg2 c6\nA13\tEnglish Opening: Agincourt Defense, Kurajica Defense\t1. c4 e6 2. Nf3 d5 3. g3 c6\nA13\tEnglish Opening: Neo-Catalan\t1. c4 e6 2. Nf3 d5 3. g3 Nf6\nA13\tEnglish Opening: Neo-Catalan Declined\t1. c4 e6 2. Nf3 d5 3. g3 Nf6 4. Bg2 Be7\nA13\tEnglish Opening: Romanishin Gambit\t1. c4 Nf6 2. Nf3 e6 3. g3 a6 4. Bg2 b5\nA15\tEnglish Opening: Anglo-Indian Defense\t1. c4 Nf6\nA15\tEnglish Opening: Anglo-Indian Defense, Anti-Anti-Gr\u00fcnfeld\t1. c4 Nf6 2. Nc3 g6 3. Nf3 Bg7 4. e4\nA15\tEnglish Opening: Anglo-Indian Defense, Gr\u00fcnfeld Formation\t1. c4 Nf6 2. Nf3 g6 3. g3 d5\nA15\tEnglish Opening: Anglo-Indian Defense, King's Indian Formation\t1. c4 Nf6 2. Nf3 g6\nA15\tEnglish Opening: Anglo-Indian Defense, King's Indian Formation, Double Fianchetto\t1. c4 Nf6 2. Nf3 g6 3. g3 b6 4. Bg2 Bb7\nA15\tEnglish Opening: Anglo-Indian Defense, King's Knight Variation\t1. c4 Nf6 2. Nf3\nA15\tEnglish Opening: Anglo-Indian Defense, Old Indian Formation\t1. c4 Nf6 2. Nf3 d6\nA15\tEnglish Opening: Anglo-Indian Defense, Queen's Indian Formation\t1. c4 Nf6 2. Nf3 b6\nA15\tEnglish Opening: Anglo-Indian Defense, Queen's Indian Formation\t1. c4 e6 2. Nf3 Nf6 3. g3 b6 4. Bg2 Bb7\nA15\tEnglish Opening: Anglo-Indian Defense, Romanishin Variation\t1. c4 e6 2. Nf3 Nf6 3. g3 a6\nA15\tEnglish Opening: Anglo-Indian Defense, Scandinavian Defense\t1. c4 Nf6 2. Nf3 d5\nA15\tEnglish Opening: Anglo-Indian Defense, Scandinavian Defense, Exchange Variation\t1. c4 Nf6 2. Nf3 d5 3. cxd5 Nxd5\nA15\tEnglish Opening: Anglo-Indian Defense, Slav Formation\t1. c4 Nf6 2. Nf3 g6 3. g3 c6\nA15\tEnglish Orangutan\t1. c4 Nf6 2. b4\nA15\tEnglish Orangutan\t1. c4 Nf6 2. Nf3 g6 3. b4\nA16\tEnglish Opening: Anglo-Gr\u00fcnfeld Defense\t1. c4 Nf6 2. Nc3 d5\nA16\tEnglish Opening: Anglo-Indian Defense, Anglo-Gr\u00fcnfeld Variation\t1. c4 Nf6 2. Nc3 d5 3. cxd5 Nxd5 4. Nf3\nA16\tEnglish Opening: Anglo-Indian Defense, Anglo-Gr\u00fcnfeld Variation\t1. c4 Nf6 2. Nc3 d5 3. cxd5 Nxd5 4. Nf3 g6\nA16\tEnglish Opening: Anglo-Indian Defense, Queen's Knight Variation\t1. c4 Nf6 2. Nc3\nA17\tEnglish Opening: Anglo-Indian Defense, Hedgehog System\t1. c4 Nf6 2. Nc3 e6\nA17\tEnglish Opening: Anglo-Indian Defense, Nimzo-English\t1. c4 Nf6 2. Nc3 e6 3. Nf3 Bb4\nA17\tEnglish Opening: Anglo-Indian Defense, Queen's Indian Formation\t1. c4 e6 2. Nc3 Nf6 3. Nf3 b6\nA17\tEnglish Opening: Anglo-Indian Defense, Zvjaginsev-Krasenkow Attack\t1. c4 e6 2. Nc3 Nf6 3. Nf3 Bb4 4. g4\nA18\tEnglish Opening: Mikenas-Carls Variation\t1. c4 e6 2. Nc3 Nf6 3. e4\nA18\tEnglish Opening: Mikenas-Carls Variation\t1. c4 e6 2. Nc3 Nf6 3. e4 Nc6\nA18\tEnglish Opening: Mikenas-Carls Variation\t1. c4 e6 2. Nc3 Nf6 3. e4 d5 4. e5\nA19\tEnglish Opening: Anglo-Indian Defense, Flohr-Mikenas-Carls Variation, Nei Gambit\t1. c4 e6 2. Nc3 Nf6 3. e4 c5 4. e5 Ng8\nA19\tEnglish Opening: Mikenas-Carls, Sicilian\t1. c4 e6 2. Nc3 Nf6 3. e4 c5\nA20\tEnglish Opening: Drill Variation\t1. c4 e5 2. g3 h5\nA20\tEnglish Opening: King's English Variation\t1. c4 e5\nA20\tEnglish Opening: King's English Variation, Kahiko-Hula Gambit\t1. c4 e5 2. e3 Nf6 3. f4 exf4 4. Nf3\nA20\tEnglish Opening: King's English Variation, Nimzowitsch Variation\t1. c4 e5 2. Nf3\nA20\tEnglish Opening: King's English Variation, Nimzowitsch-Flohr Variation\t1. c4 e5 2. Nf3 e4\nA21\tEnglish Opening: King's English Variation\t1. c4 e5 2. Nc3 d6 3. Nf3\nA21\tEnglish Opening: King's English Variation, Keres Defense\t1. c4 e5 2. Nc3 d6 3. g3 c6\nA21\tEnglish Opening: King's English Variation, Kramnik-Shirov Counterattack\t1. c4 e5 2. Nc3 Bb4\nA21\tEnglish Opening: King's English Variation, Reversed Sicilian\t1. c4 e5 2. Nc3\nA21\tEnglish Opening: King's English Variation, Smyslov Defense\t1. c4 e5 2. Nc3 d6 3. Nf3 Bg4\nA21\tEnglish Opening: King's English Variation, Troger Defense\t1. c4 e5 2. Nc3 Nc6 3. g3 d6 4. Bg2 Be6\nA22\tEnglish Opening: Carls-Bremen System\t1. c4 e5 2. Nc3 Nf6 3. g3\nA22\tEnglish Opening: King's English Variation, Adhiban Gambit\t1. c4 e5 2. Nc3 Nf6 3. Nf3 e4 4. Ng5 c6\nA22\tEnglish Opening: King's English Variation, Bellon Gambit\t1. c4 e5 2. Nc3 Nf6 3. Nf3 e4 4. Ng5 b5\nA22\tEnglish Opening: King's English Variation, Two Knights Variation\t1. c4 e5 2. Nc3 Nf6\nA22\tEnglish Opening: King's English Variation, Two Knights Variation, Reversed Dragon\t1. c4 e5 2. Nc3 Nf6 3. g3 d5\nA22\tEnglish Opening: King's English Variation, Two Knights Variation, Smyslov System\t1. c4 e5 2. Nc3 Nf6 3. g3 Bb4\nA22\tEnglish Opening: King's English, Erbenheimer Gambit\t1. c4 e5 2. Nc3 Nf6 3. Nf3 e4 4. Ng5 Ng4\nA22\tEnglish Opening: King's English, Mazedonisch\t1. c4 e5 2. Nc3 Nf6 3. f4\nA23\tEnglish Opening: King's English Variation, Two Knights Variation, Keres Variation\t1. c4 e5 2. Nc3 Nf6 3. g3 c6\nA23\tEnglish Opening: King's English Variation, Two Knights Variation, Keres Variation\t1. c4 e5 2. Nc3 Nf6 3. g3 Bc5 4. Bg2 c6\nA24\tEnglish Opening: King's English Variation, Two Knights Variation, Fianchetto Line\t1. c4 e5 2. Nc3 Nf6 3. g3 g6\nA25\tEnglish Opening: King's English Variation, Reversed Closed Sicilian\t1. c4 e5 2. Nc3 Nc6\nA25\tEnglish Opening: King's English Variation, Taimanov Variation\t1. c4 e5 2. Nc3 Nc6 3. g3 g6 4. Bg2 Bg7\nA27\tEnglish Opening: King's English Variation, Three Knights System\t1. c4 e5 2. Nc3 Nc6 3. Nf3\nA28\tEnglish Opening: Four Knights System, Nimzowitsch Variation\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6 4. e4\nA28\tEnglish Opening: King's English Variation, Four Knights Variation\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6\nA28\tEnglish Opening: King's English Variation, Four Knights Variation, Bradley Beach Variation\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6 4. d4 e4\nA28\tEnglish Opening: King's English Variation, Four Knights Variation, Flexible Line\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6 4. d3\nA28\tEnglish Opening: King's English Variation, Four Knights Variation, Korchnoi Line\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6 4. a3\nA28\tEnglish Opening: King's English Variation, Four Knights Variation, Quiet Line\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6 4. e3\nA29\tEnglish Opening: King's English Variation, Four Knights Variation, Fianchetto Line\t1. c4 e5 2. Nc3 Nf6 3. Nf3 Nc6 4. g3\nA30\tEnglish Opening: Symmetrical Variation\t1. c4 c5\nA30\tEnglish Opening: Symmetrical Variation\t1. c4 c5 2. Nf3\nA30\tEnglish Opening: Symmetrical Variation, Napolitano Gambit\t1. c4 c5 2. Nf3 Nf6 3. b4\nA30\tEnglish Opening: Wing Gambit\t1. c4 c5 2. b4\nA31\tEnglish Opening: Symmetrical Variation, Anti-Benoni Variation\t1. c4 Nf6 2. d4 c5 3. Nf3\nA32\tEnglish Opening: Symmetrical Variation, Anti-Benoni Variation, Spielmann Defense\t1. c4 e6 2. d4 c5 3. Nf3 cxd4 4. Nxd4 Nf6\nA34\tEnglish Opening: Symmetrical Variation, Fianchetto Variation\t1. c4 Nf6 2. Nc3 c5 3. g3\nA34\tEnglish Opening: Symmetrical Variation, Normal Variation\t1. c4 c5 2. Nc3\nA34\tEnglish Opening: Symmetrical Variation, Three Knights Variation\t1. c4 c5 2. Nc3 Nf6 3. Nf3\nA35\tEnglish Opening: Symmetrical Variation\t1. c4 c5 2. Nc3 Nf6 3. Nf3 e5\nA35\tEnglish Opening: Symmetrical Variation, Four Knights Variation\t1. c4 Nf6 2. Nf3 c5 3. Nc3 Nc6\nA35\tEnglish Opening: Symmetrical Variation, Two Knights Variation\t1. c4 c5 2. Nc3 Nc6\nA36\tEnglish Opening: Symmetrical Variation, Two Knights, Fianchetto Variation\t1. c4 c5 2. Nc3 Nc6 3. g3\nA36\tEnglish Opening: Symmetrical Variation, Ultra-Symmetrical Variation\t1. c4 c5 2. g3 g6 3. Bg2 Bg7 4. Nc3 Nc6\nA40\tAustralian Defense\t1. d4 Na6\nA40\tBorg Defense: Borg Gambit\t1. d4 g5\nA40\tColle System: Pterodactyl Variation\t1. d4 g6 2. Nf3 Bg7 3. e3 c5 4. Bd3 Qa5+\nA40\tEnglish Defense\t1. d4 b6\nA40\tEnglish Defense\t1. d4 e6 2. c4 b6\nA40\tEnglish Defense: Eastbourne Gambit\t1. d4 b6 2. c4 Bb7 3. Nc3 e5\nA40\tEnglish Defense: Perrin Variation\t1. d4 e6 2. c4 b6 3. e4 Bb7 4. Bd3 Nc6\nA40\tEnglund Gambit\t1. d4 e5\nA40\tEnglund Gambit Declined\t1. d4 e5 2. d5\nA40\tEnglund Gambit Declined: Diemer Counterattack\t1. d4 e5 2. d5 Bc5 3. e4 Qh4\nA40\tEnglund Gambit Declined: Reversed Alekhine\t1. d4 e5 2. Nf3\nA40\tEnglund Gambit Declined: Reversed Brooklyn\t1. d4 e5 2. Nf3 e4 3. Ng1\nA40\tEnglund Gambit Declined: Reversed French\t1. d4 e5 2. e3\nA40\tEnglund Gambit Declined: Reversed Krebs\t1. d4 e5 2. Nf3 e4\nA40\tEnglund Gambit Declined: Reversed Mokele Mbembe\t1. d4 e5 2. Nf3 e4 3. Ne5\nA40\tEnglund Gambit: Felbecker Gambit\t1. d4 e5 2. dxe5 Nc6 3. Nf3 Bc5\nA40\tEnglund Gambit: Hartlaub-Charlick Gambit\t1. d4 e5 2. dxe5 d6\nA40\tEnglund Gambit: Main Line\t1. d4 e5 2. dxe5 Nc6 3. Nf3 Qe7\nA40\tEnglund Gambit: Mosquito Gambit\t1. d4 e5 2. dxe5 Qh4\nA40\tEnglund Gambit: Soller Gambit\t1. d4 e5 2. dxe5 f6\nA40\tEnglund Gambit: Soller Gambit Deferred\t1. d4 e5 2. dxe5 Nc6 3. Nf3 f6\nA40\tEnglund Gambit: Stockholm Variation\t1. d4 e5 2. dxe5 Nc6 3. Nf3 Qe7 4. Qd5\nA40\tEnglund Gambit: Zilbermints Gambit\t1. d4 e5 2. dxe5 Nc6 3. Nf3 Nge7\nA40\tHorwitz Defense\t1. d4 e6\nA40\tHorwitz Defense: Zilbermints Gambit\t1. d4 e6 2. c4 e5\nA40\tKangaroo Defense\t1. d4 e6 2. c4 Bb4+\nA40\tKangaroo Defense: Keres Defense, Transpositional Variation\t1. d4 e6 2. c4 Bb4+ 3. Nc3\nA40\tMikenas Defense\t1. d4 Nc6\nA40\tMikenas Defense: Cannstatter Variation\t1. d4 Nc6 2. c4 e5 3. d5 Nd4\nA40\tMikenas Defense: Lithuanian Variation\t1. d4 Nc6 2. c4 e5 3. d5 Nce7\nA40\tMikenas Defense: Pozarek Gambit\t1. d4 Nc6 2. c4 e5 3. dxe5 Nxe5 4. Nc3 Nxc4\nA40\tModern Defense: Lizard Defense, Pirc-Diemer Gambit\t1. d4 g6 2. h4 Nf6 3. h5\nA40\tMontevideo Defense\t1. d4 Nc6 2. d5 Nb8\nA40\tPolish Defense\t1. d4 b5\nA40\tPolish Defense: Spassky Gambit Accepted\t1. d4 b5 2. e4 Bb7 3. Bxb5\nA40\tPterodactyl Defense: Central, Benoni Pterodactyl\t1. d4 g6 2. c4 Bg7 3. e4 c5 4. d5 Qa5+\nA40\tPterodactyl Defense: Fianchetto, Queen Benoni Pterodactyl\t1. d4 g6 2. c4 Bg7 3. Nc3 c5 4. d5 Qa5\nA40\tPterodactyl Defense: Fianchetto, Queen Pterodactyl\t1. d4 g6 2. Nf3 Bg7 3. g3 c5 4. Bg2 Qa5+\nA40\tPterodactyl Defense: Queen Pterodactyl, Quiet Line\t1. d4 g6 2. c4 Bg7 3. Nc3 c5 4. e3\nA40\tQueen's Pawn Game\t1. d4\nA40\tQueen's Pawn Game: Anglo-Slav Opening\t1. d4 c6 2. c4 d6\nA40\tQueen's Pawn Game: Modern Defense\t1. d4 g6\nA40\tSlav Indian: Kudischewitsch Gambit\t1. d4 c6 2. Nf3 Nf6 3. c4 b5\nA40\tZaire Defense\t1. d4 Nc6 2. d5 Nb8 3. e4 Nf6 4. e5 Ng8\nA41\tModern Defense\t1. d4 g6 2. c4 Bg7 3. Nc3 d6\nA41\tModern Defense: Neo-Modern Defense\t1. d4 g6 2. c4 Bg7 3. e4 e5\nA41\tOld Indian Defense\t1. d4 d6 2. c4\nA41\tQueen's Pawn Game\t1. d4 d6\nA41\tRat Defense: English Rat\t1. d4 d6 2. c4 e5\nA41\tRat Defense: English Rat, Lisbon Gambit\t1. d4 d6 2. c4 e5 3. dxe5 Nc6\nA41\tRat Defense: English Rat, Pounds Gambit\t1. d4 d6 2. c4 e5 3. dxe5 Be6\nA41\tRobatsch Defense\t1. d4 d6 2. Nf3 g6 3. c4 Bg7 4. e4 Bg4\nA41\tWade Defense\t1. d4 d6 2. Nf3 Bg4\nA41\tZukertort Opening: Wade Defense, Chigorin Plan\t1. d4 d6 2. Nf3 Bg4 3. c4 Nd7 4. Qb3 Rb8\nA42\tModern Defense: Averbakh System\t1. d4 g6 2. c4 Bg7 3. Nc3 d6 4. e4\nA42\tModern Defense: Kotov Variation\t1. d4 g6 2. c4 Bg7 3. Nc3 d6 4. e4 Nc6\nA42\tModern Defense: Randspringer Variation\t1. d4 g6 2. c4 Bg7 3. Nc3 d6 4. e4 f5\nA43\tBenoni Defense: Benoni Gambit Accepted\t1. d4 c5 2. dxc5\nA43\tBenoni Defense: Benoni Gambit, Schlenker Defense\t1. d4 c5 2. dxc5 Na6\nA43\tBenoni Defense: Benoni-Indian Defense\t1. d4 c5 2. d5 Nf6\nA43\tBenoni Defense: Benoni-Indian Defense, Kingside Move Order\t1. d4 c5 2. d5 Nf6 3. Nf3\nA43\tBenoni Defense: Benoni-Staunton Gambit\t1. d4 c5 2. d5 f5 3. e4\nA43\tBenoni Defense: Cormorant Gambit\t1. d4 c5 2. dxc5 b6\nA43\tBenoni Defense: French Benoni\t1. e4 e6 2. d4 c5 3. d5\nA43\tBenoni Defense: Hawk Variation\t1. d4 Nf6 2. Nf3 c5 3. d5 c4\nA43\tBenoni Defense: Old Benoni\t1. d4 c5\nA43\tBenoni Defense: Old Benoni\t1. d4 c5 2. d5\nA43\tBenoni Defense: Old Benoni\t1. d4 c5 2. d5 d6\nA43\tBenoni Defense: Old Benoni, Mujannah Formation\t1. d4 c5 2. d5 f5\nA43\tBenoni Defense: Old Benoni, Schmid Variation\t1. d4 c5 2. d5 d6 3. Nc3 g6\nA43\tBenoni Defense: Snail Variation\t1. d4 c5 2. d5 Na6\nA43\tBenoni Defense: Woozle\t1. d4 c5 2. d5 Nf6 3. Nc3 Qa5\nA43\tBenoni Defense: Zilbermints-Benoni Gambit\t1. d4 c5 2. b4\nA43\tBenoni Defense: Zilbermints-Benoni Gambit\t1. d4 c5 2. Nf3 cxd4 3. b4\nA43\tBenoni Defense: Zilbermints-Benoni Gambit, Tamarkin Countergambit\t1. d4 c5 2. Nf3 cxd4 3. b4 e5\nA43\tIndian Defense: Pseudo-Benko\t1. d4 Nf6 2. Nf3 c5 3. d5 b5\nA43\tQueen's Pawn Game: Liedmann Gambit\t1. d4 c5 2. c4 cxd4 3. e3\nA44\tBenoni Defense: Old Benoni\t1. d4 c5 2. d5 e5\nA44\tBenoni Defense: Semi-Benoni\t1. d4 c5 2. d5 e5 3. e4 d6\nA45\tAmazon Attack: Siberian Attack\t1. d4 Nf6 2. Nc3 d5 3. Qd3\nA45\tCanard Opening\t1. d4 Nf6 2. f4\nA45\tIndian Defense\t1. d4 Nf6\nA45\tIndian Defense: Accelerated London System\t1. d4 Nf6 2. Bf4\nA45\tIndian Defense: Gedult Attack\t1. d4 Nf6 2. f3 d5 3. g4\nA45\tIndian Defense: Gibbins-Weidenhagen Gambit\t1. d4 Nf6 2. g4\nA45\tIndian Defense: Gibbins-Weidenhagen Gambit Accepted\t1. d4 Nf6 2. g4 Nxg4\nA45\tIndian Defense: Gibbins-Weidenhagen Gambit, Maltese Falcon\t1. d4 Nf6 2. g4 Nxg4 3. f3 Nf6 4. e4\nA45\tIndian Defense: Gibbins-Weidenhagen Gambit, Oshima Defense\t1. d4 Nf6 2. g4 e5\nA45\tIndian Defense: Lazard Gambit\t1. d4 Nf6 2. Nd2 e5\nA45\tIndian Defense: Maddigan Gambit\t1. d4 Nf6 2. Nc3 e5\nA45\tIndian Defense: Omega Gambit\t1. d4 Nf6 2. e4\nA45\tIndian Defense: Omega Gambit, Arafat Gambit\t1. d4 Nf6 2. e4 Nxe4 3. Bd3 Nf6 4. Bg5\nA45\tIndian Defense: Paleface Attack, Blackmar-Diemer Gambit Deferred\t1. d4 Nf6 2. f3 d5 3. e4\nA45\tIndian Defense: Pawn Push Variation\t1. d4 Nf6 2. d5\nA45\tIndian Defense: Reversed Chigorin Defense\t1. d4 Nf6 2. Nc3 c5\nA45\tIndian Defense: Tartakower Attack\t1. d4 Nf6 2. g3\nA45\tPaleface Attack\t1. d4 Nf6 2. f3\nA45\tQueen's Pawn Game: Chigorin Variation\t1. d4 Nf6 2. Nc3 d5\nA45\tQueen's Pawn Game: Veresov, Richter Attack\t1. d4 Nf6 2. f3 d5 3. Nc3\nA45\tTrompowsky Attack\t1. d4 Nf6 2. Bg5\nA45\tTrompowsky Attack: Borg Variation\t1. d4 Nf6 2. Bg5 Ne4 3. Bf4 g5\nA45\tTrompowsky Attack: Classical Defense\t1. d4 Nf6 2. Bg5 e6\nA45\tTrompowsky Attack: Classical Defense, Big Center Variation\t1. d4 Nf6 2. Bg5 e6 3. e4\nA45\tTrompowsky Attack: Edge Variation\t1. d4 Nf6 2. Bg5 Ne4 3. Bh4\nA45\tTrompowsky Attack: Poisoned Pawn Variation\t1. d4 Nf6 2. Bg5 c5 3. d5 Qb6 4. Nc3\nA45\tTrompowsky Attack: Raptor Variation\t1. d4 Nf6 2. Bg5 Ne4 3. h4\nA45\tTrompowsky Attack: Raptor Variation, Hergert Gambit\t1. d4 Nf6 2. Bg5 Ne4 3. h4 Nxg5 4. hxg5 e5\nA46\tD\u00f6ry Defense\t1. d4 Nf6 2. Nf3 Ne4\nA46\tIndian Defense: Czech-Indian\t1. d4 Nf6 2. Nf3 c6\nA46\tIndian Defense: Knights Variation\t1. d4 Nf6 2. Nf3\nA46\tIndian Defense: Knights Variation, Alburt-Miles Variation\t1. d4 Nf6 2. Nf3 a6\nA46\tIndian Defense: London System\t1. d4 Nf6 2. Nf3 e6 3. Bf4\nA46\tIndian Defense: Polish Variation\t1. d4 Nf6 2. Nf3 b5\nA46\tIndian Defense: Spielmann-Indian\t1. d4 Nf6 2. Nf3 c5\nA46\tIndian Defense: Wade-Tartakower Defense\t1. d4 Nf6 2. Nf3 d6\nA46\tQueen's Pawn Game: Veresov Attack, Classical Defense\t1. d4 Nf6 2. Nf3 e6 3. Nc3 d5 4. Bg5\nA46\tTorre Attack: Classical Defense\t1. d4 Nf6 2. Nf3 e6 3. Bg5\nA46\tTorre Attack: Classical Defense, Nimzowitsch Variation\t1. d4 Nf6 2. Nf3 e6 3. Bg5 h6\nA46\tTorre Attack: Wagner Gambit\t1. d4 Nf6 2. Nf3 e6 3. Bg5 c5 4. e4\nA46\tYusupov-Rubinstein System\t1. d4 Nf6 2. Nf3 e6 3. e3\nA47\tIndian Defense: Schnepper Gambit\t1. d4 Nf6 2. Nf3 b6 3. c3 e5\nA47\tMarienbad System\t1. d4 Nf6 2. Nf3 b6 3. g3 Bb7 4. Bg2 c5\nA47\tPseudo Queen's Indian Defense\t1. d4 Nf6 2. Nf3 b6\nA48\tEast Indian Defense\t1. d4 Nf6 2. Nf3 g6\nA48\tIndian Defense: Colle System, King's Indian Variation\t1. d4 Nf6 2. Nf3 g6 3. e3 Bg7 4. Bd3 d6\nA48\tLondon System\t1. d4 Nf6 2. Nf3 g6 3. Bf4\nA48\tLondon System\t1. d4 Nf6 2. Nf3 g6 3. Bf4 Bg7 4. e3\nA48\tLondon System\t1. d4 Nf6 2. Nf3 g6 3. Bf4 Bg7 4. e3 d6\nA48\tQueen's Pawn Game: Barry Attack\t1. d4 Nf6 2. Nf3 g6 3. Nc3 d5 4. Bf4\nA48\tQueen's Pawn Game: Barry Attack\t1. d4 Nf6 2. Nf3 g6 3. Nc3 d5 4. Bf4 Bg7\nA48\tTorre Attack: Fianchetto Defense\t1. d4 Nf6 2. Nf3 g6 3. Bg5\nA48\tTorre Attack: Fianchetto Defense, Euwe Variation\t1. d4 Nf6 2. Nf3 g6 3. Bg5 Bg7 4. Nbd2 c5\nA49\tIndian Defense: Przepiorka Variation\t1. d4 Nf6 2. Nf3 g6 3. g3\nA50\tIndian Defense: Medusa Gambit\t1. d4 Nf6 2. c4 g5\nA50\tIndian Defense: Normal Variation\t1. d4 Nf6 2. c4\nA50\tIndian Defense: Pyrenees Gambit\t1. d4 Nf6 2. c4 b5\nA50\tMexican Defense\t1. d4 Nf6 2. c4 Nc6\nA50\tMexican Defense: Horsefly Gambit\t1. d4 Nf6 2. c4 Nc6 3. d5 Ne5 4. f4\nA50\tQueen's Indian Accelerated\t1. d4 Nf6 2. c4 b6\nA50\tSlav Indian\t1. d4 Nf6 2. c4 c6\nA51\tIndian Defense: Budapest Gambit\t1. d4 Nf6 2. c4 e5\nA51\tIndian Defense: Budapest Gambit Accepted\t1. d4 Nf6 2. c4 e5 3. dxe5\nA51\tIndian Defense: Budapest Gambit Accepted, Fajarowicz Defense\t1. d4 Nf6 2. c4 e5 3. dxe5 Ne4\nA51\tIndian Defense: Budapest Gambit Accepted, Fajarowicz Defense, Bonsdorf Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ne4 4. a3\nA51\tIndian Defense: Budapest Gambit Accepted, Fajarowicz Defense, Steiner Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ne4 4. Qc2\nA52\tIndian Defense: Budapest Gambit Accepted, Main Line\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4\nA52\tIndian Defense: Budapest Gambit Accepted, Main Line, Adler Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4 4. Nf3\nA52\tIndian Defense: Budapest Gambit Accepted, Main Line, Alekhine Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4 4. e4\nA52\tIndian Defense: Budapest Gambit Accepted, Main Line, Alekhine Variation, Abonyi Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4 4. e4 Nxe5\nA52\tIndian Defense: Budapest Gambit Accepted, Main Line, Alekhine Variation, Tartakower Defense\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4 4. e4 d6\nA52\tIndian Defense: Budapest Gambit Accepted, Main Line, Rubinstein Variation\t1. d4 Nf6 2. c4 e5 3. dxe5 Ng4 4. Bf4\nA53\tOld Indian Defense\t1. d4 Nf6 2. c4 d6\nA53\tOld Indian Defense: Aged Gibbon Gambit\t1. d4 Nf6 2. c4 d6 3. g4\nA53\tOld Indian Defense: Czech Variation, with Nc3\t1. d4 Nf6 2. c4 d6 3. Nc3 c6\nA53\tOld Indian Defense: Czech Variation, with Nf3\t1. d4 Nf6 2. c4 d6 3. Nf3 c6\nA53\tOld Indian Defense: Janowski Variation\t1. d4 Nf6 2. c4 d6 3. Nc3 Bf5\nA53\tOld Indian Defense: Janowski Variation, Fianchetto Variation\t1. d4 Nf6 2. c4 d6 3. Nc3 Bf5 4. g3\nA53\tOld Indian Defense: Janowski Variation, Grinberg Gambit\t1. d4 Nf6 2. c4 d6 3. Nc3 Bf5 4. e4\nA53\tOld Indian Defense: Janowski Variation, Main Line\t1. d4 Nf6 2. c4 d6 3. Nc3 Bf5 4. f3\nA54\tOld Indian Defense: Tartakower-Indian\t1. d4 Nf6 2. c4 d6 3. Nf3 Bg4\nA54\tOld Indian Defense: Two Knights Variation\t1. d4 Nf6 2. c4 d6 3. Nc3 e5 4. Nf3\nA54\tOld Indian Defense: Ukrainian Variation\t1. d4 Nf6 2. c4 d6 3. Nc3 e5\nA56\tBenoni Defense\t1. d4 Nf6 2. c4 c5\nA56\tBenoni Defense: Czech Benoni Defense\t1. d4 Nf6 2. c4 c5 3. d5 e5\nA56\tBenoni Defense: Hrom\u00e1dka System\t1. d4 Nf6 2. c4 c5 3. d5 d6\nA56\tBenoni Defense: Weenink Variation\t1. d4 Nf6 2. c4 c5 3. dxc5 e6\nA56\tVulture Defense\t1. d4 Nf6 2. c4 c5 3. d5 Ne4\nA57\tBenko Gambit\t1. d4 Nf6 2. c4 c5 3. d5 b5\nA57\tBenko Gambit Accepted\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. cxb5 a6\nA57\tBenko Gambit Declined: Bishop Attack\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. Bg5\nA57\tBenko Gambit Declined: Hj\u00f8rring Countergambit\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. e4\nA57\tBenko Gambit Declined: Main Line\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. Nf3\nA57\tBenko Gambit Declined: Pseudo-S\u00e4misch\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. f3\nA57\tBenko Gambit Declined: Quiet Line\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. Nd2\nA57\tBenko Gambit Declined: Sosonko Variation\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. a4\nA57\tBenko Gambit: Mutkin Countergambit\t1. d4 Nf6 2. c4 c5 3. d5 b5 4. g4\nA60\tBenoni Defense: Modern Variation\t1. d4 Nf6 2. c4 c5 3. d5 e6\nA80\tDutch Defense\t1. d4 f5\nA80\tDutch Defense: Alapin Variation\t1. d4 f5 2. Qd3\nA80\tDutch Defense: Hevendehl Gambit\t1. d4 f5 2. g4 e5\nA80\tDutch Defense: Hopton Attack\t1. d4 f5 2. Bg5\nA80\tDutch Defense: Janzen-Korchnoi Gambit\t1. d4 f5 2. h3 Nf6 3. g4\nA80\tDutch Defense: Kingfisher Gambit\t1. d4 f5 2. Nc3 d5 3. e4\nA80\tDutch Defense: Korchnoi Attack\t1. d4 f5 2. h3\nA80\tDutch Defense: Krejcik Gambit\t1. d4 f5 2. g4\nA80\tDutch Defense: Krejcik Gambit, Tate Gambit\t1. d4 f5 2. g4 fxg4 3. e4 d5 4. Nc3\nA80\tDutch Defense: Manhattan Gambit, Anti-Classical Line\t1. d4 f5 2. Qd3 e6 3. g4\nA80\tDutch Defense: Manhattan Gambit, Anti-Leningrad\t1. d4 f5 2. Qd3 g6 3. g4\nA80\tDutch Defense: Manhattan Gambit, Anti-Modern\t1. d4 f5 2. Qd3 d6 3. g4\nA80\tDutch Defense: Manhattan Gambit, Anti-Stonewall\t1. d4 f5 2. Qd3 d5 3. g4\nA80\tDutch Defense: Omega-Isis Gambit\t1. d4 f5 2. Nf3 e5\nA80\tDutch Defense: Raphael Variation\t1. d4 f5 2. Nc3\nA80\tDutch Defense: Senechaud Gambit\t1. d4 f5 2. Bf4 e6 3. g4\nA80\tDutch Defense: Spielmann Gambit\t1. d4 f5 2. Nc3 Nf6 3. g4\nA80\tQueen's Pawn Game: Veresov Attack, Dutch System\t1. d4 f5 2. Nc3 d5\nA81\tDutch Defense: Blackburne Variation\t1. d4 f5 2. g3 Nf6 3. Bg2 e6 4. Nh3\nA81\tDutch Defense: Fianchetto Attack\t1. d4 f5 2. g3\nA81\tDutch Defense: Leningrad Variation, Carlsbad Variation\t1. d4 f5 2. g3 g6 3. Bg2 Bg7 4. Nh3\nA81\tDutch Defense: Semi-Leningrad Variation\t1. d4 f5 2. g3 Nf6 3. Bg2 g6\nA82\tDutch Defense: Blackmar's Second Gambit\t1. d4 f5 2. e4 fxe4 3. Nc3 Nf6 4. f3\nA82\tDutch Defense: Staunton Gambit\t1. d4 f5 2. e4\nA82\tDutch Defense: Staunton Gambit Accepted\t1. d4 f5 2. e4 fxe4\nA82\tDutch Defense: Staunton Gambit, American Attack\t1. d4 f5 2. e4 fxe4 3. Nd2\nA82\tDutch Defense: Staunton Gambit, Tartakower Variation\t1. d4 f5 2. e4 fxe4 3. Nc3 Nf6 4. g4\nA82\tRat Defense: Balogh Defense\t1. e4 d6 2. d4 f5\nA83\tDutch Defense: Staunton Gambit\t1. d4 f5 2. e4 fxe4 3. Nc3 Nf6 4. Bg5\nA83\tDutch Defense: Staunton Gambit, Chigorin Variation\t1. d4 f5 2. e4 fxe4 3. Nc3 Nf6 4. Bg5 c6\nA83\tDutch Defense: Staunton Gambit, Nimzowitsch Variation\t1. d4 f5 2. e4 fxe4 3. Nc3 Nf6 4. Bg5 b6\nA84\tDutch Defense\t1. d4 f5 2. c4\nA84\tDutch Defense: Bellon Gambit\t1. d4 f5 2. c4 e6 3. e4\nA84\tDutch Defense: Bladel Variation\t1. d4 f5 2. c4 g6 3. Nc3 Nh6\nA84\tDutch Defense: Classical Variation\t1. d4 f5 2. c4 e6\nA84\tDutch Defense: Krause Variation\t1. d4 f5 2. c4 Nf6 3. Nc3 d6 4. Nf3 Nc6\nA84\tDutch Defense: Normal Variation\t1. d4 f5 2. c4 Nf6\nA84\tDutch Defense: Rubinstein Variation\t1. d4 f5 2. c4 e6 3. Nc3\nA85\tDutch Defense: Queen's Knight Variation\t1. d4 f5 2. c4 Nf6 3. Nc3\nA86\tDutch Defense: Fianchetto Variation\t1. d4 f5 2. c4 Nf6 3. g3\nA86\tDutch Defense: Leningrad Variation\t1. d4 f5 2. c4 Nf6 3. g3 g6\nA90\tDutch Defense: Classical Variation\t1. d4 f5 2. c4 Nf6 3. g3 e6 4. Bg2\nA90\tDutch Defense: Nimzo-Dutch Variation\t1. d4 f5 2. c4 Nf6 3. g3 e6 4. Bg2 Bb4+\nA91\tDutch Defense: Classical Variation\t1. d4 f5 2. c4 Nf6 3. g3 e6 4. Bg2 Be7\nB00\tBarnes Defense\t1. e4 f6\nB00\tBorg Defense\t1. e4 g5\nB00\tBorg Defense: Borg Gambit\t1. e4 g5 2. d4 Bg7\nB00\tBorg Defense: Troon Gambit\t1. e4 g5 2. d4 h6 3. h4 g4\nB00\tBorg Defense: Zilbermints Gambit\t1. e4 g5 2. d4 e5\nB00\tCarr Defense\t1. e4 h6\nB00\tCarr Defense: Zilbermints Gambit\t1. e4 h6 2. d4 e5\nB00\tDuras Gambit\t1. e4 f5\nB00\tFried Fox Defense\t1. e4 f6 2. d4 Kf7\nB00\tGoldsmith Defense\t1. e4 h5\nB00\tGoldsmith Defense: Picklepuss Defense\t1. e4 h5 2. d4 Nf6\nB00\tHippopotamus Defense\t1. e4 Nh6\nB00\tHippopotamus Defense\t1. e4 Nh6 2. d4 g6 3. c4 f6\nB00\tKing's Pawn Game\t1. e4\nB00\tLemming Defense\t1. e4 Na6\nB00\tLion Defense: Lion's Jaw\t1. e4 d6 2. d4 Nf6 3. f3\nB00\tNimzowitsch Defense\t1. e4 Nc6\nB00\tNimzowitsch Defense\t1. e4 Nc6 2. d4\nB00\tNimzowitsch Defense: Breyer Variation\t1. e4 Nc6 2. Nc3 Nf6 3. d4 e5\nB00\tNimzowitsch Defense: Colorado Countergambit\t1. e4 Nc6 2. Nf3 f5\nB00\tNimzowitsch Defense: Colorado Countergambit Accepted\t1. e4 Nc6 2. Nf3 f5 3. exf5\nB00\tNimzowitsch Defense: Declined Variation\t1. e4 Nc6 2. Nf3\nB00\tNimzowitsch Defense: El Columpio Defense\t1. e4 Nc6 2. Nf3 Nf6 3. e5 Ng4\nB00\tNimzowitsch Defense: Franco-Nimzowitsch Variation\t1. e4 Nc6 2. Nf3 e6\nB00\tNimzowitsch Defense: French Connection\t1. e4 Nc6 2. Nc3 e6\nB00\tNimzowitsch Defense: Hornung Gambit\t1. e4 Nc6 2. d4 d5 3. Be3\nB00\tNimzowitsch Defense: Kennedy Variation\t1. e4 Nc6 2. d4 e5\nB00\tNimzowitsch Defense: Kennedy Variation, Bielefelder Gambit\t1. e4 Nc6 2. d4 e5 3. dxe5 Bc5\nB00\tNimzowitsch Defense: Kennedy Variation, Hammer Gambit\t1. e4 Nc6 2. d4 e5 3. dxe5 f6\nB00\tNimzowitsch Defense: Kennedy Variation, Herford Gambit\t1. e4 Nc6 2. d4 e5 3. dxe5 Qh4\nB00\tNimzowitsch Defense: Kennedy Variation, Keres Attack\t1. e4 Nc6 2. d4 e5 3. dxe5 Nxe5 4. Nc3\nB00\tNimzowitsch Defense: Kennedy Variation, Linksspringer Variation\t1. e4 Nc6 2. d4 e5 3. d5\nB00\tNimzowitsch Defense: Kennedy Variation, Main Line\t1. e4 Nc6 2. d4 e5 3. dxe5 Nxe5 4. f4 Ng6\nB00\tNimzowitsch Defense: Kennedy Variation, Paulsen Attack\t1. e4 Nc6 2. d4 e5 3. dxe5 Nxe5 4. Nf3\nB00\tNimzowitsch Defense: Kennedy Variation, Riemann Defense\t1. e4 Nc6 2. d4 e5 3. dxe5 Nxe5 4. f4 Nc6\nB00\tNimzowitsch Defense: Kennedy Variation, de Smet Gambit\t1. e4 Nc6 2. d4 e5 3. dxe5 d6\nB00\tNimzowitsch Defense: Mikenas Variation\t1. e4 Nc6 2. d4 d6\nB00\tNimzowitsch Defense: Neo-Mongoloid Defense\t1. e4 Nc6 2. d4 f6\nB00\tNimzowitsch Defense: Pirc Connection\t1. e4 Nc6 2. Nc3 g6\nB00\tNimzowitsch Defense: Pseudo-Spanish Variation\t1. e4 Nc6 2. Bb5\nB00\tNimzowitsch Defense: Scandinavian Variation\t1. e4 Nc6 2. d4 d5\nB00\tNimzowitsch Defense: Scandinavian Variation, Aachen Gambit\t1. e4 Nc6 2. d4 d5 3. exd5 Nb4\nB00\tNimzowitsch Defense: Scandinavian Variation, Advance Variation\t1. e4 Nc6 2. d4 d5 3. e5\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation\t1. e4 Nc6 2. d4 d5 3. Nc3\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation\t1. e4 Nc6 2. d4 d5 3. Nc3 dxe4\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation, Brandics Gambit\t1. e4 Nc6 2. d4 d5 3. Nc3 a6\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation, Erben Gambit\t1. e4 Nc6 2. d4 d5 3. Nc3 g6\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation, Heinola-Deppe Gambit\t1. e4 Nc6 2. d4 d5 3. Nc3 e5\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation, Nimzowitsch Gambit\t1. e4 Nc6 2. d4 d5 3. Nc3 dxe4 4. d5 Ne5\nB00\tNimzowitsch Defense: Scandinavian Variation, Bogoljubow Variation, Vehre Variation\t1. e4 Nc6 2. d4 d5 3. Nc3 Nf6\nB00\tNimzowitsch Defense: Scandinavian Variation, Exchange Variation\t1. e4 Nc6 2. d4 d5 3. exd5 Qxd5\nB00\tNimzowitsch Defense: Scandinavian Variation, Exchange Variation, Marshall Gambit\t1. e4 Nc6 2. d4 d5 3. exd5 Qxd5 4. Nc3\nB00\tNimzowitsch Defense: Wheeler Gambit\t1. e4 Nc6 2. b4\nB00\tNimzowitsch Defense: Williams Variation\t1. e4 Nc6 2. Nf3 d6\nB00\tNimzowitsch Defense: Woodchuck Variation\t1. e4 Nc6 2. d4 a6\nB00\tOwen Defense\t1. e4 b6\nB00\tOwen Defense: Guatemala Defense\t1. e4 b6 2. d4 Ba6\nB00\tOwen Defense: Hekili-Loa Gambit\t1. e4 b6 2. d4 c5 3. dxc5 Nc6\nB00\tOwen Defense: Naselwaus Gambit\t1. e4 b6 2. d4 Bb7 3. Bg5\nB00\tOwen Defense: Smith Gambit\t1. e4 b6 2. d4 Bb7 3. Nf3\nB00\tOwen Defense: Unicorn Variation\t1. e4 f6 2. d4 b6 3. c4 Bb7\nB00\tOwen Defense: Wind Gambit\t1. e4 b6 2. d4 Bb7 3. f3 e5\nB00\tPirc Defense\t1. e4 d6\nB00\tPirc Defense\t1. e4 d6 2. d4\nB00\tPirc Defense\t1. e4 d6 2. d4 Nf6\nB00\tPirc Defense: Roscher Gambit\t1. e4 d6 2. d4 Nf6 3. Nf3\nB00\tRat Defense: Antal Defense\t1. e4 d6 2. d4 Nd7\nB00\tRat Defense: Fuller Gambit\t1. e4 d6 2. f4 d5 3. exd5 Nf6\nB00\tRat Defense: Harmonist\t1. e4 d6 2. f4\nB00\tRat Defense: Petruccioli Attack\t1. e4 d6 2. h4\nB00\tRat Defense: Spike Attack\t1. e4 d6 2. g4\nB00\tSt. George Defense\t1. e4 a6\nB00\tSt. George Defense: Polish Variation\t1. e4 a6 2. d4 b5 3. Nf3 Bb7 4. Bd3 e6\nB00\tSt. George Defense: Zilbermints Gambit\t1. e4 a6 2. d4 e5\nB00\tVan Geet Opening: Berlin Gambit\t1. e4 Nc6 2. d4 d5 3. Nc3 dxe4 4. d5\nB00\tWare Defense\t1. e4 a5\nB00\tWare Defense: Snagglepuss Defense\t1. e4 a5 2. d4 Nc6\nB01\tScandinavian Defense\t1. e4 d5\nB01\tScandinavian Defense\t1. e4 d5 2. b3\nB01\tScandinavian Defense: Anderssen Counterattack\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 e5\nB01\tScandinavian Defense: Blackburne Gambit\t1. e4 d5 2. exd5 c6 3. dxc6 Nxc6\nB01\tScandinavian Defense: Blackburne-Kloosterboer Gambit\t1. e4 d5 2. exd5 c6\nB01\tScandinavian Defense: Boehnke Gambit\t1. e4 d5 2. exd5 e5 3. dxe6 Bxe6\nB01\tScandinavian Defense: Gubinsky-Melts Defense\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qd6\nB01\tScandinavian Defense: Icelandic-Palme Gambit\t1. e4 d5 2. exd5 Nf6 3. c4 e6\nB01\tScandinavian Defense: Kiel Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Nxd5 4. c4 Nb4\nB01\tScandinavian Defense: Kloosterboer Gambit\t1. e4 d5 2. exd5 c6 3. dxc6 e5\nB01\tScandinavian Defense: K\u00e1das Gambit\t1. e4 d5 2. exd5 Nf6 3. d4 c6 4. dxc6 e5\nB01\tScandinavian Defense: Main Line\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5\nB01\tScandinavian Defense: Main Line, Leonhardt Gambit\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. b4\nB01\tScandinavian Defense: Main Line, Mieses Variation\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. d4 Nf6\nB01\tScandinavian Defense: Marshall Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Nxd5\nB01\tScandinavian Defense: Mieses-Kotroc Variation\t1. e4 d5 2. exd5 Qxd5\nB01\tScandinavian Defense: Modern Variation\t1. e4 d5 2. exd5 Nf6\nB01\tScandinavian Defense: Modern Variation\t1. e4 d5 2. exd5 Nf6 3. d4\nB01\tScandinavian Defense: Modern Variation, Gipslis Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Nxd5 4. Nf3 Bg4\nB01\tScandinavian Defense: Modern Variation, Wing Gambit\t1. e4 d5 2. exd5 Nf6 3. d4 g6 4. c4 b5\nB01\tScandinavian Defense: Panov Transfer\t1. e4 d5 2. exd5 Nf6 3. c4 c6\nB01\tScandinavian Defense: Portuguese Gambit\t1. e4 d5 2. exd5 Nf6 3. d4 Bg4\nB01\tScandinavian Defense: Portuguese Gambit, Classical Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Bg4 4. Nf3\nB01\tScandinavian Defense: Portuguese Gambit, Elbow Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Bg4 4. Bb5+ c6\nB01\tScandinavian Defense: Portuguese Gambit, Wuss Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Bg4 4. Be2\nB01\tScandinavian Defense: Richter Variation\t1. e4 d5 2. exd5 Nf6 3. d4 Nxd5 4. Nf3 g6\nB01\tScandinavian Defense: Richter Variation\t1. e4 d5 2. exd5 Nf6 3. d4 g6\nB01\tScandinavian Defense: Schiller-Pytel Variation\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qd6 4. d4 c6\nB01\tScandinavian Defense: Valencian Variation\t1. e4 d5 2. exd5 Qxd5 3. Nc3 Qd8\nB01\tScandinavian Defense: Zilbermints Gambit\t1. e4 d5 2. b4\nB01\tVan Geet Opening: Gr\u00fcnfeld Defense\t1. e4 d5 2. Nc3 dxe4 3. Nxe4 e5\nB02\tAlekhine Defense\t1. e4 Nf6\nB02\tAlekhine Defense: Brooklyn Variation\t1. e4 Nf6 2. e5 Ng8\nB02\tAlekhine Defense: Brooklyn Variation, Everglades Variation\t1. e4 Nf6 2. e5 Ng8 3. d4 f5\nB02\tAlekhine Defense: Buckley Attack\t1. e4 Nf6 2. e5 Nd5 3. Na3\nB02\tAlekhine Defense: Krejcik Variation\t1. e4 Nf6 2. Bc4\nB02\tAlekhine Defense: Krejcik Variation, Krejcik Gambit\t1. e4 Nf6 2. Bc4 Nxe4 3. Bxf7+\nB02\tAlekhine Defense: Mar\u00f3czy Variation\t1. e4 Nf6 2. d3\nB02\tAlekhine Defense: Mokele Mbembe\t1. e4 Nf6 2. e5 Ne4\nB02\tAlekhine Defense: Mokele Mbembe, Modern Line\t1. e4 Nf6 2. e5 Ne4 3. d4 f6\nB02\tAlekhine Defense: Mokele Mbembe, Vavra Defense\t1. e4 Nf6 2. e5 Ne4 3. d4 e6\nB02\tAlekhine Defense: Normal Variation\t1. e4 Nf6 2. e5 Nd5\nB02\tAlekhine Defense: Scandinavian Variation\t1. e4 Nf6 2. Nc3 d5\nB02\tAlekhine Defense: Scandinavian Variation, Geschev Gambit\t1. e4 Nf6 2. Nc3 d5 3. exd5 c6\nB02\tAlekhine Defense: Scandinavian Variation, Myers Gambit\t1. e4 Nf6 2. Nc3 d5 3. d3 dxe4 4. Bg5\nB02\tAlekhine Defense: Spielmann Gambit\t1. e4 Nf6 2. Nc3 d5 3. e5 Nfd7 4. e6\nB02\tAlekhine Defense: Steiner Variation\t1. e4 Nf6 2. e5 Nd5 3. c4 Nb6 4. b3\nB02\tAlekhine Defense: S\u00e4misch Attack\t1. e4 Nf6 2. e5 Nd5 3. Nc3\nB02\tAlekhine Defense: The Squirrel\t1. e4 Nf6 2. e5 Nd5 3. c4 Nf4\nB02\tAlekhine Defense: Two Pawns Attack\t1. e4 Nf6 2. e5 Nd5 3. c4\nB02\tAlekhine Defense: Two Pawns Attack, Lasker Variation\t1. e4 Nf6 2. e5 Nd5 3. c4 Nb6 4. c5\nB02\tAlekhine Defense: Two Pawns Attack, Tate Variation\t1. e4 Nf6 2. e5 Nd5 3. c4 Nb6 4. a4\nB02\tAlekhine Defense: Welling Variation\t1. e4 Nf6 2. e5 Nd5 3. b3\nB03\tAlekhine Defense\t1. e4 Nf6 2. e5 Nd5 3. d4\nB03\tAlekhine Defense\t1. e4 Nf6 2. e5 Nd5 3. d4 d6\nB03\tAlekhine Defense\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. c4\nB03\tAlekhine Defense: Balogh Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Bc4\nB03\tAlekhine Defense: O'Sullivan Gambit\t1. e4 Nf6 2. e5 Nd5 3. d4 b5\nB04\tAlekhine Defense: Modern Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3\nB04\tAlekhine Defense: Modern Variation, Alburt Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 g6\nB04\tAlekhine Defense: Modern Variation, Larsen Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 dxe5\nB04\tAlekhine Defense: Modern Variation, Larsen-Haakert Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Nc6\nB04\tAlekhine Defense: Modern Variation, Schmid Variation\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Nb6\nB05\tAlekhine Defense: Modern Variation, Main Line\t1. e4 Nf6 2. e5 Nd5 3. d4 d6 4. Nf3 Bg4\nB06\tModern Defense\t1. e4 g6\nB06\tModern Defense\t1. e4 g6 2. d4 Bg7\nB06\tModern Defense: Bishop Attack\t1. e4 g6 2. d4 Bg7 3. Bc4\nB06\tModern Defense: Bishop Attack, B\u00fccker Gambit\t1. e4 g6 2. d4 Bg7 3. Bc4 b5\nB06\tModern Defense: Bishop Attack, Monkey's Bum\t1. e4 g6 2. Bc4 Bg7 3. Qf3 e6 4. d4 Bxd4\nB06\tModern Defense: Fianchetto Gambit\t1. e4 g6 2. d4 f5\nB06\tModern Defense: Lizard Defense, Mittenberger Gambit\t1. e4 g6 2. d4 Bg7 3. Nc3 d5\nB06\tModern Defense: Modern Pterodactyl\t1. e4 g6 2. d4 Bg7 3. Nc3 c5\nB06\tModern Defense: Mongredien Defense, with Nc3\t1. e4 g6 2. d4 Bg7 3. Nc3 b6\nB06\tModern Defense: Mongredien Defense, with Nf3\t1. e4 g6 2. d4 Bg7 3. Nf3 b6\nB06\tModern Defense: Norwegian Defense\t1. e4 g6 2. d4 Nf6\nB06\tModern Defense: Norwegian Defense, Norwegian Gambit\t1. e4 g6 2. d4 Nf6 3. e5 Nh5 4. Be2 d6\nB06\tModern Defense: Pseudo-Austrian Attack\t1. e4 g6 2. d4 Bg7 3. Nc3 d6 4. f4\nB06\tModern Defense: Standard Defense\t1. e4 g6 2. d4 Bg7 3. Nc3 d6\nB06\tModern Defense: Standard Line\t1. e4 g6 2. d4 Bg7 3. Nc3\nB06\tModern Defense: Three Pawns Attack\t1. e4 g6 2. d4 Bg7 3. f4\nB06\tModern Defense: Two Knights Variation\t1. e4 g6 2. d4 Bg7 3. Nc3 d6 4. Nf3\nB06\tModern Defense: Two Knights Variation, Suttles Variation\t1. e4 g6 2. d4 Bg7 3. Nc3 c6 4. Nf3 d6\nB06\tModern Defense: Westermann Gambit\t1. e4 g6 2. d4 Bg7 3. Bd2\nB06\tModern Defense: Wind Gambit\t1. e4 g6 2. d4 Bg7 3. Bd3\nB06\tPterodactyl Defense: Austrian, Austriadactylus Western\t1. e4 g6 2. d4 Bg7 3. f4 c5 4. Nf3 Qa5+\nB06\tPterodactyl Defense: Austrian, Grand Prix Pterodactyl\t1. e4 g6 2. Nc3 Bg7 3. f4 c5 4. Nf3 Qa5\nB06\tPterodactyl Defense: Austrian, Pteranodon\t1. e4 g6 2. d4 Bg7 3. f4 c5 4. c3 Qa5\nB06\tPterodactyl Defense: Eastern, Anhanguera\t1. e4 g6 2. d4 Bg7 3. Nc3 c5 4. Be3\nB06\tPterodactyl Defense: Eastern, Benoni\t1. d4 g6 2. e4 Bg7 3. Nc3 c5 4. d5\nB06\tPterodactyl Defense: Eastern, Benoni Pterodactyl\t1. d4 g6 2. Nc3 Bg7 3. e4 c5 4. d5 Qa5\nB06\tPterodactyl Defense: Eastern, Pterodactyl\t1. e4 g6 2. d4 Bg7 3. Nc3 c5 4. dxc5 Qa5\nB06\tPterodactyl Defense: Eastern, Rhamphorhynchus\t1. e4 g6 2. d4 Bg7 3. Nc3 c5 4. dxc5\nB06\tPterodactyl Defense: Fianchetto, King Pterodactyl\t1. e4 g6 2. d4 Bg7 3. g3 c5 4. Nf3 Qa5+\nB06\tPterodactyl Defense: Fianchetto, Rhamphorhynchus\t1. e4 g6 2. d4 Bg7 3. g3 c5 4. dxc5 Qa5+\nB06\tPterodactyl Defense: Western, Anhanguera\t1. e4 g6 2. d4 Bg7 3. Nf3 c5 4. Be3 Qa5+\nB06\tRat Defense: Accelerated Gurgenidze\t1. e4 g6 2. d4 d6 3. Nc3 c6\nB07\tCzech Defense\t1. e4 d6 2. d4 Nf6 3. Nc3 c6\nB07\tKing's Pawn Game: Mar\u00f3czy Defense\t1. e4 d6 2. d4 e5\nB07\tLion Defense\t1. e4 d6 2. d4 Nf6 3. Nc3 Nbd7\nB07\tLion Defense: Anti-Philidor\t1. e4 d6 2. d4 Nf6 3. Nc3 Nbd7 4. f4\nB07\tLion Defense: Anti-Philidor, Lion's Cave\t1. e4 d6 2. d4 Nf6 3. Nc3 Nbd7 4. f4 e5\nB07\tLion Defense: Bayonet Attack\t1. e4 d6 2. d4 Nf6 3. Nc3 Nbd7 4. g4\nB07\tModern Defense: Geller's System\t1. e4 g6 2. d4 Bg7 3. Nf3 d6 4. c3\nB07\tPirc Defense\t1. e4 d6 2. d4 Nf6 3. Nc3 g6\nB07\tPirc Defense: Byrne Variation\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Bg5\nB07\tPirc Defense: Kholmov System\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Bc4\nB07\tPirc Defense: Sveshnikov System\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. g3\nB08\tPirc Defense: Classical Variation\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3\nB08\tPirc Defense: Classical Variation\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Nf3 Bg7\nB09\tPirc Defense: Austrian Attack\t1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. f4\nB10\tCaro-Kann Defense\t1. e4 c6\nB10\tCaro-Kann Defense\t1. e4 c6 2. Nc3\nB10\tCaro-Kann Defense\t1. e4 c6 2. Nc3 d5\nB10\tCaro-Kann Defense: Accelerated Panov Attack\t1. e4 c6 2. c4\nB10\tCaro-Kann Defense: Accelerated Panov Attack\t1. e4 c6 2. c4 d5\nB10\tCaro-Kann Defense: Accelerated Panov Attack, Modern Variation\t1. e4 c6 2. c4 d5 3. exd5 cxd5 4. cxd5 Nf6\nB10\tCaro-Kann Defense: Accelerated Panov Attack, Open Variation\t1. e4 c6 2. c4 e5\nB10\tCaro-Kann Defense: Accelerated Panov Attack, Pseudo-Scandinavian\t1. e4 c6 2. c4 d5 3. exd5 Qxd5\nB10\tCaro-Kann Defense: Accelerated Panov Attack, Van Weersel Attack\t1. e4 c6 2. c4 d5 3. cxd5 cxd5 4. Qb3\nB10\tCaro-Kann Defense: Apocalypse Attack\t1. e4 c6 2. Nf3 d5 3. exd5 cxd5 4. Ne5\nB10\tCaro-Kann Defense: Breyer Variation\t1. e4 c6 2. d3\nB10\tCaro-Kann Defense: Dinic Gambit\t1. e4 c6 2. Nf3 d5 3. d3 dxe4 4. Ng5\nB10\tCaro-Kann Defense: Endgame Offer\t1. e4 c6 2. Nf3 d5 3. d3\nB10\tCaro-Kann Defense: Euwe Attack\t1. e4 c6 2. b3\nB10\tCaro-Kann Defense: Goldman Variation\t1. e4 c6 2. Nc3 d5 3. Qf3\nB10\tCaro-Kann Defense: Hector Gambit\t1. e4 c6 2. Nc3 d5 3. Nf3 dxe4 4. Ng5\nB10\tCaro-Kann Defense: Hillbilly Attack\t1. e4 c6 2. Bc4\nB10\tCaro-Kann Defense: Hillbilly Attack, Schaeffer Gambit\t1. e4 c6 2. Bc4 d5 3. Bb3 dxe4 4. Qh5\nB10\tCaro-Kann Defense: Labahn Attack\t1. e4 c6 2. b4\nB10\tCaro-Kann Defense: Labahn Attack, Double Gambit\t1. e4 c6 2. b4 d5 3. b5\nB10\tCaro-Kann Defense: Labahn Attack, Polish Variation\t1. e4 c6 2. b4 e5 3. Bb2\nB10\tCaro-Kann Defense: Scorpion-Horus Gambit\t1. e4 c6 2. Nc3 d5 3. d3 dxe4 4. Bg5\nB10\tCaro-Kann Defense: Spike Variation\t1. e4 c6 2. g4\nB10\tCaro-Kann Defense: Spike Variation, Scorpion-Grob Gambit\t1. e4 c6 2. g4 d5 3. Nc3 dxe4 4. d3\nB10\tCaro-Kann Defense: St. Patrick's Attack\t1. e4 c6 2. Nc3 d5 3. h3\nB10\tCaro-Kann Defense: Toikkanen Gambit\t1. e4 c6 2. c4 d5 3. e5\nB10\tCaro-Kann Defense: Two Knights Attack\t1. e4 c6 2. Nc3 d5 3. Nf3\nB11\tCaro-Kann Defense: Two Knights Attack, Mindeno Variation\t1. e4 c6 2. Nc3 d5 3. Nf3 Bg4\nB11\tCaro-Kann Defense: Two Knights Attack, Mindeno Variation, Exchange Line\t1. e4 c6 2. Nc3 d5 3. Nf3 Bg4 4. h3 Bxf3\nB11\tCaro-Kann Defense: Two Knights Attack, Mindeno Variation, Retreat Line\t1. e4 c6 2. Nc3 d5 3. Nf3 Bg4 4. h3 Bh5\nB12\tCaro-Kann Defense\t1. e4 c6 2. d4\nB12\tCaro-Kann Defense\t1. e4 c6 2. d4 d5\nB12\tCaro-Kann Defense: Advance Variation\t1. e4 c6 2. d4 d5 3. e5\nB12\tCaro-Kann Defense: Advance Variation, Bayonet Attack\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. g4\nB12\tCaro-Kann Defense: Advance Variation, Botvinnik-Carls Defense\t1. e4 c6 2. d4 d5 3. e5 c5\nB12\tCaro-Kann Defense: Advance Variation, Bronstein Variation\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. Ne2\nB12\tCaro-Kann Defense: Advance Variation, Prins Attack\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. b4\nB12\tCaro-Kann Defense: Advance Variation, Short Variation\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nf3\nB12\tCaro-Kann Defense: Advance Variation, Tal Variation\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. h4\nB12\tCaro-Kann Defense: Advance Variation, Van der Wiel Attack\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nc3\nB12\tCaro-Kann Defense: Advance Variation, Van der Wiel Attack, Dreyev Defense\t1. e4 c6 2. d4 d5 3. e5 Bf5 4. Nc3 Qb6\nB12\tCaro-Kann Defense: De Bruycker Defense\t1. e4 c6 2. d4 Na6\nB12\tCaro-Kann Defense: De Bruycker Defense\t1. e4 c6 2. d4 Na6 3. Nc3 Nc7\nB12\tCaro-Kann Defense: Edinburgh Variation\t1. e4 c6 2. d4 d5 3. Nd2 Qb6\nB12\tCaro-Kann Defense: Mar\u00f3czy Variation\t1. e4 c6 2. d4 d5 3. f3\nB12\tCaro-Kann Defense: Masi Variation\t1. e4 c6 2. d4 Nf6\nB12\tCaro-Kann Defense: Massachusetts Defense\t1. e4 c6 2. d4 f5\nB12\tCaro-Kann Defense: Mieses Gambit\t1. e4 c6 2. d4 d5 3. Be3\nB12\tCaro-Kann Defense: Modern Variation\t1. e4 c6 2. d4 d5 3. Nd2\nB12\tCaro-Kann Defense: Ulysses Gambit\t1. e4 c6 2. d4 d5 3. Nf3 dxe4 4. Ng5\nB13\tCaro-Kann Defense: Exchange Variation\t1. e4 c6 2. d4 d5 3. exd5\nB13\tCaro-Kann Defense: Exchange Variation\t1. e4 c6 2. d4 d5 3. exd5 cxd5\nB13\tCaro-Kann Defense: Exchange Variation\t1. e4 c6 2. d4 d5 3. exd5 cxd5 4. Bf4\nB13\tCaro-Kann Defense: Exchange Variation\t1. e4 c6 2. d4 d5 3. exd5 cxd5 4. Nf3 Nc6\nB13\tCaro-Kann Defense: Exchange Variation, Bulla Attack\t1. e4 c6 2. d4 d5 3. exd5 cxd5 4. g4\nB13\tCaro-Kann Defense: Panov Attack\t1. e4 c6 2. d4 d5 3. exd5 cxd5 4. c4\nB15\tCaro-Kann Defense\t1. e4 c6 2. d4 d5 3. Nc3\nB15\tCaro-Kann Defense\t1. e4 c6 2. d4 d5 3. Nc3 dxe4\nB15\tCaro-Kann Defense: Campomanes Attack\t1. e4 c6 2. d4 d5 3. Nc3 Nf6\nB15\tCaro-Kann Defense: Gurgenidze Counterattack\t1. e4 c6 2. d4 d5 3. Nc3 b5\nB15\tCaro-Kann Defense: Gurgenidze System\t1. e4 c6 2. d4 d5 3. Nc3 g6\nB15\tCaro-Kann Defense: Main Line\t1. e4 c6 2. d4 d5 3. Nd2 dxe4 4. Nxe4\nB15\tCaro-Kann Defense: Rasa-Studier Gambit\t1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. f3\nB15\tCaro-Kann Defense: von Hennig Gambit\t1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Bc4\nB16\tCaro-Kann Defense: Finnish Variation\t1. e4 c6 2. d4 d5 3. Nd2 dxe4 4. Nxe4 h6\nB17\tCaro-Kann Defense: Karpov Variation\t1. e4 c6 2. d4 d5 3. Nd2 dxe4 4. Nxe4 Nd7\nB18\tCaro-Kann Defense: Classical Variation\t1. e4 c6 2. d4 d5 3. Nd2 dxe4 4. Nxe4 Bf5\nB20\tSicilian Defense\t1. e4 c5\nB20\tSicilian Defense: Amazon Attack\t1. e4 c5 2. Qg4\nB20\tSicilian Defense: Big Clamp Formation\t1. e4 c5 2. d3 Nc6 3. c3 d6 4. f4\nB20\tSicilian Defense: Bowdler Attack\t1. e4 c5 2. Bc4\nB20\tSicilian Defense: Brick Variation\t1. e4 c5 2. Nh3\nB20\tSicilian Defense: Czerniak Attack\t1. e4 c5 2. b3\nB20\tSicilian Defense: Czerniak Attack, Queen Fianchetto Variation\t1. e4 c5 2. b3 b6\nB20\tSicilian Defense: Euwe Attack, Prins Gambit\t1. e4 c5 2. b3 d5 3. Bb2\nB20\tSicilian Defense: Gloria Variation\t1. e4 c5 2. c4 d6 3. Nc3 Nc6 4. g3 h5\nB20\tSicilian Defense: Grob Variation\t1. e4 c5 2. g4\nB20\tSicilian Defense: Keres Variation\t1. e4 c5 2. Ne2\nB20\tSicilian Defense: King David's Opening\t1. e4 c5 2. Ke2\nB20\tSicilian Defense: Kronberger Variation\t1. e4 c5 2. Na3\nB20\tSicilian Defense: Kronberger Variation, Nemeth Gambit\t1. e4 c5 2. Na3 Nc6 3. d4 cxd4 4. Bc4\nB20\tSicilian Defense: Lasker-Dunne Attack\t1. e4 c5 2. g3\nB20\tSicilian Defense: Mengarini Variation\t1. e4 c5 2. a3\nB20\tSicilian Defense: Myers Attack, with a4\t1. e4 c5 2. a4\nB20\tSicilian Defense: Myers Attack, with h4\t1. e4 c5 2. h4\nB20\tSicilian Defense: Staunton-Cochrane Variation\t1. e4 c5 2. c4\nB20\tSicilian Defense: Wing Gambit\t1. e4 c5 2. b4\nB20\tSicilian Defense: Wing Gambit, Abrahams Variation\t1. e4 c5 2. b4 cxb4 3. Bb2\nB20\tSicilian Defense: Wing Gambit, Carlsbad Variation\t1. e4 c5 2. b4 cxb4 3. a3 bxa3\nB20\tSicilian Defense: Wing Gambit, Marshall Variation\t1. e4 c5 2. b4 cxb4 3. a3\nB20\tSicilian Defense: Wing Gambit, Santasiere Variation\t1. e4 c5 2. b4 cxb4 3. c4\nB21\tBird Opening: Dutch Variation, Batavo Gambit\t1. e4 c5 2. f4 d5 3. Nf3 dxe4\nB21\tSicilian Defense: Halasz Gambit\t1. e4 c5 2. d4 cxd4 3. f4\nB21\tSicilian Defense: McDonnell Attack\t1. e4 c5 2. f4\nB21\tSicilian Defense: McDonnell Attack, Tal Gambit\t1. e4 c5 2. f4 d5 3. exd5 Nf6\nB21\tSicilian Defense: McDonnell Attack, Toilet Variation\t1. e4 c5 2. f4 d5 3. Nc3\nB21\tSicilian Defense: Morphy Gambit\t1. e4 c5 2. d4 cxd4 3. Nf3\nB21\tSicilian Defense: Morphy Gambit, Andreaschek Gambit\t1. e4 c5 2. d4 cxd4 3. Nf3 e5 4. c3\nB21\tSicilian Defense: Smith-Morra Gambit\t1. e4 c5 2. d4\nB21\tSicilian Defense: Smith-Morra Gambit\t1. e4 c5 2. d4 cxd4 3. c3\nB21\tSicilian Defense: Smith-Morra Gambit Accepted\t1. e4 c5 2. d4 cxd4 3. c3 dxc3\nB21\tSicilian Defense: Smith-Morra Gambit Accepted, Danish Variation\t1. e4 c5 2. d4 cxd4 3. c3 dxc3 4. Nf3\nB21\tSicilian Defense: Smith-Morra Gambit Declined, Alapin Formation\t1. e4 c5 2. d4 cxd4 3. c3 Nf6\nB21\tSicilian Defense: Smith-Morra Gambit Declined, Center Formation\t1. e4 c5 2. d4 cxd4 3. c3 e5\nB21\tSicilian Defense: Smith-Morra Gambit Declined, Dubois Variation\t1. e4 c5 2. d4 cxd4 3. c3 d3 4. c4\nB21\tSicilian Defense: Smith-Morra Gambit Declined, Push Variation\t1. e4 c5 2. d4 cxd4 3. c3 d3\nB21\tSicilian Defense: Smith-Morra Gambit Declined, Scandinavian Formation\t1. e4 c5 2. d4 cxd4 3. c3 d5\nB21\tSicilian Defense: Smith-Morra Gambit Declined, Wing Formation\t1. e4 c5 2. d4 cxd4 3. c3 Qa5\nB22\tSicilian Defense: Alapin Variation\t1. e4 c5 2. c3\nB22\tSicilian Defense: Alapin Variation, Anti-Alapin Gambit\t1. e4 c5 2. c3 d5 3. exd5 Nf6\nB22\tSicilian Defense: Alapin Variation, Barmen Defense\t1. e4 c5 2. c3 d5 3. exd5 Qxd5\nB22\tSicilian Defense: Alapin Variation, Smith-Morra Declined\t1. e4 c5 2. c3 Nf6 3. e5 Nd5 4. d4 cxd4\nB23\tSicilian Defense: Closed\t1. e4 c5 2. Nc3\nB23\tSicilian Defense: Closed\t1. e4 c5 2. Nc3 e6\nB23\tSicilian Defense: Closed\t1. e4 c5 2. Nc3 e6 3. g3\nB23\tSicilian Defense: Closed, Chameleon Variation\t1. e4 c5 2. Nc3 Nc6 3. Nge2\nB23\tSicilian Defense: Closed, Grob Attack\t1. e4 c5 2. Nc3 Nc6 3. g4\nB23\tSicilian Defense: Closed, Korchnoi Defense\t1. e4 c5 2. Nc3 e6 3. g3 d5\nB23\tSicilian Defense: Closed, Portland Attack\t1. e4 c5 2. Nc3 Nc6 3. d3 g6 4. g4\nB23\tSicilian Defense: Closed, Traditional\t1. e4 c5 2. Nc3 Nc6\nB23\tSicilian Defense: Grand Prix Attack\t1. e4 c5 2. Nc3 Nc6 3. f4\nB24\tSicilian Defense: Closed\t1. e4 c5 2. Nc3 Nc6 3. g3 g6\nB24\tSicilian Defense: Closed\t1. e4 c5 2. Nc3 Nc6 3. g3 g6 4. Bg2 Bg7\nB24\tSicilian Defense: Closed, Fianchetto Variation\t1. e4 c5 2. Nc3 Nc6 3. g3\nB27\tModern Defense: Pterodactyl Variation\t1. e4 c5 2. Nf3 g6 3. d4 Bg7 4. Nc3 Qa5\nB27\tPterodactyl Defense: Western, Pterodactyl\t1. e4 c5 2. Nf3 g6 3. c3 Bg7 4. d4 Qa5\nB27\tPterodactyl Defense: Western, Rhamphorhynchus\t1. e4 c5 2. Nf3 g6 3. d4 Bg7 4. dxc5 Qa5+\nB27\tSicilian Defense\t1. e4 c5 2. Nf3\nB27\tSicilian Defense: Acton Extension\t1. e4 c5 2. Nf3 g6 3. c4 Bh6\nB27\tSicilian Defense: Brussels Gambit\t1. e4 c5 2. Nf3 f5\nB27\tSicilian Defense: B\u00fccker Variation\t1. e4 c5 2. Nf3 h6\nB27\tSicilian Defense: Double-Dutch Gambit\t1. e4 c5 2. Nf3 f5 3. exf5 Nh6\nB27\tSicilian Defense: Frederico Variation\t1. e4 c5 2. Nf3 g6 3. d4 f5\nB27\tSicilian Defense: Hyperaccelerated Dragon\t1. e4 c5 2. Nf3 g6\nB27\tSicilian Defense: Hyperaccelerated Dragon\t1. e4 c5 2. Nf3 g6 3. d4\nB27\tSicilian Defense: Hyperaccelerated Pterodactyl\t1. e4 c5 2. Nf3 g6 3. d4 Bg7\nB27\tSicilian Defense: Jalalabad Variation\t1. e4 c5 2. Nf3 e5\nB27\tSicilian Defense: Katalimov Variation\t1. e4 c5 2. Nf3 b6\nB27\tSicilian Defense: Mongoose Variation\t1. e4 c5 2. Nf3 Qa5\nB27\tSicilian Defense: Polish Gambit\t1. e4 c5 2. Nf3 b5\nB27\tSicilian Defense: Quinteros Variation\t1. e4 c5 2. Nf3 Qc7\nB28\tSicilian Defense: O'Kelly Variation\t1. e4 c5 2. Nf3 a6\nB28\tSicilian Defense: O'Kelly Variation, Aronin System\t1. e4 c5 2. Nf3 a6 3. Be2\nB28\tSicilian Defense: O'Kelly Variation, Kieseritzky System\t1. e4 c5 2. Nf3 a6 3. b3\nB28\tSicilian Defense: O'Kelly Variation, Mar\u00f3czy Bind\t1. e4 c5 2. Nf3 a6 3. c4\nB28\tSicilian Defense: O'Kelly Variation, Mar\u00f3czy Bind, Paulsen Line\t1. e4 c5 2. Nf3 a6 3. c4 e6\nB28\tSicilian Defense: O'Kelly Variation, Mar\u00f3czy Bind, Robatsch Line\t1. e4 c5 2. Nf3 a6 3. c4 d6\nB28\tSicilian Defense: O'Kelly Variation, Normal System\t1. e4 c5 2. Nf3 a6 3. d4\nB28\tSicilian Defense: O'Kelly Variation, Normal System, Cortlever Gambit\t1. e4 c5 2. Nf3 a6 3. d4 cxd4 4. Bc4\nB28\tSicilian Defense: O'Kelly Variation, Normal System, Smith-Morra Line\t1. e4 c5 2. Nf3 a6 3. d4 cxd4 4. c3\nB28\tSicilian Defense: O'Kelly Variation, Normal System, Taimanov Line\t1. e4 c5 2. Nf3 a6 3. d4 cxd4 4. Nxd4 e5\nB28\tSicilian Defense: O'Kelly Variation, Normal System, Zagorovsky Line\t1. e4 c5 2. Nf3 a6 3. d4 cxd4 4. Qxd4\nB28\tSicilian Defense: O'Kelly Variation, Quiet System\t1. e4 c5 2. Nf3 a6 3. d3\nB28\tSicilian Defense: O'Kelly Variation, R\u00e9ti System\t1. e4 c5 2. Nf3 a6 3. g3\nB28\tSicilian Defense: O'Kelly Variation, Venice System\t1. e4 c5 2. Nf3 a6 3. c3\nB28\tSicilian Defense: O'Kelly Variation, Venice System, Barcza Line\t1. e4 c5 2. Nf3 a6 3. c3 Nf6\nB28\tSicilian Defense: O'Kelly Variation, Venice System, Gambit Line\t1. e4 c5 2. Nf3 a6 3. c3 d5 4. exd5 Nf6\nB28\tSicilian Defense: O'Kelly Variation, Venice System, Ljubojevic Line\t1. e4 c5 2. Nf3 a6 3. c3 b5\nB28\tSicilian Defense: O'Kelly Variation, Venice System, Steiner Line\t1. e4 c5 2. Nf3 a6 3. c3 d6\nB28\tSicilian Defense: O'Kelly Variation, Wing Gambit\t1. e4 c5 2. Nf3 a6 3. b4\nB28\tSicilian Defense: O'Kelly Variation, Yerevan System\t1. e4 c5 2. Nf3 a6 3. Nc3\nB29\tSicilian Defense: Nimzowitsch Variation\t1. e4 c5 2. Nf3 Nf6\nB29\tSicilian Defense: Nimzowitsch Variation, Advance Variation\t1. e4 c5 2. Nf3 Nf6 3. e5\nB29\tSicilian Defense: Nimzowitsch Variation, Closed Variation\t1. e4 c5 2. Nf3 Nf6 3. Nc3\nB29\tSicilian Defense: Nimzowitsch Variation, Exchange Variation\t1. e4 c5 2. Nf3 Nf6 3. e5 Nd5 4. Nc3 Nxc3\nB30\tSicilian Defense: Closed, Anti-Sveshnikov Variation\t1. e4 c5 2. Nf3 Nc6 3. Nc3 e5\nB30\tSicilian Defense: Nyezhmetdinov-Rossolimo Attack\t1. e4 c5 2. Nf3 Nc6 3. Bb5\nB30\tSicilian Defense: Nyezhmetdinov-Rossolimo Attack, Brooklyn Retreat Defense\t1. e4 c5 2. Nf3 Nc6 3. Bb5 Nb8\nB30\tSicilian Defense: Nyezhmetdinov-Rossolimo Attack, San Francisco Gambit\t1. e4 c5 2. Nf3 Nc6 3. Bb5 Na5 4. b4\nB30\tSicilian Defense: Old Sicilian\t1. e4 c5 2. Nf3 Nc6\nB30\tSicilian Defense: Portsmouth Gambit\t1. e4 c5 2. Nf3 Nc6 3. b4\nB31\tSicilian Defense: Nyezhmetdinov-Rossolimo Attack, Fianchetto Variation\t1. e4 c5 2. Nf3 Nc6 3. Bb5 g6\nB32\tSicilian Defense: Accelerated Dragon\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 g6\nB32\tSicilian Defense: Flohr Variation\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Qc7\nB32\tSicilian Defense: Franco-Sicilian Variation\t1. e4 c5 2. Nf3 Nc6 3. d4 e6\nB32\tSicilian Defense: Godiva Variation\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Qb6\nB32\tSicilian Defense: L\u00f6wenthal Variation\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 e5\nB32\tSicilian Defense: Nimzo-American Variation\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 d5\nB32\tSicilian Defense: Open\t1. e4 c5 2. Nf3 Nc6 3. d4\nB32\tSicilian Defense: Open\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4\nB32\tSicilian Defense: Open\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4\nB33\tSicilian Defense: Open\t1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 Nf6\nB40\tSicilian Defense: Delayed Alapin Variation, with e6\t1. e4 c5 2. Nf3 e6 3. c3\nB40\tSicilian Defense: Drazic Variation\t1. e4 c5 2. Nf3 e6 3. d4 a6\nB40\tSicilian Defense: French Variation\t1. e4 c5 2. Nf3 e6\nB40\tSicilian Defense: French Variation, Normal\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Nf6\nB40\tSicilian Defense: French Variation, Open\t1. e4 c5 2. Nf3 e6 3. d4 cxd4\nB40\tSicilian Defense: French Variation, Westerinen Attack\t1. e4 c5 2. Nf3 e6 3. b3\nB40\tSicilian Defense: Kramnik Variation\t1. e4 c5 2. Nf3 e6 3. c4\nB40\tSicilian Defense: Kveinis Variation\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Qb6\nB40\tSicilian Defense: Marshall Counterattack\t1. e4 c5 2. Nf3 e6 3. d4 d5\nB40\tSicilian Defense: Paulsen-Basman Defense\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Bc5\nB40\tSicilian Defense: Smith-Morra Gambit Deferred\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. c3\nB40\tSicilian Defense: Wing Gambit Deferred\t1. e4 c5 2. Nf3 e6 3. b4\nB41\tSicilian Defense: Kan Variation\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 a6\nB44\tSicilian Defense: Taimanov Variation\t1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Nc6\nB50\tSicilian Defense\t1. e4 c5 2. Nf3 d6 3. d4\nB50\tSicilian Defense\t1. e4 c5 2. Nf3 d6 3. d4 cxd4\nB50\tSicilian Defense: Delayed Alapin Variation, with d6\t1. e4 c5 2. Nf3 d6 3. c3\nB50\tSicilian Defense: Kopec System\t1. e4 c5 2. Nf3 d6 3. Bd3\nB50\tSicilian Defense: Kotov Gambit\t1. e4 c5 2. Nf3 d6 3. g3 b5\nB50\tSicilian Defense: Modern Variations\t1. e4 c5 2. Nf3 d6\nB50\tSicilian Defense: Modern Variations, Anti-Qxd4 Move Order\t1. e4 c5 2. Nf3 d6 3. d4 Nf6\nB50\tSicilian Defense: Modern Variations, Anti-Qxd4 Move Order Accepted\t1. e4 c5 2. Nf3 d6 3. d4 Nf6 4. dxc5 Nxe4\nB50\tSicilian Defense: Modern Variations, Tartakower\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. c3\nB50\tSicilian Defense: Wing Gambit, Deferred Variation\t1. e4 c5 2. Nf3 d6 3. b4\nB51\tSicilian Defense: Moscow Variation\t1. e4 c5 2. Nf3 d6 3. Bb5+\nB52\tSicilian Defense: Moscow Variation, Main Line\t1. e4 c5 2. Nf3 d6 3. Bb5+ Bd7\nB53\tSicilian Defense: Chekhover Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Qxd4\nB54\tSicilian Defense: Dragon Variation, Accelerated Dragon\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 g6\nB54\tSicilian Defense: Modern Variations, Main Line\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6\nC00\tFrench Defense\t1. e4 e6\nC00\tFrench Defense\t1. e4 e6 2. d4 d5\nC00\tFrench Defense: Alapin Gambit\t1. e4 e6 2. d4 d5 3. Be3\nC00\tFrench Defense: Baeuerle Gambit\t1. e4 e6 2. d4 b5\nC00\tFrench Defense: Banzai-Leong Gambit\t1. e4 e6 2. b4\nC00\tFrench Defense: Banzai-Leong Gambit, Pinova Gambit\t1. e4 e6 2. b4 Bxb4 3. e5\nC00\tFrench Defense: Bird Invitation\t1. e4 e6 2. Bb5\nC00\tFrench Defense: Carlson Gambit\t1. e4 e6 2. d4 d5 3. Nf3 dxe4 4. Ne5\nC00\tFrench Defense: Chigorin Variation\t1. e4 e6 2. Qe2\nC00\tFrench Defense: Diemer-Duhm Gambit\t1. e4 e6 2. d4 d5 3. c4\nC00\tFrench Defense: Diemer-Duhm Gambit Accepted\t1. e4 e6 2. d4 d5 3. c4 dxe4\nC00\tFrench Defense: Franco-Hiva Gambit\t1. e4 e6 2. d4 f5\nC00\tFrench Defense: Franco-Hiva Gambit Accepted\t1. e4 e6 2. d4 f5 3. exf5\nC00\tFrench Defense: Franco-Sicilian Defense\t1. e4 e6 2. d4 c5\nC00\tFrench Defense: Hoffmann Gambit\t1. e4 e6 2. d4 d5 3. Qe2 e5 4. f4 exf4\nC00\tFrench Defense: Horwitz Attack\t1. e4 e6 2. b3\nC00\tFrench Defense: Horwitz Attack, Papa-Ticulat Gambit\t1. e4 e6 2. b3 d5 3. Bb2\nC00\tFrench Defense: King's Indian Attack\t1. e4 e6 2. d3\nC00\tFrench Defense: King's Indian Attack, Franco-Hiva Gambit\t1. e4 e6 2. d3 f5\nC00\tFrench Defense: Knight Variation\t1. e4 e6 2. Nf3\nC00\tFrench Defense: Knight Variation, Franco-Hiva Gambit\t1. e4 e6 2. Nf3 f5\nC00\tFrench Defense: La Bourdonnais Variation\t1. e4 e6 2. f4\nC00\tFrench Defense: La Bourdonnais Variation, Reuter Gambit\t1. e4 e6 2. f4 d5 3. Nf3 dxe4\nC00\tFrench Defense: Mediterranean Defense\t1. e4 e6 2. d4 Nf6\nC00\tFrench Defense: Morphy Gambit\t1. e4 e6 2. d4 d5 3. Nh3\nC00\tFrench Defense: Normal Variation\t1. e4 e6 2. d4\nC00\tFrench Defense: Orthoschnapp Gambit\t1. e4 e6 2. c4 d5 3. cxd5 exd5 4. Qb3\nC00\tFrench Defense: Pelikan Variation\t1. e4 e6 2. Nc3 d5 3. f4\nC00\tFrench Defense: Perseus Gambit\t1. e4 e6 2. d4 d5 3. Nf3\nC00\tFrench Defense: Queen's Knight\t1. e4 e6 2. Nc3\nC00\tFrench Defense: R\u00e9ti-Spielmann Attack\t1. e4 e6 2. g3\nC00\tFrench Defense: Schlechter Variation\t1. e4 e6 2. d4 d5 3. Bd3\nC00\tFrench Defense: St. George Defense\t1. e4 e6 2. d4 a6\nC00\tFrench Defense: St. George Defense, Sanky-George Gambit\t1. e4 e6 2. d4 a6 3. c4 b5\nC00\tFrench Defense: St. George Defense, St. George Gambit\t1. e4 e6 2. d4 a6 3. c4 b5 4. cxb5 axb5\nC00\tFrench Defense: St. George Defense, Three Pawn Attack\t1. e4 e6 2. d4 a6 3. c4\nC00\tFrench Defense: Steiner Variation\t1. e4 e6 2. c4\nC00\tFrench Defense: Steinitz Attack\t1. e4 e6 2. e5\nC00\tFrench Defense: Two Knights Variation\t1. e4 e6 2. Nf3 d5 3. Nc3\nC00\tFrench Defense: Wing Gambit\t1. e4 e6 2. Nf3 d5 3. e5 c5 4. b4\nC00\tRat Defense: Small Center Defense\t1. d4 e6 2. e4 d6\nC01\tFrench Defense: Exchange Variation\t1. e4 e6 2. d4 d5 3. exd5\nC01\tFrench Defense: Exchange Variation\t1. e4 e6 2. d4 d5 3. exd5 exd5 4. Nf3\nC01\tFrench Defense: Exchange Variation\t1. e4 e6 2. d4 d5 3. exd5 exd5 4. Nc3\nC01\tFrench Defense: Exchange Variation, Monte Carlo Variation\t1. e4 e6 2. d4 d5 3. exd5 exd5 4. c4\nC02\tFrench Defense: Advance Variation\t1. e4 e6 2. d4 d5 3. e5\nC02\tFrench Defense: Advance Variation\t1. e4 e6 2. d4 d5 3. e5 c5\nC02\tFrench Defense: Advance Variation\t1. e4 e6 2. d4 d5 3. e5 c5 4. c3\nC02\tFrench Defense: Advance Variation\t1. e4 e6 2. d4 d5 3. e5 c5 4. c3 Nc6\nC02\tFrench Defense: Advance Variation, Extended Bishop Swap\t1. e4 e6 2. d4 d5 3. e5 Bd7\nC02\tFrench Defense: Advance Variation, Frenkel Gambit\t1. e4 e6 2. d4 d5 3. e5 c5 4. b4\nC02\tFrench Defense: Advance Variation, Nimzowitsch Attack\t1. e4 e6 2. d4 d5 3. e5 c5 4. Qg4\nC02\tFrench Defense: Advance Variation, Nimzowitsch System\t1. e4 e6 2. d4 d5 3. e5 c5 4. Nf3\nC02\tFrench Defense: Advance Variation, Steinitz Variation\t1. e4 e6 2. d4 d5 3. e5 c5 4. dxc5\nC03\tFrench Defense: Tarrasch Variation\t1. e4 e6 2. d4 d5 3. Nd2\nC03\tFrench Defense: Tarrasch Variation, Guimard Defense\t1. e4 e6 2. d4 d5 3. Nd2 Nc6\nC03\tFrench Defense: Tarrasch Variation, Haberditz Variation\t1. e4 e6 2. d4 d5 3. Nd2 f5\nC03\tFrench Defense: Tarrasch Variation, Modern System\t1. e4 e6 2. d4 d5 3. Nd2 a6\nC03\tFrench Defense: Tarrasch Variation, Morozevich Variation\t1. e4 e6 2. d4 d5 3. Nd2 Be7\nC04\tFrench Defense: Tarrasch Variation, Guimard Defense, Main Line\t1. e4 e6 2. d4 d5 3. Nd2 Nc6 4. Ngf3 Nf6\nC05\tFrench Defense: Tarrasch Variation, Closed Variation\t1. e4 e6 2. d4 d5 3. Nd2 Nf6\nC07\tFrench Defense: Tarrasch Variation, Chistyakov Defense\t1. e4 e6 2. d4 d5 3. Nd2 c5 4. exd5 Qxd5\nC07\tFrench Defense: Tarrasch Variation, Open System\t1. e4 e6 2. d4 d5 3. Nd2 c5\nC07\tFrench Defense: Tarrasch Variation, Open System, Euwe-Keres Line\t1. e4 e6 2. d4 d5 3. Nd2 c5 4. Ngf3\nC07\tFrench Defense: Tarrasch Variation, Open System, Shaposhnikov Gambit\t1. e4 e6 2. d4 d5 3. Nd2 c5 4. exd5 Nf6\nC07\tFrench Defense: Tarrasch Variation, Open System, S\u00fcchting Line\t1. e4 e6 2. d4 d5 3. Nd2 c5 4. c3\nC08\tFrench Defense: Tarrasch Variation, Open System\t1. e4 e6 2. d4 d5 3. Nd2 c5 4. exd5 exd5\nC10\tFrench Defense: Hecht-Reefschl\u00e4ger Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nc6\nC10\tFrench Defense: Marshall Gambit\t1. e4 e6 2. d4 d5 3. Nc3 c5\nC10\tFrench Defense: Paulsen Variation\t1. e4 e6 2. d4 d5 3. Nc3\nC10\tFrench Defense: Rubinstein Variation\t1. e4 e6 2. d4 d5 3. Nc3 dxe4\nC10\tFrench Defense: Rubinstein Variation, Blackburne Defense\t1. e4 e6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Nd7\nC10\tFrench Defense: Rubinstein Variation, Ellis Gambit\t1. e4 e6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 e5\nC10\tFrench Defense: Rubinstein Variation, Maric Variation\t1. e4 e6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Qd5\nC11\tFrench Defense: Classical Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6\nC11\tFrench Defense: Classical Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5\nC11\tFrench Defense: Classical Variation, Burn Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5 dxe4\nC11\tFrench Defense: Classical Variation, Delayed Exchange Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. exd5\nC11\tFrench Defense: Classical Variation, Steinitz Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. e5\nC11\tFrench Defense: Classical Variation, Swiss Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bd3\nC11\tFrench Defense: Henneberger Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Be3\nC12\tFrench Defense: McCutcheon Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5 Bb4\nC13\tFrench Defense: Classical Variation, Normal Variation\t1. e4 e6 2. d4 d5 3. Nc3 Nf6 4. Bg5 Be7\nC15\tFrench Defense: Winawer Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4\nC15\tFrench Defense: Winawer Variation, Alekhine-Mar\u00f3czy Gambit\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. Ne2\nC15\tFrench Defense: Winawer Variation, Delayed Exchange Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. exd5\nC15\tFrench Defense: Winawer Variation, Fingerslip Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. Bd2\nC16\tFrench Defense: Winawer Variation, Advance Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5\nC16\tFrench Defense: Winawer Variation, Petrosian Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5 Qd7\nC17\tFrench Defense: Winawer Variation, Advance Variation\t1. e4 e6 2. d4 d5 3. Nc3 Bb4 4. e5 c5\nC20\tBarnes Opening: Walkerling\t1. f3 e5 2. e4 Nf6 3. Bc4\nC20\tBongcloud Attack\t1. e4 e5 2. Ke2\nC20\tCenter Game\t1. e4 e5 2. d4\nC20\tEnglish Opening: The Whale\t1. e4 e5 2. c4\nC20\tKing's Pawn Game\t1. e4 e5\nC20\tKing's Pawn Game: Alapin Opening\t1. e4 e5 2. Ne2\nC20\tKing's Pawn Game: Bavarian Gambit\t1. e4 e5 2. c4 d5\nC20\tKing's Pawn Game: Beyer Gambit\t1. e4 e5 2. d4 d5\nC20\tKing's Pawn Game: Clam Variation, King's Gambit Reversed\t1. e4 e5 2. d3 f5\nC20\tKing's Pawn Game: Clam Variation, Radisch Gambit\t1. e4 e5 2. d3 Nf6 3. f4 Bc5\nC20\tKing's Pawn Game: King's Head Opening\t1. e4 e5 2. f3\nC20\tKing's Pawn Game: King's Head Opening\t1. e4 e5 2. f3 Nf6 3. Nc3\nC20\tKing's Pawn Game: Leonardis Variation\t1. e4 e5 2. d3\nC20\tKing's Pawn Game: MacLeod Attack\t1. e4 e5 2. c3\nC20\tKing's Pawn Game: MacLeod Attack, Lasa Gambit\t1. e4 e5 2. c3 f5\nC20\tKing's Pawn Game: MacLeod Attack, Norwalde Gambit\t1. e4 e5 2. c3 d5 3. Qh5 Bd6\nC20\tKing's Pawn Game: Mengarini's Opening\t1. e4 e5 2. a3\nC20\tKing's Pawn Game: Napoleon Attack\t1. e4 e5 2. Qf3\nC20\tKing's Pawn Game: Philidor Gambit\t1. e4 e5 2. d4 d6 3. dxe5 Bd7\nC20\tKing's Pawn Game: Tortoise Opening\t1. e4 e5 2. Bd3\nC20\tKing's Pawn Game: Wayward Queen Attack\t1. e4 e5 2. Qh5\nC20\tKing's Pawn Game: Wayward Queen Attack, Kiddie Countergambit\t1. e4 e5 2. Qh5 Nf6\nC20\tKing's Pawn Game: Weber Gambit\t1. e4 e5 2. d3 d5 3. exd5 c6 4. dxc6 Nxc6\nC20\tKing's Pawn Opening\t1. e4 e5 2. b3\nC20\tKing's Pawn Opening: Speers\t1. e4 e5 2. Qg4 Nf6 3. Qf5\nC20\tPortuguese Opening\t1. e4 e5 2. Bb5\nC20\tPortuguese Opening: Miguel Gambit\t1. e4 e5 2. Bb5 Bc5 3. b4\nC20\tPortuguese Opening: Portuguese Gambit\t1. e4 e5 2. Bb5 Nf6 3. d4\nC21\tCenter Game\t1. e4 e5 2. d4 exd4 3. Qxd4\nC21\tCenter Game Accepted\t1. e4 e5 2. d4 exd4\nC21\tCenter Game: Halasz-McDonnell Gambit\t1. e4 e5 2. d4 exd4 3. f4\nC21\tCenter Game: Kieseritzky Variation\t1. e4 e5 2. d4 exd4 3. Nf3\nC21\tCenter Game: Kieseritzky Variation\t1. e4 e5 2. d4 exd4 3. Nf3 c5\nC21\tCenter Game: Kieseritzky Variation\t1. e4 e5 2. d4 exd4 3. Nf3 c5 4. Bc4\nC21\tCenter Game: Lanc-Arnold Gambit\t1. e4 e5 2. d4 exd4 3. Nf3 Bc5 4. c3\nC21\tCenter Game: Ross Gambit\t1. e4 e5 2. d4 exd4 3. Bd3\nC21\tCenter Game: von der Lasa Gambit\t1. e4 e5 2. d4 exd4 3. Bc4\nC21\tDanish Gambit\t1. e4 e5 2. d4 exd4 3. c3\nC21\tDanish Gambit Accepted\t1. e4 e5 2. d4 exd4 3. c3 dxc3\nC21\tDanish Gambit Accepted: Svenonius Defense\t1. e4 e5 2. d4 exd4 3. c3 Ne7\nC21\tDanish Gambit Declined: S\u00f6rensen Defense\t1. e4 e5 2. d4 exd4 3. c3 d5\nC22\tCenter Game: Berger Variation\t1. e4 e5 2. d4 exd4 3. Qxd4 Nc6 4. Qe3 Nf6\nC22\tCenter Game: Hall Variation\t1. e4 e5 2. d4 exd4 3. Qxd4 Nc6 4. Qc4\nC22\tCenter Game: Normal Variation\t1. e4 e5 2. d4 exd4 3. Qxd4 Nc6\nC22\tCenter Game: Paulsen Attack Variation\t1. e4 e5 2. d4 exd4 3. Qxd4 Nc6 4. Qe3\nC22\tCenter Game: l'Hermet Variation\t1. e4 e5 2. d4 exd4 3. Qxd4 Nc6 4. Qe3 f5\nC23\tBishop's Opening\t1. e4 e5 2. Bc4\nC23\tBishop's Opening: Anderssen Gambit\t1. e4 e5 2. Bc4 b5 3. Bxb5 c6\nC23\tBishop's Opening: Boi Variation\t1. e4 e5 2. Bc4 Bc5\nC23\tBishop's Opening: Calabrese Countergambit\t1. e4 e5 2. Bc4 f5\nC23\tBishop's Opening: Calabrese Countergambit, Jaenisch Variation\t1. e4 e5 2. Bc4 f5 3. d3\nC23\tBishop's Opening: Khan Gambit\t1. e4 e5 2. Bc4 d5\nC23\tBishop's Opening: Lewis Countergambit\t1. e4 e5 2. Bc4 Bc5 3. c3 d5\nC23\tBishop's Opening: Lewis Countergambit\t1. e4 e5 2. Bc4 Bc5 3. c3 d5 4. Bxd5 Nf6\nC23\tBishop's Opening: Lewis Gambit\t1. e4 e5 2. Bc4 Bc5 3. d4\nC23\tBishop's Opening: Lopez Variation\t1. e4 e5 2. Bc4 Bc5 3. Qe2\nC23\tBishop's Opening: Lopez Variation, Lopez Gambit\t1. e4 e5 2. Bc4 Bc5 3. Qe2 Nf6 4. f4\nC23\tBishop's Opening: McDonnell Gambit\t1. e4 e5 2. Bc4 Bc5 3. b4\nC23\tBishop's Opening: McDonnell Gambit, La Bourdonnais-Denker Gambit\t1. e4 e5 2. Bc4 Bc5 3. b4 Bxb4 4. c3\nC23\tBishop's Opening: McDonnell Gambit, McDonnell Double Gambit\t1. e4 e5 2. Bc4 Bc5 3. b4 Bxb4 4. f4\nC23\tBishop's Opening: Philidor Counterattack\t1. e4 e5 2. Bc4 c6\nC23\tBishop's Opening: Philidor Variation\t1. e4 e5 2. Bc4 Bc5 3. c3\nC23\tBishop's Opening: Stein Gambit\t1. e4 e5 2. Bc4 Bc5 3. f4\nC23\tBishop's Opening: Thorold Gambit\t1. e4 e5 2. Bc4 b5 3. Bxb5 f5\nC23\tBishop's Opening: del Rio Variation\t1. e4 e5 2. Bc4 Bc5 3. c3 Qg5\nC24\tBishop's Opening: Berlin Defense\t1. e4 e5 2. Bc4 Nf6\nC24\tBishop's Opening: Berlin Defense, Greco Gambit\t1. e4 e5 2. Bc4 Nf6 3. f4\nC24\tBishop's Opening: Kitchener Folly\t1. e4 e5 2. Bc4 Nf6 3. d3 Be7 4. Nf3 O-O\nC24\tBishop's Opening: Pachman Gambit\t1. e4 e5 2. Bc4 Nf6 3. Ne2 Nxe4 4. Nec3\nC24\tBishop's Opening: Paulsen Defense\t1. e4 e5 2. Bc4 Nf6 3. d3 c6\nC24\tBishop's Opening: Ponziani Gambit\t1. e4 e5 2. Bc4 Nf6 3. d4\nC24\tBishop's Opening: Vienna Hybrid\t1. e4 e5 2. Bc4 Nf6 3. d3 Nc6 4. Nc3\nC24\tBishop's Opening: Warsaw Gambit\t1. e4 e5 2. Bc4 Nf6 3. d4 exd4 4. c3\nC25\tVienna Gambit, with Max Lange Defense\t1. e4 e5 2. Nc3 Nc6 3. f4\nC25\tVienna Gambit, with Max Lange Defense: Cunningham Defense\t1. e4 e5 2. Nc3 Nc6 3. f4 exf4 4. Nf3 Be7\nC25\tVienna Gambit, with Max Lange Defense: Knight Variation\t1. e4 e5 2. Nc3 Nc6 3. f4 exf4 4. Nf3\nC25\tVienna Gambit, with Max Lange Defense: Quelle Gambit\t1. e4 e5 2. Nc3 Nc6 3. f4 Bc5 4. fxe5 d6\nC25\tVienna Gambit, with Max Lange Defense: Steinitz Gambit\t1. e4 e5 2. Nc3 Nc6 3. f4 exf4 4. d4\nC25\tVienna Game\t1. e4 e5 2. Nc3\nC25\tVienna Game: Anderssen Defense\t1. e4 e5 2. Nc3 Bc5\nC25\tVienna Game: Fyfe Gambit\t1. e4 e5 2. Nc3 Nc6 3. d4\nC25\tVienna Game: Giraffe Attack\t1. e4 e5 2. Nc3 Bc5 3. Qg4\nC25\tVienna Game: Hamppe-Meitner Variation\t1. e4 e5 2. Nc3 Bc5 3. Na4\nC25\tVienna Game: Max Lange Defense\t1. e4 e5 2. Nc3 Nc6\nC25\tVienna Game: Omaha Gambit\t1. e4 e5 2. Nc3 d6 3. f4\nC25\tVienna Game: Paulsen Variation\t1. e4 e5 2. Nc3 Nc6 3. g3\nC25\tVienna Game: Philidor Countergambit\t1. e4 e5 2. Nc3 Nc6 3. d4 f5\nC25\tVienna Game: Zhuravlev Countergambit\t1. e4 e5 2. Nc3 Bb4 3. Qg4 Nf6\nC26\tBishop's Opening: Horwitz Gambit\t1. e4 e5 2. Bc4 Nf6 3. Nc3 b5\nC26\tBishop's Opening: Vienna Hybrid, Spielmann Attack\t1. e4 e5 2. Nc3 Nf6 3. Bc4 Bc5 4. d3\nC26\tVienna Game: Falkbeer Variation\t1. e4 e5 2. Nc3 Nf6\nC26\tVienna Game: Mengarini Variation\t1. e4 e5 2. Nc3 Nf6 3. a3\nC26\tVienna Game: Mieses Variation\t1. e4 e5 2. Nc3 Nf6 3. g3\nC26\tVienna Game: Mieses Variation, Erben Gambit\t1. e4 e5 2. Nc3 Nf6 3. g3 d5 4. exd5 c6\nC26\tVienna Game: Stanley Variation\t1. e4 e5 2. Nc3 Nf6 3. Bc4\nC26\tVienna Game: Stanley Variation, Eifel Gambit\t1. e4 e5 2. Nc3 Nf6 3. Bc4 Bc5 4. Nge2 b5\nC26\tVienna Game: Stanley Variation, Reversed Spanish\t1. e4 e5 2. Nc3 Nf6 3. Bc4 Bb4\nC27\tBishop's Opening: Boden-Kieseritzky Gambit\t1. e4 e5 2. Nf3 Nf6 3. Bc4 Nxe4 4. Nc3\nC27\tBishop's Opening: Boden-Kieseritzky Gambit, Lichtenhein Defense\t1. e4 e5 2. Nf3 Nf6 3. Bc4 Nxe4 4. Nc3 d5\nC27\tVienna Game: Frankenstein-Dracula Variation\t1. e4 e5 2. Nc3 Nf6 3. Bc4 Nxe4\nC28\tVienna Game: Stanley Variation, Three Knights Variation\t1. e4 e5 2. Nc3 Nc6 3. Bc4 Nf6\nC29\tVienna Game: Vienna Gambit\t1. e4 e5 2. Nc3 Nf6 3. f4\nC29\tVienna Game: Vienna Gambit, Main Line\t1. e4 e5 2. Nc3 Nf6 3. f4 d5\nC29\tVienna Game: Vienna Gambit, Steinitz Variation\t1. e4 e5 2. Nc3 Nf6 3. f4 d5 4. d3\nC30\tKing's Gambit\t1. e4 e5 2. f4\nC30\tKing's Gambit Declined: Classical Variation\t1. e4 e5 2. f4 Bc5\nC30\tKing's Gambit Declined: Classical Variation\t1. e4 e5 2. f4 Bc5 3. Nf3 d6 4. c3\nC30\tKing's Gambit Declined: Classical Variation, Rotlewi Countergambit\t1. e4 e5 2. f4 Bc5 3. Nf3 d6 4. b4\nC30\tKing's Gambit Declined: Classical Variation, Rubinstein Countergambit\t1. e4 e5 2. f4 Bc5 3. Nf3 d6 4. c3 f5\nC30\tKing's Gambit Declined: Classical Variation, Walthoffen Attack\t1. e4 e5 2. f4 Bc5 3. Qh5\nC30\tKing's Gambit Declined: Classical, Hanham Variation\t1. e4 e5 2. f4 Bc5 3. Nf3 d6 4. Nc3 Nd7\nC30\tKing's Gambit Declined: Classical, Soldatenkov Variation\t1. e4 e5 2. f4 Bc5 3. Nf3 d6 4. fxe5\nC30\tKing's Gambit Declined: Hobbs-Zilbermints Gambit\t1. e4 e5 2. f4 Nc6 3. Nf3 g5 4. fxg5 h6\nC30\tKing's Gambit Declined: Keene Defense\t1. e4 e5 2. f4 Qh4+ 3. g3 Qe7\nC30\tKing's Gambit Declined: Keene's Defense\t1. e4 e5 2. f4 Qh4+\nC30\tKing's Gambit Declined: Keene's Defense\t1. e4 e5 2. f4 Qh4+ 3. g3\nC30\tKing's Gambit Declined: Mafia Defense\t1. e4 c5 2. f4 e5\nC30\tKing's Gambit Declined: Miles Defense\t1. e4 e5 2. f4 Nc6 3. Nf3 f5\nC30\tKing's Gambit Declined: Norwalde Variation\t1. e4 e5 2. f4 Qf6\nC30\tKing's Gambit Declined: Norwalde Variation, Schubert Variation\t1. e4 e5 2. f4 Qf6 3. Nc3 Qxf4 4. d4\nC30\tKing's Gambit Declined: Panteldakis Countergambit\t1. e4 e5 2. f4 f5\nC30\tKing's Gambit Declined: Panteldakis Countergambit, Greco Variation\t1. e4 e5 2. f4 f5 3. exf5 Qh4+\nC30\tKing's Gambit Declined: Panteldakis Countergambit, Schiller's Defense\t1. e4 e5 2. f4 f5 3. exf5 Bc5\nC30\tKing's Gambit Declined: Panteldakis Countergambit, Shirazi Line\t1. e4 e5 2. f4 f5 3. exf5 exf4 4. Qh5+ Ke7\nC30\tKing's Gambit Declined: Petrov's Defense\t1. e4 e5 2. f4 Nf6\nC30\tKing's Gambit Declined: Queen's Knight Defense\t1. e4 e5 2. f4 Nc6\nC30\tKing's Gambit Declined: Senechaud Countergambit\t1. e4 e5 2. f4 Bc5 3. Nf3 g5\nC30\tKing's Gambit Declined: Soller-Zilbermints Gambit\t1. e4 e5 2. f4 f6 3. fxe5 Nc6\nC30\tKing's Gambit Declined: Zilbermints Double Countergambit\t1. e4 e5 2. f4 g5\nC30\tKing's Gambit Declined: Zilbermints Double Gambit\t1. e4 e5 2. f4 Nc6 3. Nf3 g5\nC31\tKing's Gambit Declined: Falkbeer Countergambit\t1. e4 e5 2. f4 d5\nC31\tKing's Gambit Declined: Falkbeer Countergambit Accepted\t1. e4 e5 2. f4 d5 3. exd5\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Anderssen Attack\t1. e4 e5 2. f4 d5 3. exd5 e4 4. Bb5+\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Blackburne Attack\t1. e4 e5 2. f4 d5 3. Nf3\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Charousek Gambit\t1. e4 e5 2. f4 d5 3. exd5 e4 4. d3\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Hinrichsen Gambit\t1. e4 e5 2. f4 d5 3. d4\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Miles Gambit\t1. e4 e5 2. f4 d5 3. exd5 Bc5\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Milner-Barry Variation\t1. e4 e5 2. f4 d5 3. Nc3\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Modern Transfer\t1. e4 e5 2. f4 d5 3. exd5 exf4\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Nimzowitsch-Marshall Countergambit\t1. e4 e5 2. f4 d5 3. exd5 c6\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Pickler Gambit\t1. e4 e5 2. f4 d5 3. exd5 c6 4. dxc6 Bc5\nC31\tKing's Gambit Declined: Falkbeer Countergambit, Staunton Line\t1. e4 e5 2. f4 d5 3. exd5 e4\nC31\tVan Geet Opening: Gr\u00fcnfeld Defense, Steiner Gambit\t1. e4 e5 2. f4 d5 3. Nc3 dxe4 4. Nxe4\nC33\tKing's Gambit Accepted\t1. e4 e5 2. f4 exf4\nC33\tKing's Gambit Accepted: Basman Gambit\t1. e4 e5 2. f4 exf4 3. Qe2\nC33\tKing's Gambit Accepted: Bishop's Gambit\t1. e4 e5 2. f4 exf4 3. Bc4\nC33\tKing's Gambit Accepted: Bishop's Gambit, Anderssen Defense\t1. e4 e5 2. f4 exf4 3. Bc4 g5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Anderssen Variation\t1. e4 e5 2. f4 exf4 3. Bc4 d5 4. Bxd5 c6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Bledow Countergambit\t1. e4 e5 2. f4 exf4 3. Bc4 d5 4. Bxd5 Nf6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Bledow Variation\t1. e4 e5 2. f4 exf4 3. Bc4 d5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Boden Variation\t1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 Nc6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Bogoljubow Defense\t1. e4 e5 2. f4 exf4 3. Bc4 Nf6 4. Nc3 c6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Bogoljubow Variation\t1. e4 e5 2. f4 exf4 3. Bc4 Nf6 4. Nc3\nC33\tKing's Gambit Accepted: Bishop's Gambit, Bryan Countergambit\t1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Cozio Defense\t1. e4 e5 2. f4 exf4 3. Bc4 Nf6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Cozio Variation\t1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 d6\nC33\tKing's Gambit Accepted: Bishop's Gambit, First Jaenisch Variation\t1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 Nf6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Gianutio Gambit\t1. e4 e5 2. f4 exf4 3. Bc4 f5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Greco Variation\t1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 Bc5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Kieseritzky Gambit\t1. e4 e5 2. f4 exf4 3. Bc4 b5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Lopez Defense\t1. e4 e5 2. f4 exf4 3. Bc4 c6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Lopez Variation\t1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 g5\nC33\tKing's Gambit Accepted: Bishop's Gambit, Maurian Defense\t1. e4 e5 2. f4 exf4 3. Bc4 Nc6\nC33\tKing's Gambit Accepted: Bishop's Gambit, Steinitz Defense\t1. e4 e5 2. f4 exf4 3. Bc4 Ne7\nC33\tKing's Gambit Accepted: Breyer Gambit\t1. e4 e5 2. f4 exf4 3. Qf3\nC33\tKing's Gambit Accepted: Carrera Gambit\t1. e4 e5 2. f4 exf4 3. Qh5\nC33\tKing's Gambit Accepted: Dodo Variation\t1. e4 e5 2. f4 exf4 3. Qg4\nC33\tKing's Gambit Accepted: Eisenberg Variation\t1. e4 e5 2. f4 exf4 3. Nh3\nC33\tKing's Gambit Accepted: Gaga Gambit\t1. e4 e5 2. f4 exf4 3. g3\nC33\tKing's Gambit Accepted: Mason-Keres Gambit\t1. e4 e5 2. f4 exf4 3. Nc3\nC33\tKing's Gambit Accepted: Orsini Gambit\t1. e4 e5 2. f4 exf4 3. b3\nC33\tKing's Gambit Accepted: Paris Gambit\t1. e4 e5 2. f4 exf4 3. Ne2\nC33\tKing's Gambit Accepted: Schurig Gambit, with Bb5\t1. e4 e5 2. f4 exf4 3. Bb5\nC33\tKing's Gambit Accepted: Schurig Gambit, with Bd3\t1. e4 e5 2. f4 exf4 3. Bd3\nC33\tKing's Gambit Accepted: Stamma Gambit\t1. e4 e5 2. f4 exf4 3. h4\nC33\tKing's Gambit Accepted: Tartakower Gambit\t1. e4 e5 2. f4 exf4 3. Be2\nC33\tKing's Gambit Accepted: Tartakower Gambit, Weiss Defense\t1. e4 e5 2. f4 exf4 3. Be2 f5 4. exf5 d6\nC33\tKing's Gambit Accepted: Tumbleweed\t1. e4 e5 2. f4 exf4 3. Kf2\nC33\tKing's Gambit Accepted: Villemson Gambit\t1. e4 e5 2. f4 exf4 3. d4\nC34\tKing's Gambit Accepted: Becker Defense\t1. e4 e5 2. f4 exf4 3. Nf3 h6\nC34\tKing's Gambit Accepted: Bonsch-Osmolovsky Variation\t1. e4 e5 2. f4 exf4 3. Nf3 Ne7\nC34\tKing's Gambit Accepted: Fischer Defense\t1. e4 e5 2. f4 exf4 3. Nf3 d6\nC34\tKing's Gambit Accepted: Fischer Defense, Schulder Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 d6 4. b4\nC34\tKing's Gambit Accepted: Gianutio Countergambit\t1. e4 e5 2. f4 exf4 3. Nf3 f5\nC34\tKing's Gambit Accepted: King's Knight's Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 g5\nC34\tKing's Gambit Accepted: King's Knight's Gambit\t1. e4 e5 2. f4 exf4 3. Nf3\nC34\tKing's Gambit Accepted: MacLeod Defense\t1. e4 e5 2. f4 exf4 3. Nf3 Nc6\nC34\tKing's Gambit Accepted: Schallopp Defense\t1. e4 e5 2. f4 exf4 3. Nf3 Nf6\nC34\tKing's Gambit Accepted: Wagenbach Defense\t1. e4 e5 2. f4 exf4 3. Nf3 h5\nC35\tKing's Gambit Accepted: Cunningham Defense\t1. e4 e5 2. f4 exf4 3. Nf3 Be7\nC35\tKing's Gambit Accepted: Cunningham Defense, McCormick Defense\t1. e4 e5 2. f4 exf4 3. Nf3 Be7 4. Bc4 Nf6\nC36\tKing's Gambit Accepted: Abbazia Defense\t1. e4 e5 2. f4 exf4 3. Nf3 d5 4. exd5 Nf6\nC36\tKing's Gambit Accepted: Modern Defense\t1. e4 e5 2. f4 exf4 3. Nf3 d5\nC36\tKing's Gambit Accepted: Modern Defense\t1. e4 e5 2. f4 exf4 3. Nf3 d5 4. exd5\nC37\tKing's Gambit Accepted: Blachly Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 Nc6 4. Bc4 g5\nC37\tKing's Gambit Accepted: King's Knight's Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 g5 4. Bc4\nC37\tKing's Gambit Accepted: Quaade Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 g5 4. Nc3\nC37\tKing's Gambit Accepted: Rosentreter Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 g5 4. d4\nC38\tKing's Gambit Accepted: Traditional Variation\t1. e4 e5 2. f4 exf4 3. Nf3 g5 4. Bc4 Bg7\nC39\tKing's Gambit Accepted: King's Knight's Gambit\t1. e4 e5 2. f4 exf4 3. Nf3 g5 4. h4\nC40\tElephant Gambit\t1. e4 e5 2. Nf3 d5\nC40\tElephant Gambit: Mar\u00f3czy Gambit\t1. e4 e5 2. Nf3 d5 3. exd5 Bd6\nC40\tElephant Gambit: Paulsen Countergambit\t1. e4 e5 2. Nf3 d5 3. exd5 e4\nC40\tElephant Gambit: Wasp Variation\t1. e4 e5 2. Nf3 d5 3. Nxe5 dxe4 4. Bc4 Qg5\nC40\tGunderam Defense\t1. e4 e5 2. Nf3 Qe7\nC40\tKing's Knight Opening\t1. e4 e5 2. Nf3\nC40\tKing's Pawn Game: Busch-Gass Gambit\t1. e4 e5 2. Nf3 Bc5\nC40\tKing's Pawn Game: Busch-Gass Gambit, Chiodini Gambit\t1. e4 e5 2. Nf3 Bc5 3. Nxe5 Nc6\nC40\tKing's Pawn Game: Damiano Defense\t1. e4 e5 2. Nf3 f6\nC40\tKing's Pawn Game: Damiano Defense, Damiano Gambit, Chigorin Gambit\t1. e4 e5 2. Nf3 f6 3. Nxe5 Qe7 4. Nf3 d5\nC40\tKing's Pawn Game: Gunderam Defense, Gunderam Gambit\t1. e4 e5 2. Nf3 Qe7 3. Bc4 f5\nC40\tKing's Pawn Game: Gunderam Gambit\t1. e4 e5 2. Nf3 c6\nC40\tKing's Pawn Game: La Bourdonnais Gambit\t1. e4 e5 2. Nf3 Qf6 3. Bc4 Qg6 4. O-O\nC40\tKing's Pawn Game: McConnell Defense\t1. e4 e5 2. Nf3 Qf6\nC40\tLatvian Gambit\t1. e4 e5 2. Nf3 f5\nC40\tLatvian Gambit Accepted\t1. e4 e5 2. Nf3 f5 3. exf5\nC40\tLatvian Gambit Accepted: Foltys-Leonhardt Variation\t1. e4 e5 2. Nf3 f5 3. Nxe5 Qf6 4. Nc4\nC40\tLatvian Gambit Accepted: Main Line\t1. e4 e5 2. Nf3 f5 3. Nxe5 Qf6 4. d4\nC40\tLatvian Gambit: Corkscrew Countergambit\t1. e4 e5 2. Nf3 f5 3. Bc4 fxe4 4. Nxe5 Nf6\nC40\tLatvian Gambit: Diepstraten Countergambit\t1. e4 e5 2. Nf3 f5 3. c4\nC40\tLatvian Gambit: Fraser Defense\t1. e4 e5 2. Nf3 f5 3. Nxe5 Nc6\nC40\tLatvian Gambit: Greco Variation\t1. e4 e5 2. Nf3 f5 3. Nxe5 Qe7\nC40\tLatvian Gambit: Lobster Gambit\t1. e4 e5 2. Nf3 f5 3. g4\nC40\tLatvian Gambit: Mason Countergambit\t1. e4 e5 2. Nf3 f5 3. d4\nC40\tLatvian Gambit: Mayet Attack\t1. e4 e5 2. Nf3 f5 3. Bc4\nC40\tLatvian Gambit: Mayet Attack, Morgado Defense\t1. e4 e5 2. Nf3 f5 3. Bc4 Nf6\nC40\tLatvian Gambit: Mayet Attack, Polerio-Svedenborg Variation\t1. e4 e5 2. Nf3 f5 3. Bc4 fxe4 4. Nxe5 d5\nC40\tLatvian Gambit: Mayet Attack, Strautins Gambit\t1. e4 e5 2. Nf3 f5 3. Bc4 b5\nC40\tLatvian Gambit: Mlotkowski Variation\t1. e4 e5 2. Nf3 f5 3. Nc3\nC40\tLatvian Gambit: Senechaud Gambit\t1. e4 e5 2. Nf3 f5 3. b4\nC41\tPhilidor Defense\t1. e4 e5 2. Nf3 d6\nC41\tPhilidor Defense\t1. e4 e5 2. Nf3 d6 3. d4\nC41\tPhilidor Defense\t1. e4 e5 2. Nf3 d6 3. Bc4\nC41\tPhilidor Defense\t1. e4 e5 2. Nf3 d6 3. Bc4 Be7\nC41\tPhilidor Defense: Albin-Blackburne Gambit\t1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Nd7\nC41\tPhilidor Defense: Bird Gambit\t1. e4 e5 2. Nf3 d6 3. d4 exd4 4. c3\nC41\tPhilidor Defense: Boden Variation\t1. e4 e5 2. Nf3 d6 3. d4 exd4 4. Qxd4 Bd7\nC41\tPhilidor Defense: Exchange Variation\t1. e4 e5 2. Nf3 d6 3. d4 exd4\nC41\tPhilidor Defense: Exchange Variation\t1. e4 e5 2. Nf3 d6 3. d4 exd4 4. Nxd4\nC41\tPhilidor Defense: Exchange Variation\t1. e4 e5 2. Nf3 d6 3. d4 exd4 4. Nxd4 Nf6\nC41\tPhilidor Defense: Hanham Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nd7\nC41\tPhilidor Defense: Hanham Variation, Sharp Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nd7 4. Bc4 Nb6\nC41\tPhilidor Defense: Larsen Variation\t1. e4 e5 2. Nf3 d6 3. d4 exd4 4. Nxd4 g6\nC41\tPhilidor Defense: Lion Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Nc3 Nbd7\nC41\tPhilidor Defense: Lopez Countergambit\t1. e4 e5 2. Nf3 d6 3. Bc4 f5\nC41\tPhilidor Defense: Morphy Gambit\t1. e4 e5 2. Nf3 d6 3. d4 exd4 4. Bc4\nC41\tPhilidor Defense: Nimzowitsch Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nf6\nC41\tPhilidor Defense: Nimzowitsch Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. dxe5\nC41\tPhilidor Defense: Nimzowitsch Variation, Klein Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Bc4\nC41\tPhilidor Defense: Nimzowitsch, Locock Variation\t1. e4 e5 2. Nf3 d6 3. d4 Nf6 4. Ng5\nC41\tPhilidor Defense: Philidor Countergambit\t1. e4 e5 2. Nf3 d6 3. d4 f5\nC41\tPhilidor Defense: Philidor Countergambit, Zukertort Variation\t1. e4 e5 2. Nf3 d6 3. d4 f5 4. Nc3\nC41\tPhilidor Defense: Philidor Gambit\t1. e4 e5 2. Nf3 d6 3. d4 Bd7\nC41\tPhilidor Defense: Steinitz Variation\t1. e4 e5 2. Nf3 d6 3. Bc4 Be7 4. c3\nC42\tPetrov's Defense\t1. e4 e5 2. Nf3 Nf6\nC42\tPetrov's Defense\t1. e4 e5 2. Nf3 Nf6 3. Nxe5\nC42\tPetrov's Defense\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6\nC42\tPetrov's Defense\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3\nC42\tPetrov's Defense\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nf3 Nxe4\nC42\tPetrov's Defense: Cochrane Gambit\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nxf7\nC42\tPetrov's Defense: Damiano Variation\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nxe4\nC42\tPetrov's Defense: Damiano Variation, Kholmov Gambit\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nxe4 4. Qe2 Qe7\nC42\tPetrov's Defense: Italian Variation\t1. e4 e5 2. Nf3 Nf6 3. Bc4\nC42\tPetrov's Defense: Karklins-Martinovsky Variation\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nd3\nC42\tPetrov's Defense: Moody Gambit\t1. e4 e5 2. Nf3 Nf6 3. Qe2 Nc6 4. d4\nC42\tPetrov's Defense: Paulsen Attack\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 d6 4. Nc4\nC42\tPetrov's Defense: Stafford Gambit\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nc6\nC42\tPetrov's Defense: Stafford Gambit Accepted\t1. e4 e5 2. Nf3 Nf6 3. Nxe5 Nc6 4. Nxc6 dxc6\nC42\tPetrov's Defense: Three Knights Game\t1. e4 e5 2. Nf3 Nf6 3. Nc3\nC43\tBishop's Opening: Urusov Gambit\t1. e4 e5 2. Bc4 Nf6 3. d4 exd4 4. Nf3\nC43\tPetrov's Defense: Modern Attack\t1. e4 e5 2. Nf3 Nf6 3. d4\nC43\tPetrov's Defense: Modern Attack\t1. e4 e5 2. Nf3 Nf6 3. d4 exd4\nC43\tPetrov's Defense: Modern Attack, Center Variation\t1. e4 e5 2. Nf3 Nf6 3. d4 Nxe4 4. Bd3\nC43\tPetrov's Defense: Modern Attack, Murrey Variation\t1. e4 e5 2. Nf3 Nf6 3. d4 Nxe4 4. Bd3 Nc6\nC43\tPetrov's Defense: Modern Attack, Symmetrical Variation\t1. e4 e5 2. Nf3 Nf6 3. d4 d5\nC44\tDresden Opening: The Goblin\t1. e4 e5 2. Nf3 Nc6 3. c4 Nf6 4. Nxe5\nC44\tIrish Gambit\t1. e4 e5 2. Nf3 Nc6 3. Nxe5\nC44\tKing's Knight Opening: Konstantinopolsky\t1. e4 e5 2. Nf3 Nc6 3. g3\nC44\tKing's Knight Opening: Normal Variation\t1. e4 e5 2. Nf3 Nc6\nC44\tKing's Pawn Game: Dresden Opening\t1. e4 e5 2. Nf3 Nc6 3. c4\nC44\tKing's Pawn Game: Pachman Wing Gambit\t1. e4 e5 2. Nf3 Nc6 3. b4\nC44\tKing's Pawn Game: Schulze-M\u00fcller Gambit\t1. e4 e5 2. Nf3 Nc6 3. Nxe5 Nxe5 4. d4\nC44\tKing's Pawn Game: Tayler Opening\t1. e4 e5 2. Nf3 Nc6 3. Be2\nC44\tKing's Pawn Game: Tayler Opening\t1. e4 e5 2. Nf3 Nc6 3. Be2 Nf6 4. d4\nC44\tLatvian Gambit: Clam Gambit\t1. e4 e5 2. Nf3 Nc6 3. d3 f5 4. exf5\nC44\tPonziani Opening\t1. e4 e5 2. Nf3 Nc6 3. c3\nC44\tPonziani Opening: Caro Gambit\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4 Bd7\nC44\tPonziani Opening: Jaenisch Counterattack\t1. e4 e5 2. Nf3 Nc6 3. c3 Nf6\nC44\tPonziani Opening: Jaenisch Counterattack\t1. e4 e5 2. Nf3 Nc6 3. c3 Nf6 4. d3\nC44\tPonziani Opening: Jaenisch Counterattack\t1. e4 e5 2. Nf3 Nc6 3. c3 Nf6 4. d3 d5\nC44\tPonziani Opening: Leonhardt Variation\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4 Nf6\nC44\tPonziani Opening: Neumann Gambit\t1. e4 e5 2. Nf3 Nc6 3. c3 Nf6 4. Bc4\nC44\tPonziani Opening: Ponziani Countergambit\t1. e4 e5 2. Nf3 Nc6 3. c3 f5\nC44\tPonziani Opening: Romanishin Variation\t1. e4 e5 2. Nf3 Nc6 3. c3 Be7\nC44\tPonziani Opening: R\u00e9ti Variation\t1. e4 e5 2. Nf3 Nc6 3. c3 Nge7\nC44\tPonziani Opening: Spanish Variation\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Bb5\nC44\tPonziani Opening: Steinitz Variation\t1. e4 e5 2. Nf3 Nc6 3. c3 d5 4. Qa4 f6\nC44\tScotch Game\t1. e4 e5 2. Nf3 Nc6 3. d4\nC44\tScotch Game\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4\nC44\tScotch Game: Benima Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Be7 4. d4 exd4\nC44\tScotch Game: G\u00f6ring Gambit\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. c3\nC44\tScotch Game: Haxo Gambit\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Bc4 Bc5\nC44\tScotch Game: Lolli Variation\t1. e4 e5 2. Nf3 Nc6 3. d4 Nxd4\nC44\tScotch Game: Relfsson Gambit\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Bb5\nC44\tScotch Game: Scotch Gambit\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Bc4\nC44\tScotch Game: Scotch Gambit, Dubois R\u00e9ti Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4 exd4\nC44\tScotch Game: Scotch Gambit, G\u00f6ring Gambit Declined\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. c3 d5\nC44\tScotch Game: Scotch Gambit, London Defense\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Bc4 Bb4+\nC45\tScotch Game\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4\nC45\tScotch Game: Classical Variation\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Bc5\nC45\tScotch Game: Malaniuk Variation\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Bb4+\nC45\tScotch Game: Schmidt Variation\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Nf6\nC45\tScotch Game: Steinitz Variation\t1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 Qh4\nC46\tThree Knights Opening\t1. e4 e5 2. Nf3 Nc6 3. Nc3\nC46\tThree Knights Opening\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Bb4\nC46\tThree Knights Opening: Schlechter Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Bb4 4. Nd5 Nf6\nC46\tThree Knights Opening: Steinitz Defense\t1. e4 e5 2. Nf3 Nc6 3. Nc3 g6\nC46\tThree Knights Opening: Winawer Defense\t1. e4 e5 2. Nf3 Nc6 3. Nc3 f5\nC47\tFour Knights Game\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6\nC47\tFour Knights Game: Glek System\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. g3\nC47\tFour Knights Game: Gunsberg Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. a3\nC47\tFour Knights Game: Halloween Gambit\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Nxe5\nC47\tFour Knights Game: Italian Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Nc3\nC47\tFour Knights Game: Naroditsky Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Nd5\nC47\tFour Knights Game: Scotch Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. d4\nC47\tFour Knights Game: Scotch Variation Accepted\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. d4 exd4\nC48\tFour Knights Game: Spanish Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5\nC48\tFour Knights Game: Spanish Variation, Classical Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Bc5\nC48\tFour Knights Game: Spanish Variation, Rubinstein Variation\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Nd4\nC49\tFour Knights Game: Spanish Variation, Double Spanish\t1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6 4. Bb5 Bb4\nC50\tFour Knights Game: Italian Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. Nc3 Nf6\nC50\tItalian Game\t1. e4 e5 2. Nf3 Nc6 3. Bc4\nC50\tItalian Game: Anti-Fried Liver Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 h6\nC50\tItalian Game: Blackburne-Kosti\u0107 Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4\nC50\tItalian Game: Giuoco Pianissimo\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3\nC50\tItalian Game: Giuoco Pianissimo, Lucchini Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 f5\nC50\tItalian Game: Giuoco Pianissimo, Normal\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 Bc5\nC50\tItalian Game: Giuoco Piano\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5\nC50\tItalian Game: Hungarian Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Be7\nC50\tItalian Game: Jerome Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. Bxf7+\nC50\tItalian Game: Paris Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 d6\nC50\tItalian Game: Rosentreter Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d4\nC50\tItalian Game: Rousseau Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 f5\nC51\tItalian Game: Evans Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4\nC51\tItalian Game: Evans Gambit Accepted\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4\nC51\tItalian Game: Evans Gambit Declined\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bb6\nC51\tItalian Game: Evans Gambit, Fontaine Countergambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 b5\nC51\tItalian Game: Evans Gambit, Hein Countergambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 d5\nC53\tItalian Game: Classical Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3\nC53\tItalian Game: Classical Variation, Closed Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Qe7\nC54\tItalian Game: Classical Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6\nC55\tItalian Game: Two Knights Defense\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6\nC55\tItalian Game: Two Knights Defense, Modern Bishop's Opening\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3\nC55\tItalian Game: Two Knights Defense, Modern Bishop's Opening\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 Be7\nC56\tItalian Game: Scotch Invitation Declined\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4 d6\nC56\tItalian Game: Two Knights Defense, Open Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d4\nC57\tItalian Game: Two Knights Defense, Knight Attack\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5\nC57\tItalian Game: Two Knights Defense, Knight Attack, Normal Variation\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5\nC57\tItalian Game: Two Knights Defense, Ponziani-Steinitz Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 Nxe4\nC57\tItalian Game: Two Knights Defense, Traxler Counterattack\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 Bc5\nC60\tRuy Lopez\t1. e4 e5 2. Nf3 Nc6 3. Bb5\nC60\tRuy Lopez: Alapin Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bb4\nC60\tRuy Lopez: Brentano Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 g5\nC60\tRuy Lopez: Bulgarian Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a5\nC60\tRuy Lopez: Cozio Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nge7\nC60\tRuy Lopez: Cozio Defense, Paulsen Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nge7 4. Nc3 g6\nC60\tRuy Lopez: Fianchetto Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 g6\nC60\tRuy Lopez: Fianchetto Defense, Kevitz Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 g6 4. c3 f5\nC60\tRuy Lopez: Lucena Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Be7\nC60\tRuy Lopez: N\u00fcrnberg Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f6\nC60\tRuy Lopez: Pollock Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Na5\nC60\tRuy Lopez: Retreat Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nb8\nC60\tRuy Lopez: Rotary-Albany Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 b6\nC60\tRuy Lopez: Spanish Countergambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 d5\nC60\tRuy Lopez: Vinogradov Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Qe7\nC61\tRuy Lopez: Bird Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nd4\nC62\tRuy Lopez: Steinitz Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 d6\nC62\tRuy Lopez: Steinitz Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 d6 4. d4\nC63\tRuy Lopez: Schliemann Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f5\nC63\tRuy Lopez: Schliemann Defense, Dyckhoff Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f5 4. Nc3\nC63\tRuy Lopez: Schliemann Defense, Exchange Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f5 4. Bxc6\nC63\tRuy Lopez: Schliemann Defense, Jaenisch Gambit Accepted\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f5 4. exf5\nC63\tRuy Lopez: Schliemann Defense, Sch\u00f6nemann Attack\t1. e4 e5 2. Nf3 Nc6 3. Bb5 f5 4. d4\nC64\tRuy Lopez: Classical Defense, Boden Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5 4. c3 Qe7\nC64\tRuy Lopez: Classical Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5\nC64\tRuy Lopez: Classical Variation, Central Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5 4. c3\nC64\tRuy Lopez: Classical Variation, Charousek Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5 4. c3 Bb6\nC64\tRuy Lopez: Classical Variation, Cordel Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5 4. c3 f5\nC64\tRuy Lopez: Classical Variation, Konikowski Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5 4. c3 d5\nC64\tRuy Lopez: Classical Variation, Spanish Wing Gambit\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5 4. b4\nC65\tRuy Lopez: Berlin Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6\nC65\tRuy Lopez: Berlin Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O\nC65\tRuy Lopez: Berlin Defense, Anti-Berlin Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. d3\nC65\tRuy Lopez: Berlin Defense, Anti-Berlin Variation, Mortimer Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. d3 Ne7\nC65\tRuy Lopez: Berlin Defense, Beverwijk Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O Bc5\nC65\tRuy Lopez: Berlin Defense, Fishing Pole Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O Ng4\nC65\tRuy Lopez: Halloween Attack\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. Nxe5\nC66\tRuy Lopez: Berlin Defense, Improved Steinitz Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O d6\nC67\tRuy Lopez: Berlin Defense, Rio Gambit Accepted\t1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 4. O-O Nxe4\nC68\tRuy Lopez: Exchange Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6\nC68\tRuy Lopez: Exchange Variation, Lutikov Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 bxc6\nC70\tRuy Lopez: Bird's Defense Deferred\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nd4\nC70\tRuy Lopez: Morphy Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6\nC70\tRuy Lopez: Morphy Defense, Alapin's Defense Deferred\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Bb4\nC70\tRuy Lopez: Morphy Defense, Caro Variation\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 b5\nC70\tRuy Lopez: Morphy Defense, Classical Defense Deferred\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Bc5\nC70\tRuy Lopez: Morphy Defense, Cozio Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nge7\nC70\tRuy Lopez: Morphy Defense, Fianchetto Defense Deferred\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 g6\nC70\tRuy Lopez: Morphy Defense, Schliemann Defense Deferred\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 f5\nC71\tRuy Lopez: Morphy Defense, Modern Steinitz Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 d6\nD00\tAmazon Attack\t1. d4 d5 2. Qd3\nD00\tBlackmar-Diemer Gambit\t1. d4 d5 2. e4\nD00\tBlackmar-Diemer Gambit\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6\nD00\tBlackmar-Diemer Gambit Accepted\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 exf3\nD00\tBlackmar-Diemer Gambit Declined: Brombacher Countergambit\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 c5\nD00\tBlackmar-Diemer Gambit Declined: Elbert Countergambit\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 e5\nD00\tBlackmar-Diemer Gambit Declined: Gedult Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 a6\nD00\tBlackmar-Diemer Gambit Declined: Lamb Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 Nc6\nD00\tBlackmar-Diemer Gambit Declined: Langeheinicke Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 e3\nD00\tBlackmar-Diemer Gambit Declined: O'Kelly Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 c6\nD00\tBlackmar-Diemer Gambit Declined: Vienna Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 Bf5\nD00\tBlackmar-Diemer Gambit Declined: Weinsbach Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. f3 e6\nD00\tBlackmar-Diemer Gambit: Blackmar Gambit\t1. d4 d5 2. e4 dxe4 3. f3\nD00\tBlackmar-Diemer Gambit: Diemer-Rosenberg Attack\t1. d4 d5 2. e4 dxe4 3. Be3\nD00\tBlackmar-Diemer Gambit: Fritz Attack\t1. d4 d5 2. e4 dxe4 3. Bc4\nD00\tBlackmar-Diemer Gambit: Lemberger Countergambit\t1. d4 d5 2. e4 dxe4 3. Nc3 e5\nD00\tBlackmar-Diemer Gambit: Lemberger Countergambit, Endgame Variation\t1. d4 d5 2. e4 dxe4 3. Nc3 e5 4. dxe5\nD00\tBlackmar-Diemer Gambit: Lemberger Countergambit, Lange Gambit\t1. d4 d5 2. e4 dxe4 3. Nc3 e5 4. Nxe4\nD00\tBlackmar-Diemer Gambit: Lemberger Countergambit, Rasmussen Attack\t1. d4 d5 2. e4 dxe4 3. Nc3 e5 4. Nge2\nD00\tBlackmar-Diemer Gambit: Lemberger Countergambit, Sneiders Attack\t1. d4 d5 2. e4 dxe4 3. Nc3 e5 4. Qh5\nD00\tBlackmar-Diemer Gambit: Lemberger Countergambit, Soller Attack\t1. d4 d5 2. e4 dxe4 3. Nc3 e5 4. Be3\nD00\tBlackmar-Diemer Gambit: Netherlands Variation\t1. d4 d5 2. e4 dxe4 3. Nc3 f5\nD00\tBlackmar-Diemer Gambit: Rasa-Studier Gambit\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. Be3\nD00\tBlackmar-Diemer Gambit: Reversed Albin Countergambit\t1. d4 d5 2. e4 dxe4 3. Nc3 c5\nD00\tBlackmar-Diemer Gambit: Zeller Defense\t1. d4 d5 2. e4 dxe4 3. Nc3 Bf5\nD00\tBlackmar-Diemer Gambit: von Popiel Gambit\t1. d4 d5 2. e4 dxe4 3. Nc3 Nf6 4. Bg5\nD00\tQueen's Pawn Game\t1. d4 d5\nD00\tQueen's Pawn Game\t1. d4 d5 2. e3\nD00\tQueen's Pawn Game\t1. d4 d5 2. e3 Nf6\nD00\tQueen's Pawn Game: Accelerated London System\t1. d4 d5 2. Bf4\nD00\tQueen's Pawn Game: Accelerated London System, Steinitz Countergambit\t1. d4 d5 2. Bf4 c5\nD00\tQueen's Pawn Game: Accelerated London System, Steinitz Countergambit Accepted\t1. d4 d5 2. Bf4 c5 3. dxc5\nD00\tQueen's Pawn Game: Accelerated London System, Steinitz Countergambit, Morris Countergambit\t1. d4 d5 2. Bf4 c5 3. e4\nD00\tQueen's Pawn Game: Accelerated London System, Steinitz Countergambit, Morris Countergambit Accepted\t1. d4 d5 2. Bf4 c5 3. e4 dxe4\nD00\tQueen's Pawn Game: Chigorin Variation\t1. d4 d5 2. Nc3\nD00\tQueen's Pawn Game: Chigorin Variation\t1. d4 d5 2. Nc3 e6\nD00\tQueen's Pawn Game: Chigorin Variation, Alburt Defense\t1. d4 d5 2. Nc3 Bf5\nD00\tQueen's Pawn Game: Chigorin Variation, Anti-Veresov\t1. d4 d5 2. Nc3 Bg4\nD00\tQueen's Pawn Game: Chigorin Variation, Fianchetto Defense\t1. d4 g6 2. Nf3 Bg7 3. Nc3 d5\nD00\tQueen's Pawn Game: Chigorin Variation, Irish Gambit\t1. d4 d5 2. Nc3 c5\nD00\tQueen's Pawn Game: Chigorin Variation, Shaviliuk Gambit\t1. d4 d5 2. Nc3 e5\nD00\tQueen's Pawn Game: Chigorin Variation, Shropshire Defense\t1. d4 d5 2. Nc3 h5\nD00\tQueen's Pawn Game: H\u00fcbsch Gambit\t1. d4 Nf6 2. Nc3 d5 3. e4\nD00\tQueen's Pawn Game: Levitsky Attack\t1. d4 d5 2. Bg5\nD00\tQueen's Pawn Game: Levitsky Attack, Welling Variation\t1. d4 d5 2. Bg5 Bg4\nD00\tQueen's Pawn Game: Mason Attack\t1. d4 d5 2. f4\nD00\tQueen's Pawn Game: Stonewall Attack\t1. d4 d5 2. e3 Nf6 3. Bd3\nD00\tQueen's Pawn Game: Zurich Gambit\t1. d4 d5 2. g4\nD01\tRapport-Jobava System\t1. d4 d5 2. Nc3 Nf6 3. Bf4\nD01\tRapport-Jobava System\t1. d4 d5 2. Nc3 Nf6 3. Bf4 e6\nD01\tRapport-Jobava System\t1. d4 d5 2. Nc3 Nf6 3. Bf4 g6\nD01\tRapport-Jobava System, with e6\t1. d4 d5 2. Nc3 e6 3. Bf4\nD01\tRichter-Veresov Attack\t1. d4 Nf6 2. Nc3 d5 3. Bg5\nD01\tRichter-Veresov Attack\t1. d4 Nf6 2. Nc3 d5 3. Bg5 Bf5\nD01\tRichter-Veresov Attack: Boyce Defense\t1. d4 Nf6 2. Nc3 d5 3. Bg5 Ne4\nD01\tRichter-Veresov Attack: Richter Variation\t1. d4 Nf6 2. Nc3 d5 3. Bg5 Bf5 4. f3\nD01\tRichter-Veresov Attack: Two Knights System\t1. d4 Nf6 2. Nc3 d5 3. Bg5 Nbd7 4. Nf3\nD01\tRichter-Veresov Attack: Two Knights System, Gr\u00fcnfeld Defense\t1. d4 Nf6 2. Nc3 d5 3. Bg5 Nbd7 4. Nf3 g6\nD01\tRichter-Veresov Attack: Veresov Variation\t1. d4 Nf6 2. Nc3 d5 3. Bg5 Bf5 4. Bxf6\nD02\tQueen's Gambit Declined: Baltic Defense, Pseudo-Slav\t1. d4 d5 2. Nf3 Bf5 3. c4 e6 4. Nc3 c6\nD02\tQueen's Pawn Game: Anti-Torre\t1. Nf3 d5 2. d4 Bg4\nD02\tQueen's Pawn Game: Chandler Gambit\t1. d4 d5 2. Nf3 c5 3. g3 cxd4 4. Bg2\nD02\tQueen's Pawn Game: Chigorin Variation\t1. d4 d5 2. Nf3 Nc6\nD02\tQueen's Pawn Game: Krause Variation\t1. d4 d5 2. Nf3 c5\nD02\tQueen's Pawn Game: Levitsky Attack, Euwe Variation, Modern Line\t1. d4 d5 2. Nf3 c6 3. Bg5 h6 4. Bh4 Qb6\nD02\tQueen's Pawn Game: London System\t1. d4 d5 2. Nf3 Nf6 3. Bf4\nD02\tQueen's Pawn Game: London System\t1. d4 d5 2. Nf3 Nf6 3. Bf4 c5 4. e3\nD02\tQueen's Pawn Game: London System, with e6\t1. d4 d5 2. Nf3 e6 3. Bf4\nD02\tQueen's Pawn Game: London System, with e6\t1. d4 d5 2. Nf3 e6 3. Bf4 Nf6\nD02\tQueen's Pawn Game: Symmetrical Variation\t1. d4 d5 2. Nf3 Nf6\nD02\tQueen's Pawn Game: Symmetrical Variation, Pseudo-Catalan\t1. d4 d5 2. Nf3 Nf6 3. g3\nD02\tQueen's Pawn Game: Symmetrical Variation, Pseudo-Catalan\t1. d4 d5 2. Nf3 Nf6 3. g3 c6 4. Bg2 Bg4\nD02\tQueen's Pawn Game: Zilbermints Countergambit\t1. d4 d5 2. Nf3 Nf6 3. c4 b5\nD02\tQueen's Pawn Game: Zukertort Variation\t1. d4 d5 2. Nf3\nD03\tQueen's Pawn Game: Torre Attack\t1. d4 d5 2. Nf3 Nf6 3. Bg5\nD03\tQueen's Pawn Game: Torre Attack, Gossip Variation\t1. d4 d5 2. Nf3 Nf6 3. Bg5 Ne4\nD03\tQueen's Pawn Game: Torre Attack, Gr\u00fcnfeld Variation\t1. d4 d5 2. Nf3 Nf6 3. Bg5 g6\nD04\tQueen's Pawn Game: Colle System\t1. d4 d5 2. Nf3 Nf6 3. e3\nD04\tQueen's Pawn Game: Colle System, Anti-Colle\t1. d4 d5 2. Nf3 Nf6 3. e3 Bf5\nD04\tQueen's Pawn Game: Colle System, Gr\u00fcnfeld Formation\t1. d4 d5 2. Nf3 Nf6 3. e3 g6 4. Bd3 Bg7\nD05\tQueen's Pawn Game: Colle System\t1. d4 d5 2. Nf3 Nf6 3. e3 e6\nD05\tQueen's Pawn Game: Colle System\t1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. Bd3\nD05\tQueen's Pawn Game: Colle System\t1. d4 d5 2. Nf3 Nf6 3. e3 e6 4. b3\nD06\tQueen's Gambit\t1. d4 d5 2. c4\nD06\tQueen's Gambit Declined: Austrian Attack, Salvio Countergambit\t1. d4 d5 2. c4 c5 3. dxc5 d4\nD06\tQueen's Gambit Declined: Austrian Defense\t1. d4 d5 2. c4 c5\nD06\tQueen's Gambit Declined: Austrian Defense, Gusev Countergambit\t1. d4 d5 2. c4 c5 3. cxd5 Nf6\nD06\tQueen's Gambit Declined: Baltic Defense\t1. d4 d5 2. c4 Bf5\nD06\tQueen's Gambit Declined: Baltic Defense, Pseudo-Chigorin\t1. d4 d5 2. c4 Bf5 3. Nc3 e6 4. Nf3 Nc6\nD06\tQueen's Gambit Declined: Baltic Defense, Queen Attack\t1. d4 d5 2. c4 Bf5 3. Qb3\nD06\tQueen's Gambit Declined: Baltic Defense, Queen Attack Deferred\t1. d4 d5 2. c4 Bf5 3. Nc3 e6 4. Qb3\nD06\tQueen's Gambit Declined: Marshall Defense\t1. d4 d5 2. c4 Nf6\nD06\tQueen's Gambit Declined: Marshall Defense, Tan Gambit\t1. d4 d5 2. c4 Nf6 3. cxd5 c6\nD06\tQueen's Gambit Declined: Zilbermints Gambit\t1. d4 d5 2. c4 b5\nD07\tQueen's Gambit Declined: Chigorin Defense\t1. d4 d5 2. c4 Nc6\nD07\tQueen's Gambit Declined: Chigorin Defense\t1. d4 d5 2. c4 Nc6 3. Nc3\nD07\tQueen's Gambit Declined: Chigorin Defense\t1. d4 d5 2. c4 Nc6 3. Nc3 dxc4\nD07\tQueen's Gambit Declined: Chigorin Defense, Exchange Variation\t1. d4 d5 2. c4 Nc6 3. cxd5 Qxd5\nD07\tQueen's Gambit Declined: Chigorin Defense, Janowski Variation\t1. d4 d5 2. c4 Nc6 3. Nc3 dxc4 4. Nf3\nD07\tQueen's Gambit Declined: Chigorin Defense, Lazard Gambit\t1. d4 d5 2. c4 Nc6 3. Nf3 e5\nD07\tQueen's Gambit Declined: Chigorin Defense, Main Line\t1. d4 d5 2. c4 Nc6 3. Nf3 Bg4\nD07\tQueen's Gambit Declined: Chigorin Defense, Main Line, Alekhine Variation\t1. d4 d5 2. c4 Nc6 3. Nf3 Bg4 4. Qa4\nD07\tQueen's Gambit Declined: Chigorin Defense, Modern Gambit\t1. d4 d5 2. c4 Nc6 3. Nc3 dxc4 4. Nf3 Nf6\nD07\tQueen's Gambit Declined: Chigorin Defense, Tartakower Gambit\t1. d4 d5 2. c4 Nc6 3. Nc3 e5\nD08\tQueen's Gambit Declined: Albin Countergambit\t1. d4 d5 2. c4 e5\nD08\tQueen's Gambit Declined: Albin Countergambit, Normal Line\t1. d4 d5 2. c4 e5 3. dxe5 d4 4. Nf3\nD08\tQueen's Gambit Declined: Albin Countergambit, Spassky Variation\t1. d4 d5 2. c4 e5 3. dxe5 d4 4. e4\nD08\tQueen's Gambit Declined: Albin Countergambit, Tartakower Defense\t1. d4 d5 2. c4 e5 3. dxe5 d4 4. Nf3 c5\nD10\tSlav Defense\t1. d4 d5 2. c4 c6\nD10\tSlav Defense\t1. d4 d5 2. c4 c6 3. Nc3\nD10\tSlav Defense\t1. d4 d5 2. c4 c6 3. Nc3 dxc4\nD10\tSlav Defense: Diemer Gambit\t1. d4 d5 2. c4 c6 3. e4\nD10\tSlav Defense: Exchange Variation\t1. d4 d5 2. c4 c6 3. cxd5\nD10\tSlav Defense: Slav Gambit, Alekhine Attack\t1. d4 d5 2. c4 c6 3. Nc3 dxc4 4. e4\nD10\tSlav Defense: Winawer Countergambit\t1. d4 d5 2. c4 c6 3. Nc3 e5\nD10\tSlav Defense: Winawer Countergambit, Anti-Winawer Gambit\t1. d4 d5 2. c4 c6 3. Nc3 e5 4. e4\nD11\tSlav Defense: Bonet Gambit\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Bg5\nD11\tSlav Defense: Breyer Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nbd2\nD11\tSlav Defense: Modern Line\t1. d4 d5 2. c4 c6 3. Nf3\nD11\tSlav Defense: Quiet Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. e3\nD11\tSlav Defense: Quiet Variation, Pin Defense\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. e3 Bg4\nD12\tSlav Defense: Quiet Variation, Schallopp Defense\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. e3 Bf5\nD13\tSlav Defense: Exchange Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. cxd5 cxd5\nD15\tSlav Defense: Chebanenko Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 a6\nD15\tSlav Defense: Schlechter Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 g6\nD15\tSlav Defense: S\u00fcchting Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 Qb6\nD15\tSlav Defense: Three Knights Variation\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3\nD15\tSlav Defense: Two Knights Attack\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 dxc4\nD20\tQueen's Gambit Accepted\t1. d4 d5 2. c4 dxc4\nD20\tQueen's Gambit Accepted: Accelerated Mannheim Variation\t1. d4 d5 2. c4 dxc4 3. Qa4+\nD20\tQueen's Gambit Accepted: Central Variation, Alekhine System\t1. d4 d5 2. c4 dxc4 3. e4 Nf6\nD20\tQueen's Gambit Accepted: Central Variation, Greco Variation\t1. d4 d5 2. c4 dxc4 3. e4 b5\nD20\tQueen's Gambit Accepted: Central Variation, McDonnell Defense\t1. d4 d5 2. c4 dxc4 3. e4 e5\nD20\tQueen's Gambit Accepted: Central Variation, McDonnell Defense, Somov Gambit\t1. d4 d5 2. c4 dxc4 3. e4 e5 4. Bxc4\nD20\tQueen's Gambit Accepted: Central Variation, Modern Defense\t1. d4 d5 2. c4 dxc4 3. e4 Nc6\nD20\tQueen's Gambit Accepted: Central Variation, Rubinstein Defense\t1. d4 d5 2. c4 dxc4 3. e4 c5\nD20\tQueen's Gambit Accepted: Central Variation, Rubinstein Defense, Yefimov Gambit\t1. d4 d5 2. c4 dxc4 3. e4 c5 4. d5 b5\nD20\tQueen's Gambit Accepted: Old Variation\t1. d4 d5 2. c4 dxc4 3. e3\nD20\tQueen's Gambit Accepted: Saduleto Variation\t1. d4 d5 2. c4 dxc4 3. e4\nD20\tQueen's Gambit Accepted: Schwartz Defense\t1. d4 d5 2. c4 dxc4 3. e4 f5\nD21\tQueen's Gambit Accepted: Alekhine Defense, Borisenko-Furman Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 a6 4. e4\nD21\tQueen's Gambit Accepted: Godes Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nd7\nD21\tQueen's Gambit Accepted: Gunsberg Defense\t1. d4 d5 2. c4 dxc4 3. Nf3 c5\nD21\tQueen's Gambit Accepted: Normal Variation\t1. d4 d5 2. c4 dxc4 3. Nf3\nD21\tQueen's Gambit Accepted: Rosenthal Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 e6\nD21\tQueen's Gambit Accepted: Slav Gambit\t1. d4 d5 2. c4 dxc4 3. Nf3 b5\nD22\tQueen's Gambit Accepted: Alekhine Defense\t1. d4 d5 2. c4 dxc4 3. Nf3 a6\nD22\tQueen's Gambit Accepted: Alekhine Defense, Haberditz Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 a6 4. e3 b5\nD23\tQueen's Gambit Accepted\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6\nD23\tQueen's Gambit Accepted: Mannheim Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. Qa4+\nD24\tQueen's Gambit Accepted: Showalter Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. Nc3\nD25\tQueen's Gambit Accepted: Janowski-Larsen Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 Bg4\nD25\tQueen's Gambit Accepted: Normal Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3\nD25\tQueen's Gambit Accepted: Smyslov Variation\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 g6\nD25\tQueen's Gambit Accepted: Winawer Defense\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 Be6\nD26\tQueen's Gambit Accepted: Normal Variation, Traditional System\t1. d4 d5 2. c4 dxc4 3. Nf3 Nf6 4. e3 e6\nD30\tQueen's Gambit Declined\t1. d4 d5 2. c4 e6\nD30\tQueen's Gambit Declined: Capablanca Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Bg5 h6\nD30\tQueen's Gambit Declined: Tarrasch Defense, Pseudo-Tarrasch\t1. d4 d5 2. c4 e6 3. Nf3 c5\nD30\tQueen's Gambit Declined: Traditional Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Bg5\nD30\tQueen's Gambit Declined: Vienna Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Bg5 Bb4+\nD31\tQueen's Gambit Declined: Alapin Variation\t1. d4 e6 2. c4 b6 3. Nc3 d5\nD31\tQueen's Gambit Declined: Charousek Variation\t1. d4 d5 2. c4 e6 3. Nc3 Be7\nD31\tQueen's Gambit Declined: Janowski Variation\t1. d4 d5 2. c4 e6 3. Nc3 a6\nD31\tQueen's Gambit Declined: Queen's Knight Variation\t1. d4 d5 2. c4 e6 3. Nc3\nD31\tSemi-Slav Defense: Accelerated Move Order\t1. d4 d5 2. c4 e6 3. Nc3 c6\nD31\tSemi-Slav Defense: Marshall Gambit\t1. d4 d5 2. c4 e6 3. Nc3 c6 4. e4\nD31\tSemi-Slav Defense: Noteboom Variation\t1. d4 d5 2. c4 e6 3. Nc3 c6 4. Nf3 dxc4\nD32\tQueen's Gambit Declined: Tarrasch Defense\t1. d4 d5 2. c4 e6 3. Nc3 c5 4. cxd5 exd5\nD32\tTarrasch Defense\t1. d4 d5 2. c4 e6 3. Nc3 c5\nD32\tTarrasch Defense: Schara Gambit\t1. d4 d5 2. c4 e6 3. Nc3 c5 4. cxd5 cxd4\nD35\tQueen's Gambit Declined: Exchange Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 d5 4. cxd5\nD35\tQueen's Gambit Declined: Harrwitz Attack\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bf4\nD35\tQueen's Gambit Declined: Normal Defense\t1. d4 d5 2. c4 e6 3. Nc3 Nf6\nD37\tQueen's Gambit Declined: Barmen Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3 Nbd7\nD37\tQueen's Gambit Declined: Three Knights Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3\nD37\tQueen's Gambit Declined: Three Knights, Vienna Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3 dxc4\nD38\tQueen's Gambit Declined: Ragozin Defense\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3 Bb4\nD40\tQueen's Gambit Declined: Semi-Tarrasch Defense\t1. d4 Nf6 2. c4 e6 3. Nf3 d5 4. Nc3 c5\nD43\tSemi-Slav Defense\t1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6\nD50\tQueen's Gambit Declined: Been-Koomen Variation\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 c5\nD50\tQueen's Gambit Declined: Modern Variation\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5\nD51\tQueen's Gambit Declined: Modern Variation, Knight Defense\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Nbd7\nD53\tQueen's Gambit Declined\t1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7\nD70\tNeo-Gr\u00fcnfeld Defense: Goglidze Attack\t1. d4 Nf6 2. c4 g6 3. f3 d5\nD70\tNeo-Gr\u00fcnfeld Defense: with Nf3\t1. d4 Nf6 2. c4 g6 3. Nf3 d5\nD70\tNeo-Gr\u00fcnfeld Defense: with g3\t1. d4 Nf6 2. c4 g6 3. g3 d5\nD80\tGr\u00fcnfeld Defense\t1. d4 Nf6 2. c4 g6 3. Nc3 d5\nD80\tGr\u00fcnfeld Defense: Gibbon Gambit\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. g4\nD80\tGr\u00fcnfeld Defense: Lutikov Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. f3\nD80\tGr\u00fcnfeld Defense: Stockholm Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Bg5\nD80\tGr\u00fcnfeld Defense: Zaitsev Gambit\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. h4\nD81\tGr\u00fcnfeld Defense: Russian Variation, Accelerated Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Qb3\nD82\tGr\u00fcnfeld Defense: Brinckmann Attack\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Bf4\nD85\tGr\u00fcnfeld Defense: Exchange Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. cxd5 Nxd5\nD90\tGr\u00fcnfeld Defense: Three Knights Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Nf3\nD90\tGr\u00fcnfeld Defense: Three Knights Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 d5 4. Nf3 Bg7\nE00\tCatalan Opening\t1. d4 Nf6 2. c4 e6 3. g3\nE00\tCatalan Opening\t1. d4 Nf6 2. c4 e6 3. g3 d5\nE00\tCatalan Opening: Hungarian Gambit\t1. d4 Nf6 2. c4 e6 3. g3 e5\nE00\tIndian Defense\t1. d4 Nf6 2. c4 e6 3. Qb3\nE00\tIndian Defense: Devin Gambit\t1. d4 Nf6 2. c4 e6 3. g4\nE00\tIndian Defense: Seirawan Attack\t1. d4 Nf6 2. c4 e6 3. Bg5\nE01\tCatalan Opening: Closed\t1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2\nE02\tCatalan Opening: Open Defense\t1. d4 Nf6 2. c4 e6 3. g3 d5 4. Bg2 dxc4\nE10\tBlumenfeld Countergambit\t1. d4 Nf6 2. c4 e6 3. Nf3 c5 4. d5 b5\nE10\tIndian Defense: Anti-Nimzo-Indian\t1. d4 Nf6 2. c4 e6 3. Nf3\nE10\tIndian Defense: Dzindzi-Indian Defense\t1. d4 Nf6 2. c4 e6 3. Nf3 a6\nE10\tIndian Defense: D\u00f6ry Indian\t1. d4 Nf6 2. c4 e6 3. Nf3 Ne4\nE11\tBogo-Indian Defense\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+\nE11\tBogo-Indian Defense: Exchange Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 Bxd2+\nE11\tBogo-Indian Defense: Gr\u00fcnfeld Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Nbd2\nE11\tBogo-Indian Defense: Haiti Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 Nc6\nE11\tBogo-Indian Defense: New England Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Nfd2\nE11\tBogo-Indian Defense: Nimzowitsch Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 Qe7\nE11\tBogo-Indian Defense: Retreat Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 Be7\nE11\tBogo-Indian Defense: Vitolins Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 c5\nE11\tBogo-Indian Defense: Wade-Smyslov Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+ 4. Bd2 a5\nE12\tQueen's Indian Defense\t1. d4 Nf6 2. c4 e6 3. Nf3 b6\nE12\tQueen's Indian Defense: Kasparov Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. Nc3\nE12\tQueen's Indian Defense: Miles Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. Bf4\nE12\tQueen's Indian Defense: Petrosian Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. a3\nE14\tQueen's Indian Defense: Spassky System\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. e3\nE14\tQueen's Indian Defense: Spassky System\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. e3 Bb7\nE15\tQueen's Indian Defense: Fianchetto Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3\nE15\tQueen's Indian Defense: Fianchetto Variation, Nimzowitsch Variation\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Ba6\nE15\tQueen's Indian Defense: Fianchetto Variation, Traditional Line\t1. d4 Nf6 2. c4 e6 3. Nf3 b6 4. g3 Bb7\nE20\tNimzo-Indian Defense\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4\nE20\tNimzo-Indian Defense: Dilworth Gambit\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e4\nE20\tNimzo-Indian Defense: Kmoch Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. f3\nE20\tNimzo-Indian Defense: Mikenas Attack\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qd3\nE20\tNimzo-Indian Defense: Romanishin Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. g3\nE21\tNimzo-Indian Defense: Three Knights Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Nf3\nE22\tNimzo-Indian Defense: Spielmann Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qb3\nE24\tNimzo-Indian Defense: S\u00e4misch Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. a3\nE30\tNimzo-Indian Defense: Leningrad Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Bg5\nE32\tNimzo-Indian Defense: Classical Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qc2\nE33\tNimzo-Indian Defense: Classical Variation, Zurich Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qc2 Nc6\nE34\tNimzo-Indian Defense: Classical Variation, Noa Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qc2 d5\nE38\tNimzo-Indian Defense: Classical Variation, Berlin Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. Qc2 c5\nE40\tNimzo-Indian Defense: Rubinstein System\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3\nE40\tNimzo-Indian Defense: Rubinstein System, Taimanov Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 Nc6\nE41\tNimzo-Indian Defense: Rubinstein System\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 c5\nE43\tNimzo-Indian Defense: St. Petersburg Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 b6\nE46\tNimzo-Indian Defense: Normal Variation\t1. d4 Nf6 2. c4 e6 3. Nc3 Bb4 4. e3 O-O\nE60\tGr\u00fcnfeld Defense: Counterthrust Variation\t1. d4 Nf6 2. c4 g6 3. g3 Bg7 4. Bg2 d5\nE60\tIndian Defense: Anti-Gr\u00fcnfeld, Adorjan Gambit\t1. d4 Nf6 2. c4 g6 3. d5 b5\nE60\tIndian Defense: Anti-Gr\u00fcnfeld, Advance Variation\t1. d4 Nf6 2. c4 g6 3. d5\nE60\tIndian Defense: Anti-Gr\u00fcnfeld, Alekhine Variation\t1. d4 Nf6 2. c4 g6 3. f3\nE60\tIndian Defense: Anti-Gr\u00fcnfeld, Alekhine Variation, Leko Gambit\t1. d4 Nf6 2. c4 g6 3. f3 e5\nE60\tIndian Defense: Anti-Gr\u00fcnfeld, Basman-Williams Attack\t1. d4 Nf6 2. c4 g6 3. h4\nE60\tIndian Defense: West Indian Defense\t1. d4 Nf6 2. c4 g6\nE60\tKing's Indian Defense: Fianchetto Variation\t1. d4 Nf6 2. c4 g6 3. Nf3 Bg7 4. g3\nE60\tKing's Indian Defense: Fianchetto Variation, Immediate Fianchetto\t1. d4 Nf6 2. c4 g6 3. g3\nE60\tKing's Indian Defense: Normal Variation, King's Knight Variation\t1. d4 Nf6 2. Nf3 g6 3. c4\nE60\tKing's Indian Defense: Santasiere Variation\t1. d4 Nf6 2. c4 g6 3. Nf3 Bg7 4. b4\nE60\tQueen's Pawn, Mengarini Attack\t1. d4 Nf6 2. c4 g6 3. Qc2\nE61\tKing's Indian Defense\t1. d4 Nf6 2. c4 g6 3. Nc3\nE70\tKing's Indian Defense: Normal Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4\nE70\tKing's Indian Defense: Normal Variation\t1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6";
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

/* ---------- coached opening library (unchanged from v2) ---------- */
const M = (from, to, c) => ({ from: sqIdx(from), to: sqIdx(to), c });
const OPENINGS = [
  {
    id: "italian", side: "w", name: "Italian Game", tag: "Classical • Beginner friendly",
    blurb: "The oldest recorded opening. Develop fast, aim the bishop at f7, castle early. It teaches every classical principle at once.",
    line: [
      M("e2","e4","Claim the center immediately. The e-pawn opens lines for your queen and light-squared bishop — two pieces with one move."),
      M("e7","e5","Black answers symmetrically, staking an equal claim in the center."),
      M("g1","f3","Develop with a threat: the knight attacks the e5 pawn. Development that creates a threat gains time."),
      M("b8","c6","Black defends e5 while developing — the same principle in reverse."),
      M("f1","c4","The Italian bishop. From c4 it stares at f7, the one square defended only by Black's king."),
      M("f8","c5","Black mirrors, pointing a bishop at your f2."),
      M("c2","c3","Quiet but ambitious: c3 prepares d4, building a broad pawn center. Pawns support pieces; pieces don't like doing pawn work."),
      M("g8","f6","Black develops and counterattacks e4."),
      M("d2","d3","Solid. You protect e4, keep the tension, and finish development before opening the position."),
      M("d7","d6","Black solidifies e5 the same way."),
      M("e1","g1","Castle! Your king tucks away and the rook joins the game. Never launch an attack with your king still in the middle."),
      M("e8","g8","Both kings are safe. Now the middlegame plans begin: the d4 break, rook to e1, and the knight tour b1-d2-f1-g3."),
    ],
  },
  {
    id: "ruy", side: "w", name: "Ruy Lopez", tag: "Classical • The Spanish torture",
    blurb: "White's most respected try for an edge after 1.e4 e5. You pressure the defender of e5 and squeeze for the whole game.",
    line: [
      M("e2","e4","Center, lines, tempo — the classical first move."),
      M("e7","e5","Black holds the center."),
      M("g1","f3","Attack e5 while developing."),
      M("b8","c6","Black defends with the knight."),
      M("f1","b5","The Spanish move. You attack the knight that defends e5 — indirect pressure on the center itself."),
      M("a7","a6","Black puts the question to the bishop."),
      M("b5","a4","Keep the pressure alive. Trading on c6 is playable, but retreating keeps long-term pressure."),
      M("g8","f6","Black develops and hits e4."),
      M("e1","g1","Castle first — e4 is poisoned: if the knight grabs it, rook to e1 wins the material back with a better position."),
      M("f8","e7","Black plays it safe and prepares to castle."),
      M("f1","e1","Now the rook truly defends e4. Every piece has a job."),
      M("b7","b5","Black finally kicks the bishop with tempo."),
      M("a4","b3","The bishop lands on its dream diagonal, b3 to f7. Slow pressure is the Ruy's whole identity."),
      M("d7","d6","Black shores up e5. The famous Spanish middlegame begins: c3, h3, then d4."),
    ],
  },
  {
    id: "london", side: "w", name: "London System", tag: "System • Low theory",
    blurb: "A setup you can play against almost anything: d4, Bf4, e3, a pawn pyramid on c3-d4-e3. Structure over memorization.",
    line: [
      M("d2","d4","Take the center with the d-pawn — a positional, queenside-leaning approach."),
      M("d7","d5","Black claims the same ground."),
      M("c1","f4","The London move. Get this bishop OUT before playing e3, or it's buried behind its own pawn."),
      M("g8","f6","Black develops normally."),
      M("e2","e3","Now the pawn chain forms and the f1 bishop gets its diagonal."),
      M("e7","e6","Black mirrors the structure."),
      M("g1","f3","Knights before deciding on pawn breaks. This knight also supports a later hop to e5."),
      M("f8","d6","Black challenges your best piece — the f4 bishop."),
      M("f4","g3","Sidestep. If Black takes on g3, your h-pawn recaptures toward the center and opens the rook's file."),
      M("e8","g8","Black castles."),
      M("f1","d3","The bishop aims at h7 — the London's favorite target once Black castles short."),
      M("c7","c5","Black strikes at your center from the side."),
      M("c2","c3","The pyramid is complete: c3, d4, e3. Rock solid. Plans: knight to d2, knight to e5, sometimes the h-pawn march against the king."),
      M("b8","c6","A full, healthy London position. You know the plan; many opponents don't."),
    ],
  },
  {
    id: "qg", side: "w", name: "Queen's Gambit", tag: "Classical • Fight for the center",
    blurb: "Offer the c-pawn to deflect Black's central pawn. Not really a gambit — you regain it — but it wins the center fight.",
    line: [
      M("d2","d4","Occupy the center."),
      M("d7","d5","Black matches you."),
      M("c2","c4","The gambit: take my c-pawn and give up your grip on the center. If Black declines, you keep lasting pressure on d5."),
      M("e7","e6","The Declined — Black keeps the center solid at the cost of the c8 bishop's diagonal."),
      M("b1","c3","Pile onto d5."),
      M("g8","f6","Black defends d5 a second time."),
      M("c1","g5","Pin the defender! The f6 knight can't fight for d5 and e4 while pinned to the queen."),
      M("f8","e7","Black breaks the pin calmly."),
      M("e2","e3","Open the bishop's diagonal and reinforce d4."),
      M("e8","g8","Black castles into the main line."),
      M("g1","f3","Complete development. Next: bishop to d3 or rook to c1, then choose the minority attack or central play with e4."),
      M("b8","d7","The classical Queen's Gambit position. You have more space and clearer plans."),
    ],
  },
  {
    id: "sicilian", side: "b", name: "Sicilian Defense (Najdorf)", tag: "For Black • Fighting",
    blurb: "The most combative answer to 1.e4. Trade a flank pawn for a center pawn, own the c-file, and play for a win.",
    line: [
      M("e2","e4","White claims the center."),
      M("c7","c5","The Sicilian. You don't mirror — you attack d4 from the side. Asymmetry means imbalance, and imbalance means winning chances."),
      M("g1","f3","White prepares d4."),
      M("d7","d6","Control e5 and open the c8 bishop. A quiet move with a big job."),
      M("d2","d4","White breaks in the center."),
      M("c5","d4","Trade! Your c-pawn — a flank pawn — removes White's d-pawn, a center pawn. You've won the central exchange, and the half-open c-file is yours forever."),
      M("f3","d4","White recaptures with the knight."),
      M("g8","f6","Develop with a threat against e4 — force White to spend a move defending."),
      M("b1","c3","White defends e4."),
      M("a7","a6","The Najdorf move. Tiny but deep: it stops any piece landing on b5 and prepares the pawn breaks e5 and b5. Your plan: expand on the queenside, pressure the c-file, strike with d5 when ready."),
    ],
  },
  {
    id: "french", side: "b", name: "French Defense", tag: "For Black • Solid counterattack",
    blurb: "Build a wall, invite White forward, then chop the pawn chain down at its base. Strategic and resilient.",
    line: [
      M("e2","e4","White takes the center."),
      M("e7","e6","The French. You prepare d5 with full support instead of contesting e4 head-on."),
      M("d2","d4","White grabs maximum space."),
      M("d7","d5","Now strike. White must resolve the tension: push, trade, or defend."),
      M("b1","c3","White defends e4 with a piece."),
      M("g8","f6","Add a second attacker on e4. Keep asking questions."),
      M("c1","g5","White pins your knight."),
      M("f8","e7","Break the pin immediately — simple and sound."),
      M("e4","e5","White advances and gains space, but the pawn chain now has a fixed base on d4..."),
      M("f6","d7","Retreat with purpose. The knight reroutes, and your plan crystallizes: c5 hits d4, the base of the chain. Attack chains at the base, never the head. Later comes f6 to challenge e5 too."),
    ],
  },
  {
    id: "carokann", side: "b", name: "Caro-Kann Defense", tag: "For Black • Solid & healthy",
    blurb: "Like the French, but your light-squared bishop gets out BEFORE the pawn wall closes. Famously sound.",
    line: [
      M("e2","e4","White takes the center."),
      M("c7","c6","The Caro-Kann. You'll support d5 — but unlike the French, the c8 bishop's diagonal stays open."),
      M("d2","d4","White builds the big center."),
      M("d7","d5","Challenge it at once."),
      M("b1","c3","White defends e4 with the knight."),
      M("d5","e4","Trade in the center. You give up central presence for smooth, problem-free development."),
      M("c3","e4","White recaptures."),
      M("c8","f5","The point of the whole opening: this bishop develops actively BEFORE e6 locks it in. In the French this piece suffers; here it thrives."),
      M("e4","g3","White attacks the bishop."),
      M("f5","g6","Slide back, staying on the powerful diagonal toward White's king."),
      M("h2","h4","White lunges, threatening to trap the bishop."),
      M("h7","h6","Give the bishop an escape hatch on h7. Small prophylactic moves like this are the soul of the Caro-Kann."),
      M("g1","f3","White develops."),
      M("b8","d7","Classical setup complete. Your structure has no weaknesses; develop, castle, and outlast them."),
    ],
  },
  {
    id: "kid", side: "b", name: "King's Indian Defense", tag: "For Black • Attack the king",
    blurb: "Concede the center on purpose, coil behind the fianchetto, then detonate with e5 and a kingside pawn storm.",
    line: [
      M("d2","d4","White takes the center."),
      M("g8","f6","Develop first, decide on pawns later — the hypermodern creed."),
      M("c2","c4","White grabs more space."),
      M("g7","g6","Prepare the fianchetto. The g7 bishop will rake the long diagonal all game."),
      M("b1","c3","White develops."),
      M("f8","g7","The King's Indian bishop arrives. It looks blocked now — its moment comes later."),
      M("e2","e4","White builds the perfect center. You allowed it deliberately: a big center is a big target."),
      M("d7","d6","Restrain e5 for now and prepare your own e5 break."),
      M("g1","f3","White develops."),
      M("e8","g8","Castle before the fireworks."),
      M("f1","e2","White finishes developing."),
      M("e7","e5","The thematic strike! If White locks the center, the plan is famous: f5, f4, then the g-pawn charges — a pawn avalanche at the White king while White plays on the queenside. Whoever breaks through first wins."),
    ],
  },
];

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
  .ct-boardwrap { position:relative; width:100%; aspect-ratio:1; overflow:hidden; box-shadow:0 4px 16px rgba(0,0,0,.45); }
  .ct-board { display:grid; grid-template-columns:repeat(8,1fr); grid-template-rows:repeat(8,1fr); width:100%; height:100%; }
  .ct-sq { position:relative; display:flex; align-items:center; justify-content:center; user-select:none; -webkit-tap-highlight-color:transparent; }
  .ct-sq.light { background:var(--lt); } .ct-sq.dark { background:var(--dk); }
  .ct-sq.light.hl, .ct-sq.light.sel { background:var(--hlL); }
  .ct-sq.dark.hl, .ct-sq.dark.sel { background:var(--hlD); }
  .ct-sq.chk { background:radial-gradient(circle, #ff5a52 20%, #d9453e 70%) !important; }
  .ct-dot { width:26%; height:26%; border-radius:50%; background:rgba(20,20,20,.22); position:absolute; z-index:2; }
  .ct-ring { position:absolute; inset:0; border:4px solid rgba(20,20,20,.25); border-radius:50%; box-sizing:border-box; margin:3%; z-index:2; }
  .ct-coord { position:absolute; font-size:11px; font-weight:800; opacity:.95; z-index:1; }
  .ct-coord.f { bottom:2px; right:4px; } .ct-coord.r { top:2px; left:4px; }
  .ct-coord.onlight { color:var(--dk); } .ct-coord.ondark { color:var(--lt); }
  .ct-pw { width:100%; height:100%; display:flex; align-items:center; justify-content:center; }
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
  .ct-badge { display:inline-block; min-width:22px; text-align:center; border-radius:6px; font-size:11px; font-weight:900; padding:3px 6px; margin-right:8px; }
  .b-best { background:#1f7a3d; color:#fff; } .b-good { background:#3a7ca5; color:#fff; }
  .b-inac { background:#d9b02f; color:#231f10; } .b-mist { background:#e8871e; color:#fff; } .b-blun { background:#c93b3b; color:#fff; }
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
const Settings = createContext({ sound: true, voice: false, theme: "green" });

/* ---------- shared UI ---------- */
function Board({ board, flipped, onTap, selected, targets, lastMove, checkSq }) {
  const order = [...Array(64).keys()];
  const disp = flipped ? order.map((i) => 63 - i) : order;
  return (
    <div className="ct-boardout">
    <div className="ct-boardwrap">
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
            <div key={i} className={cls} onClick={onTap ? () => onTap(i) : undefined}>
              {isTarget && !p && <div className="ct-dot" />}
              {isTarget && p && <div className="ct-ring" />}
              {p && (
                <div className={"ct-pw" + (lastMove && lastMove.to === i ? " ct-pop" : "")}>
                  <PieceSVG code={p} />
                </div>
              )}
              {visF === 0 && <span className={"ct-coord r " + (isLight ? "onlight" : "ondark")}>{8 - r}</span>}
              {visR === 7 && <span className={"ct-coord f " + (isLight ? "onlight" : "ondark")}>{FILESTR[f]}</span>}
            </div>
          );
        })}
      </div>
    </div>
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
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
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
        const scored = rootSearch(before, 2);
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
  const { sound } = useContext(Settings);
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
function FreePlay({ profile, updateProfile }) {
  const { sound } = useContext(Settings);
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
      const m = enginePick(state, level.depth, level.margin);
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

  if (setup) {
    return (
      <>
        <div className="ct-elochip">
          <div className="num">{profile.elo}</div>
          <div className="lbl">YOUR ELO RATING • {profile.games} games • {profile.wins} wins</div>
        </div>
        <Coach text="Pick an opponent and a color. Win and your rating climbs; lose and it dips — just like real rated chess. Every game gets a full move-by-move review afterward." />
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
      <Board board={state.board} flipped={userColor === "b"} onTap={handleTap} selected={selected} targets={targets} lastMove={lastMove} checkSq={checkSq} />
      <CapturedTray board={state.board} color={userColor} />
      <div className="ct-moves">{moveList || "Game start"}</div>
      <div className="ct-controls">
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

/* ---------- App shell ---------- */
export default function ChessTrainer() {
  const [screen, setScreen] = useState({ name: "home" });
  const [ask, setAsk] = useState(null);
  const [settings, setSettings] = useState({ sound: true, voice: false, theme: "green" });
  const [profile, setProfile] = useState({ elo: 800, games: 0, wins: 0, streak: 0, lastDay: null });
  const [ecoRows, setEcoRows] = useState(() => parsePacked(ECO_EMBED));
  const [ecoFull, setEcoFull] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await loadStore("ct-settings", { sound: true, voice: false, theme: "green" });
      const p = await loadStore("ct-profile", { elo: 800, games: 0, wins: 0, streak: 0, lastDay: null });
      setSettings({ theme: "green", ...s });
      setProfile({ streak: 0, lastDay: null, ...p });
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
  const TRAINING = new Set(["learn", "play", "free", "lesson", "ecoview"]);
  const go = (s) => { if (TRAINING.has(s.name)) touchStreak(); setScreen(s); };

  const title =
    screen.name === "home" ? "♟ Chess Trainer" :
    screen.name === "openings" ? (screen.play ? "Play vs Coach" : "Coached Openings") :
    screen.name === "learn" || screen.name === "play" ? screen.opening.name :
    screen.name === "explorer" ? "Openings Database" :
    screen.name === "ecoview" ? screen.row[0] + " · " + screen.row[1] :
    screen.name === "free" ? "Free Play (Rated)" :
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

  return (
    <Settings.Provider value={settings}>
      <div className="ct-root" style={{ "--lt": T.lt, "--dk": T.dk, "--hlL": T.hlL, "--hlD": T.hlD }}>
        <style>{CSS}</style>
        <div className="ct-head">
          {screen.name !== "home" && <button className="ct-back" onClick={() => setScreen(backTarget())}>‹</button>}
          <h1>{title}</h1>
          <button className="ct-tgl" title={"Board theme: " + T.label} onClick={cycleTheme}>🎨</button>
          <button className={"ct-tgl" + (settings.sound ? "" : " off")} title="Clock-click sounds"
            onClick={() => { const s = { ...settings, sound: !settings.sound }; updateSettings(s); if (s.sound) playFX("move", true); }}>
            {settings.sound ? "🔊" : "🔇"}
          </button>
          <button className={"ct-tgl" + (settings.voice ? "" : " off")} title="Coach voice"
            onClick={() => { const s = { ...settings, voice: !settings.voice }; updateSettings(s); speak(s.voice ? "Voice coach on. Let's train!" : "", s.voice); if (!s.voice && window.speechSynthesis) window.speechSynthesis.cancel(); }}>
            🗣
          </button>
        </div>
        <div className="ct-body">

          {screen.name === "home" && (
            <>
              <div className="ct-home-hero">
                <div className="crown">🧔</div>
                <h2>Your coach is ready</h2>
                <p>Openings, strategy, fundamentals, rated games, and full game reviews.</p>
                <div className="ct-streak">🔥 {profile.streak || 0}-day training streak</div>
              </div>
              <div className="ct-card" onClick={() => go({ name: "explorer" })}>
                <span className="ct-tag">{ecoRows.length.toLocaleString()} openings{ecoFull ? " • full database" : ""}</span>
                <h3>🔍 Openings database</h3>
                <p>Every named opening and defense in the encyclopedia — searchable by name, ECO code, or first moves. Step through any line and ask the coach about it.</p>
              </div>
              <div className="ct-card" onClick={() => go({ name: "openings", play: false })}>
                <span className="ct-tag">Step-by-step</span>
                <h3>📖 Coached openings</h3>
                <p>8 core openings — 4 for White, 4 for Black — with a coach explanation for every single move.</p>
              </div>
              <div className="ct-card" onClick={() => go({ name: "openings", play: true })}>
                <span className="ct-tag">Interactive</span>
                <h3>♟ Play vs coach</h3>
                <p>Play the opening yourself. The coach cheers book moves and explains better ones when you stray.</p>
              </div>
              <div className="ct-card" onClick={() => go({ name: "free" })}>
                <span className="ct-tag">Rated • Elo {profile.elo}</span>
                <h3>⚔️ Free play</h3>
                <p>Rated games at 3 strengths. Your Elo rises and falls with results, and every game gets a move-by-move review.</p>
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
          {screen.name === "free" && <FreePlay profile={profile} updateProfile={updateProfile} />}

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
