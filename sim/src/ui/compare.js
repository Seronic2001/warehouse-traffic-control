// Comparison modal: this project's distributed design (16 region managers,
// edge-chasing probes, gossiped loads) against a centralised one (a single
// server owns every cell, sees the whole wait-for graph, and knows every
// region's load exactly). Robots, leases, fencing, epochs, the network and
// congestion-aware routing are identical in both; only the coordination layer
// differs. Three sweeps, all in background workers:
//   S. normal operation vs robot density, with a server fast enough for anything
//   K. equal hardware: every coordinator node handles the same messages per second
//   F. coordinator crashes every 45 s
import { MODE_SERIES } from '../render/palette.js';
import { lineChart, section } from './bench.js';
import { runPool, poolSize } from './pool.js';

const $ = (id) => document.getElementById(id);
const MODES = ['detect', 'central'];
const TICK_S = 0.05;
const SEEDS = [1, 2, 3];
const DENSITIES = [50, 100, 150, 200];
const S_TICKS = 2400; // 2 minutes
const RATES = [10, 20, 30, 40, 50, 60]; // messages per tick per node
const K_ROBOTS = 200;
const K_SEEDS = [1, 2];
const EQUAL_RATE = 30; // the "equal hardware" row of the scorecard
const F_ROBOTS = 120;
const F_TICKS = 3600; // 3 minutes: 4 coordinator crashes
const F_SEEDS = [1, 2];
const perSec = (rate) => rate / TICK_S;

const LABEL = { detect: 'Distributed (this project)', central: 'Centralised server' };
const SHORT = { detect: 'Distributed', central: 'Centralised' };
const color = (m) => MODE_SERIES[m].hex;

export class Compare {
  constructor(app) {
    this.app = app;
    this.results = new Map();
    this.isOpen = false;
    $('btn-compare').addEventListener('click', () => this.open());
    $('cmp-close').addEventListener('click', () => this.close());
    $('compare').addEventListener('click', (e) => e.target.id === 'compare' && this.close());
    $('cmp-run').addEventListener('click', () => this.run());
    const cores = poolSize();
    $('cmp-dur').textContent = cores > 5 ? `about 30 seconds on ${cores} CPU cores` : cores > 1 ? `about a minute on ${cores} CPU cores` : 'a few minutes';
    this.refresh();
  }

  refresh() {
    $('cmp-legend').innerHTML = MODES.map((m) => `<span><i style="background:${color(m)}"></i>${LABEL[m]}</span>`).join('');
    this.draw();
  }

  open() {
    $('compare').hidden = false;
    this.isOpen = true;
  }

  close() {
    $('compare').hidden = true;
    this.isOpen = false;
  }

  jobs() {
    const base = { ...this.app.cfg };
    delete base.mode;
    delete base.robots;
    delete base.seed;
    base.mgrRate = 0;
    base.floors = 1;
    base.injectFailures = false;
    const jobs = [];
    for (const mode of MODES) {
      for (const n of DENSITIES) for (const seed of SEEDS) jobs.push({ id: `S:${mode}:${n}:${seed}`, cfg: { ...base, mode, robots: n, seed }, ticks: S_TICKS });
      for (const rate of RATES) for (const seed of K_SEEDS) jobs.push({ id: `K:${mode}:${rate}:${seed}`, cfg: { ...base, mode, robots: K_ROBOTS, seed, mgrRate: rate }, ticks: S_TICKS });
      for (const kind of ['clean', 'crash']) for (const seed of F_SEEDS) jobs.push({ id: `F:${mode}:${kind}:${seed}`, cfg: { ...base, mode, robots: F_ROBOTS, seed, injectFailures: kind === 'crash' && 'managers' }, ticks: F_TICKS });
    }
    return jobs;
  }

  run() {
    this.stop();
    this.results = new Map();
    this.draw();
    $('cmp-run').disabled = true;
    const prog = $('cmp-progress');
    prog.hidden = false;
    prog.querySelector('div').style.width = '0%';
    this.pool = runPool(this.jobs(), {
      onResult: (id, summary, done, total) => {
        this.results.set(id, summary);
        prog.querySelector('div').style.width = `${(done / total) * 100}%`;
        prog.querySelector('span').textContent = `${done} / ${total} runs · ${this.pool.cores} worker${this.pool.cores === 1 ? '' : 's'}`;
        if (done % 6 === 0 || done === total) this.draw();
      },
      onDone: (secs, cores) => {
        prog.querySelector('span').textContent = `Done · ${this.pool.total} runs on ${cores} worker${cores === 1 ? '' : 's'} in ${secs.toFixed(0)}s`;
        $('cmp-run').disabled = false;
        $('cmp-run').textContent = 'Run again';
      },
    });
    prog.querySelector('span').textContent = `Starting ${this.pool.cores} worker${this.pool.cores === 1 ? '' : 's'}…`;
  }

  stop() {
    this.pool?.stop();
    this.pool = null;
  }

  // Mean of `pick(summary)` over a sweep's seeds, ignoring missing values.
  mean(ids, pick) {
    const vals = ids.map((id) => this.results.get(id)).filter(Boolean).map(pick).filter((v) => v != null && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  s(mode, n, pick) {
    return this.mean(SEEDS.map((seed) => `S:${mode}:${n}:${seed}`), pick);
  }

  k(mode, rate, pick) {
    return this.mean(K_SEEDS.map((seed) => `K:${mode}:${rate}:${seed}`), pick);
  }

  f(mode, kind, pick) {
    return this.mean(F_SEEDS.map((seed) => `F:${mode}:${kind}:${seed}`), pick);
  }

  // Smallest per-node capacity at which 200 robots keep 90% of the
  // throughput they reach with an unlimited server.
  capacityNeeded(mode) {
    const free = this.s(mode, K_ROBOTS, (r) => r.tasks);
    if (free == null) return null;
    for (const rate of RATES) {
      const v = this.k(mode, rate, (r) => r.tasks);
      if (v == null) return null;
      if (v >= 0.9 * free) return perSec(rate);
    }
    return Infinity;
  }

  scorecard() {
    const all = (mode) => [...this.results].filter(([id]) => id.split(':')[1] === mode);
    const collisions = (mode) => (all(mode).length ? all(mode).reduce((a, [, r]) => a + r.collisions, 0) : null);
    const meanOver = (mode, pick) => {
      const v = DENSITIES.map((n) => this.s(mode, n, pick)).filter((x) => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const s1 = (v) => v.toFixed(1), s2 = (v) => v.toFixed(2);
    const groups = [
      {
        title: 'Normal operation',
        rows: [
          { label: 'Safety', note: 'Collisions between protected robots, all runs', better: 'lower', tol: 0.5, fmt: (v) => `${v}`, get: collisions, why: { close: 'Both use the same leases, fencing epochs and floor sensor, so neither ever collides.' } },
          { label: 'Throughput', note: 'Tasks / min, mean of 50–200 robots, fast server', better: 'higher', fmt: (v) => v.toFixed(0), get: (m) => meanOver(m, (r) => r.throughput), why: { close: 'Same robots and traffic rules: who grants the lease barely changes how fast the floor moves.' } },
          { label: 'Lease wait (p95)', note: 'Seconds, at 150 robots', better: 'lower', tol: 0.25, fmt: (v) => `${s2(v)} s`, get: (m) => this.s(m, 150, (r) => r.waitP95), why: { close: 'Queueing is set by traffic on the floor, not by where the table lives.' } },
          { label: 'Deadlock resolution', note: 'Seconds from cycle forming to a victim yielding', better: 'lower', tol: 0.25, fmt: (v) => `${s2(v)} s`, get: (m) => meanOver(m, (r) => r.avgResolve), why: { close: 'Probes take a few network hops; the server scans its graph every 0.4 s. It comes out about even.', detect: 'Probes start as soon as a robot has waited long enough; the server only scans its graph periodically.', central: 'The server sees the whole wait-for graph at once instead of chasing edges hop by hop.' } },
          { label: 'Network messages', note: 'Messages per move, at 150 robots', better: 'lower', fmt: s1, get: (m) => this.s(m, 150, (r) => r.msgsPerMove), why: { central: 'No probes and no load gossip: the server already knows the wait-for graph and every region’s load. This is the price of decentralising.', close: 'Probes and gossip add little traffic at this density.' } },
        ],
      },
      {
        title: 'Scalability',
        rows: [
          { label: 'Busiest coordinator', note: `Peak messages / s on one node, ${K_ROBOTS} robots`, better: 'lower', fmt: (v) => `${v.toFixed(0)}/s`, get: (m) => this.s(m, K_ROBOTS, (r) => r.mgrPeak), why: { detect: 'Sixteen managers split the floor; the central server handles every request, renewal and release alone.' } },
          { label: 'Equal hardware', note: `Tasks / min at ${K_ROBOTS} robots, each node ${perSec(EQUAL_RATE)} msgs/s`, better: 'higher', fmt: (v) => v.toFixed(0), get: (m) => this.k(m, EQUAL_RATE, (r) => r.throughput), why: { detect: 'On the same machines the server falls behind: grants and renewals queue up, leases run out and robots stall.' } },
          { label: 'Capacity needed', note: `Per-node msgs/s to keep 90% of throughput at ${K_ROBOTS} robots`, better: 'lower', fmt: (v) => (v === Infinity ? `> ${perSec(RATES[RATES.length - 1])}` : `${v.toFixed(0)}/s`), get: (m) => this.capacityNeeded(m), why: { detect: 'Each region manager can be a small, cheap machine; the central server must be sized for the whole floor at its peak.' } },
        ],
      },
      {
        title: 'Fault tolerance',
        rows: [
          { label: 'Crash blast radius', note: `Robots cut off per coordinator crash, ${F_ROBOTS} robots`, better: 'lower', fmt: (v) => v.toFixed(0), get: (m) => this.f(m, 'crash', (r) => r.outageRobots), why: { detect: 'A region manager crash only affects robots in or heading into that region. The central server is a single point of failure: the whole floor stops.' } },
          { label: 'Throughput lost', note: 'Share of tasks lost to a coordinator crash every 45 s', better: 'lower', tol: 3, fmt: (v) => `${v.toFixed(0)}%`, get: (m) => this.lost(m), why: { detect: 'The other fifteen regions keep working while one manager reconciles; with one server, every robot waits.', close: 'Outages are short (4 s down + reconciliation), so either way most of the work still gets done.' } },
          { label: 'Recovery time', note: 'Seconds from crash to grants resuming', better: 'lower', tol: 0.3, fmt: (v) => `${s1(v)} s`, get: (m) => this.f(m, 'crash', (r) => r.recovery.mgrReconcile), why: { close: 'Same restart protocol: bump the incarnation, collect robot reports, rebuild the table.' } },
        ],
      },
    ];
    for (const g of groups)
      for (const row of g.rows) {
        row.vals = MODES.map((m) => row.get(m));
        row.verdict = verdict(row, ...row.vals);
      }
    return groups;
  }

  draw() {
    const grid = $('cmp-grid');
    if (!this.results.size) {
      grid.innerHTML = `<div class="bench-empty">Run the comparison to race this project's distributed design against a single central server: normal operation from 50 to 200 robots, the same per-node hardware, and coordinator crashes.</div>`;
      return;
    }
    grid.innerHTML = '';
    grid.appendChild(this.scoreCard());

    // ── S ──
    grid.appendChild(section('Normal operation', `${SEEDS.length} seeds × ${(S_TICKS * TICK_S) / 60} minutes per point. The central server is given unlimited capacity here, its best case.`));
    const dens = (title, note, pick, fmt) =>
      lineChart({ title, note, xs: DENSITIES, xFmt: (n) => `${n}`, xName: 'robots', fmt, series: MODES.map((m) => ({ label: LABEL[m], color: color(m), values: DENSITIES.map((n) => this.s(m, n, pick)) })) });
    grid.appendChild(dens('Throughput', 'Tasks completed per minute', (r) => r.throughput, (v) => v.toFixed(0)));
    grid.appendChild(dens('95th-percentile lease wait', 'Seconds: 95% of lease requests are granted within this', (r) => r.waitP95, (v) => `${v.toFixed(2)}s`));
    grid.appendChild(dens('Messages per move', 'Requests, grants, renewals, probes, gossip…', (r) => r.msgsPerMove, (v) => v.toFixed(1)));
    grid.appendChild(dens('Time to resolve a deadlock', 'Seconds from cycle forming to victim yielding (gaps: no deadlocks)', (r) => r.avgResolve, (v) => `${v.toFixed(2)}s`));

    // ── K ──
    grid.appendChild(section('Scalability: load on one coordinator', `How hard the busiest coordinator node works, and what happens when every node, region manager or central server, gets the same hardware: messages beyond its capacity wait in its inbox. ${K_ROBOTS} robots, ${K_SEEDS.length} seeds.`));
    grid.appendChild(dens('Busiest coordinator node', 'Peak messages per second handled by a single node', (r) => r.mgrPeak, (v) => v.toFixed(0)));
    const xs = RATES.map(perSec);
    grid.appendChild(
      lineChart({ title: `Throughput vs node capacity`, note: `Tasks per minute at ${K_ROBOTS} robots, by messages per second each node can handle`, xs, xFmt: (v) => `${v}`, xName: 'node capacity (msgs/s)', fmt: (v) => v.toFixed(0), series: MODES.map((m) => ({ label: LABEL[m], color: color(m), values: RATES.map((rate) => this.k(m, rate, (r) => r.throughput)) })) }),
    );
    grid.appendChild(
      lineChart({ title: 'Inbox delay vs node capacity', note: 'Seconds a message waits, on average, before its coordinator gets to it', xs, xFmt: (v) => `${v}`, xName: 'node capacity (msgs/s)', fmt: (v) => `${v.toFixed(v < 1 ? 2 : 1)}s`, series: MODES.map((m) => ({ label: LABEL[m], color: color(m), values: RATES.map((rate) => this.k(m, rate, (r) => r.mgrQueueMs / 1000)) })) }),
    );

    // ── F ──
    grid.appendChild(section('Coordinator failure', `${F_ROBOTS} robots, ${(F_TICKS * TICK_S) / 60} minutes, a coordinator crash every 45 s (down 4 s, then reconciliation). In the distributed design one random region manager crashes; in the centralised one, the server.`));
    grid.appendChild(this.failureCard());
  }

  scoreCard() {
    const groups = this.scorecard();
    const rows = groups.flatMap((g) => g.rows);
    const count = (v) => rows.filter((r) => r.verdict === v).length;
    const card = document.createElement('div');
    card.className = 'chart cmp-score';
    const chip = { detect: 'Distributed better', close: 'Close', central: 'Centralised better', pending: '…' };
    const cell = (row, i) => {
      const v = row.vals[i];
      const win = row.verdict === MODES[i];
      return `<td class="${win ? 'win' : ''}" data-l="${SHORT[MODES[i]]}">${v == null ? '—' : row.fmt(v)}</td>`;
    };
    card.innerHTML = `
      <div class="cmp-tally">
        <div class="t-detect"><b>${count('detect')}</b><span>distributed better</span></div>
        <div class="t-close"><b>${count('close')}</b><span>close</span></div>
        <div class="t-central"><b>${count('central')}</b><span>centralised better</span></div>
      </div>
      <table>
        <thead><tr><th>Category</th><th><i style="background:${color('detect')}"></i>${SHORT.detect}</th><th><i style="background:${color('central')}"></i>${SHORT.central}</th><th>Verdict</th></tr></thead>
        ${groups
          .map(
            (g) => `<tbody><tr class="grp"><td colspan="4">${g.title}</td></tr>${g.rows
              .map(
                (row) => `<tr>
                  <td><b>${row.label}</b><small>${row.note}</small></td>
                  ${cell(row, 0)}${cell(row, 1)}
                  <td><span class="vchip v-${row.verdict}">${chip[row.verdict]}</span>${row.verdict !== 'pending' && row.why[row.verdict] ? `<small>${row.why[row.verdict]}</small>` : ''}</td>
                </tr>`,
              )
              .join('')}</tbody>`,
          )
          .join('')}
      </table>`;
    return card;
  }

  // Percentage of tasks lost to coordinator crashes, against the same run
  // without them.
  lost(mode) {
    const c = this.f(mode, 'crash', (r) => r.tasks), b = this.f(mode, 'clean', (r) => r.tasks);
    return c == null || b == null ? null : Math.max(0, (1 - c / b) * 100);
  }

  failureCard() {
    const card = document.createElement('div');
    card.className = 'chart recovery';
    const rows = [
      { label: 'Robots cut off per crash', note: `out of ${F_ROBOTS}: tried to reach the coordinator while it was down`, get: (m) => this.f(m, 'crash', (r) => r.outageRobots), fmt: (v) => v.toFixed(0), max: F_ROBOTS },
      { label: 'Throughput lost', note: 'tasks lost vs the same run without crashes', get: (m) => this.lost(m), fmt: (v) => `${v.toFixed(0)}%` },
      { label: 'Recovery time', note: 'crash → grants resume', get: (m) => this.f(m, 'crash', (r) => r.recovery.mgrReconcile), fmt: (v) => `${v.toFixed(1)} s` },
    ];
    const bar = (row, m) => {
      const v = row.get(m);
      const max = row.max ?? Math.max(1, ...MODES.map((x) => row.get(x) || 0));
      return `<div class="rec-bar" title="${LABEL[m]}"><i style="width:${v == null ? 0 : Math.max(1.5, (v / max) * 100)}%;background:${color(m)}"></i><span>${v == null ? '—' : row.fmt(v)}</span></div>`;
    };
    card.innerHTML = `<h3>Impact of a coordinator crash</h3><p>Bar colour = design. Means over ${F_SEEDS.length} seeds.</p>
      <div class="rec-rows">${rows.map((row) => `<div class="rec-row"><div class="rec-label"><b>${row.label}</b><small>${row.note}</small></div><div class="rec-bars">${MODES.map((m) => bar(row, m)).join('')}</div></div>`).join('')}</div>`;
    return card;
  }
}

// Which design wins a row: within 15% (or the row's absolute tolerance) is
// "close".
function verdict(row, a, b) {
  if (a == null || b == null) return 'pending';
  if (a === b) return 'close';
  const diff = Math.abs(a - b);
  if (diff <= (row.tol ?? 0)) return 'close';
  if (Number.isFinite(a) && Number.isFinite(b) && diff / Math.max(Math.abs(a), Math.abs(b)) < 0.15) return 'close';
  const aBetter = row.better === 'higher' ? a > b : a < b;
  return aBetter ? 'detect' : 'central';
}
