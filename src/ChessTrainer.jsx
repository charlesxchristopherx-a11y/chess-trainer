import React, { useState, useMemo, useEffect, useRef } from "react";

/* ============================================================
   CHESS TRAINER — openings, strategy, fundamentals, coach play
   Board styling matches the classic green/cream tournament look.
   ============================================================ */

/* ---------- core chess engine ---------- */
const GLYPH = { K: "\u265A", Q: "\u265B", R: "\u265C", B: "\u265D", N: "\u265E", P: "\u265F" };
const VAL = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
const FILESTR = "abcdefgh";

const sqIdx = (name) => {
  const f = FILESTR.indexOf(name[0]);
  const r = parseInt(name[1], 10);
  return (8 - r) * 8 + f;
};
const idxName = (i) => FILESTR[i % 8] + (8 - Math.floor(i / 8));

function initialBoard() {
  const b = new Array(64).fill(null);
  const back = ["R", "N", "B", "Q", "K", "B", "N", "R"];
  for (let f = 0; f < 8; f++) {
    b[0 * 8 + f] = "b" + back[f];
    b[1 * 8 + f] = "bP";
    b[6 * 8 + f] = "wP";
    b[7 * 8 + f] = "w" + back[f];
  }
  return b;
}
const startState = () => ({
  board: initialBoard(),
  turn: "w",
  castling: { wK: true, wQ: true, bK: true, bQ: true },
  ep: null,
  full: 1,
});
const cloneState = (s) => ({
  board: s.board.slice(),
  turn: s.turn,
  castling: { ...s.castling },
  ep: s.ep,
  full: s.full,
});

const KN = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const KG = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const DIAG = [[-1,-1],[-1,1],[1,-1],[1,1]];
const ORTH = [[-1,0],[1,0],[0,-1],[0,1]];

function isAttacked(board, idx, byColor) {
  const r = Math.floor(idx / 8), f = idx % 8;
  const pd = byColor === "w" ? 1 : -1; // attacking pawn sits "below" for white
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
  // en passant capture
  if (type === "P" && to === s.ep && !captured) {
    const capIdx = (color === "w" ? tr + 1 : tr - 1) * 8 + tf;
    captured = s.board[capIdx];
    s.board[capIdx] = null;
  }
  s.board[to] = p;
  s.board[from] = null;
  // castling rook hop
  let castleSAN = null;
  if (type === "K" && Math.abs(tf - ff) === 2) {
    const home = color === "w" ? 7 : 0;
    if (tf === 6) { s.board[home * 8 + 5] = s.board[home * 8 + 7]; s.board[home * 8 + 7] = null; castleSAN = "O-O"; }
    else { s.board[home * 8 + 3] = s.board[home * 8 + 0]; s.board[home * 8 + 0] = null; castleSAN = "O-O-O"; }
  }
  // promotion (auto queen)
  let promo = false;
  if (type === "P" && (tr === 0 || tr === 7)) { s.board[to] = color + "Q"; promo = true; }
  // ep square
  s.ep = type === "P" && Math.abs(tr - fr) === 2 ? ((fr + tr) / 2) * 8 + tf : null;
  // castling rights
  if (type === "K") { s.castling[color + "K"] = false; s.castling[color + "Q"] = false; }
  if (from === sqIdx("a1") || to === sqIdx("a1")) s.castling.wQ = false;
  if (from === sqIdx("h1") || to === sqIdx("h1")) s.castling.wK = false;
  if (from === sqIdx("a8") || to === sqIdx("a8")) s.castling.bQ = false;
  if (from === sqIdx("h8") || to === sqIdx("h8")) s.castling.bK = false;
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
    const type = res.type;
    const cap = res.captured ? "x" : "";
    const pre = type === "P" ? (res.captured ? FILESTR[from % 8] : "") : type;
    san = pre + cap + idxName(to) + (res.promo ? "=Q" : "");
  }
  const st = gameStatus(res.state);
  if (st === "checkmate") san += "#";
  else if (st === "check") san += "+";
  return { san, ...res };
}

/* simple 1-ply coach engine for off-book replies */
function engineMove(state) {
  const moves = allLegalMoves(state);
  if (!moves.length) return null;
  const opp = state.turn === "w" ? "b" : "w";
  let best = null, bestScore = -Infinity;
  for (const m of moves) {
    const { state: ns, captured } = applyMove(state, m.from, m.to);
    if (gameStatus(ns) === "checkmate") return m;
    let score = captured ? VAL[captured[1]] * 10 : 0;
    const mover = state.board[m.from];
    if (isAttacked(ns.board, m.to, opp)) score -= VAL[mover[1]] * 8;
    const tf = m.to % 8, tr = Math.floor(m.to / 8);
    score += (3.5 - Math.abs(tf - 3.5)) + (3.5 - Math.abs(tr - 3.5)); // centre pull
    if (mover[1] === "N" || mover[1] === "B") score += 2; // develop
    if (mover[1] === "Q" && state.full < 6) score -= 3;
    score += Math.random() * 1.5;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

function toFEN(state) {
  let fen = "";
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = state.board[r * 8 + f];
      if (!p) empty++;
      else {
        if (empty) { fen += empty; empty = 0; }
        fen += p[0] === "w" ? p[1] : p[1].toLowerCase();
      }
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
  const rows = fen.split(" ")[0].split("/");
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += parseInt(ch, 10);
      else { b[r * 8 + f] = (ch === ch.toUpperCase() ? "w" : "b") + ch.toUpperCase(); f++; }
    }
  });
  return b;
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
      M("e8","g8","Both kings are safe. Now the middlegame plans begin: d4 breaks, Re1, Nbd2–f1–g3."),
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
      M("b5","a4","Keep the pin idea alive. Trading on c6 is playable, but retreating keeps long-term pressure."),
      M("g8","f6","Black develops and hits e4."),
      M("e1","g1","Castle first — e4 is poisoned: if Nxe4 you play Re1 and win material back with a better position."),
      M("f8","e7","Black plays it safe and prepares to castle."),
      M("f1","e1","Now the rook truly defends e4. Every piece has a job."),
      M("b7","b5","Black finally kicks the bishop with tempo."),
      M("a4","b3","The bishop lands on its dream diagonal, b3–f7. Slow pressure is the Ruy's whole identity."),
      M("d7","d6","Black shores up e5. The famous Spanish middlegame begins: c3, h3, d4."),
    ],
  },
  {
    id: "london", side: "w", name: "London System", tag: "System • Low theory",
    blurb: "A setup you can play against almost anything: d4, Bf4, e3, a pawn pyramid on c3–d4–e3. Great when you want structure over memorization.",
    line: [
      M("d2","d4","Take the center with the d-pawn — a positional, queenside-leaning approach."),
      M("d7","d5","Black claims the same ground."),
      M("c1","f4","The London move. Get this bishop OUT before playing e3, or it's buried behind its own pawn."),
      M("g8","f6","Black develops normally."),
      M("e2","e3","Now the pawn chain forms and the f1 bishop gets its diagonal."),
      M("e7","e6","Black mirrors the structure."),
      M("g1","f3","Knights before deciding on pawn breaks. f3 supports a later Ne5."),
      M("f8","d6","Black challenges your best piece — the f4 bishop."),
      M("f4","g3","Sidestep. If Black takes on g3, your h-pawn recaptures toward the center and opens the rook's file."),
      M("e8","g8","Black castles."),
      M("f1","d3","The bishop aims at h7 — the London's favorite target once Black castles short."),
      M("c7","c5","Black strikes at your center from the side."),
      M("c2","c3","The pyramid is complete: c3–d4–e3. Rock solid. Plans: Nbd2, Ne5, sometimes h4–h5 against the king."),
      M("b8","c6","A full, healthy London position. You know the plan; many opponents don't."),
    ],
  },
  {
    id: "qg", side: "w", name: "Queen's Gambit", tag: "Classical • Fight for the center",
    blurb: "Offer the c-pawn to deflect Black's central pawn. It's not really a gambit — you regain it — but it wins the fight for the center.",
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
      M("g1","f3","Complete development. Next: Bd3 or Rc1, then decide between the minority attack (b4–b5) or central play (e4)."),
      M("b8","d7","The classical QGD tabiya. You have more space and clearer plans."),
    ],
  },
  {
    id: "sicilian", side: "b", name: "Sicilian Defense (Najdorf)", tag: "For Black • Fighting",
    blurb: "The most combative answer to 1.e4. You trade a flank pawn for a center pawn and get an open c-file plus real winning chances.",
    line: [
      M("e2","e4","White claims the center."),
      M("c7","c5","The Sicilian. You don't mirror — you attack d4 from the side. Asymmetry means imbalance, and imbalance means winning chances."),
      M("g1","f3","White prepares d4."),
      M("d7","d6","Control e5 and open the c8 bishop. A quiet move with a big job."),
      M("d2","d4","White breaks in the center."),
      M("c5","d4","Trade! Your c-pawn (a flank pawn) removes White's d-pawn (a center pawn). You've won the central exchange — and the half-open c-file is yours forever."),
      M("f3","d4","White recaptures with the knight."),
      M("g8","f6","Develop with a threat against e4 — force White to spend a move defending."),
      M("b1","c3","White defends e4."),
      M("a7","a6","The Najdorf move. Tiny but deep: it stops Nb5/Bb5 forever and prepares ...e5 and ...b5. Your plan: expand queenside, pressure the c-file, strike with ...d5 when ready."),
    ],
  },
  {
    id: "french", side: "b", name: "French Defense", tag: "For Black • Solid counterattack",
    blurb: "Build a wall, invite White forward, then chop the pawn chain down at its base. Strategic, resilient, and rich in counterplay.",
    line: [
      M("e2","e4","White takes the center."),
      M("e7","e6","The French. You prepare ...d5 with full support instead of contesting e4 head-on."),
      M("d2","d4","White grabs maximum space."),
      M("d7","d5","Now strike. White must resolve the central tension: push, trade, or defend."),
      M("b1","c3","White defends e4 with a piece."),
      M("g8","f6","Add a second attacker on e4. Keep asking questions."),
      M("c1","g5","White pins your knight."),
      M("f8","e7","Break the pin immediately — simple and sound."),
      M("e4","e5","White advances and gains space, but the pawn chain now has a fixed base at d4..."),
      M("f6","d7","Retreat with purpose. The knight reroutes, and your plan crystallizes: ...c5 hits d4, the base of the chain. Attack chains at the base, never the head. Later comes ...f6 to challenge e5 too."),
    ],
  },
  {
    id: "carokann", side: "b", name: "Caro-Kann Defense", tag: "For Black • Solid & healthy",
    blurb: "Like the French, but your light-squared bishop gets out BEFORE the pawn wall closes. Famously sound structure.",
    line: [
      M("e2","e4","White takes the center."),
      M("c7","c6","The Caro-Kann. You'll support ...d5 — but unlike the French, the c8 bishop's diagonal stays open."),
      M("d2","d4","White builds the big center."),
      M("d7","d5","Challenge it at once."),
      M("b1","c3","White defends e4 with the knight."),
      M("d5","e4","Trade in the center. You give up central presence for smooth, problem-free development."),
      M("c3","e4","White recaptures."),
      M("c8","f5","The point of the whole opening: this bishop develops actively BEFORE ...e6 locks it in. In the French this piece suffers; here it thrives."),
      M("e4","g3","White attacks the bishop."),
      M("f5","g6","Slide back, staying on the powerful b1–h7 diagonal."),
      M("h2","h4","White lunges, threatening to trap the bishop with h5."),
      M("h7","h6","Give the bishop an escape hatch on h7. Small prophylactic moves like this are the soul of the Caro-Kann."),
      M("g1","f3","White develops."),
      M("b8","d7","Classical setup complete. Your structure has no weaknesses; play ...Ngf6, ...e6, castle, and outlast them."),
    ],
  },
  {
    id: "kid", side: "b", name: "King's Indian Defense", tag: "For Black • Attack the king",
    blurb: "Concede the center on purpose, coil behind the fianchetto, then detonate with ...e5 and a kingside pawn storm. For attackers.",
    line: [
      M("d2","d4","White takes the center."),
      M("g8","f6","Develop first, decide on pawns later — the hypermodern creed."),
      M("c2","c4","White grabs more space."),
      M("g7","g6","Prepare the fianchetto. The g7 bishop will rake the long diagonal all game."),
      M("b1","c3","White develops."),
      M("f8","g7","The King's Indian bishop arrives. It looks blocked now — its moment comes later."),
      M("e2","e4","White builds the 'perfect' center. You allowed it deliberately: a big center is a big target."),
      M("d7","d6","Restrain e5 for now and open your own ...e5 break."),
      M("g1","f3","White develops."),
      M("e8","g8","Castle before the fireworks."),
      M("f1","e2","White finishes developing."),
      M("e7","e5","The thematic strike! If White locks with d5, the plan is famous: ...f5, ...f4, then g5–g4 — a pawn avalanche at the White king while White plays on the queenside. Whoever breaks through first wins."),
    ],
  },
];

/* ---------- lesson library ---------- */
const FUNDAMENTALS = [
  {
    id: "values", title: "The board & piece values",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    body: [
      "Every trade decision starts with piece values: pawn = 1, knight = 3, bishop = 3, rook = 5, queen = 9. The king is priceless — losing it loses the game.",
      "These numbers are a guide, not law. A knight buried in the corner is worth less than an active one in the center. Activity bends the math.",
      "Rule of thumb: never trade a piece for one of lower value without a concrete reason (checkmate, winning material back, or destroying the king's shelter).",
    ],
  },
  {
    id: "center", title: "Control the center",
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
    body: [
      "The four center squares — d4, d5, e4, e5 — are the high ground. Pieces placed there reach the most squares: a knight in the center hits 8 squares; in the corner, only 2.",
      "Control the center with pawns when you can, with pieces when you must. That's the difference between classical openings (occupy it) and hypermodern ones (attack it from afar).",
      "In this position both sides fight for the center: White's e4 pawn and c4 bishop versus Black's e5 pawn and c6 knight.",
    ],
  },
  {
    id: "development", title: "Development & tempo",
    fen: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 5",
    body: [
      "The opening is a race to bring pieces to useful squares. Each move is one unit of time — a tempo. Wasting tempi (moving the same piece twice, grabbing pawns while undeveloped) loses the race.",
      "Order of business: knights and bishops out, castle, connect the rooks. Bring the queen out late — an early queen becomes a target that develops your opponent for free.",
      "Development with a threat is best of all: your opponent must respond, so your move was free.",
    ],
  },
  {
    id: "kingsafety", title: "King safety",
    fen: "r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 6",
    body: [
      "Castle early — usually within the first ten moves. It does two jobs at once: hides the king behind a pawn wall and activates a rook.",
      "After castling, think twice before moving the pawns in front of your king. Every pawn move creates a permanent hole.",
      "The most common beginner disaster: opening the center while your king still stands on its starting square. Open lines point straight at an uncastled king.",
    ],
  },
  {
    id: "fork", title: "Tactics: the fork",
    fen: "8/2r1k3/8/3N4/8/8/8/4K3 w - - 0 1",
    body: [
      "A fork is one piece attacking two targets at once. The defender can only save one.",
      "Knights are the fork champions — their jump can't be blocked, and they attack squares of one color while sitting safe on the other. Here the knight on d5 hits BOTH the king on e7 and the rook on c7. The king must move; the rook falls.",
      "Training habit: on every move, ask 'can any knight jump reach two of my big pieces?' — and ask the same about your opponent's.",
    ],
  },
  {
    id: "pin", title: "Tactics: the pin",
    fen: "rn1qkb1r/ppp1pppp/5n2/3p2B1/3P4/8/PPP1PPPP/RN1QKBNR b KQkq - 2 3",
    body: [
      "A pin freezes a piece because moving it would expose something more valuable behind it. Here White's bishop on g5 pins the f6 knight to the queen on d8.",
      "A pinned piece is half a piece: it can't defend, can't capture, can't join the fight. Pile attackers onto a pinned piece — it can't run.",
      "Absolute pin: the piece behind is the king, so moving the pinned piece is literally illegal. Relative pin: it's merely disastrous.",
    ],
  },
  {
    id: "skewer", title: "Tactics: the skewer",
    fen: "4q3/8/8/4k3/8/8/8/4RK2 w - - 0 1",
    body: [
      "A skewer is a pin in reverse: the MORE valuable piece stands in front and must move, exposing the piece behind it.",
      "Here the rook on e1 gives check. The Black king must step off the e-file — and the rook captures the queen on e8.",
      "Kings and queens standing on the same line (file, rank, or diagonal) are a standing invitation for a skewer. Notice those alignments — yours and theirs.",
    ],
  },
  {
    id: "endgame", title: "Endgame: the opposition",
    fen: "4k3/8/4K3/4P3/8/8/8/8 b - - 0 1",
    body: [
      "In king-and-pawn endings, the kings duel for squares. 'The opposition' means the kings face off with one square between them — and the player NOT to move wins the duel, forcing the other king to give way.",
      "Golden rule for the attacker: put your king IN FRONT of your pawn, not behind it. The king clears the path; the pawn walks in its shadow.",
      "Here White's king already stands proudly in front of the pawn with the opposition. Black's king must step aside, and the pawn marches through to promote.",
    ],
  },
];

const STRATEGY = [
  {
    id: "pawnstructure", title: "Pawn structure — the skeleton",
    fen: "r1bq1rk1/pp3ppp/2n1pn2/2pp4/3P4/2PBPN2/PP3PPP/RNBQ1RK1 w - - 0 8",
    body: [
      "Pawns are the only pieces that can't move backward, so every pawn move is permanent. The pawn structure is the skeleton of the position — it decides where pieces belong and where the play happens.",
      "Weak pawns: isolated (no friendly pawn on adjacent files), doubled (two on one file), backward (can't advance safely, can't be defended by a pawn). Weak pawns need pieces to babysit them.",
      "Strong pawns: passed pawns (no enemy pawn can stop them) and protected chains. Rule: attack a pawn chain at its base.",
    ],
  },
  {
    id: "openfiles", title: "Open files & rooks",
    fen: "3r1rk1/pp3ppp/2n1bn2/8/8/2N1BN2/PP3PPP/3R1RK1 w - - 0 14",
    body: [
      "Rooks are useless behind their own pawns. They need open files — files with no pawns — like a cannon needs a clear line of fire.",
      "The plan is always three steps: (1) seize the open file with a rook, (2) double rooks on it, (3) invade the 7th rank, where the rook eats pawns and traps the king.",
      "When one file is open, whoever controls it usually controls the game. Fight for it immediately — the first rook there often keeps it.",
    ],
  },
  {
    id: "outposts", title: "Outposts — a knight's dream",
    fen: "r2q1rk1/pp2bppp/2n1pn2/3pN3/3P4/2NBP3/PP3PPP/R2Q1RK1 b - - 5 10",
    body: [
      "An outpost is a square in enemy territory that no enemy pawn can ever attack — protected by one of your own pawns. Plant a knight there and it's a permanent thorn.",
      "Here White's knight on e5 sits on a perfect outpost: supported by the d4 pawn, and no Black pawn can ever chase it (the d and f pawns have passed by or can't reach).",
      "A knight on a central outpost on the 5th or 6th rank is often worth more than a rook's five points suggest. Creating and occupying outposts is a complete middlegame plan by itself.",
    ],
  },
  {
    id: "bishoppair", title: "Good bishop, bad bishop, bishop pair",
    fen: "2r2rk1/1b3ppp/pq2p3/1p1n4/3P4/1BN1P3/PP3PPP/R2Q1RK1 w - - 0 15",
    body: [
      "A bishop is 'bad' when its own pawns stand on its color and cage it in. Fix it by trading it off, or by moving the pawns to the other color.",
      "The bishop pair (both bishops vs. bishop+knight or two knights) is a real advantage in open positions — together the two bishops cover every square color and slice across the whole board.",
      "Matchup rule: bishops love open positions and play on both wings; knights love closed positions and fixed targets. Trade toward the minor piece your pawn structure favors.",
    ],
  },
  {
    id: "trading", title: "When to trade pieces",
    fen: "r2q1rk1/ppp2ppp/2npbn2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 4 7",
    body: [
      "Trade when: you're ahead in material (simplification magnifies your edge), you're cramped (fewer pieces need less room), or the enemy piece is better than yours.",
      "Avoid trades when: you're behind in material, you're the one attacking (you need attackers!), or your pieces are the active ones.",
      "Never trade on autopilot. Before every exchange ask: whose remaining pieces get better? That question alone will win you games.",
    ],
  },
  {
    id: "planning", title: "Making a plan",
    fen: "r1bq1rk1/pp2ppbp/2np1np1/8/2PNP3/2N1B3/PP2BPPP/R2Q1RK1 b - - 6 8",
    body: [
      "A plan doesn't need to be deep — it needs to exist. Weak players move pieces; strong players move pieces toward something.",
      "Read the position for clues: Where are the open files? Which side do my pawns point toward? (Attack that side.) What's my worst piece? (Improve it.) What's their weakest pawn or square? (Target it.)",
      "The improvement loop that never fails: find your worst-placed piece and give it a better home. Repeat. When every piece stands proudly, tactics appear on their own.",
    ],
  },
];

/* ---------- UI pieces ---------- */
const CSS = `
  .ct-root { min-height: 100vh; background: #2c2a27; color: #ECEBE9; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; display:flex; flex-direction:column; }
  .ct-head { display:flex; align-items:center; gap:10px; padding:14px 16px; background:#22201d; position:sticky; top:0; z-index:5; }
  .ct-head h1 { font-size:19px; font-weight:800; margin:0; letter-spacing:.2px; }
  .ct-back { background:none; border:none; color:#b9b7b4; font-size:22px; padding:2px 8px; cursor:pointer; }
  .ct-body { flex:1; padding:14px; max-width:560px; width:100%; margin:0 auto; box-sizing:border-box; }
  .ct-card { background:#3a3733; border-radius:14px; padding:16px; margin-bottom:12px; cursor:pointer; border:1px solid #47443f; }
  .ct-card:active { background:#454138; }
  .ct-card h3 { margin:0 0 4px; font-size:17px; }
  .ct-card p { margin:0; color:#b6b3ae; font-size:13.5px; line-height:1.45; }
  .ct-tag { display:inline-block; font-size:11px; font-weight:700; color:#e8ab24; margin-bottom:6px; letter-spacing:.4px; text-transform:uppercase; }
  .ct-bubblewrap { display:flex; gap:10px; align-items:flex-start; margin-bottom:12px; }
  .ct-avatar { width:52px; height:52px; border-radius:50%; background:#4c6b3c; flex:none; display:flex; align-items:center; justify-content:center; font-size:30px; box-shadow:0 2px 6px rgba(0,0,0,.4); }
  .ct-bubble { background:#fff; color:#1c1b1a; border-radius:16px; border-top-left-radius:4px; padding:12px 14px; font-size:14.5px; line-height:1.45; flex:1; box-shadow:0 2px 8px rgba(0,0,0,.35); }
  .ct-bubble b { font-weight:800; }
  .ct-boardwrap { position:relative; width:100%; aspect-ratio:1; border-radius:6px; overflow:hidden; box-shadow:0 4px 16px rgba(0,0,0,.45); }
  .ct-board { display:grid; grid-template-columns:repeat(8,1fr); grid-template-rows:repeat(8,1fr); width:100%; height:100%; }
  .ct-sq { position:relative; display:flex; align-items:center; justify-content:center; user-select:none; }
  .ct-sq.light { background:#EBECD0; } .ct-sq.dark { background:#739552; }
  .ct-sq.light.hl { background:#F5F682; } .ct-sq.dark.hl { background:#B9CA43; }
  .ct-sq.light.sel { background:#F5F682; } .ct-sq.dark.sel { background:#B9CA43; }
  .ct-piece { font-size: clamp(26px, 9.4vw, 52px); line-height:1; cursor:pointer; }
  .ct-piece.w { color:#f9f9f9; text-shadow: 0 0 1px #7a7a7a, 0 1.5px 2px rgba(0,0,0,.45); }
  .ct-piece.b { color:#3f3d3a; text-shadow: 0 0 1px #14130f, 0 1.5px 2px rgba(0,0,0,.35); }
  .ct-dot { width:26%; height:26%; border-radius:50%; background:rgba(20,20,20,.22); position:absolute; }
  .ct-ring { position:absolute; inset:0; border:4px solid rgba(20,20,20,.22); border-radius:50%; box-sizing:border-box; margin:4%; }
  .ct-coord { position:absolute; font-size:10px; font-weight:700; opacity:.85; }
  .ct-coord.f { bottom:1px; right:3px; } .ct-coord.r { top:1px; left:3px; }
  .ct-coord.onlight { color:#739552; } .ct-coord.ondark { color:#EBECD0; }
  .ct-controls { display:flex; gap:10px; justify-content:center; margin-top:14px; flex-wrap:wrap; }
  .ct-btn { background:#3a3733; color:#ECEBE9; border:1px solid #4a463f; border-radius:10px; padding:11px 16px; font-size:14px; font-weight:700; cursor:pointer; }
  .ct-btn:disabled { opacity:.35; }
  .ct-btn.primary { background:#81B64C; border-color:#6d9c40; color:#fff; box-shadow:0 3px 0 #5d8a35; }
  .ct-btn.orange { background:#e8871e; border-color:#c9720f; color:#fff; box-shadow:0 3px 0 #b06209; }
  .ct-progress { height:10px; background:#22201d; border-radius:6px; margin-top:14px; overflow:hidden; }
  .ct-progress > div { height:100%; background:#e8871e; border-radius:6px; transition:width .25s; }
  .ct-moves { margin-top:10px; font-size:13px; color:#cfccc6; line-height:1.7; word-spacing:2px; min-height:20px; }
  .ct-moves b { color:#fff; }
  .ct-lesson p { font-size:14.5px; line-height:1.6; color:#dedcd7; margin:0 0 12px; }
  .ct-modal { position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:flex-end; justify-content:center; z-index:20; }
  .ct-sheet { background:#33312d; width:100%; max-width:560px; border-radius:18px 18px 0 0; padding:18px; box-sizing:border-box; max-height:80vh; overflow:auto; }
  .ct-input { width:100%; box-sizing:border-box; background:#22201d; border:1px solid #4a463f; color:#ECEBE9; border-radius:10px; padding:12px; font-size:14px; min-height:64px; font-family:inherit; }
  .ct-chips { display:flex; gap:8px; flex-wrap:wrap; margin:10px 0; }
  .ct-chip { background:#3f3c37; border:1px solid #55514a; color:#dbd8d2; border-radius:999px; padding:7px 12px; font-size:12.5px; cursor:pointer; }
  .ct-home-hero { text-align:center; padding:22px 8px 10px; }
  .ct-home-hero .crown { font-size:52px; }
  .ct-home-hero h2 { margin:8px 0 4px; font-size:24px; font-weight:800; }
  .ct-home-hero p { color:#b6b3ae; margin:0; font-size:14px; }
  .ct-mini { width:200px; margin:0 auto 14px; }
  .ct-status { text-align:center; margin-top:10px; font-weight:800; color:#e8ab24; }
  .ct-toprow { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; font-size:13px; color:#b6b3ae; }
  @media (prefers-reduced-motion: reduce) { .ct-progress > div { transition:none; } }
`;

function Board({ board, flipped, onTap, selected, targets, lastMove, small }) {
  const order = [...Array(64).keys()];
  const disp = flipped ? order.map((i) => 63 - i) : order;
  return (
    <div className={"ct-boardwrap" + (small ? " ct-mini" : "")}>
      <div className="ct-board">
        {disp.map((i, vis) => {
          const r = Math.floor(i / 8), f = i % 8;
          const isLight = (r + f) % 2 === 0;
          const p = board[i];
          const isSel = selected === i;
          const isTarget = targets && targets.includes(i);
          const isLast = lastMove && (lastMove.from === i || lastMove.to === i);
          const visR = Math.floor(vis / 8), visF = vis % 8;
          return (
            <div key={i}
              className={"ct-sq " + (isLight ? "light" : "dark") + (isLast ? " hl" : "") + (isSel ? " sel" : "")}
              onClick={onTap ? () => onTap(i) : undefined}>
              {isTarget && !p && <div className="ct-dot" />}
              {isTarget && p && <div className="ct-ring" />}
              {p && <span className={"ct-piece " + p[0]}>{GLYPH[p[1]]}</span>}
              {!small && visF === 7 && (
                <span className={"ct-coord r " + (isLight ? "onlight" : "ondark")}>{8 - r}</span>
              )}
              {!small && visR === 7 && (
                <span className={"ct-coord f " + (isLight ? "onlight" : "ondark")}>{FILESTR[f]}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Coach({ children }) {
  return (
    <div className="ct-bubblewrap">
      <div className="ct-avatar">🧔</div>
      <div className="ct-bubble">{children}</div>
    </div>
  );
}

/* ---------- Ask Coach (AI) ---------- */
function AskCoach({ context, onClose }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [err, setErr] = useState(null);

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
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await r.json();
      const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      if (text) setAnswer(text);
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
          {["Why is this move good?", "What's the plan from here?", "What should I watch out for?", "What's my worst piece?"].map((c) => (
            <button key={c} className="ct-chip" onClick={() => { setQ(c); ask(c); }}>{c}</button>
          ))}
        </div>
        <textarea className="ct-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything about this position..." />
        <div className="ct-controls">
          <button className="ct-btn primary" disabled={busy} onClick={() => ask()}>{busy ? "Thinking…" : "Ask"}</button>
          <button className="ct-btn" onClick={onClose}>Close</button>
        </div>
        {answer && <Coach>{answer}</Coach>}
        {err && <p style={{ color: "#ff9c9c", fontSize: 13 }}>{err}</p>}
        {busy && <p style={{ color: "#b6b3ae", fontSize: 13, textAlign: "center" }}>The coach is studying the board…</p>}
      </div>
    </div>
  );
}

/* ---------- Learn mode (step through a line) ---------- */
function LearnMode({ opening, onExit }) {
  const [step, setStep] = useState(0); // number of moves played
  const [ask, setAsk] = useState(false);
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

  const cur = step > 0 ? opening.line[step - 1] : null;
  const moveList = sans.map((s, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${s}` : s)).join("  ");

  return (
    <>
      <Coach>
        {step === 0 ? (
          <><b>{opening.name}.</b> {opening.blurb} Tap <b>Next</b> and I'll walk you through it move by move.</>
        ) : (
          <><b>{sans[sans.length - 1]}</b> — {cur.c}</>
        )}
      </Coach>
      <Board board={state.board} flipped={flipped} lastMove={lastMove} />
      <div className="ct-progress"><div style={{ width: (step / opening.line.length) * 100 + "%" }} /></div>
      <div className="ct-moves">{moveList || "Starting position"}</div>
      <div className="ct-controls">
        <button className="ct-btn" disabled={step === 0} onClick={() => setStep(step - 1)}>‹ Back</button>
        <button className="ct-btn primary" disabled={step === opening.line.length} onClick={() => setStep(step + 1)}>
          {step === opening.line.length ? "Line complete ✓" : "Next ›"}
        </button>
        <button className="ct-btn orange" onClick={() => setAsk(true)}>🧔 Ask coach</button>
      </div>
      {step === opening.line.length && (
        <div className="ct-status">Line learned! Now try it in “Play vs Coach”.</div>
      )}
      {ask && (
        <AskCoach onClose={() => setAsk(false)} context={{
          mode: "Studying an opening line step by step",
          opening: opening.name, fen: toFEN(state), moves: moveList,
        }} />
      )}
    </>
  );
}

/* ---------- Play vs Coach ---------- */
function PlayMode({ opening, onExit }) {
  const userColor = opening.side;
  const flipped = userColor === "b";
  const [state, setState] = useState(startState);
  const [selected, setSelected] = useState(null);
  const [targets, setTargets] = useState([]);
  const [lastMove, setLastMove] = useState(null);
  const [bookStep, setBookStep] = useState(0);
  const [offBook, setOffBook] = useState(false);
  const [msg, setMsg] = useState(null);
  const [sans, setSans] = useState([]);
  const [over, setOver] = useState(null);
  const [ask, setAsk] = useState(false);
  const [pendingUndo, setPendingUndo] = useState(null); // snapshot before an off-book user move
  const [hintSq, setHintSq] = useState(null);
  const coachTimer = useRef(null);

  const inBook = !offBook && bookStep < opening.line.length;
  const bookMove = inBook ? opening.line[bookStep] : null;

  const pushMove = (st, from, to) => {
    const res = makeSAN(st, from, to);
    setSans((s) => [...s, res.san]);
    setLastMove({ from, to });
    const status = gameStatus(res.state);
    if (status === "checkmate") setOver(res.state.turn === userColor ? "Checkmate — the coach wins this one. Rematch?" : "Checkmate — you win! 🎉");
    else if (status === "stalemate") setOver("Stalemate — a draw.");
    return res.state;
  };

  // Coach moves whenever it's the coach's turn
  useEffect(() => {
    if (over) return;
    if (state.turn === userColor) return;
    coachTimer.current = setTimeout(() => {
      let from, to, comment = null;
      if (inBook && bookMove) {
        from = bookMove.from; to = bookMove.to; comment = bookMove.c;
        setBookStep((b) => b + 1);
      } else {
        const m = engineMove(state);
        if (!m) return;
        from = m.from; to = m.to;
      }
      const ns = pushMove(state, from, to);
      setState(ns);
      if (comment) setMsg(comment);
      else if (!inBook) setMsg((prev) => prev); // keep last message off-book
    }, 550);
    return () => clearTimeout(coachTimer.current);
  }, [state, over]); // eslint-disable-line

  const handleTap = (i) => {
    if (over || state.turn !== userColor) return;
    setHintSq(null);
    const p = state.board[i];
    if (selected != null && targets.includes(i)) {
      const from = selected, to = i;
      // book check
      if (inBook && bookMove) {
        if (from === bookMove.from && to === bookMove.to) {
          const ns = pushMove(state, from, to);
          setState(ns); setSelected(null); setTargets([]);
          setBookStep((b) => b + 1);
          setMsg("✓ Book move! " + bookMove.c);
          setPendingUndo(null);
          return;
        } else {
          // off-book: snapshot for take-back
          const snap = { state: cloneState(state), sans: sans.slice(), lastMove, bookStep };
          const ns = pushMove(state, from, to);
          setState(ns); setSelected(null); setTargets([]);
          setPendingUndo(snap);
          const bookSAN = makeSAN(snap.state, bookMove.from, bookMove.to).san;
          setMsg(`That's playable, but the book move here is ${bookSAN} — ${bookMove.c} Take it back, or keep playing your way and we'll continue as a free game.`);
          setOffBook(true);
          return;
        }
      }
      const ns = pushMove(state, from, to);
      setState(ns); setSelected(null); setTargets([]);
      return;
    }
    if (p && p[0] === userColor && state.turn === userColor) {
      setSelected(i);
      setTargets(legalMoves(state, i));
    } else {
      setSelected(null); setTargets([]);
    }
  };

  const takeBack = () => {
    if (!pendingUndo) return;
    setState(pendingUndo.state);
    setSans(pendingUndo.sans);
    setLastMove(pendingUndo.lastMove);
    setBookStep(pendingUndo.bookStep);
    setOffBook(false);
    setPendingUndo(null);
    setMsg("Good instinct — let's try the book move. Tap Hint if you want me to show it.");
  };

  const hint = () => {
    if (inBook && bookMove && state.turn === userColor) {
      setSelected(bookMove.from);
      setTargets([bookMove.to]);
      setHintSq(bookMove.to);
      setMsg("Here's the book move — the highlighted piece to the marked square.");
    } else {
      setMsg("We're past the book line now — play what looks most active, and ask me anything!");
    }
  };

  const restart = () => {
    setState(startState()); setSelected(null); setTargets([]); setLastMove(null);
    setBookStep(0); setOffBook(false); setSans([]); setOver(null); setPendingUndo(null);
    setMsg(null);
  };

  const moveList = sans.map((s, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${s}` : s)).join("  ");
  const lineDone = bookStep >= opening.line.length && !offBook;

  return (
    <>
      <Coach>
        {over ? <b>{over}</b> :
         msg ? msg :
         userColor === "w"
          ? <>You have the White pieces. Play the <b>{opening.name}</b> — start with the first move. Tap a piece, then tap where it goes. Stuck? Tap <b>Hint</b>.</>
          : <>You have the Black pieces in the <b>{opening.name}</b>. I'll open for White — answer with the book moves. Tap <b>Hint</b> any time.</>}
        {lineDone && !over && <> <b>You've completed the whole book line — excellent!</b> We're in a real game now. Show me a plan!</>}
      </Coach>
      <div className="ct-toprow">
        <span>{offBook ? "Free play" : `Book: move ${Math.min(bookStep + 1, opening.line.length)} of ${opening.line.length}`}</span>
        <span>{state.turn === userColor ? "Your move" : "Coach is thinking…"}</span>
      </div>
      <Board board={state.board} flipped={flipped} onTap={handleTap} selected={selected} targets={targets} lastMove={lastMove} />
      <div className="ct-moves">{moveList || "Game start"}</div>
      <div className="ct-controls">
        <button className="ct-btn" onClick={hint}>💡 Hint</button>
        {pendingUndo && <button className="ct-btn orange" onClick={takeBack}>↩ Take back</button>}
        <button className="ct-btn" onClick={restart}>⟲ Restart</button>
        <button className="ct-btn orange" onClick={() => setAsk(true)}>🧔 Ask coach</button>
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

  const go = (s) => setScreen(s);
  const title =
    screen.name === "home" ? "Chess Trainer" :
    screen.name === "openings" ? (screen.play ? "Play vs Coach" : "Openings") :
    screen.name === "learn" ? screen.opening.name :
    screen.name === "play" ? screen.opening.name :
    screen.name === "fundamentals" ? "Fundamentals" :
    screen.name === "strategy" ? "Strategy" :
    screen.name === "lesson" ? screen.lesson.title : "Chess Trainer";

  const backTarget = () => {
    if (screen.name === "learn" || screen.name === "play") return { name: "openings", play: screen.name === "play" };
    if (screen.name === "lesson") return { name: screen.from };
    return { name: "home" };
  };

  return (
    <div className="ct-root">
      <style>{CSS}</style>
      <div className="ct-head">
        {screen.name !== "home" && <button className="ct-back" onClick={() => go(backTarget())}>‹</button>}
        <h1>{screen.name === "home" ? "♟ Chess Trainer" : title}</h1>
      </div>
      <div className="ct-body">

        {screen.name === "home" && (
          <>
            <div className="ct-home-hero">
              <div className="crown">🧔</div>
              <h2>Your coach is ready</h2>
              <p>Openings for White and Black, strategy, fundamentals, and one-on-one training games.</p>
            </div>
            <div className="ct-card" onClick={() => go({ name: "openings", play: false })}>
              <span className="ct-tag">Step-by-step</span>
              <h3>📖 Learn openings</h3>
              <p>Walk through 8 openings — 4 for White, 4 for Black — with a coach explanation for every single move.</p>
            </div>
            <div className="ct-card" onClick={() => go({ name: "openings", play: true })}>
              <span className="ct-tag">Interactive</span>
              <h3>♟ Play vs coach</h3>
              <p>Play the opening yourself. The coach answers with the book moves, cheers correct moves, and explains better ones when you stray.</p>
            </div>
            <div className="ct-card" onClick={() => go({ name: "fundamentals" })}>
              <span className="ct-tag">Foundations</span>
              <h3>🎓 Fundamentals</h3>
              <p>Piece values, the center, development, king safety, forks, pins, skewers, and endgame basics — with diagrams.</p>
            </div>
            <div className="ct-card" onClick={() => go({ name: "strategy" })}>
              <span className="ct-tag">Middlegame</span>
              <h3>🧠 Strategy</h3>
              <p>Pawn structure, open files, outposts, the bishop pair, trading, and how to actually make a plan.</p>
            </div>
          </>
        )}

        {screen.name === "openings" && (
          <>
            <Coach>
              {screen.play
                ? <>Pick an opening and we'll play it out together — you make the moves, I'll respond and coach you.</>
                : <>Pick an opening to study. <b>White repertoires</b> first, then <b>Black defenses</b>.</>}
            </Coach>
            <p style={{ color: "#b6b3ae", fontSize: 12, fontWeight: 800, letterSpacing: 1, margin: "6px 0" }}>PLAY AS WHITE</p>
            {OPENINGS.filter((o) => o.side === "w").map((o) => (
              <div key={o.id} className="ct-card" onClick={() => go({ name: screen.play ? "play" : "learn", opening: o })}>
                <span className="ct-tag">{o.tag}</span>
                <h3>{o.name}</h3>
                <p>{o.blurb}</p>
              </div>
            ))}
            <p style={{ color: "#b6b3ae", fontSize: 12, fontWeight: 800, letterSpacing: 1, margin: "14px 0 6px" }}>PLAY AS BLACK</p>
            {OPENINGS.filter((o) => o.side === "b").map((o) => (
              <div key={o.id} className="ct-card" onClick={() => go({ name: screen.play ? "play" : "learn", opening: o })}>
                <span className="ct-tag">{o.tag}</span>
                <h3>{o.name}</h3>
                <p>{o.blurb}</p>
              </div>
            ))}
          </>
        )}

        {screen.name === "learn" && <LearnMode opening={screen.opening} />}
        {screen.name === "play" && <PlayMode key={screen.opening.id} opening={screen.opening} />}

        {screen.name === "fundamentals" && (
          <>
            <Coach>Master these eight ideas and you'll beat most casual players without memorizing a single line.</Coach>
            {FUNDAMENTALS.map((l) => (
              <div key={l.id} className="ct-card" onClick={() => go({ name: "lesson", lesson: l, from: "fundamentals" })}>
                <h3>{l.title}</h3><p>{l.body[0].slice(0, 90)}…</p>
              </div>
            ))}
          </>
        )}
        {screen.name === "strategy" && (
          <>
            <Coach>Openings get you to a good middlegame — strategy tells you what to do once you're there.</Coach>
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
  );
}
