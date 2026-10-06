// Replay scrubber: drag back to any earlier moment of the run. Marks on the
// track show notable events; clicking one jumps to just before it.
import { EVENT_COLORS } from '../render/palette.js';

const $ = (id) => document.getElementById(id);
const MARK_LABEL = {
  deadlock: 'Deadlock', crash: 'Robot crash', pause: 'Robot froze', fenced: 'Fenced move', collision: 'Collision',
  mgrdown: 'Manager crash', reconciled: 'Manager reconciled', partition: 'Network cut', healed: 'Network healed',
};
const LEAD = 20; // ticks: a mark jumps to 1 s before the event
// The track spans a fixed length that only grows in steps, so it doesn't
// rescale (and every mark slide) on each tick.
const SPANS_S = [30, 60, 120, 300, 600, 1200, 1800, 3600, 7200];

export class Scrubber {
  constructor(app) {
    this.app = app;
    this.canvas = $('scrub-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.dragging = false;
    this.pending = null;
    this.hoverMark = null;
    this.dragTick = null;
    this.span = 1;
    this.refresh();

    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.hoverMark) {
        app.seek(Math.max(0, this.hoverMark.tick - LEAD));
        return;
      }
      this.dragging = true;
      app.scrubbing = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.drag(e.clientX);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) return this.drag(e.clientX);
      this.hoverAt(e.clientX);
    });
    const end = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      app.scrubbing = false;
      this.pending = null;
      this.dragTick = null;
      app.seek(this.tickAt(e.clientX));
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverMark = null;
      $('scrub-tip').hidden = true;
      this.canvas.style.cursor = '';
    });
    $('scrub-back').addEventListener('click', () => app.seek(app.sim.tick - 100));
    $('scrub-fwd').addEventListener('click', () => app.seek(app.sim.tick + 100));
    $('scrub-live').addEventListener('click', () => app.seek(app.history.head));
    window.addEventListener('resize', () => this.draw());
  }

  // The playhead follows the pointer at once; the (slower) seek catches up.
  drag(clientX) {
    this.dragTick = this.tickAt(clientX);
    this.draw();
    this.queue(this.dragTick);
  }

  // While dragging, seek at most once per frame, without the timeline warm-up.
  queue(tick) {
    const first = this.pending === null;
    this.pending = tick;
    if (!first) return;
    requestAnimationFrame(() => {
      if (this.pending === null) return;
      const t = this.pending;
      this.pending = null;
      this.app.seek(t, true);
    });
  }

  tickAt(clientX) {
    const r = this.canvas.getBoundingClientRect();
    const k = Math.max(0, Math.min(1, (clientX - r.left - PAD) / (r.width - 2 * PAD)));
    return Math.min(this.app.history.head, Math.round(k * this.span));
  }

  hoverAt(clientX) {
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const w = r.width - 2 * PAD;
    let best = null, bd = 6;
    for (const m of this.app.history.marks) {
      const d = Math.abs(PAD + (m.tick / this.span) * w - x);
      if (d < bd) (bd = d), (best = m);
    }
    this.hoverMark = best;
    this.canvas.style.cursor = best ? 'pointer' : '';
    const tip = $('scrub-tip');
    if (!best) {
      tip.hidden = true;
      return;
    }
    const s = (best.tick * this.app.sim.cfg.tickMs) / 1000;
    tip.innerHTML = `<b>${MARK_LABEL[best.kind] || best.kind} · ${fmt(s)}</b><p>${best.text}</p><small>Click to jump to 1 s before</small>`;
    tip.hidden = false;
    const px = PAD + (best.tick / this.span) * w;
    tip.style.left = `${Math.max(0, Math.min(r.width - tip.offsetWidth, px - tip.offsetWidth / 2))}px`;
  }

  onSim() {
    this.draw(true);
  }

  onHistory() {
    this.draw(true);
  }

  // Theme colours, read once per theme change rather than every frame.
  refresh() {
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    this.col = { ink: v('--ink'), cyan: v('--cyan'), panel: v('--panel-solid') };
    this.draw();
  }

  update() {
    this.draw();
  }

  draw() {
    const app = this.app;
    const sim = app.sim;
    const h = app.history;
    if (!sim || !h) return;
    const perS = 1000 / sim.cfg.tickMs;
    const spanS = SPANS_S.find((x) => x * perS >= h.head * 1.02) ?? Math.ceil(h.head / perS / 3600) * 3600;
    this.span = spanS * perS;
    const shown = this.dragTick ?? sim.tick;
    const atHead = shown >= h.head;
    const sec = (t) => (t * sim.cfg.tickMs) / 1000;
    // Fixed-width text: the track never changes size as the numbers change.
    const time = `${fmt(sec(shown))} / ${fmt(sec(h.head))}`;
    if (this.timeText !== time) $('scrub-time').innerHTML = `<b>${fmt(sec(shown))}</b><span> / ${fmt(sec(h.head))}</span>`;
    this.timeText = time;
    if (this.atHead !== atHead) {
      this.atHead = atHead;
      $('scrub-live').classList.toggle('on', atHead);
      $('scrub').classList.toggle('behind', !atHead);
    }

    const cv = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const { ink, cyan, panel } = this.col;
    const w = W - 2 * PAD;
    const y = H / 2;
    const X = (t) => PAD + (t / this.span) * w;
    // track; the recorded part (up to the furthest point) is darker
    g.fillStyle = `rgba(${ink},0.07)`;
    roundRect(g, PAD, y - 2, w, 4, 2);
    g.fill();
    g.fillStyle = `rgba(${ink},0.16)`;
    roundRect(g, PAD, y - 2, Math.max(0, X(h.head) - PAD), 4, 2);
    g.fill();
    // played part
    g.fillStyle = cyan;
    roundRect(g, PAD, y - 2, Math.max(0, X(shown) - PAD), 4, 2);
    g.fill();
    // event marks
    for (const m of h.marks) {
      const x = X(m.tick);
      g.fillStyle = EVENT_COLORS[m.kind] || `rgba(${ink},0.5)`;
      const big = m === this.hoverMark;
      g.fillRect(Math.round(x) - (big ? 1.5 : 1), y - (big ? 9 : 7), big ? 3 : 2, big ? 18 : 14);
    }
    // playhead
    const hx = X(shown);
    g.fillStyle = panel;
    g.strokeStyle = cyan;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(hx, y, 6, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
}

const PAD = 8;

function fmt(s) {
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}
