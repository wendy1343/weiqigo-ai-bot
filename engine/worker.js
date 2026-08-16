'use strict';
// Worker thread: run one MCTS search over a serialized root position and
// report the root-level move statistics back.
const { parentPort } = require('worker_threads');
const Go = require('../go-engine.js');
const E = require('./engine.js');

parentPort.on('message', (msg) => {
  try {
    const gg = Go.GoGame.fromData(msg.rootData);
    const res = E.search(gg, msg.opts);
    parentPort.postMessage({ ok: true, stats: res.stats, iterations: res.iterations });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e && e.stack || e) });
  }
});
