// Message timeline: a space-time diagram for one robot. One horizontal lane
// per process it talks to (itself, the region managers, the world, other
// robots), time running left to right, one arrow per message. Above the
// robot's lane, the leases it believes it holds; the lane itself is coloured
// by what the robot is doing.
import { theme } from '../render/theme.js';
import { STATUS, EVENT_COLORS } from '../render/palette.js';
import { fmtCell } from '../sim/layout.js';
import { fmtEpoch } from '../sim/manager.js';

const $ = (id) => document.getElementById(id);
const WINDOWS = [4, 8, 16]; // seconds shown
const GROUPS = [
  { key: 'acquire', label: 'Request', types: ['REQ', 'QUEUED', 'DENIED', 'CANCEL'] },
  { key: 'grant', label: 'Grant', types: ['GRANT', 'BLOCKED'] },
  { key: 'release', label: 'Release', types: ['RELEASE'] },
  { key: 'renew', label: 'Renew', types: ['RENEW', 'RENEWED'] },
  { key: 'probe', label: 'Probe', types: ['PROBE', 'ABORT'] },
  { key: 'recovery', label: 'Recovery', types: ['REJOIN', 'CLEARED', 'RECONCILE', 'REPORT'] },
];
const GROUP_OF = Object.fromEntries(GROUPS.flatMap((g) => g.types.map((t) => [t, g.key])));
const MARK_LABEL = {
  fenced: 'FENCED', crash: 'CRASH', pause: 'FROZE', deadlock: 'DEADLOCK', blocked: 'BLOCKED', regrant: 'RE-GRANT',
  cleared: 'CLEARED', collision: 'COLLISION', respawn: 'BACK', partition: 'NET CUT', healed: 'HEALED',
};
const STATUS_LABEL = { moving: 'moving', wait: 'waiting for a lease', work: 'picking / dropping', paused: 'frozen', crashed: 'crashed', rejoin: 'resyncing', offline: 'cut off from the network', idle: 'idle', removed: 'removed' };

const GUTTER = 64; // lane labels
const PAD_R = 14;
const BAR_H = 13;
const LANE_GAP = 34;

export class Timeline {
  constructor(app) {
    this.app = app;
    this.open = false;
    this.robot = -1;
    this.win = 8;
    this.hidden = new Set();
    this.hits = [];
    this.hover = null;
    this.mouse = null;
    this.lastDraw = 0;
    this.canvas = $('tl-canvas');
    this.ctx = this.canvas.getContext('2d');
    $('tl-close').addEventListener('click', () => this.close());
    $('tl-windows').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-win]');
      if (!b) return;
      this.win = +b.dataset.win;
      this.syncHeader();
      this.draw(true);
    });
    $('tl-groups').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-group]');
      if (!b) return;
      const k = b.dataset.group;
      this.hidden.has(k) ? this.hidden.delete(k) : this.hidden.add(k);
      this.syncHeader();
      this.draw(true);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.draw(true);
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.mouse = null;
      this.hover = null;
      $('tl-tip').hidden = true;
      this.draw(true);
    });
    window.addEventListener('resize', () => this.open && this.draw(true));
    this.refresh();
  }

  toggle(force) {
    const want = force ?? !this.open;
    if (want) this.show();
    else this.close();
  }

  show() {
    this.open = true;
    $('timeline').hidden = false;
    document.body.classList.add('has-timeline');
    const live = this.app.live;
    if (live.selected >= 0) this.robot = live.selected;
    else if (this.robot < 0 && live.focusRobots.size) this.robot = [...live.focusRobots][0];
    this.draw(true);
  }

  close() {
    this.open = false;
    $('timeline').hidden = true;
    $('tl-tip').hidden = true;
    document.body.classList.remove('has-timeline');
  }

  // Colours come from the theme and the CSS tokens.
  refresh() {
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    this.col = {
      text: v('--text'), text2: v('--text-2'), muted: v('--muted'), line: v('--line-2'), grid: v('--line'),
      surface: `rgb(${v('--surface')})`,
    };
    const M = theme.msg;
    const extra = { PROBE: theme.probe.tail[0], ABORT: theme.probe.tail[0], RECONCILE: theme.mgrState.reconciling, REPORT: theme.mgrState.reconciling };
    this.msgColor = (type) => M[type] || extra[type] || M.REQ;
    this.lostColor = M.lost;
    this.statusColor = {
      moving: STATUS.moving.hex, wait: STATUS.wait.hex, work: STATUS.work.hex, paused: STATUS.paused.hex,
      crashed: STATUS.crashed.hex, rejoin: STATUS.yield.hex, offline: theme.mgrState.down,
    };
    this.leaseColor = STATUS.moving.hex;
    this.syncHeader();
    if (this.open) this.draw(true);
  }

  syncHeader() {
    $('tl-windows').innerHTML = WINDOWS.map((w) => `<button data-win="${w}" class="${w === this.win ? 'on' : ''}">${w}s</button>`).join('');
    $('tl-groups').innerHTML = GROUPS.map(
      (g) => `<button data-group="${g.key}" class="${this.hidden.has(g.key) ? 'off' : ''}" title="Show or hide ${g.label.toLowerCase()} messages"><i style="background:${this.msgColor(g.types[0])}"></i>${g.label}</button>`,
    ).join('');
  }

  update(t) {
    if (!this.open) return;
    const live = this.app.live;
    if (live.selected >= 0 && live.selected !== this.robot) this.robot = live.selected;
    this.t = t;
    const now = performance.now();
    if (now - this.lastDraw < 33) return; // ~30 fps is plenty
    this.draw();
  }

  draw(force = false) {
    if (!this.open) return;
    this.lastDraw = performance.now();
    const sim = this.app.sim;
    const trace = sim.trace;
    const cv = this.canvas;
    const g = this.ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth;
    const id = this.robot;
    $('tl-robot').textContent = id >= 0 ? `R${id}` : '—';

    if (id < 0 || !trace || !sim.robots[id]) {
      this.size(W, 120, dpr);
      g.fillStyle = this.col.muted;
      g.font = '13px Inter, sans-serif';
      g.textAlign = 'center';
      g.fillText('Click a robot to see the messages it sends and receives.', W / 2, 64);
      return;
    }

    const now = this.t ?? sim.tick;
    const span = (this.win * 1000) / sim.cfg.tickMs;
    const t0 = now - span;
    const plotW = W - GUTTER - PAD_R;
    const X = (t) => GUTTER + ((t - t0) / span) * plotW;
    const me = 'r' + id;

    // Messages in view, and which lanes they need.
    const msgs = (trace.msgs.get(id) || []).filter((e) => e.t1 >= t0 && e.t0 <= now && !this.hidden.has(GROUP_OF[e.msg.type]));
    const laneOf = (addr) => (addr === me ? me : addr[0] === 'r' ? 'peers' : addr);
    const others = new Set();
    for (const e of msgs) {
      others.add(laneOf(e.msg.from));
      others.add(laneOf(e.msg.to));
    }
    others.delete(me);
    const mgrs = [...others].filter((k) => k[0] === 'm').sort((a, b) => +a.slice(1) - +b.slice(1));
    const lanes = [me, ...mgrs, ...(others.has('w') ? ['w'] : []), ...(others.has('peers') ? ['peers'] : [])];

    // Lease bars, packed into rows above the robot's lane.
    const leases = (trace.leases.get(id) || []).filter((l) => (l.t1 ?? now) >= t0);
    const rows = [];
    for (const l of leases) {
      let r = rows.findIndex((end) => end < l.t0);
      if (r < 0) r = rows.push(0) - 1;
      rows[r] = l.t1 ?? Infinity;
      l.row = r;
    }
    const nRows = Math.max(1, Math.min(rows.length, 4));
    const top = 10;
    const robotY = top + nRows * (BAR_H + 3) + 12;
    const laneY = new Map([[me, robotY]]);
    lanes.slice(1).forEach((k, i) => laneY.set(k, robotY + 30 + i * LANE_GAP));
    const axisY = robotY + 30 + Math.max(0, lanes.length - 1) * LANE_GAP;
    const H = axisY + 22;
    this.size(W, H, dpr);
    const hits = [];

    // Grid + time axis.
    const step = this.win <= 4 ? 1 : this.win <= 8 ? 1 : 2;
    const stepT = (step * 1000) / sim.cfg.tickMs;
    g.font = '10.5px "JetBrains Mono", monospace';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    for (let t = Math.max(0, Math.ceil(t0 / stepT) * stepT); t <= now; t += stepT) {
      const x = X(t);
      g.strokeStyle = this.col.grid;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x + 0.5, top - 4);
      g.lineTo(x + 0.5, axisY - 6);
      g.stroke();
      g.fillStyle = this.col.muted;
      g.fillText(fmtT((t * sim.cfg.tickMs) / 1000), x, axisY + 10);
    }

    // Lanes: labels and base lines.
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const k of lanes) {
      const y = laneY.get(k);
      g.strokeStyle = this.col.line;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(GUTTER, y + 0.5);
      g.lineTo(W - PAD_R, y + 0.5);
      g.stroke();
      g.fillStyle = k === me ? this.col.text : this.col.text2;
      g.font = `${k === me ? 600 : 500} 12px Inter, sans-serif`;
      g.fillText(k === me ? `R${id}` : k === 'w' ? 'World' : k === 'peers' ? 'Robots' : `M${k.slice(1)}`, GUTTER - 12, y);
    }

    // Manager lanes: shade while the manager is down or reconciling.
    for (const k of mgrs) {
      const y = laneY.get(k);
      for (const s of trace.mgr.get(+k.slice(1)) || []) {
        const a = Math.max(t0, s.t0), b = Math.min(now, s.t1 ?? now);
        if (b <= a) continue;
        g.fillStyle = s.state === 'DOWN' ? theme.mgrState.down : theme.mgrState.reconciling;
        g.fillRect(X(a), y - 2, X(b) - X(a), 4);
        hits.push({ kind: 'box', x: X(a), y: y - 7, w: X(b) - X(a), h: 14, tip: `<b>M${k.slice(1)} · ${s.state === 'DOWN' ? 'down' : 'reconciling'}</b><div><span>From</span>${fmtT(sec(sim, s.t0))}</div><div><span>Until</span>${s.t1 === null ? 'now' : fmtT(sec(sim, s.t1))}</div>` });
      }
    }

    // Robot lane: coloured by status.
    for (const s of trace.status.get(id) || []) {
      const a = Math.max(t0, s.t0), b = Math.min(now, s.t1 ?? now);
      if (b <= a) continue;
      const c = this.statusColor[s.kind];
      if (!c) continue;
      g.fillStyle = c;
      g.fillRect(X(a), robotY - 2.5, X(b) - X(a), 5);
      hits.push({ kind: 'box', x: X(a), y: robotY - 7, w: X(b) - X(a), h: 14, tip: `<b>R${id} · ${STATUS_LABEL[s.kind]}</b><div><span>From</span>${fmtT(sec(sim, s.t0))}</div><div><span>Until</span>${s.t1 === null ? 'now' : fmtT(sec(sim, s.t1))}</div>` });
    }

    // Lease bars. The part after the robot's own-clock expiry is hatched:
    // the robot still lists the lease but no longer trusts it.
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.font = '600 10.5px "JetBrains Mono", monospace';
    for (const l of leases) {
      if (l.row >= nRows) continue;
      const y = top + (nRows - 1 - l.row) * (BAR_H + 3);
      const end = l.t1 ?? now;
      const a = Math.max(t0, l.t0), b = Math.min(now, end);
      if (b <= a) continue;
      const xa = X(a), xb = X(b);
      const xe = Math.max(xa, Math.min(xb, X(l.exp)));
      g.fillStyle = withAlpha(this.leaseColor, 0.22);
      g.fillRect(xa, y, xe - xa, BAR_H);
      if (xb > xe) {
        g.save();
        g.beginPath();
        g.rect(xe, y, xb - xe, BAR_H);
        g.clip();
        g.strokeStyle = withAlpha(theme.mgrState.down, 0.6);
        g.lineWidth = 1.5;
        for (let x = xe - BAR_H; x < xb; x += 5) {
          g.beginPath();
          g.moveTo(x, y + BAR_H);
          g.lineTo(x + BAR_H, y);
          g.stroke();
        }
        g.restore();
      }
      g.strokeStyle = this.leaseColor;
      g.lineWidth = 1;
      g.strokeRect(xa + 0.5, y + 0.5, xb - xa - 1, BAR_H - 1);
      const label = `${fmtCell(l.cell)} e${fmtEpoch(l.epoch)}`;
      if (xb - xa > g.measureText(label).width + 8) {
        g.fillStyle = this.col.text;
        g.fillText(label, xa + 4, y + BAR_H / 2 + 0.5);
      }
      const expTxt = l.exp <= end ? `${fmtT(sec(sim, l.exp))} (passed)` : fmtT(sec(sim, l.exp));
      hits.push({ kind: 'box', x: xa, y, w: xb - xa, h: BAR_H, tip: `<b>Lease ${fmtCell(l.cell)} · epoch ${fmtEpoch(l.epoch)}</b><div><span>Held from</span>${fmtT(sec(sim, l.t0))}</div><div><span>Until</span>${l.t1 === null ? 'now' : fmtT(sec(sim, l.t1))}</div><div><span>Expires (own clock)</span>${expTxt}</div>` });
    }

    // Messages.
    const hov = this.pickHover(hits, msgs, X, laneY, laneOf, now);
    for (const e of msgs) {
      const isHov = hov && hov.e === e;
      this.drawMsg(g, e, X, laneY, laneOf, now, isHov, hov && !isHov);
    }

    // Event marks on the robot's lane.
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.font = '700 10px "JetBrains Mono", monospace';
    let lastX = -1e9;
    for (const m of trace.marks.get(id) || []) {
      if (m.tick < t0 || m.tick > now) continue;
      const x = X(m.tick);
      const c = EVENT_COLORS[m.kind] || this.col.text2;
      g.fillStyle = c;
      g.beginPath();
      g.moveTo(x, robotY - 6);
      g.lineTo(x + 5, robotY);
      g.lineTo(x, robotY + 6);
      g.lineTo(x - 5, robotY);
      g.closePath();
      g.fill();
      g.strokeStyle = this.col.surface;
      g.lineWidth = 1.5;
      g.stroke();
      if (x - lastX > 64) {
        const label = MARK_LABEL[m.kind] || m.kind;
        const tw = g.measureText(label).width;
        g.textAlign = x + 7 + tw > W - PAD_R ? 'right' : 'left';
        g.fillText(label, g.textAlign === 'right' ? x - 7 : x + 7, robotY + 6);
        g.textAlign = 'left';
        lastX = x;
      }
      hits.push({ kind: 'mark', x: x - 7, y: robotY - 8, w: 14, h: 16, tip: `<b>${MARK_LABEL[m.kind] || m.kind} · ${fmtT(sec(sim, m.tick))}</b><p>${m.text}</p>` });
    }

    // "now" edge.
    g.strokeStyle = this.col.muted;
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(X(now) + 0.5, top - 4);
    g.lineTo(X(now) + 0.5, axisY - 6);
    g.stroke();
    g.setLineDash([]);

    this.hits = hits;
    this.showTip(hov, sim);
  }

  drawMsg(g, e, X, laneY, laneOf, now, hovered, dimmed) {
    const ya = laneY.get(laneOf(e.msg.from));
    const yb = laneY.get(laneOf(e.msg.to));
    if (ya === undefined || yb === undefined) return;
    const xa = X(e.t0), xb = X(e.t1);
    let k = 1;
    if (e.lost) k = 0.55;
    if (e.t1 > now) k = Math.min(k, (now - e.t0) / Math.max(1e-6, e.t1 - e.t0));
    const xe = xa + (xb - xa) * k, ye = ya + (yb - ya) * k;
    const color = e.lost ? this.lostColor : this.msgColor(e.msg.type);
    const faint = e.msg.type === 'RENEW' || e.msg.type === 'RENEWED';
    g.globalAlpha = dimmed ? 0.18 : faint && !hovered ? 0.5 : 1;
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = hovered ? 2.5 : 1.5;
    if (e.lost) g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(xa, ya);
    g.lineTo(xe, ye);
    g.stroke();
    g.setLineDash([]);
    if (e.lost) {
      const s = 4;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(xe - s, ye - s);
      g.lineTo(xe + s, ye + s);
      g.moveTo(xe + s, ye - s);
      g.lineTo(xe - s, ye + s);
      g.stroke();
    } else if (k >= 1) {
      const ang = Math.atan2(yb - ya, xb - xa);
      const s = hovered ? 8 : 6;
      g.beginPath();
      g.moveTo(xb, yb);
      g.lineTo(xb - s * Math.cos(ang - 0.4), yb - s * Math.sin(ang - 0.4));
      g.lineTo(xb - s * Math.cos(ang + 0.4), yb - s * Math.sin(ang + 0.4));
      g.closePath();
      g.fill();
    } else {
      g.beginPath();
      g.arc(xe, ye, 2.5, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // Nearest message to the pointer (within 7 px), else a box under it.
  pickHover(boxes, msgs, X, laneY, laneOf, now) {
    const m = this.mouse;
    if (!m) return null;
    let best = null, bd = 7;
    for (const e of msgs) {
      const ya = laneY.get(laneOf(e.msg.from)), yb = laneY.get(laneOf(e.msg.to));
      if (ya === undefined || yb === undefined) continue;
      let k = e.lost ? 0.55 : 1;
      if (e.t1 > now) k = Math.min(k, (now - e.t0) / Math.max(1e-6, e.t1 - e.t0));
      const xa = X(e.t0), xb = X(e.t1);
      const d = segDist(m.x, m.y, xa, ya, xa + (xb - xa) * k, ya + (yb - ya) * k);
      if (d < bd) (bd = d), (best = { e });
    }
    if (best) return best;
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      if (m.x >= b.x && m.x <= b.x + b.w && m.y >= b.y && m.y <= b.y + b.h) return { box: b };
    }
    return null;
  }

  showTip(hov, sim) {
    const tip = $('tl-tip');
    if (!hov || !this.mouse) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = hov.e ? msgTip(hov.e, sim) : hov.box.tip;
    tip.hidden = false;
    const cw = this.canvas.clientWidth;
    const tw = tip.offsetWidth;
    const x = this.mouse.x + 14 + tw > cw ? this.mouse.x - tw - 14 : this.mouse.x + 14;
    tip.style.left = `${x}px`;
    tip.style.top = `${this.canvas.offsetTop + Math.max(0, this.mouse.y - 10)}px`;
  }

  size(w, h, dpr) {
    const cv = this.canvas;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.height = `${h}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
  }
}

function msgTip(e, sim) {
  const m = e.msg;
  const name = (a) => (a[0] === 'r' ? `R${a.slice(1)}` : a[0] === 'm' ? `M${a.slice(1)}` : 'World');
  const rows = [];
  if (m.cell !== undefined) rows.push(['Cell', fmtCell(m.cell)]);
  if (m.epoch !== undefined) rows.push(['Epoch', fmtEpoch(m.epoch)]);
  if (m.holder !== undefined && m.holder >= 0) rows.push(['Held by', `R${m.holder}`]);
  if (m.prio !== undefined) rows.push(['Priority', m.prio]);
  if (m.tryOnly) rows.push(['Mode', 'try-lock, never queue']);
  if (m.type === 'RENEW') rows.push(['Leases', m.cells.map((c) => fmtCell(c.cell)).join(' ')]);
  if (m.type === 'RENEWED') rows.push(['Renewed / lost', `${m.ok.length / 2} / ${m.lost.length / 2}`]);
  if (m.type === 'PROBE') rows.push(['Path', m.path.map((i) => 'R' + i).join(' → ')]);
  if (m.type === 'REPORT') rows.push(['Leases reported', m.cells.length / 2]);
  if (m.type === 'RECONCILE') rows.push(['Incarnation', m.gen]);
  if (m.type === 'CLEARED') rows.push(['Assign to', m.assignTo >= 0 ? `R${m.assignTo}` : 'nobody (Free)']);
  const ms = (e.t1 - e.t0) * sim.cfg.tickMs;
  rows.push(['Sent', fmtT(sec(sim, e.t0))]);
  rows.push([e.lost ? 'Lost' : 'Arrived', e.lost ? (sim.deadZones.length || m.from[0] === 'r' ? 'never arrived' : 'dropped') : `${fmtT(sec(sim, e.t1))} (${ms} ms)`]);
  return `<b>${m.type} · ${name(m.from)} → ${name(m.to)}</b>${rows.map(([k, v]) => `<div><span>${k}</span>${v}</div>`).join('')}`;
}

const sec = (sim, t) => (t * sim.cfg.tickMs) / 1000;

function fmtT(s) {
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const k = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * k, py - ay - dy * k);
}

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
