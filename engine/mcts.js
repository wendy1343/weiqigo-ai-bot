'use strict';
// Top-level move chooser: run MCTS in the main thread or fan out across
// worker threads (root parallelization) and merge the results.
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const Go = require('../go-engine.js');
const E = require('./engine.js');

function mergeStats(results) {
  const map = new Map();
  for (const r of results) {
    for (const s of r.stats) {
      const key = s.pass ? 'pass' : s.r + ',' + s.c;
      if (!map.has(key)) map.set(key, { ...s, visits: 0, wins: 0 });
      const e = map.get(key);
      e.visits += s.visits;
      e.wins += s.wins;
    }
  }
  return [...map.values()].sort((a, b) => b.visits - a.visits);
}

function pickBest(stats) {
  if (!stats || !stats.length) return null;
  let best = stats[0];
  for (const s of stats) {
    if (s.visits > best.visits) best = s;
    else if (s.visits === best.visits) {
      const br = best.visits ? best.wins / best.visits : 0;
      const sr = s.visits ? s.wins / s.visits : 0;
      if (sr > br) best = s;
    }
  }
  return best;
}

// rootGame: a Go.GoGame (authoritative, synced to the server position).
// opts: { size, color('b'|'w'), komi, timeBudgetMs, seed, workers }
// Returns a Promise<{ pass, r, c, stats }>.
function chooseMove(rootGame, opts) {
  const timeBudget = opts.timeBudgetMs || 2500;
  const nWorkers = Math.max(1, opts.workers || Math.min(8, os.cpus().length || 4));

  if (nWorkers === 1) {
    const res = E.search(rootGame, {
      size: opts.size, color: opts.color, komi: opts.komi,
      timeBudgetMs: timeBudget, seed: opts.seed || 1,
    });
    return Promise.resolve(pickBest(res.stats));
  }

  const rootData = rootGame.toData();
  return new Promise((resolve) => {
    const results = [];
    let done = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const stats = mergeStats(results);
      resolve(pickBest(stats));
    };
    for (let i = 0; i < nWorkers; i++) {
      const w = new Worker(path.join(__dirname, 'worker.js'));
      const onMsg = (res) => {
        if (res && res.ok) results.push({ stats: res.stats, iterations: res.iterations });
        w.terminate().catch(() => {});
        done++;
        if (done === nWorkers) finish();
      };
      w.on('message', onMsg);
      w.on('error', () => { done++; if (done === nWorkers) finish(); });
      w.postMessage({
        rootData,
        opts: {
          size: opts.size, color: opts.color, komi: opts.komi,
          timeBudgetMs: timeBudget, seed: (opts.seed || 1) + i * 7919 + 13,
        },
      });
    }
  });
}

module.exports = { chooseMove, pickBest, mergeStats };
