// One-time setup: download KataGo (v1.17.1, Eigen CPU + OpenCL backends) and the
// b18c384nbt neural network into ./katago/.
//
//   node setup-katago.mjs                 (normal)
//   node --use-system-ca setup-katago.mjs (if GitHub/katagotraining TLS fails)
//
// Downloads are resumable: re-run the script and it continues where it stopped.
import { createWriteStream, createReadStream, mkdirSync, existsSync, statSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const DIR = 'katago';
mkdirSync(DIR, { recursive: true });

const ZIP_EIGEN = 'https://github.com/lightvector/KataGo/releases/download/v1.17.1/katago-v1.17.1-eigen-windows-x64.zip';
const ZIP_OPENCL = 'https://github.com/lightvector/KataGo/releases/download/v1.17.1/katago-v1.17.1-opencl-windows-x64.zip';
const MODEL_URL = 'https://media.katagotraining.org/uploaded/networks/models/kata1/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz';
const MODEL = path.join(DIR, 'model.bin.gz');

// Sequential download with resume (Range). Returns when the file is complete.
async function downloadResumable(url, out) {
  // 1) learn total size
  const probe = await fetch(url, { headers: { 'User-Agent': UA, 'Range': 'bytes=0-0' } });
  if (probe.status !== 206) throw new Error('HTTP ' + probe.status + ' (no range support?) ' + url);
  const total = Number((probe.headers.get('content-range') || '').split('/')[1]);
  if (!total) throw new Error('cannot determine size for ' + url);

  if (existsSync(out) && statSync(out).size === total) { console.log('SKIP (complete)', out); return; }

  const have = existsSync(out) ? statSync(out).size : 0;
  console.log('GET', url, have > 0 ? '(resume from ' + have + ')' : '');
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Range': `bytes=${have}-${total - 1}` } });
  if (r.status !== 206) throw new Error('range ' + r.status + ' for ' + url);

  const ws = createWriteStream(out, { flags: have > 0 ? 'a' : 'w' });
  const reader = r.body.getReader();
  let got = 0, lastLog = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!ws.write(Buffer.from(value))) await new Promise((res) => ws.once('drain', res));
    const now = Date.now();
    if (now - lastLog > 3000) {
      lastLog = now;
      process.stdout.write('\r  ' + path.basename(out) + ': ' + ((have + got) / 1048576).toFixed(1) + '/' + (total / 1048576).toFixed(1) + ' MB');
    }
  }
  await new Promise((res) => ws.end(res));
  console.log('\n  ->', out, statSync(out).size, 'bytes');
}

function extract(zip, dest) {
  if (existsSync(path.join(dest, 'katago.exe'))) { console.log('SKIP (extracted)', dest); return; }
  mkdirSync(dest, { recursive: true });
  const r = spawnSync('tar', ['-xf', zip, '-C', dest], { shell: false });
  if (r.status !== 0) {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${dest}' -Force`], { shell: false });
    if (ps.status !== 0) throw new Error('failed to extract ' + zip);
  }
  console.log('extracted ->', dest);
}

// ---- main -------------------------------------------------------------------
const zipEigen = path.join(DIR, 'eigen.zip');
const zipOpencl = path.join(DIR, 'opencl.zip');
await downloadResumable(ZIP_EIGEN, zipEigen);
await downloadResumable(ZIP_OPENCL, zipOpencl);
await downloadResumable(MODEL_URL, MODEL);
extract(zipEigen, path.join(DIR, 'eigen'));
extract(zipOpencl, path.join(DIR, 'opencl'));

console.log('\n--- katago/ ---');
for (const f of readdirSync(DIR)) {
  const st = statSync(path.join(DIR, f));
  console.log((st.isDirectory() ? 'DIR  ' : 'FILE '), f, st.isDirectory() ? '' : (st.size / 1048576).toFixed(1) + ' MB');
}
console.log('\nKataGo is ready. Run `node bot.js` to use it.');
