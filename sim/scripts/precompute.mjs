// Runs every Benchmark job (both tabs) headless and saves the summaries to
// src/data/precomputed.csv (one row per run), which the "Saved results" tab
// shows instantly.
// Same jobs, same settings as pressing Run in the page with the defaults
// (120 robots, seed 42). Takes 15–20 minutes on 8 cores.
//
//   npm run precompute
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { writeFileSync, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { Simulation, DEFAULTS } from '../src/sim/simulation.js';
import { toCsv } from '../src/sim/csv.js';

if (!isMainThread) {
  parentPort.on('message', (job) => {
    const sim = new Simulation(job.cfg);
    for (let t = 0; t < job.ticks; t++) sim.step();
    parentPort.postMessage({ id: job.id, summary: sim.summary() });
  });
} else {
  // The pages' job lists, built from the page's default settings.
  globalThis.navigator ??= { hardwareConcurrency: 2 };
  const { Bench } = await import('../src/ui/bench.js');
  const { Compare } = await import('../src/ui/compare.js');
  const app = { cfg: { ...DEFAULTS, robots: 120, seed: 42 } };
  const jobs = [
    ...Bench.prototype.jobs.call({ app }).map((j) => ({ ...j, tab: 'bench' })),
    ...Compare.prototype.jobs.call({ app }).map((j) => ({ ...j, tab: 'compare' })),
  ].sort((a, b) => b.ticks * b.cfg.robots - a.ticks * a.cfg.robots);

  const out = { generated: new Date().toISOString().slice(0, 10), seed: app.cfg.seed, runs: jobs.length, bench: {}, compare: {} };
  const n = Math.max(1, Math.min(jobs.length, cpus().length - 1));
  const t0 = Date.now();
  let next = 0, done = 0;
  await new Promise((resolve) => {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL(import.meta.url));
      const feed = () => {
        if (next >= jobs.length) {
          w.terminate();
          if (done === jobs.length) resolve();
          return;
        }
        w.postMessage(jobs[next++]);
      };
      w.on('message', ({ id, summary }) => {
        const job = jobs.find((j) => j.id === id && !(id in out[j.tab]));
        out[job.tab][id] = summary;
        done++;
        process.stdout.write(`\r${done} / ${jobs.length} runs · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        feed();
      });
      feed();
    }
  });
  mkdirSync(new URL('../src/data/', import.meta.url), { recursive: true });
  const rows = [];
  for (const tab of ['bench', 'compare']) for (const [id, s] of Object.entries(out[tab])) rows.push({ tab, id, generated: out.generated, seed: out.seed, ...s });
  writeFileSync(new URL('../src/data/precomputed.csv', import.meta.url), toCsv(rows));
  console.log(`\nSaved ${jobs.length} runs to src/data/precomputed.csv`);
}
