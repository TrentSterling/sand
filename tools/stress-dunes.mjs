import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const html = await readFile(process.argv[2] || new URL('../index.html', import.meta.url), 'utf8');
const bytes = Buffer.from(html.match(/<script id="wasm"[^>]*>([^<]+)<\/script>/)[1], 'base64');
const { instance } = await WebAssembly.instantiate(bytes);
const sim = instance.exports;
const samples = [[], []],
  batchSamples = [[], []];
const ticks = 900,
  repeats = 7,
  batch = 30;
let volume, hash, visits;
for (let rep = -1; rep < repeats; rep++) {
  const counts = [0, 0],
    hashes = [0, 0];
  for (let h = 0; h < 2; h++) {
    const dense = (rep + h + 2) % 2,
      w = sim.dunes_new(dense);
    volume = sim.world_initial_m3(w);
    const batches = [];
    for (let start = 0; start < ticks; start += batch) {
      const then = performance.now();
      for (let f = start; f < start + batch; f++) {
        sim.dune_stress_step(w, f);
        counts[dense] += sim.world_visited(w);
      }
      batches.push(performance.now() - then);
    }
    if (rep >= 0) {
      samples[dense].push(batches.reduce((a, b) => a + b));
      batchSamples[dense].push(...batches);
    }
    assert.equal(sim.world_balance(w), 0);
    hashes[dense] = sim.world_hash(w) >>> 0;
    sim.world_drop(w);
  }
  assert.equal(hashes[0], hashes[1]);
  if (rep >= 0 && hash !== undefined) assert.equal(hashes[0], hash);
  [hash] = hashes;
  visits = counts;
}
function percentile(values, q) {
  const a = values.toSorted((a, b) => a - b);
  return +a[Math.ceil(q * a.length) - 1].toFixed(3);
}
const schedulers = samples.map((runs, i) => ({
  medianReplayMs: percentile(runs, 0.5),
  p95BatchMs: percentile(batchSamples[i], 0.95),
  pairs: visits[i],
}));
console.log(
  JSON.stringify(
    {
      runtime: process.version,
      initialSandM3: volume,
      representedSandTonnes: volume * 1.6,
      grid: [256, 256],
      ticks,
      landslides: 15,
      repeats,
      batchTicks: batch,
      active: schedulers[0],
      dense: schedulers[1],
      hash: hash.toString(16),
      massError: 0,
    },
    null,
    2,
  ),
);
