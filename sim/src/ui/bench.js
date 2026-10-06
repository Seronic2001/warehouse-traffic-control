// Benchmark modal. Three sweeps, all run in a Web Worker:
//   A. strategies vs robot density (baseline / detection / ordered)
//   B. safety margin under a hostile network (loss, delay, clock drift)
//   C. recovery times after injected crashes, pauses and manager crashes
import { MODE_SERIES } from '../render/palette.js';
import { WAIT_BIN_SECONDS } from '../sim/simulation.js';

const $ = (id) => document.getElementById(id);
const MODES = ['baseline', 'detect', 'ordered'];
const PROTOCOLS = ['detect', 'ordered'];
const DENSITIES = [50, 100, 150, 200];
const TICK_S = 0.05;

const SWEEP_A_TICKS = 2400; // 2 minutes
const MARGINS = [0, 4, 8, 12, 16, 24, 32]; // ticks
const HOSTILE = { mode: 'detect', robots: 120, loss: 0.2, delayMin: 1, delayMax: 6, clockDrift: 0.2, leaseTicks: 40, renewEvery: 10 };
const MARGIN_SEEDS = [1, 2];
const FAIL_TICKS = 3600; // 3 minutes, a failure every 15 s
const POOL_MAX = 8;
const CONG_TICKS = 12000; // 10 minutes: congestion builds up slowly
const CONG_DENSITIES = [100, 150, 200]; // workers; one core is always left for the page

const DENSITY_METRICS = [
  { key: 'collisionsPer1k', title: 'Collisions per 1,000 moves', note: 'Both protocols must stay at 0', fmt: (v) => v.toFixed(1) },
  { key: 'throughput', title: 'Throughput', note: 'Tasks completed per minute', fmt: (v) => v.toFixed(0) },
  { key: 'deadlocksPer1k', title: 'Deadlocks per 1,000 moves', note: 'Wait-for cycles found by probes', fmt: (v) => v.toFixed(2), skip: ['baseline'] },
  { key: 'avgResolve', title: 'Time to resolve a deadlock', note: 'Seconds from cycle forming to victim yielding (gaps: no deadlocks)', fmt: (v) => `${v.toFixed(2)}s`, skip: ['baseline'] },
  { key: 'waitP95', title: '95th-percentile wait for a lease', note: 'Seconds: 95% of lease requests are granted within this', fmt: (v) => `${v.toFixed(2)}s`, skip: ['baseline'] },
  { key: 'msgsPerMove', title: 'Messages per move', note: 'Requests, grants, renewals, probes…', fmt: (v) => v.toFixed(1), skip: ['baseline'] },
];

const RECOVERY_ROWS = [
  { key: 'crashOwnership', label: 'Robot crash → its lease taken back', note: 'lease expiry, then re-grant' },
  { key: 'crashCleared', label: 'Robot crash → Blocked cell cleared', note: 'expiry + maintenance crew' },
  { key: 'pauseResync', label: 'Robot pause → resynced', note: 'from waking up to holding its cell again' },
  { key: 'mgrReconcile', label: 'Manager crash → grants resume', note: 'downtime + reconciliation' },
];

export class Bench {
  constructor(app) {
    this.app = app;
    this.results = new Map();
    this.isOpen = false;
    $('btn-bench').addEventListener('click', () => this.open());
    $('bench-close').addEventListener('click', () => this.close());
    $('bench').addEventListener('click', (e) => e.target.id === 'bench' && this.close());
    $('bench-run').addEventListener('click', () => this.run());
    $('bench-table-btn').addEventListener('click', () => {
      const t = $('bench-table');
      t.hidden = !t.hidden;
      $('bench-table-btn').textContent = t.hidden ? 'Table' : 'Charts';
      $('bench-grid').hidden = !t.hidden;
    });
    const cores = Math.max(1, Math.min(POOL_MAX, (navigator.hardwareConcurrency || 2) - 1));
    $('bench-dur').textContent = cores > 5 ? `about 25 seconds on ${cores} CPU cores` : cores > 1 ? `under a minute on ${cores} CPU cores` : 'about two minutes';
    this.refresh();
  }

  refresh() {
    $('bench-legend').innerHTML = MODES.map((m) => `<span><i style="background:${MODE_SERIES[m].hex}"></i>${MODE_SERIES[m].label}</span>`).join('');
    this.draw();
  }

  open() {
    $('bench').hidden = false;
    this.isOpen = true;
  }

  close() {
    $('bench').hidden = true;
    this.isOpen = false;
  }

  jobs() {
    const base = { ...this.app.cfg };
    delete base.mode;
    delete base.robots;
    const jobs = [];
    for (const n of DENSITIES) for (const mode of MODES) jobs.push({ id: `A:${mode}:${n}`, cfg: { ...base, mode, robots: n }, ticks: SWEEP_A_TICKS });
    for (const m of MARGINS) for (const seed of MARGIN_SEEDS) jobs.push({ id: `B:${m}:${seed}`, cfg: { ...base, ...HOSTILE, safetyMargin: m, seed }, ticks: SWEEP_A_TICKS });
    for (const mode of PROTOCOLS) jobs.push({ id: `C:${mode}`, cfg: { ...base, mode, robots: 120, injectFailures: true }, ticks: FAIL_TICKS });
    for (const n of CONG_DENSITIES) for (const on of [true, false]) jobs.push({ id: `D:${on ? 'on' : 'off'}:${n}`, cfg: { ...base, mode: 'detect', robots: n, congestion: on }, ticks: CONG_TICKS });
    return jobs;
  }

  // Runs the jobs on a pool of workers, one per spare CPU core. Each worker
  // takes the next job as soon as it finishes one; the biggest jobs go first
  // so no core is left with a long run at the end.
  run() {
    this.stop();
    this.results = new Map();
    this.draw();
    $('bench-run').disabled = true;
    const prog = $('bench-progress');
    prog.hidden = false;
    prog.querySelector('div').style.width = '0%';
    const jobs = this.jobs().sort((a, b) => b.ticks * b.cfg.robots - a.ticks * a.cfg.robots);
    const cores = Math.max(1, Math.min(POOL_MAX, (navigator.hardwareConcurrency || 2) - 1, jobs.length));
    prog.querySelector('span').textContent = `Starting ${cores} worker${cores === 1 ? '' : 's'}…`;
    const t0 = performance.now();
    let next = 0;
    let done = 0;
    this.pool = [];
    const feed = (w) => {
      if (next < jobs.length) w.postMessage({ job: jobs[next++] });
    };
    for (let i = 0; i < cores; i++) {
      const w = new Worker(new URL('../sim/bench.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        this.results.set(e.data.id, e.data.summary);
        done++;
        prog.querySelector('div').style.width = `${(done / jobs.length) * 100}%`;
        prog.querySelector('span').textContent = `${done} / ${jobs.length} runs · ${cores} worker${cores === 1 ? '' : 's'}`;
        this.draw();
        if (done === jobs.length) {
          const secs = ((performance.now() - t0) / 1000).toFixed(0);
          prog.querySelector('span').textContent = `Done · seed ${this.app.cfg.seed}, ${jobs.length} runs on ${cores} worker${cores === 1 ? '' : 's'} in ${secs}s`;
          $('bench-run').disabled = false;
          $('bench-run').textContent = 'Run again';
          $('bench-table-btn').disabled = false;
          this.stop();
        } else feed(w);
      };
      this.pool.push(w);
      feed(w);
    }
  }

  stop() {
    for (const w of this.pool || []) w.terminate();
    this.pool = [];
  }

  // Sweep A value for a mode/density.
  a(mode, n, key) {
    const r = this.results.get(`A:${mode}:${n}`);
    return r ? r[key] ?? null : null;
  }

  // Sweep B value for a margin, averaged over seeds.
  b(margin, key) {
    const vals = MARGIN_SEEDS.map((s) => this.results.get(`B:${margin}:${s}`)).filter(Boolean).map((r) => r[key]);
    return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
  }

  draw() {
    const grid = $('bench-grid');
    if (!this.results.size) {
      grid.innerHTML = `<div class="bench-empty">Run the sweeps to compare strategies across 50 to 200 robots, measure the effect of the lease safety margin, time recovery after crashes, pauses and manager failures, and test congestion control over 10-minute runs.</div>`;
      $('bench-table').innerHTML = '';
      return;
    }
    grid.innerHTML = '';

    // ── A ──
    grid.appendChild(section('Strategies vs robot density', `Same seed, ${(SWEEP_A_TICKS * TICK_S) / 60} minutes of warehouse time per run.`));
    for (const metric of DENSITY_METRICS) {
      const modes = MODES.filter((m) => !(metric.skip || []).includes(m));
      grid.appendChild(
        lineChart({
          title: metric.title, note: metric.note, xs: DENSITIES, xFmt: (n) => `${n}`, xName: 'robots', fmt: metric.fmt,
          series: modes.map((m) => ({ label: MODE_SERIES[m].label, color: MODE_SERIES[m].hex, values: DENSITIES.map((n) => this.a(m, n, metric.key)) })),
        }),
      );
    }
    const share = this.a('detect', 150, 'waitShare') || this.a('ordered', 150, 'waitShare');
    if (share) {
      const bins = share.map((_, i) => i);
      const last = bins.length - 1;
      grid.appendChild(
        lineChart({
          title: 'Wait-time distribution at 150 robots',
          note: 'Share of lease requests by how long they waited',
          xs: bins,
          xFmt: (i) => (i === last ? '4+' : (i * WAIT_BIN_SECONDS) % 1 === 0 ? `${i * WAIT_BIN_SECONDS}` : ''),
          tipX: (i) => (i === last ? 'waited ≥ 4 s' : `waited ${(i * WAIT_BIN_SECONDS).toFixed(2)}–${((i + 1) * WAIT_BIN_SECONDS).toFixed(2)} s`),
          xName: 'seconds waited',
          fmt: (v) => `${v.toFixed(1)}%`,
          series: PROTOCOLS.map((m) => ({ label: MODE_SERIES[m].label, color: MODE_SERIES[m].hex, values: this.a(m, 150, 'waitShare') || bins.map(() => null) })),
        }),
      );
    }

    // ── B ──
    grid.appendChild(
      section(
        'Lease safety margin under a hostile network',
        `Leases + detection, 120 robots, ${HOSTILE.loss * 100}% message loss, delay up to ${HOSTILE.delayMax * 50} ms, clocks drifting up to ±${HOSTILE.clockDrift * 100}%, ${HOSTILE.leaseTicks * TICK_S} s leases, averaged over ${MARGIN_SEEDS.length} seeds. With too little margin, robots act on leases that are about to run out. With too much, they can almost never move.`,
      ),
    );
    const mx = MARGINS.map((m) => m * TICK_S);
    const det = MODE_SERIES.detect;
    const one = (key) => [{ label: det.label, color: det.hex, values: MARGINS.map((m) => this.b(m, key)) }];
    grid.appendChild(lineChart({ title: 'Leases lost by working robots', note: 'Per 1,000 moves: renewals failed and the lease expired under a robot that was still running', xs: mx, xFmt: (v) => v.toFixed(1), xName: 'safety margin (s)', fmt: (v) => v.toFixed(1), series: one('liveExpiriesPer1k') }));
    grid.appendChild(lineChart({ title: 'Throughput vs safety margin', note: 'Tasks completed per minute', xs: mx, xFmt: (v) => v.toFixed(1), xName: 'safety margin (s)', fmt: (v) => v.toFixed(0), series: one('throughput') }));
    grid.appendChild(lineChart({ title: 'Risky moves', note: 'Per 1,000 moves: started with less lease left than the move takes. Fencing and the floor sensor still prevent harm.', xs: mx, xFmt: (v) => v.toFixed(1), xName: 'safety margin (s)', fmt: (v) => v.toFixed(2), series: one('riskyPer1k') }));

    // ── C ──
    grid.appendChild(
      section(
        'Recovery after failures',
        `120 robots, ${(FAIL_TICKS * TICK_S) / 60} minutes: a robot crash and a robot pause every 15 s, and a region-manager crash every 45 s.`,
      ),
    );
    grid.appendChild(this.recoveryCard());

    // ── D ──
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
    const on = { label: 'Congestion control on', color: MODE_SERIES.detect.hex };
    const off = { label: 'Congestion control off', color: muted };
    grid.appendChild(
      section(
        'Congestion control over the long run',
        `Leases + detection, ${(CONG_TICKS * TICK_S) / 60} minutes per run. Managers gossip their region's load; robots route around crowded regions and don't take jobs in full ones. <span class="sec-key"><i style="background:${on.color}"></i>on <i style="background:${off.color}"></i>off</span>`,
      ),
    );
    const d = (k, n, key) => this.results.get(`D:${k}:${n}`)?.[key] ?? null;
    const perMin = (k, n) => (d(k, n, 'tasks') == null ? null : d(k, n, 'tasks') / ((CONG_TICKS * TICK_S) / 60));
    grid.appendChild(lineChart({ title: 'Average throughput, whole run', note: 'Tasks completed per minute over all 10 minutes', xs: CONG_DENSITIES, xFmt: (n) => `${n}`, xName: 'robots', fmt: (v) => v.toFixed(0), series: [{ ...on, values: CONG_DENSITIES.map((n) => perMin('on', n)) }, { ...off, values: CONG_DENSITIES.map((n) => perMin('off', n)) }] }));
    grid.appendChild(lineChart({ title: 'Throughput in the final minute', note: 'Without control, queues build up and throughput sags late in the run', xs: CONG_DENSITIES, xFmt: (n) => `${n}`, xName: 'robots', fmt: (v) => v.toFixed(0), series: [{ ...on, values: CONG_DENSITIES.map((n) => d('on', n, 'throughput')) }, { ...off, values: CONG_DENSITIES.map((n) => d('off', n, 'throughput')) }] }));
    this.table();
  }

  recoveryCard() {
    const card = document.createElement('div');
    card.className = 'chart recovery';
    const rows = RECOVERY_ROWS.map((row) => ({
      ...row,
      vals: PROTOCOLS.map((m) => {
        const r = this.results.get(`C:${m}`);
        return { m, v: r ? r.recovery[row.key] : null, n: r ? r.recoveryCounts[row.key] : 0 };
      }),
    }));
    const max = Math.max(1, ...rows.flatMap((r) => r.vals.map((v) => v.v || 0)));
    const bar = ({ m, v, n }) =>
      `<div class="rec-bar" title="${MODE_SERIES[m].label}: ${v == null ? 'no data' : `${v.toFixed(2)} s, averaged over ${n} events`}"><i style="width:${v == null ? 0 : Math.max(1.5, (v / max) * 100)}%;background:${MODE_SERIES[m].hex}"></i><span>${v == null ? '—' : `${v.toFixed(1)} s`}<small>${n ? ` · ${n}×` : ''}</small></span></div>`;
    const foot = PROTOCOLS.map((m) => {
      const r = this.results.get(`C:${m}`);
      return r ? `${MODE_SERIES[m].label}: <b>${r.collisions}</b> collisions, ${r.throughput.toFixed(0)} tasks/min while failing` : '';
    })
      .filter(Boolean)
      .join(' · ');
    card.innerHTML = `<h3>Mean recovery time</h3><p>Seconds per failure type (bar colour = strategy)</p>
      <div class="rec-rows">${rows.map((row) => `<div class="rec-row"><div class="rec-label"><b>${row.label}</b><small>${row.note}</small></div><div class="rec-bars">${row.vals.map(bar).join('')}</div></div>`).join('')}</div>
      <p class="rec-foot">${foot}</p>`;
    return card;
  }

  table() {
    const fmt = (v, f) => (v == null ? '—' : f(v));
    let html = `<h4>Strategies vs density</h4><table><tr><th>Mode</th><th>Robots</th>${DENSITY_METRICS.map((m) => `<th>${m.title}</th>`).join('')}</tr>`;
    for (const n of DENSITIES)
      for (const m of MODES) {
        if (!this.results.has(`A:${m}:${n}`)) continue;
        html += `<tr><td>${MODE_SERIES[m].label}</td><td>${n}</td>${DENSITY_METRICS.map((k) => `<td>${(k.skip || []).includes(m) ? '—' : fmt(this.a(m, n, k.key), k.fmt)}</td>`).join('')}</tr>`;
      }
    html += `</table><h4>Safety margin (hostile network)</h4><table><tr><th>Margin</th><th>Leases lost / 1k moves</th><th>Risky moves / 1k</th><th>Throughput</th><th>Collisions</th></tr>`;
    for (const m of MARGINS) {
      if (this.b(m, 'throughput') == null) continue;
      html += `<tr><td>${(m * TICK_S).toFixed(1)} s</td><td>${this.b(m, 'liveExpiriesPer1k').toFixed(1)}</td><td>${this.b(m, 'riskyPer1k').toFixed(2)}</td><td>${this.b(m, 'throughput').toFixed(0)}</td><td>${this.b(m, 'collisions').toFixed(0)}</td></tr>`;
    }
    html += `</table><h4>Recovery after failures</h4><table><tr><th>Failure</th>${PROTOCOLS.map((m) => `<th>${MODE_SERIES[m].label}</th>`).join('')}</tr>`;
    for (const row of RECOVERY_ROWS) {
      html += `<tr><td>${row.label}</td>${PROTOCOLS.map((m) => {
        const r = this.results.get(`C:${m}`);
        return `<td>${r ? fmt(r.recovery[row.key], (v) => `${v.toFixed(2)} s (${r.recoveryCounts[row.key]}×)`) : '—'}</td>`;
      }).join('')}</tr>`;
    }
    html += `</table><h4>Congestion control (${(CONG_TICKS * TICK_S) / 60} minutes)</h4><table><tr><th>Robots</th><th>Control</th><th>Tasks</th><th>Tasks / min, whole run</th><th>Tasks / min, final minute</th><th>Collisions</th></tr>`;
    for (const n of CONG_DENSITIES)
      for (const k of ['on', 'off']) {
        const r = this.results.get(`D:${k}:${n}`);
        if (r) html += `<tr><td>${n}</td><td>${k}</td><td>${r.tasks}</td><td>${(r.tasks / ((CONG_TICKS * TICK_S) / 60)).toFixed(0)}</td><td>${r.throughput.toFixed(0)}</td><td>${r.collisions}</td></tr>`;
      }
    $('bench-table').innerHTML = html + '</table>';
  }
}

function section(title, note) {
  const el = document.createElement('div');
  el.className = 'bench-section';
  el.innerHTML = `<h3>${title}</h3><p>${note}</p>`;
  return el;
}

// Small-multiple line chart with direct end labels and a hover tooltip.
function lineChart({ title, note, xs, xFmt, tipX, xName, fmt, series }) {
  const W = 320, H = 176, ml = 40, mr = 64, mt = 10, mb = 34;
  const iw = W - ml - mr, ih = H - mt - mb;
  let max = 0;
  for (const s of series) for (const v of s.values) if (v != null) max = Math.max(max, v);
  const step = niceStep(max || 1);
  const top = Math.max(step, Math.ceil((max * 1.05) / step) * step);
  const x0 = xs[0], x1 = xs[xs.length - 1];
  const x = (v) => ml + ((v - x0) / (x1 - x0 || 1)) * iw;
  const y = (v) => mt + ih - (v / top) * ih;
  const dense = xs.length > 8;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">`;
  svg += '<g class="grid">';
  for (let v = 0; v <= top + 1e-9; v += step) svg += `<line x1="${ml}" x2="${ml + iw}" y1="${y(v)}" y2="${y(v)}"/>`;
  svg += '</g><g class="axis">';
  for (let v = 0; v <= top + 1e-9; v += step) svg += `<text x="${ml - 6}" y="${y(v) + 3.5}" text-anchor="end">${fmtAxis(v)}</text>`;
  for (const xv of xs) {
    const lbl = xFmt(xv);
    if (lbl !== '') svg += `<text x="${x(xv)}" y="${mt + ih + 13}" text-anchor="middle">${lbl}</text>`;
  }
  svg += `<text class="xname" x="${ml + iw / 2}" y="${H - 3}" text-anchor="middle">${xName}</text>`;
  svg += '</g>';
  svg += `<line class="xhair" x1="0" x2="0" y1="${mt}" y2="${mt + ih}" visibility="hidden"/>`;

  const ends = [];
  for (const s of series) {
    let d = '';
    let pen = false;
    xs.forEach((xv, i) => {
      const v = s.values[i];
      if (v == null) return void (pen = false);
      d += `${pen ? 'L' : 'M'}${x(xv)},${y(v)}`;
      pen = true;
    });
    if (!d) continue;
    svg += `<g class="series"><path stroke="${s.color}" d="${d}"/>`;
    if (!dense) xs.forEach((xv, i) => s.values[i] != null && (svg += `<circle cx="${x(xv)}" cy="${y(s.values[i])}" r="4" fill="${s.color}"/>`));
    svg += '</g>';
    const li = s.values.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop();
    if (li !== undefined && !dense) ends.push({ x: x(xs[li]) + 8, y: y(s.values[li]), text: fmt(s.values[li]) });
  }
  // Identical end values share one label; the rest are nudged apart and kept
  // inside the plot area.
  const merged = [];
  for (const e of ends.sort((a, b) => a.y - b.y)) if (!merged.find((o) => o.text === e.text && Math.abs(o.y - e.y) < 1)) merged.push(e);
  for (let i = 1; i < merged.length; i++) if (merged[i].y - merged[i - 1].y < 12) merged[i].y = merged[i - 1].y + 12;
  const over = merged.length ? merged[merged.length - 1].y - (mt + ih - 4) : 0;
  if (over > 0) for (const e of merged) e.y -= over;
  for (const e of merged) svg += `<text class="dlabel" x="${e.x}" y="${e.y + 3.5}">${e.text}</text>`;
  const band = iw / Math.max(1, xs.length - 1);
  xs.forEach((xv, i) => (svg += `<rect class="hit" data-i="${i}" x="${x(xv) - band / 2}" y="${mt}" width="${band}" height="${ih}"/>`));
  svg += '</svg>';

  const card = document.createElement('div');
  card.className = 'chart';
  card.innerHTML = `<h3>${title}</h3><p>${note}</p>${svg}<div class="tip" hidden></div>`;
  const tip = card.querySelector('.tip');
  const xh = card.querySelector('.xhair');
  const svgEl = card.querySelector('svg');
  card.querySelectorAll('.hit').forEach((r) => {
    r.addEventListener('mouseenter', () => {
      const i = +r.dataset.i;
      xh.setAttribute('x1', x(xs[i]));
      xh.setAttribute('x2', x(xs[i]));
      xh.setAttribute('visibility', 'visible');
      const rows = series
        .map((s) => ({ s, v: s.values[i] }))
        .filter((o) => o.v != null)
        .sort((a, b) => b.v - a.v)
        .map((o) => `<div><span><i style="background:${o.s.color}"></i>${o.s.label}</span>${fmt(o.v)}</div>`)
        .join('');
      tip.innerHTML = `<b>${tipX ? tipX(xs[i]) : `${xFmt(xs[i])} ${xName}`}</b>${rows || '<div>no data</div>'}`;
      tip.hidden = false;
      const bb = svgEl.getBoundingClientRect();
      const cb = card.getBoundingClientRect();
      const px = (x(xs[i]) / W) * bb.width + bb.left - cb.left;
      tip.style.left = `${Math.max(4, Math.min(px + 12, cb.width - 230))}px`;
      tip.style.top = `${bb.top - cb.top + 8}px`;
    });
    r.addEventListener('mouseleave', () => {
      tip.hidden = true;
      xh.setAttribute('visibility', 'hidden');
    });
  });
  return card;
}

function niceStep(max) {
  const raw = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function fmtAxis(v) {
  if (v >= 1000) return `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(v < 1 ? 2 : 1);
}
