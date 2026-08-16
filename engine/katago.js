'use strict';
/*
 * KataGo GTP client.
 * Spawns `katago gtp -model <model> -config <cfg>` and talks GTP over stdio.
 * Coordinates are converted between the server's (r,c) convention (row 0 = top,
 * col 0 = left) and GTP's letter/number convention (A1 = bottom-left).
 */
const { spawn } = require('child_process');

const COLS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'; // Go letters (skip I)

function colLetter(i) { return COLS[i]; }
function colIndex(letter) { return COLS.indexOf(letter.toUpperCase()); }

// server (r, c) -> "C#" (GTP)
function toGtp(r, c, size) { return colLetter(c) + String(size - r); }

// "C#" / "pass" / "resign" -> { r, c } | { pass } | { resign } | null
function fromGtp(s, size) {
  const t = (s || '').trim().toLowerCase();
  if (t === 'pass') return { pass: true };
  if (t === 'resign') return { resign: true };
  const m = /^([a-z])(\d+)$/.exec(t);
  if (!m) return null;
  const c = colIndex(m[1]);
  if (c < 0) return null;
  const r = size - parseInt(m[2], 10);
  return { r, c, pass: false };
}

class KataGoEngine {
  constructor(opts) {
    this.binary = opts.binary;
    this.model = opts.model;
    this.config = opts.config;
    this.proc = null;
    this.queue = [];
    this.buf = '';
    this.size = 19;
    this.ready = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      const args = ['gtp', '-model', this.model, '-config', this.config];
      let proc;
      try {
        proc = spawn(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) { return reject(e); }
      this.proc = proc;
      proc.stdout.on('data', (d) => this._onData(d));
      proc.stderr.on('data', () => {}); // KataGo diagnostics go to stderr
      proc.on('error', (e) => reject(e));
      proc.on('exit', () => { this.ready = false; });

      // First command confirms the engine loaded its model and is responsive.
      this._cmd('protocol_version')
        .then((v) => { this.ready = true; resolve(v.trim()); })
        .catch(reject);
    });
  }

  _cmd(cmd) {
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, resolve, reject, sent: false });
      this._pump();
    });
  }

  _pump() {
    if (!this.proc || !this.proc.stdin) return;
    for (const q of this.queue) {
      if (q.sent) continue;
      q.sent = true;
      try { this.proc.stdin.write(q.cmd + '\n'); }
      catch (e) { q.reject(e); }
    }
  }

  _onData(d) {
    this.buf += d.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const chunk = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this._handleResponse(chunk);
    }
  }

  _handleResponse(chunk) {
    const first = chunk.split('\n')[0].trim();
    const q = this.queue.shift();
    if (!q) return;
    if (first.startsWith('=')) q.resolve(first.slice(1).trim());
    else if (first.startsWith('?')) q.reject(new Error('gtp: ' + first.slice(1).trim()));
    else q.reject(new Error('bad gtp response: ' + JSON.stringify(chunk)));
  }

  // ---- game lifecycle ----------------------------------------------------
  async newGame(size, komi) {
    this.size = size;
    await this._cmd('boardsize ' + size);
    await this._cmd('clear_board');
    await this._cmd('komi ' + (komi != null ? komi : 7.5));
  }

  // color: 'black'|'white'|'b'|'w'. move: {r,c} | {pass} | {resign}
  async play(color, move) {
    const c = (color === 'black' || color === 'b') ? 'B' : 'W';
    const mv = move.pass ? 'pass' : move.resign ? 'resign' : toGtp(move.r, move.c, this.size);
    await this._cmd('play ' + c + ' ' + mv);
  }

  // Generate a move for `color`, thinking for roughly timeMs.
  async genmove(color, timeMs) {
    const c = (color === 'black' || color === 'b') ? 'B' : 'W';
    if (timeMs != null) {
      const secs = Math.max(0.1, timeMs / 1000).toFixed(1);
      // byo-yomi of `secs` per move (0 main time)
      await this._cmd('time_settings 0 ' + secs + ' 1');
    }
    const res = await this._cmd('genmove ' + c);
    return fromGtp(res, this.size);
  }

  quit() {
    if (this.proc) {
      try { this.proc.stdin.write('quit\n'); } catch (e) {}
      try { this.proc.kill(); } catch (e) {}
      this.proc = null;
    }
  }
}

module.exports = { KataGoEngine, toGtp, fromGtp };
