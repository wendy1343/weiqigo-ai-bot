/*
 * WeiqiGo AI bot — auto-plays Go against a friend on weiqigo.com.
 * ------------------------------------------------------------------
 * Flow:
 *   1. (optional) log in / register -> JWT token.
 *   2. Connect Socket.IO and either CREATE a private room (prints the invite
 *      link for your friend) or JOIN a friend's room from a link.
 *   3. Track the board; on our turn, run the MCTS engine and reply.
 *
 * Usage:
 *   node bot.js              # create/join according to config.json
 *   node bot.js --register   # create a new account from config.auth
 *   node bot.js --login      # test credentials, print the account
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const Go = require('./go-engine.js');
const { chooseMove } = require('./engine/mcts.js');
const { KataGoEngine } = require('./engine/katago.js');

const ARGS = process.argv.slice(2);
function resolveConfigPath() {
  const i = ARGS.indexOf('--config');
  return i >= 0 && ARGS[i + 1] ? path.resolve(__dirname, ARGS[i + 1]) : path.join(__dirname, 'config.json');
}
const CONFIG_PATH = resolveConfigPath();
const DEBUG = ARGS.includes('--debug');

function boardChecksum(board) {
  let s = '';
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) {
      s += board[r][c] === 'b' ? 'b' : board[r][c] === 'w' ? 'w' : '.';
    }
  }
  // simple 32-bit hash
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function log(...a) { console.log('[bot]', ...a); }
function logErr(...a) { console.error('[bot]', ...a); }

// ---------------------------------------------------------------------------
// REST auth
// ---------------------------------------------------------------------------
async function apiPost(cfg, endpoint, body, token) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(cfg.baseUrl + endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

async function login(cfg) {
  const res = await apiPost(cfg, '/api/auth/login', { email: cfg.auth.email, password: cfg.auth.password });
  if (res.status === 200 && res.data.success) {
    cfg.auth.token = res.data.token;
    saveConfig(cfg);
    log('logged in as', res.data.user && (res.data.user.username || res.data.user.email));
    return res.data.token;
  }
  logErr('login failed:', res.data.message || res.status);
  return null;
}

async function register(cfg) {
  const { username, email, password } = cfg.auth;
  const res = await apiPost(cfg, '/api/auth/register', { username, email, password });
  if (res.status === 200 && res.data.success) {
    cfg.auth.token = res.data.token;
    saveConfig(cfg);
    log('registered + logged in as', res.data.user && res.data.user.username);
    return res.data.token;
  }
  logErr('register failed:', res.data.message || JSON.stringify(res.data));
  return null;
}

async function ensureAuth(cfg) {
  if (cfg.auth.token) {
    // verify token is still valid
    const r = await fetch(cfg.baseUrl + '/api/auth/me', {
      headers: { Authorization: 'Bearer ' + cfg.auth.token, 'User-Agent': 'Mozilla/5.0' },
    });
    if (r.status === 200) {
      const d = await r.json().catch(() => ({}));
      log('authenticated as', d.user && d.user.username);
      return cfg.auth.token;
    }
    log('cached token expired, re-authenticating...');
  }
  if (cfg.auth.email && cfg.auth.password) {
    return login(cfg);
  }
  log('no credentials: playing as guest', JSON.stringify(cfg.playerName));
  return null;
}

// ---------------------------------------------------------------------------
// KataGo engine (optional strong backend). Resolves binary/model/config and
// starts the GTP process. Returns a ready KataGoEngine, or null on any failure
// (the caller then falls back to the built-in MCTS engine).
// ---------------------------------------------------------------------------
function kataPaths(cfg) {
  const k = (cfg.engine && cfg.engine.katago) || {};
  const dir = path.join(__dirname, 'katago');
  return {
    opencl: k.binaryOpencl || path.join(dir, 'opencl', 'katago.exe'),
    eigen: k.binary || path.join(dir, 'eigen', 'katago.exe'),
    model: k.model || path.join(dir, 'model.bin.gz'),
    config: k.config || path.join(dir, 'katago.cfg'),
    backend: k.backend || 'auto',
  };
}

async function initKataGo(cfg) {
  const p = kataPaths(cfg);
  const candidates = p.backend === 'opencl' ? [p.opencl]
    : p.backend === 'eigen' ? [p.eigen]
    : [p.opencl, p.eigen]; // auto: prefer GPU(OpenCL), fall back to CPU(Eigen)

  for (const bin of candidates) {
    if (!fs.existsSync(bin)) continue;
    if (!fs.existsSync(p.model)) { logErr('KataGo model not found:', p.model); break; }
    const eng = new KataGoEngine({ binary: bin, model: p.model, config: p.config });
    try {
      const ver = await Promise.race([
        eng.start(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('start timeout (60s)')), 60000)),
      ]);
      log('KataGo ready:', bin.replace(__dirname, '.'), '(protocol', (ver || '').trim() + ')');
      return eng;
    } catch (e) {
      logErr('KataGo failed to start (' + bin + '):', e.message);
      eng.quit();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Board state helpers
// ---------------------------------------------------------------------------
function emptyBoard(size) {
  const b = [];
  for (let r = 0; r < size; r++) { const row = []; for (let c = 0; c < size; c++) row.push(null); b.push(row); }
  return b;
}

function buildGameFromState(state) {
  const g = new Go.GoGame({ size: state.boardSize, komi: state.komi });
  for (let r = 0; r < state.boardSize; r++) {
    for (let c = 0; c < state.boardSize; c++) {
      const v = state.board[r][c];
      g.board[r][c] = v === 'b' ? 'b' : v === 'w' ? 'w' : null;
    }
  }
  g.koPoint = state.koPoint || null;
  g.passes = state.passes || 0;
  g.turn = state.currentPlayer === 'black' ? 'b' : 'w';
  g._seen = {};
  g._seen[Go.boardKey(g.board)] = true;
  return g;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------
class GoBot {
  constructor(cfg, token, kata) {
    this.cfg = cfg;
    this.token = token;
    this.kata = kata || null;   // KataGoEngine or null (fall back to MCTS)
    this.socket = null;
    this.currentRoomId = null;
    this.accessToken = null;
    this.isPrivate = cfg.mode === 'create' || !!cfg.roomUrl;

    this.state = null;       // { boardSize, komi, myColor, currentPlayer, board, koPoint, passes }
    this.thinking = false;
    this.ended = false;
    this.scoring = false;
    this.moveCount = 0;

    // stable client token (for reconnect grace on quick-match)
    this.sessionToken = 'bot_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  connect() {
    const cfg = this.cfg;
    this.socket = io(cfg.baseUrl, {
      transports: ['websocket'],
      path: '/socket.io',
      auth: { token: this.token || undefined },
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 15000,
    });
    this.wire();
  }

  wire() {
    const s = this.socket;

    s.on('connect', () => {
      log('socket connected, id =', s.id);
      if (this.currentRoomId) {
        // re-attach to a room we were already seated in (private room)
        this.emitJoin();
      } else {
        this.start();
      }
    });

    s.on('connect_error', (e) => logErr('connect_error:', e.message));
    s.on('disconnect', (reason) => log('disconnected:', reason));

    s.on('room-joined', (data) => this.onRoomJoined(data));
    s.on('waiting-for-player', () => log('waiting for opponent...'));
    s.on('game-start', (data) => this.onGameStart(data));
    s.on('move-made', (data) => this.onMoveMade(data));
    s.on('player-passed', (data) => this.onPassed(data));
    s.on('turn-change', (cp) => { if (this.state) { this.state.currentPlayer = cp; this.maybeMove(); } });
    s.on('move-rejected', (data) => this.onMoveRejected(data));
    s.on('game-state', (data) => this.onGameState(data));
    s.on('enter-scoring', (data) => this.onEnterScoring(data));
    s.on('scoring-update', (data) => this.onScoringUpdate(data));
    s.on('game-end', (data) => this.onGameEnd(data));
    s.on('room-error', (data) => logErr('room-error:', JSON.stringify(data)));
    s.on('chat-message', (data) => {
      if (this.cfg.logChat) log('chat', (data.name || '?') + ':', data.message);
    });
    s.on('player-disconnected', (data) => log('opponent disconnected:', JSON.stringify(data)));
    s.on('player-reconnected', () => log('opponent reconnected'));
  }

  start() {
    const cfg = this.cfg;
    if (cfg.mode === 'join' && cfg.roomUrl) {
      const { roomId, token } = this.parseRoomUrl(cfg.roomUrl);
      if (!roomId) { logErr('invalid roomUrl:', cfg.roomUrl); return; }
      this.currentRoomId = roomId;
      this.accessToken = token || null;
      this.isPrivate = true;
      log('joining private room', roomId, token ? '(with token)' : '(no token)');
    } else if (cfg.mode === 'create') {
      this.isPrivate = true;
      log('creating a private room...');
    }
    this.emitJoin();
  }

  parseRoomUrl(url) {
    try {
      const u = new URL(url);
      const roomId = u.searchParams.get('room');
      const token = u.searchParams.get('token');
      return { roomId, token };
    } catch (e) {
      const m = /[?&]room=([A-Za-z0-9]+)(?:&token=([A-Za-z0-9_-]+))?/.exec(url);
      if (m) return { roomId: m[1], token: m[2] || null };
      return { roomId: null, token: null };
    }
  }

  emitJoin() {
    const cfg = this.cfg;
    const payload = {
      playerName: cfg.playerName,
      isPrivate: this.isPrivate,
      roomId: this.currentRoomId || null,
      accessToken: this.accessToken || null,
      authInfo: { isAuthenticated: !!this.token, realUsername: this.token ? (cfg.auth.username || cfg.playerName) : null },
      spectateEnabled: true,
      boardSize: cfg.boardSize,
      timeControl: this.isPrivate ? cfg.timeControl : 'standard',
      sessionToken: this.sessionToken,
    };
    this.socket.emit('join-game', payload);
    log('join-game sent:', JSON.stringify({ playerName: payload.playerName, isPrivate: payload.isPrivate, roomId: payload.roomId, boardSize: payload.boardSize, timeControl: payload.timeControl }));
  }

  onRoomJoined(data) {
    this.currentRoomId = data.roomId;
    this.accessToken = data.accessToken || this.accessToken;
    if (data.isPrivate) {
      const url = data.roomUrl || (this.cfg.baseUrl + '/online-battle/?room=' + encodeURIComponent(data.roomId) + '&token=' + encodeURIComponent(data.accessToken));
      log('');
      log('==============================================================');
      log('  INVITE LINK (send this to your friend):');
      log('  ' + url);
      log('==============================================================');
      log('');
    } else {
      log('in room', data.roomId);
    }
  }

  onGameStart(data) {
    if (data.waitForCreator) { log('waiting for room creator...'); return; }
    this.applyStartData(data);
    log('GAME START — board', this.state.boardSize + 'x' + this.state.boardSize,
        '| you are', this.state.myColor, '|', this.state.currentPlayer, 'to move');
    this.thinking = false;
    this.ended = false;
    this.scoring = false;
    this.maybeMove();
  }

  applyStartData(data) {
    const boardSize = data.boardSize || this.cfg.boardSize;
    const me = (data.players || []).find(p => p.id === this.socket.id);
    const myColor = me ? me.color : null;
    this.state = {
      boardSize,
      komi: data.komi != null ? data.komi : this.cfg.engine.komi,
      myColor,
      currentPlayer: data.currentPlayer || 'black',
      board: emptyBoard(boardSize),
      koPoint: null,
      passes: 0,
    };
    if (data.board) this.loadBoard(data.board, data.koPoint);
    this.moveCount = 0;

    // Reset the KataGo board for this game.
    if (this.kata) {
      this.kata.newGame(this.state.boardSize, this.state.komi)
        .catch((e) => logErr('katago newGame error:', e.message));
    }
  }

  loadBoard(boardArr, koPoint) {
    const st = this.state;
    for (let r = 0; r < st.boardSize; r++) {
      for (let c = 0; c < st.boardSize; c++) {
        const v = boardArr[r] && boardArr[r][c];
        st.board[r][c] = v === 'b' ? 'b' : v === 'w' ? 'w' : null;
      }
    }
    st.koPoint = koPoint || null;
  }

  onMoveMade(data) {
    if (!this.state) return;
    this.thinking = false;
    if (DEBUG) {
      const before = boardChecksum(this.state.board);
      log('DBG move-made hasBoard=' + !!data.board,
          'serverBoard=' + (data.board ? boardChecksum(data.board) : '-'),
          'myBefore=' + before,
          'move=' + data.r + ',' + data.c, data.color, 'currentPlayer=' + data.currentPlayer);
    }
    const colorChar = data.color === 'black' ? 'b' : 'w';
    // apply to our tracked board (incremental), then reconcile with server board
    this.applyStone(data.r, data.c, colorChar);
    if (data.board) this.loadBoard(data.board, data.koPoint);
    this.state.currentPlayer = data.currentPlayer || (data.color === 'black' ? 'white' : 'black');
    this.moveCount++;
    const who = (this.state.myColor && data.color === this.state.myColor) ? 'we' : 'opponent';
    log('move', this.moveCount, who, this.coordLabel(data.r, data.c), '(' + data.r + ',' + data.c + ')');
    if (this.kata) this.kata.play(data.color, { r: data.r, c: data.c }).catch(() => {});
    this.maybeMove();
  }

  applyStone(r, c, colorChar) {
    // minimal incremental apply using the rules engine (for captures)
    const g = new Go.GoGame({ size: this.state.boardSize, komi: this.state.komi });
    for (let rr = 0; rr < this.state.boardSize; rr++)
      for (let cc = 0; cc < this.state.boardSize; cc++)
        g.board[rr][cc] = this.state.board[rr][cc];
    g.turn = colorChar;
    const res = g.play(r, c, colorChar);
    if (res.ok) {
      this.state.board = g.board;
      this.state.koPoint = g.koPoint;
    }
  }

  onPassed(data) {
    if (!this.state) return;
    this.thinking = false;
    this.state.passes = (this.state.passes || 0) + 1;
    this.state.koPoint = null;
    this.state.currentPlayer = data.currentPlayer || (data.color === 'black' ? 'white' : 'black');
    this.moveCount++;
    const who = (this.state.myColor && data.color === this.state.myColor) ? 'we' : 'opponent';
    log('pass', who);
    if (this.kata) this.kata.play(data.color, { pass: true }).catch(() => {});
    this.maybeMove();
  }

  onMoveRejected(data) {
    if (!this.state) return;
    this.thinking = false;
    log('move rejected:', data.reason || JSON.stringify(data));
    if (data.board) this.loadBoard(data.board, data.koPoint);
    if (data.currentPlayer) this.state.currentPlayer = data.currentPlayer;
    this.maybeMove();
  }

  onGameState(data) {
    if (!data || data.throttled || data.error) return;
    if (data.gameActive === false) return;
    if (!this.state && data.boardSize) {
      // rebuild minimal state from a resumed game
      this.state = {
        boardSize: data.boardSize,
        komi: data.komi != null ? data.komi : this.cfg.engine.komi,
        myColor: this.state ? this.state.myColor : null,
        currentPlayer: data.currentPlayer || 'black',
        board: emptyBoard(data.boardSize),
        koPoint: null,
        passes: 0,
      };
    }
    if (this.state) {
      if (data.currentPlayer) this.state.currentPlayer = data.currentPlayer;
      if (data.board) this.loadBoard(data.board, data.koPoint);
      if (data.blackCaptures != null) { /* ignore; captures derived from board */ }
      this.maybeMove();
    }
  }

  onEnterScoring(data) { this.handleScoring(data); }
  onScoringUpdate(data) { this.handleScoring(data); }

  handleScoring(data) {
    if (!this.state || this.ended) return;
    this.scoring = true;
    log('entering scoring phase');
    // Mark clearly-dead stones (conservative Benson-based guess) then confirm.
    try {
      const g = buildGameFromState(this.state);
      const dead = g.guessDeadStones();
      const keys = Object.keys(dead);
      if (keys.length) log('marking', keys.length, 'dead stone(s)');
      for (const k of keys) {
        const [r, c] = k.split(',').map(Number);
        this.socket.emit('mark-dead', { roomId: this.currentRoomId, r, c });
      }
    } catch (e) {
      logErr('dead-stone guess failed:', e.message);
    }
    setTimeout(() => {
      if (!this.ended && this.currentRoomId) this.socket.emit('confirm-score', { roomId: this.currentRoomId });
    }, 400);
  }

  onGameEnd(data) {
    this.ended = true;
    this.thinking = false;
    const myColor = this.state && this.state.myColor;
    let result = 'game over';
    if (data.type === 'draw') result = 'draw';
    else if (data.type === 'no-result') result = 'no result';
    else if (data.winnerColor) result = (data.winnerColor === myColor ? 'WE WIN' : 'we lose');
    else if (data.winner) result = data.winner;
    log('GAME END:', result, '| reason:', data.reason || 'score', '| score:', JSON.stringify(data.score || {}));
    if (this.cfg.autoRematch && this.currentRoomId) {
      setTimeout(() => this.socket.emit('rematch', { roomId: this.currentRoomId }), 1500);
    }
  }

  maybeMove() {
    if (!this.state || this.ended || this.thinking || this.scoring) return;
    if (this.state.currentPlayer !== this.state.myColor) return;
    this.thinking = true;
    const delay = this.cfg.moveDelayMs || 0;
    setTimeout(() => this.computeAndMove(), delay);
  }

  async computeAndMove() {
    const st = this.state;
    if (!st || this.ended || st.currentPlayer !== st.myColor) { this.thinking = false; return; }
    try {
      const myColorChar = st.myColor === 'black' ? 'b' : 'w';
      // Termination safeguard: pass when the game has run absurdly long (a
      // capture/ko cycle that would otherwise never end).
      const maxMoves = this.cfg.maxMoves || st.boardSize * st.boardSize * 2;

      let move = null;
      if (this.kata) {
        // ---- KataGo backend -------------------------------------------------
        if (this.moveCount >= maxMoves) {
          move = { pass: true };
          log('move cap reached, passing to end the game');
        } else {
          const t0 = Date.now();
          move = await this.kata.genmove(myColorChar, this.cfg.engine.timeBudgetMs);
          log('katago chose', move && (move.pass ? 'pass' : move.resign ? 'resign' : this.coordLabel(move.r, move.c)),
              'in', Date.now() - t0, 'ms');
        }
      } else {
        // ---- built-in MCTS backend -----------------------------------------
        const g = buildGameFromState(st);
        const legal = g.legalMoves(myColorChar);

        // count empty intersections
        let emptyCount = 0;
        for (let r = 0; r < st.boardSize; r++)
          for (let c = 0; c < st.boardSize; c++)
            if (!st.board[r][c]) emptyCount++;

        if (legal.length === 0 || emptyCount <= 2 || this.moveCount >= maxMoves) {
          move = { pass: true };
          if (this.moveCount >= maxMoves) log('move cap reached, passing to end the game');
        } else {
          const t0 = Date.now();
          move = await chooseMove(g, {
            size: st.boardSize,
            color: myColorChar,
            komi: st.komi,
            timeBudgetMs: this.cfg.engine.timeBudgetMs,
            workers: this.cfg.engine.workers,
            seed: (Date.now() & 0xffffffff) ^ (this.moveCount * 2654435761),
          });
          log('engine chose', move && (move.pass ? 'pass' : this.coordLabel(move.r, move.c)), 'in', Date.now() - t0, 'ms');
        }
      }

      if (this.ended || st.currentPlayer !== st.myColor) { this.thinking = false; return; }

      if (move && move.resign) {
        log('we resign');
        this.socket.emit('resign', { roomId: this.currentRoomId });
      } else if (move && move.pass) {
        log('we pass');
        this.socket.emit('pass-move', { roomId: this.currentRoomId });
      } else if (move && move.r != null) {
        this.socket.emit('make-move', { roomId: this.currentRoomId, r: move.r, c: move.c });
        log('played', this.coordLabel(move.r, move.c), '(' + move.r + ',' + move.c + ')');
      } else {
        // fallback: pass
        log('no move found, passing');
        this.socket.emit('pass-move', { roomId: this.currentRoomId });
      }
    } catch (e) {
      logErr('computeAndMove error:', e && e.stack || e);
      // safest fallback: pass rather than crash mid-game
      if (!this.ended && this.currentRoomId) this.socket.emit('pass-move', { roomId: this.currentRoomId });
    }
    // thinking stays true until the server echoes the move (move-made/pass clears it)
  }

  coordLabel(r, c) {
    if (this.state) {
      const letters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';
      const col = letters[c] || String(c);
      const row = this.state.boardSize - r;
      return col + row;
    }
    return '(' + r + ',' + c + ')';
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------
(async () => {
  const cfg = loadConfig();

  if (ARGS.includes('--register')) {
    if (!cfg.auth.email || !cfg.auth.password || !cfg.auth.username) {
      logErr('register needs auth.email, auth.password and auth.username in config.json');
      process.exit(1);
    }
    await register(cfg);
    process.exit(0);
  }

  if (ARGS.includes('--login')) {
    const t = await ensureAuth(cfg);
    process.exit(t ? 0 : 1);
  }

  const token = await ensureAuth(cfg);
  if (cfg.engine.workers === 0) cfg.engine.workers = Math.min(8, (require('os').cpus() || []).length || 4);

  // Resolve the engine: KataGo if requested and available, else built-in MCTS.
  const engineType = (cfg.engine.type || 'auto').toLowerCase();
  let kata = null;
  if (engineType === 'katago' || engineType === 'auto') {
    kata = await initKataGo(cfg);
    if (!kata && engineType === 'katago') {
      logErr('KataGo was requested (engine.type="katago") but failed to start; falling back to MCTS');
    }
  }
  const usingKata = !!kata;
  log('engine:', usingKata ? 'KataGo' : 'MCTS (built-in)',
      '| timeBudgetMs=' + cfg.engine.timeBudgetMs + ', boardSize=' + cfg.boardSize);

  const bot = new GoBot(cfg, token, kata);
  bot.connect();

  process.on('SIGINT', () => { if (kata) kata.quit(); log('shutting down'); process.exit(0); });
})();
