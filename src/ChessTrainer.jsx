import React, { useState, useMemo, useEffect, useRef, createContext, useContext } from "react";

/* ============================================================
   CHESS TRAINER v2
   • Tournament-style SVG pieces on a green/cream board
   • Move / capture / check sounds + haptics (toggleable)
   • Voice coach (speech synthesis, toggleable)
   • Free Play vs engine (3 levels) with persistent Elo rating
   • Post-game move-by-move review with grades + AI deep review
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

/* ---------- SVG piece set (classic tournament style) ---------- */
function PieceSVG({ code, size = "86%" }) {
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

/* ---------- sound + voice ---------- */
let ACTX = null;
function actx() {
  if (!ACTX) ACTX = new (window.AudioContext || window.webkitAudioContext)();
  if (ACTX.state === "suspended") ACTX.resume();
  return ACTX;
}
function knock(freqA, freqB, dur, gain, when = 0) {
  const c = actx(), t = c.currentTime + when;
  const o = c.createOscillator(), g = c.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(freqA, t);
  o.frequency.exponentialRampToValueAtTime(freqB, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t); o.stop(t + dur + 0.02);
  // wooden click layer
  const len = Math.floor(c.sampleRate * 0.02);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const n = c.createBufferSource(); n.buffer = buf;
  const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1800;
  const ng = c.createGain(); ng.gain.setValueAtTime(gain * 0.5, t);
  n.connect(hp).connect(ng).connect(c.destination);
  n.start(t);
}
function playFX(kind, enabled) {
  if (!enabled) return;
  try {
    if (kind === "move") knock(210, 70, 0.09, 0.5);
    else if (kind === "capture") { knock(300, 90, 0.08, 0.55); knock(160, 55, 0.1, 0.45, 0.045); }
    else if (kind === "castle") { knock(210, 70, 0.08, 0.45); knock(210, 70, 0.08, 0.45, 0.1); }
    else if (kind === "check") { knock(660, 620, 0.14, 0.3); }
    else if (kind === "win") { [440, 554, 659, 880].forEach((f, i) => knock(f, f, 0.16, 0.28, i * 0.13)); }
    else if (kind === "lose") { [330, 262, 196].forEach((f, i) => knock(f, f, 0.2, 0.28, i * 0.16)); }
    if (navigator.vibrate) navigator.vibrate(12);
  } catch (e) { /* audio blocked until first tap — fine */ }
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
    const clean = String(text).replace(/[🧔♟📖🎓🧠💡⟲↩✓🎉🔊🗣›‹]/g, "").replace(/\s+/g, " ").trim();
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

/* ---------- opening library ---------- */
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

/* ---------- lessons ---------- */
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

/* ---------- styles ---------- */
const CSS = `
  .ct-root { min-height:100vh; background:#2c2a27; color:#ECEBE9; font-family:-apple-system,"Segoe UI",Roboto,sans-serif; display:flex; flex-direction:column; }
  .ct-head { display:flex; align-items:center; gap:8px; padding:12px 14px; background:#22201d; position:sticky; top:0; z-index:5; }
  .ct-head h1 { font-size:18px; font-weight:800; margin:0; flex:1; letter-spacing:.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ct-back { background:none; border:none; color:#b9b7b4; font-size:24px; padding:0 6px; cursor:pointer; line-height:1; }
  .ct-tgl { background:#3a3733; border:1px solid #4a463f; border-radius:9px; color:#ECEBE9; font-size:16px; padding:6px 9px; cursor:pointer; }
  .ct-tgl.off { opacity:.4; }
  .ct-body { flex:1; padding:12px; max-width:560px; width:100%; margin:0 auto; box-sizing:border-box; }
  .ct-card { background:#3a3733; border-radius:14px; padding:16px; margin-bottom:12px; cursor:pointer; border:1px solid #47443f; }
  .ct-card:active { background:#454138; }
  .ct-card h3 { margin:0 0 4px; font-size:17px; }
  .ct-card p { margin:0; color:#b6b3ae; font-size:13.5px; line-height:1.45; }
  .ct-tag { display:inline-block; font-size:11px; font-weight:700; color:#e8ab24; margin-bottom:6px; letter-spacing:.4px; text-transform:uppercase; }
  .ct-bubblewrap { display:flex; gap:10px; align-items:flex-start; margin-bottom:10px; }
  .ct-avatar { width:48px; height:48px; border-radius:50%; background:#4c6b3c; flex:none; display:flex; align-items:center; justify-content:center; font-size:27px; box-shadow:0 2px 6px rgba(0,0,0,.4); }
  .ct-bubble { background:#fff; color:#1c1b1a; border-radius:16px; border-top-left-radius:4px; padding:11px 13px; font-size:14px; line-height:1.45; flex:1; box-shadow:0 2px 8px rgba(0,0,0,.35); }
  .ct-boardwrap { position:relative; width:100%; aspect-ratio:1; border-radius:5px; overflow:hidden; box-shadow:0 4px 16px rgba(0,0,0,.45); }
  .ct-board { display:grid; grid-template-columns:repeat(8,1fr); grid-template-rows:repeat(8,1fr); width:100%; height:100%; }
  .ct-sq { position:relative; display:flex; align-items:center; justify-content:center; user-select:none; -webkit-tap-highlight-color:transparent; }
  .ct-sq.light { background:#EBECD0; } .ct-sq.dark { background:#739552; }
  .ct-sq.light.hl { background:#F5F682; } .ct-sq.dark.hl { background:#B9CA43; }
  .ct-sq.light.sel { background:#F5F682; } .ct-sq.dark.sel { background:#B9CA43; }
  .ct-sq.chk { background:radial-gradient(circle, #ff5a52 20%, #d9453e 70%) !important; }
  .ct-dot { width:26%; height:26%; border-radius:50%; background:rgba(20,20,20,.22); position:absolute; z-index:2; }
  .ct-ring { position:absolute; inset:0; border:4px solid rgba(20,20,20,.25); border-radius:50%; box-sizing:border-box; margin:3%; z-index:2; }
  .ct-coord { position:absolute; font-size:10px; font-weight:700; opacity:.9; z-index:1; }
  .ct-coord.f { bottom:1px; right:3px; } .ct-coord.r { top:1px; left:3px; }
  .ct-coord.onlight { color:#739552; } .ct-coord.ondark { color:#EBECD0; }
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
  .ct-input { width:100%; box-sizing:border-box; background:#22201d; border:1px solid #4a463f; color:#ECEBE9; border-radius:10px; padding:12px; font-size:14px; min-height:60px; font-family:inherit; }
  .ct-chips { display:flex; gap:8px; flex-wrap:wrap; margin:10px 0; }
  .ct-chip { background:#3f3c37; border:1px solid #55514a; color:#dbd8d2; border-radius:999px; padding:7px 12px; font-size:12.5px; cursor:pointer; }
  .ct-home-hero { text-align:center; padding:18px 8px 8px; }
  .ct-home-hero .crown { font-size:48px; }
  .ct-home-hero h2 { margin:8px 0 4px; font-size:23px; font-weight:800; }
  .ct-home-hero p { color:#b6b3ae; margin:0; font-size:13.5px; }
  .ct-status { text-align:center; margin-top:10px; font-weight:800; color:#e8ab24; }
  .ct-toprow { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; font-size:12.5px; color:#b6b3ae; }
  .ct-tray { display:flex; align-items:center; gap:0; min-height:22px; margin:3px 0; flex-wrap:wrap; }
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
  @media (prefers-reduced-motion: reduce) { .ct-progress > div { transition:none; } .ct-pop{animation:none;} }
`;

/* ---------- settings context ---------- */
const Settings = createContext({ sound: true, voice: false });

/* ---------- shared UI ---------- */
function Board({ board, flipped, onTap, selected, targets, lastMove, checkSq }) {
  const order = [...Array(64).keys()];
  const disp = flipped ? order.map((i) => 63 - i) : order;
  return (
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
              {visF === 7 && <span className={"ct-coord r " + (isLight ? "onlight" : "ondark")}>{8 - r}</span>}
              {visR === 7 && <span className={"ct-coord f " + (isLight ? "onlight" : "ondark")}>{FILESTR[f]}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CapturedTray({ board, color }) {
  // pieces of `color` that are missing from the board = captured by opponent
  const startCount = { P: 8, N: 2, B: 2, R: 2, Q: 1, K: 1 };
  const cur = { P: 0, N: 0, B: 0, R: 0, Q: 0, K: 0 };
  let myMat = 0, oppMat = 0;
  for (const p of board) {
    if (!p) continue;
    if (p[0] === color) { cur[p[1]]++; }
    if (p[1] !== "K") (p[0] === color ? (myMat += VAL[p[1]]) : (oppMat += VAL[p[1]]));
  }
  const caps = [];
  for (const t of ["P", "N", "B", "R", "Q"])
    for (let i = 0; i < startCount[t] - cur[t]; i++) caps.push(color + t);
  const diff = oppMat - myMat; // opponent leads by diff → shown on opponent tray
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

/* ---------- Learn mode ---------- */
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
    } else if (sound) playFX("move", sound);
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
  const [cursor, setCursor] = useState(history.length); // position after last move
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
        checkSq={gameStatus(shownState) !== "ok" && inCheck(shownState) ? kingIdx(shownState.board, shownState.turn) : null} />
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

/* ---------- Play vs Coach (openings) ---------- */
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
    setOver(text);
    if (!scoredRef.current) {
      scoredRef.current = true;
      const newElo = eloUpdate(profile.elo, level.elo, score);
      const delta = newElo - profile.elo;
      updateProfile({ ...profile, elo: newElo, games: profile.games + 1, wins: profile.wins + (score === 1 ? 1 : 0) });
      setOver(text + ` Your rating: ${newElo} (${delta >= 0 ? "+" : ""}${delta}).`);
      playFX(score === 1 ? "win" : score === 0 ? "lose" : "move", sound);
    }
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
  const [settings, setSettings] = useState({ sound: true, voice: false });
  const [profile, setProfile] = useState({ elo: 800, games: 0, wins: 0 });
  const loaded = useRef(false);

  useEffect(() => {
    (async () => {
      const s = await loadStore("ct-settings", { sound: true, voice: false });
      const p = await loadStore("ct-profile", { elo: 800, games: 0, wins: 0 });
      setSettings(s); setProfile(p); loaded.current = true;
    })();
  }, []);
  const updateSettings = (s) => { setSettings(s); saveStore("ct-settings", s); };
  const updateProfile = (p) => { setProfile(p); saveStore("ct-profile", p); };

  const go = (s) => setScreen(s);
  const title =
    screen.name === "home" ? "♟ Chess Trainer" :
    screen.name === "openings" ? (screen.play ? "Play vs Coach" : "Openings") :
    screen.name === "learn" || screen.name === "play" ? screen.opening.name :
    screen.name === "free" ? "Free Play (Rated)" :
    screen.name === "fundamentals" ? "Fundamentals" :
    screen.name === "strategy" ? "Strategy" :
    screen.name === "lesson" ? screen.lesson.title : "Chess Trainer";

  const backTarget = () => {
    if (screen.name === "learn" || screen.name === "play") return { name: "openings", play: screen.name === "play" };
    if (screen.name === "lesson") return { name: screen.from };
    return { name: "home" };
  };

  return (
    <Settings.Provider value={settings}>
      <div className="ct-root">
        <style>{CSS}</style>
        <div className="ct-head">
          {screen.name !== "home" && <button className="ct-back" onClick={() => go(backTarget())}>‹</button>}
          <h1>{title}</h1>
          <button className={"ct-tgl" + (settings.sound ? "" : " off")} title="Sound effects"
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
              </div>
              <div className="ct-card" onClick={() => go({ name: "openings", play: false })}>
                <span className="ct-tag">Step-by-step</span>
                <h3>📖 Learn openings</h3>
                <p>8 openings — 4 for White, 4 for Black — with a coach explanation for every single move.</p>
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
