/*
 * WeiqiGo AI bot — self-contained Go engine.
 * ------------------------------------------
 * Fast in-memory board + heuristic playouts + MCTS (UCB1) search.
 * The authoritative move legality at the ROOT of each search is taken from
 * go-engine.js (suicide / simple-ko / positional-superko all correct), while
 * the deeper tree and the playouts use a lightweight board that enforces
 * suicide + simple-ko (fast, and more than enough for casual strength).
 *
 * Board encoding: flat Int16Array, 0 = empty, 1 = black, 2 = white.
 * Coordinates: r = row (0 top), c = col (0 left), matching the server.
 */
'use strict';

const EMPTY = 0, BLACK = 1, WHITE = 2;
function other(c) { return c === BLACK ? WHITE : BLACK; }

// ---- reusable scratch buffers (flood fill) ------------------------------
let _vis = null, _lib = null, _stack = null;
let _gen = 0, _libGen = 0;
function ensureBufs(n) {
  if (!_vis || _vis.length < n) {
    _vis = new Int32Array(n);
    _lib = new Int32Array(n);
    _stack = new Int32Array(n);
  }
}
// Generation counters must not overflow the marker array width; reset well
// before 2^31 so the marks stay exact.
function nextVisGen() {
  if (_gen > 1000000000) { _vis.fill(0); _lib.fill(0); _gen = 0; _libGen = 0; }
  return ++_gen;
}
function nextLibGen() {
  if (_libGen > 1000000000) { _vis.fill(0); _lib.fill(0); _gen = 0; _libGen = 0; }
  return ++_libGen;
}

class FastBoard {
  constructor(size) {
    this.size = size;
    this.n = size * size;
    this.cells = new Int16Array(this.n);
    this.ko = -1;             // index forbidden by simple ko, or -1
    this.passes = 0;          // consecutive passes
    this.emptyCount = this.n; // empty intersections (maintained incrementally)
  }
  idx(r, c) { return r * this.size + c; }
  clone() {
    const b = new FastBoard(this.size);
    b.cells.set(this.cells);
    b.ko = this.ko;
    b.passes = this.passes;
    b.emptyCount = this.emptyCount;
    return b;
  }
}

// Flood fill from start index; returns { count, liberties } for the group.
function groupInfo(board, start, color) {
  const cells = board.cells, size = board.size;
  ensureBufs(cells.length);
  const gen = nextVisGen(), libGen = nextLibGen();
  const vis = _vis, lib = _lib, stack = _stack;
  let sp = 0, count = 0, libs = 0;
  stack[sp++] = start; vis[start] = gen;
  while (sp > 0) {
    const p = stack[--sp];
    count++;
    const r = (p / size) | 0, c = p - r * size;
    if (r > 0) probe(p - size);
    if (r < size - 1) probe(p + size);
    if (c > 0) probe(p - 1);
    if (c < size - 1) probe(p + 1);
  }
  return { count, liberties: libs };

  function probe(q) {
    const v = cells[q];
    if (v === EMPTY) {
      if (lib[q] !== libGen) { lib[q] = libGen; libs++; }
    } else if (v === color) {
      if (vis[q] !== gen) { vis[q] = gen; stack[sp++] = q; }
    }
  }
}

// Collect every stone index of the group containing `start` into outArr.
function collectGroupStones(board, start, color, outArr) {
  const cells = board.cells, size = board.size;
  ensureBufs(cells.length);
  const gen = nextVisGen();
  const vis = _vis, stack = _stack;
  let sp = 0;
  stack[sp++] = start; vis[start] = gen;
  while (sp > 0) {
    const p = stack[--sp];
    outArr.push(p);
    const r = (p / size) | 0, c = p - r * size;
    if (r > 0) probe(p - size);
    if (r < size - 1) probe(p + size);
    if (c > 0) probe(p - 1);
    if (c < size - 1) probe(p + 1);
  }
  function probe(q) {
    if (cells[q] === color && vis[q] !== gen) { vis[q] = gen; stack[sp++] = q; }
  }
}

// Mutating apply of `color` at (r,c). Enforces suicide + simple ko.
// Returns { captured, ko, illegal } — on success `captured` is an array of
// removed stone indices, `ko` is the new ko index (-1 if none).
function applyMove(board, r, c, color) {
  const size = board.size, cells = board.cells;
  const pos = board.idx(r, c);
  if (cells[pos] !== EMPTY) return { illegal: true };
  if (pos === board.ko) return { illegal: true };
  cells[pos] = color;
  board.emptyCount--;
  const enemy = other(color);

  const capturedStones = [];
  // capture adjacent enemy groups with zero liberties
  let directEmpty = false;
  const neighbors = [];
  if (r > 0) neighbors.push(pos - size);
  if (r < size - 1) neighbors.push(pos + size);
  if (c > 0) neighbors.push(pos - 1);
  if (c < size - 1) neighbors.push(pos + 1);

  for (let i = 0; i < neighbors.length; i++) {
    const q = neighbors[i];
    const v = cells[q];
    if (v === EMPTY) { directEmpty = true; continue; }
    if (v === enemy) {
      const gi = groupInfo(board, q, enemy);
      if (gi.liberties === 0) {
        collectGroupStones(board, q, enemy, capturedStones);
      }
    }
  }

  if (capturedStones.length > 0) {
    // dedupe (a multi-stone group may be adjacent at several points)
    const uniq = new Set(capturedStones);
    capturedStones.length = 0;
    for (const s of uniq) capturedStones.push(s);
    for (let i = 0; i < capturedStones.length; i++) cells[capturedStones[i]] = EMPTY;
    board.emptyCount += capturedStones.length;
    // simple ko: exactly one stone captured AND the placed stone is now alone
    // with that one liberty -> set ko to the captured point.
    let ko = -1;
    if (capturedStones.length === 1) {
      const gi = groupInfo(board, pos, color);
      if (gi.count === 1 && gi.liberties === 1) ko = capturedStones[0];
    }
    board.ko = ko;
    board.passes = 0;
    return { captured: capturedStones, ko, illegal: false };
  }

  // no capture -> suicide check
  if (!directEmpty) {
    const gi = groupInfo(board, pos, color);
    if (gi.liberties === 0) { cells[pos] = EMPTY; board.emptyCount++; return { illegal: true }; }
  }
  board.ko = -1;
  board.passes = 0;
  return { captured: [], ko: -1, illegal: false };
}

// Pass on the FastBoard (returns whether the game has now ended via two passes).
function applyPass(board) {
  board.ko = -1;
  board.passes += 1;
  return board.passes >= 2;
}

// ---- opening prior -------------------------------------------------------
let _priorCache = { size: 0, map: null };
function hoshiLines(size) {
  if (size === 19) return [3, 9, 15];
  if (size === 13) return [3, 6, 9];
  if (size === 9) return [2, 4, 6];
  // generic fallback: thirds
  const third = Math.floor(size / 3);
  return [Math.min(2, size - 1), third, size - 1 - third, Math.max(size - 3, 0)].filter((v, i, a) => a.indexOf(v) === i);
}
function buildPriorMap(size) {
  if (_priorCache.size === size) return _priorCache.map;
  const map = new Float64Array(size * size);
  const lines = hoshiLines(size);
  const pts = [];
  for (const a of lines) for (const b of lines) pts.push([a, b]);
  const W = 40;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      let best = 0;
      for (const [pr, pc] of pts) {
        const d = Math.max(Math.abs(r - pr), Math.abs(c - pc));
        if (d <= 4) {
          const w = W / (1 + d * 2);
          if (w > best) best = w;
        }
      }
      map[r * size + c] = best;
    }
  }
  _priorCache = { size, map };
  return map;
}
function openingPrior(r, c, size, moveNum) {
  if (moveNum >= 10) return 0;
  const map = buildPriorMap(size);
  const fade = 1 - moveNum / 10;
  return map[r * size + c] * fade;
}

// Generate legal moves for `color` on the board, each with a heuristic score.
// Returns array of { r, c, score }. Does NOT mutate the board.
function generateMoves(board, color, moveNum) {
  const size = board.size, cells = board.cells;
  const priorMap = buildPriorMap(size);
  const out = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const pos = r * size + c;
      if (cells[pos] !== EMPTY) continue;
      if (pos === board.ko) continue;
      // trial apply to read captures / self-atari
      const before = cells[pos];
      cells[pos] = color;
      const enemy = other(color);
      let captured = 0;
      let ownAtari = false;
      let savesAtari = false;
      let adjOwn = 0, adjEnemy = 0;
      let directEmpty = false;
      const nb = [];
      if (r > 0) nb.push(pos - size);
      if (r < size - 1) nb.push(pos + size);
      if (c > 0) nb.push(pos - 1);
      if (c < size - 1) nb.push(pos + 1);

      for (const q of nb) {
        const v = cells[q];
        if (v === EMPTY) { directEmpty = true; continue; }
        if (v === color) {
          adjOwn++;
          if (groupInfo(board, q, color).liberties === 1) savesAtari = true;
        } else {
          adjEnemy++;
          const gi = groupInfo(board, q, enemy);
          if (gi.liberties === 0) captured += gi.count;
        }
      }
      if (captured === 0) {
        // check own group (suicide / self-atari)
        const gi = groupInfo(board, pos, color);
        if (gi.liberties === 0) { cells[pos] = before; continue; } // suicide
        if (gi.liberties === 1) ownAtari = true;
      }
      cells[pos] = before;

      // heuristic score (higher = better)
      let s = 0;
      if (captured > 0) s += 24 + 10 * captured;
      if (savesAtari) s += 12;
      if (ownAtari) s -= 9;
      s += 2.2 * adjOwn + 1.4 * adjEnemy;
      s += openingPrior(r, c, size, moveNum);
      out.push({ r, c, score: s });
    }
  }
  return out;
}

// Pick a move with softmax over scores (temperature). RNG: mulberry32.
function pickWeighted(moves, rng) {
  let maxS = -Infinity;
  for (const m of moves) if (m.score > maxS) maxS = m.score;
  let sum = 0;
  const weights = new Float64Array(moves.length);
  for (let i = 0; i < moves.length; i++) {
    const w = Math.exp((moves[i].score - maxS) * 0.35);
    weights[i] = w;
    sum += w;
  }
  let x = rng() * sum;
  for (let i = 0; i < moves.length; i++) {
    x -= weights[i];
    if (x <= 0) return moves[i];
  }
  return moves[moves.length - 1];
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- area scoring (Chinese rules) ---------------------------------------
function areaScore(board, komi) {
  const size = board.size, cells = board.cells;
  ensureBufs(cells.length);
  const gen = nextVisGen();
  const vis = _vis, stack = _stack;
  let black = 0, white = 0;
  // stones
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === BLACK) black++;
    else if (cells[i] === WHITE) white++;
  }
  // territory: flood fill empty regions
  for (let start = 0; start < cells.length; start++) {
    if (cells[start] !== EMPTY || vis[start] === gen) continue;
    let sp = 0;
    stack[sp++] = start; vis[start] = gen;
    let count = 0, touchB = false, touchW = false;
    while (sp > 0) {
      const p = stack[--sp];
      count++;
      const r = (p / size) | 0, c = p - r * size;
      if (r > 0) probe(p - size);
      if (r < size - 1) probe(p + size);
      if (c > 0) probe(p - 1);
      if (c < size - 1) probe(p + 1);
    }
    if (touchB && !touchW) black += count;
    else if (touchW && !touchB) white += count;
    continue;

    function probe(q) {
      const v = cells[q];
      if (v === EMPTY) {
        if (vis[q] !== gen) { vis[q] = gen; stack[sp++] = q; }
      } else if (v === BLACK) touchB = true;
      else touchW = true;
    }
  }
  const blackScore = black;
  const whiteScore = white + komi;
  return {
    black: blackScore,
    white: whiteScore,
    winner: blackScore > whiteScore ? BLACK : whiteScore > blackScore ? WHITE : null,
    margin: Math.abs(blackScore - whiteScore),
  };
}

// ---- playout -------------------------------------------------------------
function playout(board, color, komi, rng) {
  const maxMoves = board.size * board.size + board.size;
  const b = board.clone();
  let cur = color;
  let moveNum = 0;
  while (moveNum < maxMoves) {
    const moves = generateMoves(b, cur, moveNum);
    // Pass more readily as the board fills, so playouts converge to a real
    // score instead of filling every last dame point.
    const fill = 1 - b.emptyCount / (b.size * b.size);
    const passProb = 0.002 + (fill > 0.6 ? 0.03 : 0) + (fill > 0.85 ? 0.12 : 0);
    if (moves.length === 0 || rng() < passProb) {
      if (applyPass(b)) break;
      cur = other(cur);
      moveNum++;
      continue;
    }
    const m = pickWeighted(moves, rng);
    applyMove(b, m.r, m.c, cur);
    cur = other(cur);
    moveNum++;
  }
  const sc = areaScore(b, komi);
  return sc.winner;
}

// ---- MCTS node -----------------------------------------------------------
function Node(moveKey, parent, prior) {
  this.move = moveKey;       // "r,c" or "pass"
  this.parent = parent;
  this.prior = prior || 0;
  this.visits = 0;
  this.wins = 0;
  this.children = null;      // Map on demand
  this.untried = null;       // array of {key, prior} not yet expanded
}

function moveKeyFrom(r, c) { return r + ',' + c; }

const UCB_C = 1.35;
const PRIOR_WEIGHT = 14.0;

function bestChild(node) {
  const logParent = Math.log(Math.max(1, node.visits));
  let best = null, bestVal = -Infinity;
  for (const child of node.children.values()) {
    const visits = child.visits || 1e-9;
    const exploit = child.wins / visits;
    const explore = UCB_C * Math.sqrt(logParent / visits);
    const prior = (PRIOR_WEIGHT * child.prior) / (1 + child.visits);
    const val = exploit + explore + prior;
    if (val > bestVal) { bestVal = val; best = child; }
  }
  return best;
}

// Build a best-first ordered untried list (sorted descending by prior) and
// always include "pass" (its prior grows as the board fills, so a winning bot
// learns to close the game out).
function buildUntried(moveList, passPrior) {
  const arr = moveList.map(m => ({ key: m.r + ',' + m.c, prior: Math.max(0.01, m.score) }));
  arr.push({ key: 'pass', prior: passPrior != null ? passPrior : 0.02 });
  arr.sort((a, b) => a.prior - b.prior); // ascending: pop() yields highest prior first
  return arr;
}

function winValue(winner, rootColor) {
  if (winner == null) return 0.5;
  return winner === rootColor ? 1 : 0;
}

// ---- MCTS search ---------------------------------------------------------
// rootGame: authoritative GoGame instance (from go-engine.js) at the start of
//   our turn. We only use it to seed truly-legal moves + ko + passes.
// opts: { size, color('b'|'w'), komi, timeBudgetMs, seed }
// Returns root-level move statistics: [{ r, c, pass, visits, wins }] sorted.
function search(rootGame, opts) {
  const size = opts.size;
  const color = opts.color === 'black' || opts.color === 'b' ? BLACK : WHITE;
  const komi = opts.komi != null ? opts.komi : 7.5;
  const timeBudgetMs = opts.timeBudgetMs || 2500;
  const rng = mulberry32(opts.seed || (Date.now() & 0xffffffff));

  // Build root FastBoard from the authoritative game.
  const rootBoard = new FastBoard(size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const v = rootGame.board[r][c];
      if (v === 'b') rootBoard.cells[rootBoard.idx(r, c)] = BLACK;
      else if (v === 'w') rootBoard.cells[rootBoard.idx(r, c)] = WHITE;
    }
  }
  if (rootGame.koPoint) rootBoard.ko = rootBoard.idx(rootGame.koPoint[0], rootGame.koPoint[1]);
  rootBoard.passes = rootGame.passes || 0;

  const moveNum = countStones(rootGame.board);

  // Root moves: fast-heuristic scores, filtered to the authoritative legal set
  // (this keeps positional-superko / suicide / ko exactly correct at the root).
  const authoritative = new Set(rootGame.legalMoves(color === BLACK ? 'b' : 'w').map(m => m[0] + ',' + m[1]));
  const rootUntried = [];
  for (const m of generateMoves(rootBoard, color, moveNum)) {
    if (authoritative.has(m.r + ',' + m.c)) rootUntried.push(m);
  }
  const root = new Node(null, null, 0);
  const fill = 1 - rootBoard.emptyCount / (size * size);
  const passPrior = 0.02 + (fill > 0.5 ? 0.15 : 0) + (fill > 0.8 ? 0.8 : 0);
  root.untried = buildUntried(rootUntried, passPrior);

  const deadline = Date.now() + timeBudgetMs;
  let iterations = 0;

  if (opts.debug) console.error('[search] root built, legalMoves=', authoritative.size, 'rootUntried=', rootUntried.length);
  while (Date.now() < deadline) {
    if (opts.debug && (iterations < 10 || iterations % 200 === 0)) console.error('[search] iter', iterations, 'elapsed', Date.now() - (deadline - timeBudgetMs));
    const scratch = rootBoard.clone();
    let node = root;
    let b = scratch;
    let cur = color;
    let mn = moveNum;

    // selection + expansion + playout
    let innerGuard = 0;
    while (true) {
      if (++innerGuard > 100000) {
        throw new Error('search inner-loop runaway: untried=' + (node.untried ? node.untried.length : 'null') +
          ' children=' + (node.children ? node.children.size : 'null'));
      }
      if (node.untried === null) {
        node.untried = buildUntried(generateMoves(b, cur, mn));
      }
      if (node.untried.length > 0) {
        // expand the highest-prior untried move
        const choice = node.untried.pop();
        if (opts.debug && iterations === 0) console.error('[search] expanding', choice.key);
        const child = new Node(choice.key, node, choice.prior);
        if (!node.children) node.children = new Map();
        node.children.set(choice.key, child);
        node = child;
        let ended = false;
        if (choice.key === 'pass') ended = applyPass(b);
        else { const parts = choice.key.split(','); applyMove(b, +parts[0], +parts[1], cur); }
        if (opts.debug && iterations === 0) console.error('[search] applied move, playing out');
        cur = other(cur);
        mn++;
        if (ended) {
          backprop(node, winValue(areaScore(b, komi).winner, color));
        } else {
          backprop(node, winValue(playout(b, cur, komi, rng), color));
        }
        if (opts.debug && iterations === 0) console.error('[search] playout done');
        break;
      } else if (node.children && node.children.size > 0) {
        const child = bestChild(node);
        node = child;
        let ended = false;
        if (child.move === 'pass') ended = applyPass(b);
        else { const parts = child.move.split(','); applyMove(b, +parts[0], +parts[1], cur); }
        cur = other(cur);
        mn++;
        if (ended) {
          backprop(node, winValue(areaScore(b, komi).winner, color));
          break;
        }
        // else loop: continue descending from this child
      } else {
        // no untried moves and no children -> terminal (all moves exhausted)
        backprop(node, winValue(areaScore(b, komi).winner, color));
        break;
      }
    }
    iterations++;
  }

  // collect root stats
  const stats = [];
  if (root.children) {
    for (const [key, child] of root.children) {
      if (key === 'pass') stats.push({ pass: true, visits: child.visits, wins: child.wins });
      else {
        const parts = key.split(',');
        stats.push({ r: +parts[0], c: +parts[1], pass: false, visits: child.visits, wins: child.wins });
      }
    }
  }
  stats.sort((a, b) => b.visits - a.visits);
  return { stats, iterations };
}

function backprop(node, value) {
  let n = node;
  while (n) {
    n.visits++;
    n.wins += value;
    n = n.parent;
  }
}

function countStones(board) {
  let n = 0;
  for (const row of board) for (const v of row) if (v) n++;
  return n;
}

module.exports = {
  FastBoard,
  applyMove,
  applyPass,
  areaScore,
  generateMoves,
  playout,
  search,
  mulberry32,
  BLACK, WHITE, EMPTY,
};
