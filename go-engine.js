/*
 * WeiqiGo.com - Shared Go (Weiqi / 圍棋) rules engine
 * --------------------------------------------------------------
 * Vendored (unmodified) from the public WeiqiGo.com frontend so the bot's
 * move legality and scoring match the server exactly. Copyright and all
 * rights for this file belong to WeiqiGo.com; it is included here only for
 * protocol/rule compatibility, not relicensed under this repository's license.
 *
 * Authoritative legality / capture / ko / scoring logic shared by:
 *   - the browser board renderer (single player + online + spectate)
 *   - the AI web worker
 *   - the Node.js game server (move validation + result detection)
 *
 * Board: square grid of size N x N (N = 9, 13 or 19). Stones live on the
 * line intersections. Black plays first.
 *
 * Coordinates: row 0 = top, increasing downward; col 0 = left, increasing
 * rightward (mirrors the legacy renderer's [r,c] convention).
 *
 * Stone encoding: 'b' (black) | 'w' (white) | null (empty intersection).
 *
 * Rules implemented:
 *   - Capture: a group with zero liberties is removed.
 *   - Suicide is illegal (a play that leaves your own group with no
 *     liberties and captures nothing).
 *   - Positional superko: a play may not recreate any previous whole-board
 *     position (this subsumes the simple ko rule). Used for Chinese rules.
 *   - Pass: two consecutive passes end the game and trigger scoring.
 *   - Scoring: Chinese area scoring (stones on board + surrounded territory),
 *     white receives komi (default 7.5). Dead stones may be supplied to be
 *     treated as removed before counting.
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    global.Go = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BLACK = 'b';
  var WHITE = 'w';
  var DEFAULT_SIZE = 19;
  var DEFAULT_KOMI = 7.5;
  var SIZES = [9, 13, 19];

  function other(color) {
    return color === BLACK ? WHITE : BLACK;
  }

  function emptyBoard(size) {
    var b = [];
    for (var r = 0; r < size; r++) {
      var row = [];
      for (var c = 0; c < size; c++) row.push(null);
      b.push(row);
    }
    return b;
  }

  function cloneBoard(board) {
    var b = [];
    for (var r = 0; r < board.length; r++) b.push(board[r].slice());
    return b;
  }

  function boardKey(board) {
    // Compact whole-board string used for positional-superko detection.
    var s = '';
    for (var r = 0; r < board.length; r++) {
      for (var c = 0; c < board.length; c++) {
        var v = board[r][c];
        s += v === BLACK ? 'b' : v === WHITE ? 'w' : '.';
      }
    }
    return s;
  }

  var DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  // Collect the maximally-connected group of same-colour stones containing
  // (r,c), plus the set of its liberty points. Returns { stones, liberties }
  // where stones is an array of [r,c] and liberties is an array of [r,c].
  function collectGroup(board, r, c) {
    var size = board.length;
    var color = board[r][c];
    if (!color) return { stones: [], liberties: [] };
    var stones = [];
    var libSet = {};
    var seen = {};
    var stack = [[r, c]];
    seen[r + ',' + c] = true;
    while (stack.length) {
      var cur = stack.pop();
      var cr = cur[0], cc = cur[1];
      stones.push([cr, cc]);
      for (var i = 0; i < 4; i++) {
        var nr = cr + DIRS[i][0], nc = cc + DIRS[i][1];
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        var v = board[nr][nc];
        var k = nr + ',' + nc;
        if (v === null) {
          libSet[k] = [nr, nc];
        } else if (v === color && !seen[k]) {
          seen[k] = true;
          stack.push([nr, nc]);
        }
      }
    }
    var liberties = [];
    for (var key in libSet) {
      if (libSet.hasOwnProperty(key)) liberties.push(libSet[key]);
    }
    return { stones: stones, liberties: liberties };
  }

  function countLiberties(board, r, c) {
    return collectGroup(board, r, c).liberties.length;
  }

  // Try to place `color` at (r,c) on a COPY of `board`. Returns
  // { ok, board, captures:[[r,c]...], reason } without mutating the input.
  // koCheck(keyString) -> true if the resulting position is forbidden.
  function tryPlay(board, r, c, color, koCheck) {
    var size = board.length;
    if (r < 0 || r >= size || c < 0 || c >= size) return { ok: false, reason: 'off-board' };
    if (board[r][c] !== null) return { ok: false, reason: 'occupied' };

    var nb = cloneBoard(board);
    nb[r][c] = color;
    var opp = other(color);
    var captures = [];

    // Remove any adjacent opponent group left without liberties.
    for (var i = 0; i < 4; i++) {
      var nr = r + DIRS[i][0], nc = c + DIRS[i][1];
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
      if (nb[nr][nc] !== opp) continue;
      var grp = collectGroup(nb, nr, nc);
      if (grp.liberties.length === 0) {
        for (var s = 0; s < grp.stones.length; s++) {
          var st = grp.stones[s];
          if (nb[st[0]][st[1]] !== null) {
            nb[st[0]][st[1]] = null;
            captures.push([st[0], st[1]]);
          }
        }
      }
    }

    // Suicide check: after captures, the played stone's group must have a liberty.
    if (countLiberties(nb, r, c) === 0) {
      return { ok: false, reason: 'suicide' };
    }

    // Ko / positional superko.
    if (koCheck && koCheck(boardKey(nb))) {
      return { ok: false, reason: 'ko' };
    }

    return { ok: true, board: nb, captures: captures };
  }

  // ----------------------------------------------------------------- scoring
  // Chinese area scoring. deadMap is an optional object keyed "r,c" => true of
  // stones to treat as already removed (captured) before counting.
  // Returns { black, white, territory:{black,white,neutral}, stones:{black,white},
  //           winner, margin, komi }.
  function scoreArea(board, komi, deadMap) {
    var size = board.length;
    deadMap = deadMap || {};
    var work = cloneBoard(board);
    var capturedByBlack = 0, capturedByWhite = 0; // dead-stone bonus (Chinese: counts as area anyway)
    var s, r, c;

    // Remove dead stones.
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (deadMap[r + ',' + c] && work[r][c]) {
          if (work[r][c] === BLACK) capturedByWhite++;
          else capturedByBlack++;
          work[r][c] = null;
        }
      }
    }

    var stonesBlack = 0, stonesWhite = 0;
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (work[r][c] === BLACK) stonesBlack++;
        else if (work[r][c] === WHITE) stonesWhite++;
      }
    }

    // Flood-fill empty regions to assign territory.
    var seen = {};
    var terrBlack = 0, terrWhite = 0, terrNeutral = 0;
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (work[r][c] !== null || seen[r + ',' + c]) continue;
        var region = [];
        var borders = {};
        var stack = [[r, c]];
        seen[r + ',' + c] = true;
        while (stack.length) {
          var cur = stack.pop();
          var cr = cur[0], cc = cur[1];
          region.push([cr, cc]);
          for (var i = 0; i < 4; i++) {
            var nr = cr + DIRS[i][0], nc = cc + DIRS[i][1];
            if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
            var v = work[nr][nc];
            var k = nr + ',' + nc;
            if (v === null) {
              if (!seen[k]) { seen[k] = true; stack.push([nr, nc]); }
            } else {
              borders[v] = true;
            }
          }
        }
        if (borders[BLACK] && !borders[WHITE]) terrBlack += region.length;
        else if (borders[WHITE] && !borders[BLACK]) terrWhite += region.length;
        else terrNeutral += region.length;
      }
    }

    var black = stonesBlack + terrBlack;
    var white = stonesWhite + terrWhite + (komi || 0);
    var margin = black - white;
    return {
      black: black,
      white: white,
      komi: komi || 0,
      stones: { black: stonesBlack, white: stonesWhite },
      territory: { black: terrBlack, white: terrWhite, neutral: terrNeutral },
      captured: { byBlack: capturedByBlack, byWhite: capturedByWhite },
      winner: margin === 0 ? 'draw' : (margin > 0 ? BLACK : WHITE),
      margin: Math.abs(margin)
    };
  }

  // Per-point ownership grid for the scoring overlay. Returns an NxN array of
  // 'b' | 'w' | null, where empty regions surrounded by a single colour (and
  // the points under dead stones) are attributed to that colour.
  function territoryGrid(board, deadMap) {
    var size = board.length;
    deadMap = deadMap || {};
    var work = cloneBoard(board);
    var r, c;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) {
      if (deadMap[r + ',' + c] && work[r][c]) work[r][c] = null;
    }
    var grid = [];
    for (r = 0; r < size; r++) { grid.push([]); for (c = 0; c < size; c++) grid[r].push(null); }
    var seen = {};
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (work[r][c] !== null || seen[r + ',' + c]) continue;
        var region = [], borders = {}, stack = [[r, c]];
        seen[r + ',' + c] = true;
        while (stack.length) {
          var cur = stack.pop(), cr = cur[0], cc = cur[1];
          region.push([cr, cc]);
          for (var i = 0; i < 4; i++) {
            var nr = cr + DIRS[i][0], nc = cc + DIRS[i][1];
            if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
            var v = work[nr][nc], k = nr + ',' + nc;
            if (v === null) { if (!seen[k]) { seen[k] = true; stack.push([nr, nc]); } }
            else borders[v] = true;
          }
        }
        var owner = (borders[BLACK] && !borders[WHITE]) ? BLACK
          : (borders[WHITE] && !borders[BLACK]) ? WHITE : null;
        if (owner) for (var s = 0; s < region.length; s++) grid[region[s][0]][region[s][1]] = owner;
      }
    }
    return grid;
  }

  // -------------------------------------------------------------- Game class
  function GoGame(opts) {
    opts = opts || {};
    if (typeof opts === 'number') opts = { size: opts };
    this.size = opts.size || DEFAULT_SIZE;
    this.komi = (opts.komi != null) ? opts.komi : DEFAULT_KOMI;
    this.handicap = opts.handicap || 0;
    this.board = emptyBoard(this.size);
    this.turn = BLACK; // black moves first
    this.history = [];          // list of { color, r, c, pass, captures }
    this.captures = { b: 0, w: 0 }; // stones captured BY black / BY white
    this.passes = 0;            // consecutive passes
    this.koPoint = null;        // [r,c] forbidden by simple ko, for UI hinting
    this.ended = false;
    this.result = null;
    this._seen = {};            // positional-superko set of past board keys
    this._seen[boardKey(this.board)] = true;
    if (this.handicap > 1) this._placeHandicap(this.handicap);
  }

  GoGame.SIZES = SIZES;
  GoGame.BLACK = BLACK;
  GoGame.WHITE = WHITE;

  // Standard handicap star points for the given board size.
  function handicapPoints(size) {
    var edge = size >= 13 ? 3 : 2;            // distance from edge
    var far = size - 1 - edge;
    var mid = (size - 1) / 2;
    var pts = {
      corners: [[far, edge], [edge, far], [far, far], [edge, edge]],
      sides: [[mid, edge], [mid, far], [edge, mid], [far, mid]],
      center: [mid, mid]
    };
    return pts;
  }

  GoGame.handicapStones = function (size, count) {
    var p = handicapPoints(size);
    var order = [];
    // Conventional placement order.
    if (count >= 1) order.push(p.corners[0]);
    if (count >= 2) order.push(p.corners[1]);
    if (count >= 3) order.push(p.corners[2]);
    if (count >= 4) order.push(p.corners[3]);
    if (size % 2 === 1) {
      if (count === 5) { order.push(p.center); }
      else if (count >= 5) {
        if (count >= 6) { order.push(p.sides[0]); order.push(p.sides[1]); }
        if (count >= 7) order.push(p.center);
        if (count >= 8) { order.push(p.sides[2]); order.push(p.sides[3]); }
        if (count === 9) order.push(p.center);
      }
    }
    // De-dupe while keeping order, cap at count.
    var out = [], seen = {};
    for (var i = 0; i < order.length && out.length < count; i++) {
      var k = order[i][0] + ',' + order[i][1];
      if (!seen[k]) { seen[k] = true; out.push(order[i]); }
    }
    return out;
  };

  GoGame.prototype._placeHandicap = function (count) {
    var stones = GoGame.handicapStones(this.size, count);
    for (var i = 0; i < stones.length; i++) {
      this.board[stones[i][0]][stones[i][1]] = BLACK;
    }
    this._seen = {};
    this._seen[boardKey(this.board)] = true;
    this.turn = WHITE; // after handicap stones, White plays first
    this.handicapStones = stones;
  };

  GoGame.prototype.clone = function () {
    var g = new GoGame({ size: this.size, komi: this.komi });
    g.board = cloneBoard(this.board);
    g.turn = this.turn;
    g.captures = { b: this.captures.b, w: this.captures.w };
    g.passes = this.passes;
    g.koPoint = this.koPoint ? this.koPoint.slice() : null;
    g.ended = this.ended;
    g.result = this.result;
    g.history = this.history.slice();
    g._seen = {};
    for (var k in this._seen) if (this._seen.hasOwnProperty(k)) g._seen[k] = true;
    return g;
  };

  GoGame.prototype.stoneAt = function (r, c) {
    if (r < 0 || r >= this.size || c < 0 || c >= this.size) return null;
    return this.board[r][c];
  };

  // Is placing the current player's stone at (r,c) legal?
  GoGame.prototype.isLegal = function (r, c, color) {
    color = color || this.turn;
    var self = this;
    var res = tryPlay(this.board, r, c, color, function (key) {
      return self._seen[key] === true;
    });
    return res.ok;
  };

  // All legal points for `color` (used by the AI / highlighting).
  GoGame.prototype.legalMoves = function (color) {
    color = color || this.turn;
    var out = [];
    for (var r = 0; r < this.size; r++) {
      for (var c = 0; c < this.size; c++) {
        if (this.board[r][c] === null && this.isLegal(r, c, color)) out.push([r, c]);
      }
    }
    return out;
  };

  // Does `color` have ANY legal point? Same test as legalMoves() but it stops at
  // the first hit instead of building the whole list — this runs once per turn
  // on a 19x19 board, where the full enumeration costs 361 flood fills.
  //
  // Under Chinese rules a player with no legal move must pass; the game still
  // ends only on two consecutive passes, never on a full board. This exists so
  // the UI can say so instead of leaving that player tapping a dead board.
  GoGame.prototype.hasLegalMove = function (color) {
    color = color || this.turn;
    for (var r = 0; r < this.size; r++) {
      for (var c = 0; c < this.size; c++) {
        if (this.board[r][c] === null && this.isLegal(r, c, color)) return true;
      }
    }
    return false;
  };

  // Play a stone. Returns { ok, color, captures:[[r,c]...], capturedCount,
  // ended, result } or { ok:false, reason }.
  GoGame.prototype.play = function (r, c, color) {
    if (this.ended) return { ok: false, reason: 'game-over' };
    color = color || this.turn;
    if (color !== this.turn) return { ok: false, reason: 'not-your-turn' };
    var self = this;
    var res = tryPlay(this.board, r, c, color, function (key) {
      return self._seen[key] === true;
    });
    if (!res.ok) return { ok: false, reason: res.reason };

    this.board = res.board;
    var capCount = res.captures.length;
    if (color === BLACK) this.captures.b += capCount;
    else this.captures.w += capCount;

    // Simple-ko hint for UI: single-stone capture by a fresh single-liberty stone.
    this.koPoint = null;
    if (capCount === 1) {
      var grp = collectGroup(this.board, r, c);
      if (grp.stones.length === 1 && grp.liberties.length === 1) {
        this.koPoint = res.captures[0].slice();
      }
    }

    this._seen[boardKey(this.board)] = true;
    this.history.push({ color: color, r: r, c: c, pass: false, captures: res.captures });
    this.passes = 0;
    this.turn = other(color);
    return {
      ok: true, color: color, r: r, c: c,
      captures: res.captures, capturedCount: capCount,
      koPoint: this.koPoint, ended: false, result: null
    };
  };

  // Pass. Two consecutive passes end the game (scoring follows separately).
  GoGame.prototype.pass = function (color) {
    if (this.ended) return { ok: false, reason: 'game-over' };
    color = color || this.turn;
    if (color !== this.turn) return { ok: false, reason: 'not-your-turn' };
    this.koPoint = null;
    this.passes += 1;
    this.history.push({ color: color, pass: true });
    this.turn = other(color);
    var ended = this.passes >= 2;
    if (ended) this.ended = true;
    return { ok: true, color: color, pass: true, ended: ended };
  };

  GoGame.prototype.resign = function (color) {
    color = color || this.turn;
    this.ended = true;
    this.result = { type: 'resign', winner: other(color), loser: color };
    return this.result;
  };

  // Compute a score with optional dead-stone map ("r,c" => true).
  GoGame.prototype.score = function (deadMap) {
    return scoreArea(this.board, this.komi, deadMap || {});
  };

  GoGame.prototype.territoryGrid = function (deadMap) {
    return territoryGrid(this.board, deadMap || {});
  };

  // The connected same-colour group containing (r,c) as an array of "r,c" keys.
  GoGame.prototype.groupKeys = function (r, c) {
    if (!this.board[r] || this.board[r][c] == null) return [];
    var grp = collectGroup(this.board, r, c);
    return grp.stones.map(function (s) { return s[0] + ',' + s[1]; });
  };

  // Auto-detection of dead stones, used to seed the end-of-game marking UI.
  //
  // This runs at the moment BOTH players have passed, which is what makes it
  // tractable: neither side believes another stone is worth playing, so a group
  // that is sealed inside enemy space and cannot make two eyes is dead by
  // agreement of the passes themselves.
  //
  // The rule is: a group is dead when it has fewer than two eyes AND every empty
  // region touching it also touches the opponent (it has no private outside to
  // escape into). An "eye" here is an adjacent empty region bordered exclusively
  // by the group's own colour.
  //
  // The previous heuristic was "<=1 liberty AND <=3 stones", which was wrong in
  // both directions: it missed every dead group of 4+ stones, and it pre-marked
  // live stones that merely sat in atari (snapback throw-ins, ko stones). Since
  // an unattended scoring phase auto-settles on these marks, an unmarked dead
  // dragon could flip the result.
  //
  // Players still confirm; this only decides what they are shown first.
  // Benson's algorithm (1976): which chains of `color` are UNCONDITIONALLY
  // ALIVE — provably uncapturable even if their owner never answers a move.
  //
  // This is a theorem, not a heuristic, and it is the safety net under
  // guessDeadStones(). The seeding rule below is deliberately crude, and a
  // cross-check against this algorithm over 300 random positions found 224
  // stones it marked dead that are provably alive — flipping the winner in 6 of
  // them. Anything Benson certifies must never be pre-marked dead.
  //
  // Sound but INCOMPLETE: most living groups are not *unconditionally* alive
  // (they would have to answer threats), and a seki group usually has no eyes
  // at all, so silence from Benson proves nothing. It only rules out one class
  // of error — the class that was actually occurring.
  //
  //   chains            connected groups of `color`
  //   enclosed region   maximal connected set of non-`color` points whose every
  //                     neighbour is a `color` stone
  //   vital(R, c)       every EMPTY point of R is a liberty of chain c
  //
  // Fixed point: drop chains with < 2 vital regions; drop regions bordered by a
  // dropped chain; repeat. What survives is unconditionally alive.
  GoGame.prototype.bensonAlive = function (color) {
    var size = this.size, board = this.board, r, c, i;
    var chainId = {}, chains = [];
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (board[r][c] !== color || chainId[r + ',' + c] !== undefined) continue;
        var id = chains.length, stones = [], libs = {};
        var st = [[r, c]];
        chainId[r + ',' + c] = id;
        while (st.length) {
          var p = st.pop();
          stones.push(p);
          for (i = 0; i < 4; i++) {
            var nr = p[0] + DIRS[i][0], nc = p[1] + DIRS[i][1];
            if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
            var v = board[nr][nc];
            if (v === null) libs[nr + ',' + nc] = true;
            else if (v === color && chainId[nr + ',' + nc] === undefined) {
              chainId[nr + ',' + nc] = id;
              st.push([nr, nc]);
            }
          }
        }
        chains.push({ id: id, stones: stones, libs: libs });
      }
    }
    if (!chains.length) return {};

    var seen = {}, regions = [];
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (board[r][c] === color || seen[r + ',' + c]) continue;
        var empties = [], borders = {}, any = false;
        var s2 = [[r, c]];
        seen[r + ',' + c] = true;
        while (s2.length) {
          var q = s2.pop();
          if (board[q[0]][q[1]] === null) empties.push(q[0] + ',' + q[1]);
          for (i = 0; i < 4; i++) {
            var mr = q[0] + DIRS[i][0], mc = q[1] + DIRS[i][1];
            if (mr < 0 || mr >= size || mc < 0 || mc >= size) continue;
            if (board[mr][mc] === color) { borders[chainId[mr + ',' + mc]] = true; any = true; }
            else if (!seen[mr + ',' + mc]) { seen[mr + ',' + mc] = true; s2.push([mr, mc]); }
          }
        }
        regions.push({ empties: empties, borders: borders, live: any });
      }
    }

    var aliveChain = {};
    for (i = 0; i < chains.length; i++) aliveChain[chains[i].id] = true;
    for (;;) {
      var changed = false, vital = {}, k, j;
      for (i = 0; i < chains.length; i++) vital[chains[i].id] = 0;
      for (i = 0; i < regions.length; i++) {
        var reg = regions[i];
        if (!reg.live) continue;
        var bk = Object.keys(reg.borders);
        for (j = 0; j < bk.length; j++) {
          var cid = bk[j];
          if (!aliveChain[cid]) continue;
          var ch = chains[cid], allLibs = true;
          for (k = 0; k < reg.empties.length; k++) {
            if (!ch.libs[reg.empties[k]]) { allLibs = false; break; }
          }
          if (allLibs) vital[cid]++;
        }
      }
      for (i = 0; i < chains.length; i++) {
        var cc = chains[i].id;
        if (aliveChain[cc] && vital[cc] < 2) { delete aliveChain[cc]; changed = true; }
      }
      for (i = 0; i < regions.length; i++) {
        var rg = regions[i];
        if (!rg.live) continue;
        var rk = Object.keys(rg.borders);
        for (j = 0; j < rk.length; j++) {
          if (!aliveChain[rk[j]]) { rg.live = false; changed = true; break; }
        }
      }
      if (!changed) break;
    }

    var out = {};
    for (i = 0; i < chains.length; i++) {
      if (!aliveChain[chains[i].id]) continue;
      for (var t = 0; t < chains[i].stones.length; t++) {
        out[chains[i].stones[t][0] + ',' + chains[i].stones[t][1]] = true;
      }
    }
    return out;
  };

  // Label every connected empty region of `board` and record which colours
  // border it. Split out of guessDeadStones so the second pass can redo it on a
  // board with the dead stones lifted.
  function scanRegions(board, size) {
    var regionOf = {};                 // "r,c" -> region index
    // { borders: {b:true,w:true}, points: n, bcount: {b:n,w:n} }
    // bcount counts border ADJACENCIES, not distinct stones: it is used only as
    // a ratio ("how much of this region's edge is theirs"), where weighting a
    // stone by how much of the boundary it forms is what we want.
    var regions = [];
    var seenEmpty = {};
    var r, c, i;
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (board[r][c] !== null || seenEmpty[r + ',' + c]) continue;
        var idx = regions.length;
        var borders = {};
        var bcount = {};
        bcount[BLACK] = 0; bcount[WHITE] = 0;
        var stack = [[r, c]], pts = 0, members = [];
        seenEmpty[r + ',' + c] = true;
        while (stack.length) {
          var p = stack.pop();
          regionOf[p[0] + ',' + p[1]] = idx;
          pts++;
          if (pts <= 2) members.push(p);
          for (i = 0; i < 4; i++) {
            var nr = p[0] + DIRS[i][0], nc = p[1] + DIRS[i][1];
            if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
            var key = nr + ',' + nc;
            var v = board[nr][nc];
            if (v === null) {
              if (!seenEmpty[key]) { seenEmpty[key] = true; stack.push([nr, nc]); }
            } else {
              borders[v] = true;
              bcount[v]++;
            }
          }
        }
        // `spots` is only kept for one- and two-point regions: the false-eye
        // test needs the actual coordinates, and holding them for a 200-point
        // region would be pointless memory.
        regions.push({ borders: borders, points: pts, bcount: bcount,
                       spots: pts <= 2 ? members : null });
      }
    }
    return { regionOf: regionOf, regions: regions };
  }

  // Eye/seal reading for a set of liberties against a given region map.
  // Returns { eyes, sealed, touched } — `touched` is how many distinct regions.
  // Is a one-point eye actually FALSE?
  //
  // A point ringed orthogonally by our own stones looks like an eye, but it only
  // is one if the stones forming it are connected around the corners. Where the
  // opponent holds the diagonals, the ring can be cut and the "eye" collapses.
  // Reported from a real game (1W5AF8BH): a 7-stone White group had two
  // liberties, F19 and G18, each ringed only by White — read naively that is two
  // eyes and the group lives. But F19 sits on the edge with a Black stone on its
  // one usable diagonal, so it is false; the group has one real eye and is dead.
  //
  // The classic count: away from the edge an eye needs three of its four
  // diagonals; on the edge or in the corner it needs all of them, because a
  // single cut there is enough. Off-board diagonals are ours by convention.
  function isFalseEye(board, size, r, c, colour, opp) {
    var diag = [[r - 1, c - 1], [r - 1, c + 1], [r + 1, c - 1], [r + 1, c + 1]];
    var onBoard = 0, enemy = 0, i;
    for (i = 0; i < 4; i++) {
      var dr = diag[i][0], dc = diag[i][1];
      if (dr < 0 || dc < 0 || dr >= size || dc >= size) continue;
      onBoard++;
      if (board[dr][dc] === opp) enemy++;
    }
    return onBoard < 4 ? enemy >= 1 : enemy >= 2;
  }

  function readEyes(liberties, regionOf, regions, opp, board, size, colour) {
    var adjacent = {}, i;
    for (i = 0; i < liberties.length; i++) {
      var lib = liberties[i];
      var ri = regionOf[lib[0] + ',' + lib[1]];
      if (ri !== undefined) adjacent[ri] = true;
    }
    var eyes = 0, sealed = true;
    var keys = Object.keys(adjacent);
    for (i = 0; i < keys.length; i++) {
      var reg = regions[keys[i]];
      if (!reg.borders[opp]) {
        // A single point that fails the diagonal test is not an eye at all.
        // Larger regions are left alone: judging whether a two-point space
        // yields an eye is life-and-death reading, not a corner count.
        var real = true;
        if (board && reg.points === 1 && reg.spots && reg.spots.length) {
          var p = reg.spots[0];
          if (isFalseEye(board, size, p[0], p[1], colour, opp)) real = false;
        }
        if (real) eyes++;
      }
      if (reg.points > 2) sealed = false;
    }
    return { eyes: eyes, sealed: sealed, touched: keys.length };
  }

  // Chains of one colour that share an enclosed, single-colour empty region are
  // judged TOGETHER, not one at a time.
  //
  // A region bordered only by our own stones is not merely an eye — it is also a
  // place we can connect through. Reported from a real game (GIZNDLF6): a
  // 15-stone Black chain had exactly two liberties, G16 and G15, and that region
  // is bordered only by Black — so read alone it showed one eye and was marked
  // dead. But the same two points also touch three OTHER live Black chains.
  // Black plays G15, joins them, and the whole thing is alive. Every one of that
  // game's 23 wrongly-marked stones had this shape.
  //
  // So: union same-colour chains across every region that only they border, and
  // read eyes for the union. Chains with nothing to connect to are unaffected.
  function buildUnits(board, size, groups, regionOf, regions) {
    var parent = [], i;
    for (i = 0; i < groups.length; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }

    // region index -> the groups of each colour that touch it
    var touchers = {};
    for (i = 0; i < groups.length; i++) {
      var g = groups[i], libs = g.grp.liberties, j;
      for (j = 0; j < libs.length; j++) {
        var ri = regionOf[libs[j][0] + ',' + libs[j][1]];
        if (ri === undefined) continue;
        if (!touchers[ri]) touchers[ri] = [];
        if (touchers[ri].indexOf(i) === -1) touchers[ri].push(i);
      }
    }
    for (var key in touchers) {
      if (!Object.prototype.hasOwnProperty.call(touchers, key)) continue;
      var reg = regions[key];
      // Only a region enclosed by ONE colour joins anything: a region touching
      // both colours is contested ground, not a private connection.
      var borderColours = Object.keys(reg.borders);
      if (borderColours.length !== 1) continue;
      var list = touchers[key];
      for (i = 1; i < list.length; i++) union(list[0], list[i]);
    }

    var units = {};
    for (i = 0; i < groups.length; i++) {
      var root = find(i);
      if (!units[root]) units[root] = { colour: groups[i].colour, opp: groups[i].opp,
                                        members: [], stones: [], liberties: [] };
      var u = units[root];
      u.members.push(i);
      u.stones = u.stones.concat(groups[i].grp.stones);
      u.liberties = u.liberties.concat(groups[i].grp.liberties);
    }
    return units;
  }

  GoGame.prototype.guessDeadStones = function () {
    var size = this.size, board = this.board;
    var r, c, i;

    // 1. Label every connected empty region and record which colours border it.
    var scan0 = scanRegions(board, size);
    var regionOf = scan0.regionOf, regions = scan0.regions;

    // 2. Judge each group against the regions it touches.
    // Computed once for both colours: a chain Benson certifies is provably
    // uncapturable, so no amount of eye-counting may overrule it.
    var unconditional = {};
    try {
      var ba = this.bensonAlive(BLACK), wa = this.bensonAlive(WHITE), bk;
      for (bk in ba) if (Object.prototype.hasOwnProperty.call(ba, bk)) unconditional[bk] = true;
      for (bk in wa) if (Object.prototype.hasOwnProperty.call(wa, bk)) unconditional[bk] = true;
    } catch (e) { unconditional = {}; }   // the seed must never throw

    var dead = {};
    var seenStone = {};
    var allGroups = [];                 // kept for the second pass
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        var col = board[r][c];
        if (col === null || seenStone[r + ',' + c]) continue;
        var grp = collectGroup(board, r, c);
        for (i = 0; i < grp.stones.length; i++) seenStone[grp.stones[i].join(',')] = true;
        allGroups.push({ grp: grp, colour: col,
                         opp: col === BLACK ? WHITE : BLACK, root: r + ',' + c });
      }
    }

    // Judge each UNIT — chains joined through the regions only they enclose.
    var units0 = buildUnits(board, size, allGroups, regionOf, regions);
    var uk;
    for (uk in units0) {
      if (!Object.prototype.hasOwnProperty.call(units0, uk)) continue;
      var U = units0[uk];

      // Only pockets of one or two points can never become two eyes, so a unit
      // whose every liberty sits in such a pocket cannot live. Anything touching
      // a larger space is left alone: judging THAT correctly is real
      // life-and-death reading, and marking a live group dead is far worse
      // than leaving a dead one for the players to mark themselves.
      var e0 = readEyes(U.liberties, regionOf, regions, U.opp, board, size, U.colour);

      // Benson's veto. The eye count above is crude — it treats any empty
      // region bordered only by our own colour as an eye, which over-counts
      // false eyes and under-counts split eye space. Where the crude reading
      // and the theorem disagree, the theorem wins.
      var certified = false;
      for (i = 0; i < U.stones.length; i++) {
        if (unconditional[U.stones[i].join(',')]) { certified = true; break; }
      }
      if (e0.sealed && e0.eyes < 2 && e0.touched > 0 && !certified) {
        for (i = 0; i < U.stones.length; i++) dead[U.stones[i].join(',')] = true;
      }
    }

    // 3. Second pass: a group is only dead if it stays dead once the ENEMY
    // stones that are themselves dead come off the board.
    //
    // The first pass judges every group against the board as it stands, so an
    // eye space still occupied by a doomed enemy stone does not read as an eye.
    // Reported from a real 19x19 game (UV5V5H8Y): a 28-stone White group had
    // exactly two liberties, N7 and M8. {N7} was bordered only by White and
    // counted; {M8} touched the lone Black stone at M9 and did not — so White
    // showed one eye and was marked dead. But M9 was marked dead in the same
    // sweep, and it cannot be saved (playing M8 to defend it is self-capture).
    // Lift it and {M8,M9} becomes a White-only two-point region: a second eye.
    // White plays M8, takes M9, and lives. The group was alive all along.
    //
    // Removing enemy dead stones can only ENLARGE a group's eye space, so this
    // pass only ever un-marks. It cannot invent a new dead group, which keeps
    // the conservative bias the first pass was built around. Iterated to a fixed
    // point because reviving one group can revive its neighbour.
    for (var pass = 0; pass < 4; pass++) {
      var revived = false;
      // Board with each colour's dead stones lifted, built once per pass.
      var lifted = { b: null, w: null };
      var side;
      for (side in lifted) {
        if (!Object.prototype.hasOwnProperty.call(lifted, side)) continue;
        var bb = board.map(function (row) { return row.slice(); });
        for (r = 0; r < size; r++) {
          for (c = 0; c < size; c++) {
            if (bb[r][c] === side && dead[r + ',' + c]) bb[r][c] = null;
          }
        }
        lifted[side] = { board: bb, scan: scanRegions(bb, size) };
      }

      // Re-judge in units on the lifted board too — lifting enemy stones can
      // itself open a connection between two of our chains.
      for (side in lifted) {
        if (!Object.prototype.hasOwnProperty.call(lifted, side)) continue;
        var oppSide = side === BLACK ? WHITE : BLACK;
        var view = lifted[oppSide];                   // enemy dead stones lifted
        // Rebuild this colour's chains against that view; liberties change.
        var mine = [], sawStone = {};
        for (r = 0; r < size; r++) {
          for (c = 0; c < size; c++) {
            if (view.board[r][c] !== side || sawStone[r + ',' + c]) continue;
            var gg = collectGroup(view.board, r, c);
            for (i = 0; i < gg.stones.length; i++) sawStone[gg.stones[i].join(',')] = true;
            mine.push({ grp: gg, colour: side, opp: oppSide, root: r + ',' + c });
          }
        }
        var units2 = buildUnits(view.board, size, mine, view.scan.regionOf, view.scan.regions);
        var uk2;
        for (uk2 in units2) {
          if (!Object.prototype.hasOwnProperty.call(units2, uk2)) continue;
          var U2 = units2[uk2];
          var anyDead = false;
          for (i = 0; i < U2.stones.length; i++) {
            if (dead[U2.stones[i].join(',')]) { anyDead = true; break; }
          }
          if (!anyDead) continue;
          var e2 = readEyes(U2.liberties, view.scan.regionOf, view.scan.regions, U2.opp,
                            view.board, size, U2.colour);
          if (e2.eyes >= 2) {
            for (i = 0; i < U2.stones.length; i++) {
              if (dead[U2.stones[i].join(',')]) { delete dead[U2.stones[i].join(',')]; revived = true; }
            }
          }
        }
      }
      if (!revived) break;
    }

    // 4. Stones stranded inside the opponent's area, with nowhere to build an eye.
    //
    // Everything above only marks a group dead when EVERY empty region it
    // touches is a one- or two-point pocket. That is a deliberately narrow test,
    // and it misses the commonest dead shape of all: a stone or small chain left
    // sitting in the other player's territory. Such a group has no private eye
    // space whatsoever — every region it touches is bordered by the enemy too —
    // so it cannot make two eyes, yet the pocket rule never fires because the
    // surrounding area is bigger than two points.
    //
    // "No eye space" alone is not enough to call something dead: a lone stone on
    // an empty board has no eye space either, and it is simply unsettled. So the
    // space around it has to be demonstrably the opponent's:
    //
    //   MAX_ENEMY_REGION  the biggest empty region it may touch. Anything larger
    //                     is open board, where nothing is settled yet.
    //   MIN_ENEMY_SHARE   the share of the stones bordering those regions that
    //                     belong to the opponent.
    //
    // Both were chosen by measurement, not taste: swept against KataGo ownership
    // over 41 recorded games, split into a 13-game tuning set and a 28-game
    // held-out set. A 60% share looked free on the tuning set and produced a
    // false positive on the held-out one, which is why the bar is 70%.
    //
    // The region cap was 30 on that evidence, where the failure point measured
    // 56. Re-swept over 229 games the failure point is 220, so 30 was throwing
    // away groups that are plainly stranded — a two-stone chain whose only
    // liberties open into a 55-point area walled 95% by the opponent is dead,
    // and the cap alone was saving it. 100 keeps the same kind of margin the
    // original choice had against a failure point four times further out.
    var MAX_ENEMY_REGION = 100;
    var MIN_ENEMY_SHARE = 0.70;
    var scanF = scanRegions(board, size);
    var seenF = {};
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        var colF = board[r][c];
        if (colF === null || seenF[r + ',' + c]) continue;
        var grpF = collectGroup(board, r, c);
        for (i = 0; i < grpF.stones.length; i++) seenF[grpF.stones[i].join(',')] = true;
        var already = false;
        for (i = 0; i < grpF.stones.length; i++) {
          if (dead[grpF.stones[i].join(',')]) { already = true; break; }
        }
        if (already) continue;
        var oppF = colF === BLACK ? WHITE : BLACK;

        var adjF = {}, k2;
        for (i = 0; i < grpF.liberties.length; i++) {
          var lb = grpF.liberties[i];
          var ri2 = scanF.regionOf[lb[0] + ',' + lb[1]];
          if (ri2 !== undefined) adjF[ri2] = true;
        }
        var idxs = Object.keys(adjF);
        if (!idxs.length) continue;

        var hasPrivate = false, tooOpen = false, mineB = 0, theirsB = 0;
        for (i = 0; i < idxs.length; i++) {
          var rg = scanF.regions[idxs[i]];
          if (!rg.borders[oppF]) hasPrivate = true;      // somewhere to make an eye
          if (rg.points > MAX_ENEMY_REGION) tooOpen = true;
          mineB += rg.bcount[colF] || 0;
          theirsB += rg.bcount[oppF] || 0;
        }
        if (hasPrivate || tooOpen) continue;
        if (theirsB / Math.max(1, mineB + theirsB) < MIN_ENEMY_SHARE) continue;
        // Benson still has the last word.
        var certF = false;
        for (i = 0; i < grpF.stones.length; i++) {
          if (unconditional[grpF.stones[i].join(',')]) { certF = true; break; }
        }
        if (certF) continue;
        for (i = 0; i < grpF.stones.length; i++) dead[grpF.stones[i].join(',')] = true;
      }
    }

    // 5. Liberty-race veto.
    //
    // Everything above decides life by eye space alone. A group with no eye space
    // is not necessarily lost: it may be able to capture the chain penning it in
    // and build its eyes out of the vacated points. That is a capturing race, and
    // the cheapest honest reading of one is a liberty count — if the group has
    // strictly more liberties than the weakest enemy chain touching it, it fills
    // first and lives.
    //
    // Chains that cannot be the losing side of a race are excluded: Benson-alive
    // ones cannot be captured at all, and already-dead ones are not opponents.
    var scanV = scanRegions(board, size);
    var seenV = {}, vetoed = {};
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (board[r][c] === null || seenV[r + ',' + c]) continue;
        var grpV = collectGroup(board, r, c);
        for (i = 0; i < grpV.stones.length; i++) seenV[grpV.stones[i].join(',')] = true;
        if (!dead[grpV.stones[0].join(',')]) continue;
        if (!grpV.liberties.length) continue;
        var oppV = board[r][c] === BLACK ? WHITE : BLACK;
        var minOpp = Infinity, oSeen = {};
        for (i = 0; i < grpV.stones.length; i++) {
          var vr = grpV.stones[i][0], vc = grpV.stones[i][1];
          for (var dv = 0; dv < 4; dv++) {
            var nvr = vr + [-1, 1, 0, 0][dv], nvc = vc + [0, 0, -1, 1][dv];
            if (nvr < 0 || nvc < 0 || nvr >= size || nvc >= size) continue;
            if (board[nvr][nvc] !== oppV || oSeen[nvr + ',' + nvc]) continue;
            var ogV = collectGroup(board, nvr, nvc);
            for (var oj = 0; oj < ogV.stones.length; oj++) oSeen[ogV.stones[oj].join(',')] = true;
            var kV = ogV.stones[0].join(',');
            if (unconditional[kV] || dead[kV]) continue;
            if (ogV.liberties.length < minOpp) minOpp = ogV.liberties.length;
          }
        }
        if (grpV.liberties.length > minOpp && grpV.stones.length >= 20) {
          for (i = 0; i < grpV.stones.length; i++) vetoed[grpV.stones[i].join(',')] = true;
        }
      }
    }
    for (var vk in vetoed) if (vetoed.hasOwnProperty(vk)) delete dead[vk];

    return dead;
  };

  // Could the winner change depending on a life-and-death call nobody made?
  //
  // Used when a scoring phase expires with neither player having marked or
  // confirmed anything. For every group not already marked dead, ask "what if
  // this one were dead instead?" — if any single answer flips the winner, the
  // count on screen is not a fact and silence must not be read as agreement.
  //
  // If no flip changes the winner, the position is decided regardless of the
  // unresolved groups, and settling on it is safe.
  GoGame.prototype.scoreIsAmbiguous = function (deadMap) {
    deadMap = deadMap || {};
    var base = this.score(deadMap);
    var size = this.size, board = this.board;
    var seen = {}, r, c, i;
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (board[r][c] === null || seen[r + ',' + c]) continue;
        var grp = collectGroup(board, r, c);
        var keys = [];
        for (i = 0; i < grp.stones.length; i++) {
          var k = grp.stones[i].join(',');
          seen[k] = true;
          keys.push(k);
        }
        if (deadMap[keys[0]]) continue;               // already settled as dead
        var alt = {};
        for (var q in deadMap) if (Object.prototype.hasOwnProperty.call(deadMap, q)) alt[q] = deadMap[q];
        for (i = 0; i < keys.length; i++) alt[keys[i]] = true;
        if (this.score(alt).winner !== base.winner) return true;
      }
    }
    return false;
  };

  GoGame.prototype.toData = function () {
    return {
      size: this.size,
      komi: this.komi,
      board: boardKey(this.board),
      turn: this.turn,
      captures: { b: this.captures.b, w: this.captures.w },
      passes: this.passes,
      koPoint: this.koPoint,
      ended: this.ended,
      moveCount: this.history.length
    };
  };

  // Rebuild a board array from a flat board key string.
  GoGame.boardFromKey = function (key, size) {
    var b = emptyBoard(size);
    for (var i = 0; i < key.length; i++) {
      var ch = key.charAt(i);
      var r = Math.floor(i / size), c = i % size;
      b[r][c] = ch === 'b' ? BLACK : ch === 'w' ? WHITE : null;
    }
    return b;
  };

  GoGame.fromData = function (data) {
    var g = new GoGame({ size: data.size, komi: data.komi });
    g.board = GoGame.boardFromKey(data.board, data.size);
    g.turn = data.turn || BLACK;
    if (data.captures) g.captures = { b: data.captures.b || 0, w: data.captures.w || 0 };
    g.passes = data.passes || 0;
    g.koPoint = data.koPoint || null;
    g.ended = !!data.ended;
    g._seen = {};
    g._seen[boardKey(g.board)] = true;
    return g;
  };

  return {
    BLACK: BLACK,
    WHITE: WHITE,
    SIZES: SIZES,
    DEFAULT_SIZE: DEFAULT_SIZE,
    DEFAULT_KOMI: DEFAULT_KOMI,
    GoGame: GoGame,
    other: other,
    emptyBoard: emptyBoard,
    cloneBoard: cloneBoard,
    boardKey: boardKey,
    collectGroup: collectGroup,
    countLiberties: countLiberties,
    tryPlay: tryPlay,
    scoreArea: scoreArea,
    territoryGrid: territoryGrid,
    handicapStones: GoGame.handicapStones
  };
});
