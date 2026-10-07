// Runs benchmark jobs on a pool of Web Workers, one per spare CPU core. Each
// worker takes the next job as soon as it finishes one; the biggest jobs go
// first so no core is left with a long run at the end.
const POOL_MAX = 8;

export const poolSize = () => Math.max(1, Math.min(POOL_MAX, (navigator.hardwareConcurrency || 2) - 1));

export function runPool(jobs, { onResult, onDone }) {
  jobs = [...jobs].sort((a, b) => b.ticks * b.cfg.robots - a.ticks * a.cfg.robots);
  const cores = Math.min(poolSize(), jobs.length);
  const t0 = performance.now();
  const workers = [];
  let next = 0;
  let done = 0;
  const stop = () => {
    for (const w of workers) w.terminate();
    workers.length = 0;
  };
  const feed = (w) => {
    if (next < jobs.length) w.postMessage({ job: jobs[next++] });
  };
  for (let i = 0; i < cores; i++) {
    const w = new Worker(new URL('../sim/bench.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      done++;
      onResult(e.data.id, e.data.summary, done, jobs.length);
      if (done === jobs.length) {
        stop();
        onDone((performance.now() - t0) / 1000, cores);
      } else feed(w);
    };
    workers.push(w);
    feed(w);
  }
  return { cores, total: jobs.length, stop };
}
