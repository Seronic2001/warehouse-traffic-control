// DOM side of the demo: KPI tiles, controls, event feed, inspector and the
// scenario narration card.
import { STATUS, EVENT_COLORS } from '../render/palette.js';
import { theme } from '../render/theme.js';
import { robotStatusKey } from '../render/live.js';
import { xOf, yOf, regionOf, fmtCell, cellOf } from '../sim/layout.js';
import { fmtEpoch } from '../sim/manager.js';

const $ = (id) => document.getElementById(id);
const FEED_KINDS = new Set(['deadlock', 'fenced', 'blocked', 'regrant', 'cleared', 'crash', 'pause', 'collision', 'respawn', 'mgrdown', 'mgrrestart', 'reconciled', 'partition', 'healed']);

export class Hud {
  constructor(app) {
    this.app = app;
    this.lastUpdate = 0;
    this.spark = [];
    this.lastSparkTick = 0;
    this.feedSeq = 0;
    this.prevCollisions = 0;

    this.buildLegend();
    this.bindTopbar();
    this.bindControls();
    this.bindDock();
    this.bindInspector();
    setTimeout(() => $('hint').classList.add('gone'), 9000);
  }

  // ───────────────────────────── wiring ─────────────────────────────

  buildLegend() {
    const items = Object.values(STATUS).map((s) => `<li title="${s.label}"><i style="background:${s.hex};color:${s.hex}"></i>${s.short}</li>`);
    const cyan = STATUS.moving.hex, amber = STATUS.wait.hex;
    items.push(`<li class="sq"><i style="background:color-mix(in srgb, ${cyan} 25%, transparent);outline:1.5px solid ${cyan}"></i>Reserved cell</li>`);
    items.push(`<li class="sq"><i style="background:repeating-linear-gradient(45deg,${amber} 0 3px,var(--stripe-bg) 3px 6px)"></i>Blocked cell</li>`);
    items.push(`<li><i style="background:${theme.arcs.wait[0]};height:2px"></i>Wait-for edge</li>`);
    items.push(`<li><i style="background:${theme.probe.tail[0]};height:6px;width:6px;border-radius:50%"></i>Probe</li>`);
    $('legend').innerHTML = items.join('');
  }

  bindTopbar() {
    document.querySelectorAll('.modes button').forEach((b) =>
      b.addEventListener('click', () => this.app.setMode(b.dataset.mode)),
    );
    document.querySelectorAll('.speeds button').forEach((b) =>
      b.addEventListener('click', () => {
        this.app.speed = +b.dataset.speed;
        this.syncTransport();
      }),
    );
    $('btn-play').addEventListener('click', () => this.app.togglePlay());
    $('btn-restart').addEventListener('click', () => this.app.restart());
  }

  bindControls() {
    const app = this.app;
    const fill = (el) => el.style.setProperty('--p', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
    let timer = 0;
    const restartSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => app.restart(), 250);
    };
    const bind = (id, apply) => {
      const el = $(id);
      const run = () => {
        fill(el);
        apply(+el.value);
      };
      el.addEventListener('input', () => {
        run();
        restartSoon();
      });
      run();
    };
    bind('in-robots', (v) => {
      app.cfg.robots = v;
      $('out-robots').textContent = v;
    });
    bind('in-delay', (v) => {
      app.cfg.delayMin = Math.max(1, v - 1);
      app.cfg.delayMax = v + 1;
      $('out-delay').textContent = `${app.cfg.delayMin * app.cfg.tickMs}–${app.cfg.delayMax * app.cfg.tickMs} ms`;
    });
    bind('in-loss', (v) => {
      app.cfg.loss = v / 100;
      $('out-loss').textContent = `${v}%`;
    });
    bind('in-lease', (v) => {
      app.cfg.leaseTicks = v;
      app.cfg.renewEvery = Math.round(v / 4);
      $('out-lease').textContent = `${((v * app.cfg.tickMs) / 1000).toFixed(1)} s`;
    });
    bind('in-margin', (v) => {
      app.cfg.safetyMargin = v;
      $('out-margin').textContent = `${((v * app.cfg.tickMs) / 1000).toFixed(1)} s`;
    });
    bind('in-drift', (v) => {
      app.cfg.clockDrift = v / 100;
      $('out-drift').textContent = `±${v}%`;
    });
    $('in-congestion').addEventListener('change', (e) => {
      app.cfg.congestion = e.target.checked;
      app.restart();
    });
    $('in-seed').addEventListener('change', (e) => {
      app.cfg.seed = Math.max(1, +e.target.value | 0);
      app.restart();
    });
    $('btn-dice').addEventListener('click', () => {
      app.cfg.seed = 1 + Math.floor(Math.random() * 99999);
      $('in-seed').value = app.cfg.seed;
      app.restart();
    });
    document.querySelectorAll('[data-layer]').forEach((el) =>
      el.addEventListener('change', () => {
        app.live.layers[el.dataset.layer] = el.checked;
      }),
    );
    document.querySelectorAll('.collapse[data-target]').forEach((b) =>
      b.addEventListener('click', () => {
        const p = $(b.dataset.target);
        p.classList.toggle('collapsed');
        b.textContent = p.classList.contains('collapsed') ? '+' : '–';
      }),
    );
    if (window.innerWidth < 860) document.querySelector('.collapse[data-target="controls"]').click();
  }

  bindDock() {
    document.querySelectorAll('.scn[data-scenario]').forEach((b) =>
      b.addEventListener('click', () => {
        if (this.app.scenario === b.dataset.scenario) this.app.exitScenario();
        else this.app.startScenario(b.dataset.scenario);
      }),
    );
    $('nar-exit').addEventListener('click', () => this.app.exitScenario());
    $('nar-replay').addEventListener('click', () => this.app.startScenario(this.app.scenario));
    $('feed-list').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-cell]');
      if (!li) return;
      const cell = +li.dataset.cell;
      this.app.focusCell(xOf(cell), yOf(cell), 12);
      if (li.dataset.robot) this.app.select(+li.dataset.robot);
    });
  }

  bindInspector() {
    $('ins-close').addEventListener('click', () => this.app.select(-1));
    $('ins-body').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const app = this.app;
      const id = app.live.selected;
      const act = b.dataset.act;
      if (act === 'crash') app.act('crashRobot', id);
      else if (act === 'pause') app.act('pauseRobot', id, Math.round(app.sim.cfg.leaseTicks * 1.6));
      else if (act === 'follow') app.follow = !app.follow;
      else if (act === 'timeline') app.timeline.toggle(true);
      else if (act === 'robot') app.select(+b.dataset.id);
      else if (act === 'crashmgr') app.act('crashManager', +b.dataset.id);
      else if (act === 'cutnet') app.act('cutNetwork', +b.dataset.x, +b.dataset.y, 2, 160);
      this.onSelect();
    });
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  onSim(sim) {
    this.spark = [];
    this.lastSparkTick = 0;
    this.feedSeq = 0;
    this.prevCollisions = 0;
    $('feed-list').innerHTML = '';
    $('feed-count').textContent = '';
    document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === sim.cfg.mode));
    document.querySelectorAll('.scn[data-scenario]').forEach((b) => b.classList.toggle('on', b.dataset.scenario === this.app.scenario));
    const base = sim.cfg.mode === 'baseline';
    $('hero-title').textContent = base ? 'Collisions (unprotected)' : 'Protected collisions';
    $('hero-chip').textContent = base ? 'no coordination' : 'must be 0';
    $('inspector').hidden = true;
    document.querySelector('.right-col').classList.remove('has-inspector');
    this.syncTransport();
    this.lastUpdate = 0;
  }

  // After a rewind: rebuild the event log from the restored simulation.
  onSeek(sim) {
    this.feedSeq = 0;
    this.prevCollisions = sim.metrics.collisions;
    $('feed-list').innerHTML = '';
    this.lastUpdate = 0;
  }

  syncTransport() {
    $('btn-play').classList.toggle('paused', !this.app.running);
    document.querySelectorAll('.speeds button').forEach((b) => b.classList.toggle('on', +b.dataset.speed === this.app.speed));
  }

  update(now) {
    if (now - this.lastUpdate < 140) return;
    this.lastUpdate = now;
    const sim = this.app.sim;
    const s = sim.summary();

    $('clock').textContent = fmtTime(s.seconds);
    const base = sim.cfg.mode === 'baseline';
    $('kpi-collisions').textContent = s.collisions.toLocaleString();
    $('hero-sub').textContent = `per 1,000 moves: ${s.collisionsPer1k.toFixed(2)}`;
    const hero = $('kpi-hero');
    hero.classList.toggle('bad', s.collisions > 0);
    if (s.collisions > this.prevCollisions && !base) {
      hero.classList.remove('flash');
      void hero.offsetWidth;
      hero.classList.add('flash');
    }
    this.prevCollisions = s.collisions;

    $('kpi-thr').textContent = s.throughput.toFixed(0);
    $('kpi-dl').textContent = s.deadlocks;
    $('kpi-dl-sub').textContent = base ? 'not tracked' : `${s.resolved} resolved${s.resolved ? ` · ${s.avgResolve.toFixed(1)}s` : ''}`;
    $('kpi-mpm').textContent = s.msgsPerMove.toFixed(1);
    $('kpi-mpm-sub').textContent = `${s.dropped.toLocaleString()} dropped`;
    $('kpi-fenced').textContent = s.fenced;
    $('kpi-blocked').textContent = s.blocked;
    $('kpi-wait').textContent = `avg wait ${s.avgWait.toFixed(2)} s`;

    this.updateSpark(sim, s);
    this.updateFeed(sim);
    this.renderInspector();
  }

  updateSpark(sim, s) {
    const every = Math.round(1000 / sim.cfg.tickMs);
    if (sim.tick - this.lastSparkTick >= every) {
      this.lastSparkTick = sim.tick;
      this.spark.push(s.throughput);
      if (this.spark.length > 60) this.spark.shift();
    }
    const pts = this.spark;
    const svg = $('spark');
    if (pts.length < 2) {
      svg.querySelector('.line').setAttribute('d', '');
      svg.querySelector('.area').setAttribute('d', '');
      return;
    }
    const max = Math.max(10, ...pts) * 1.1;
    const xs = (i) => (i / 59) * 120;
    const ys = (v) => 30 - (v / max) * 28;
    let d = '';
    pts.forEach((v, i) => (d += `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`));
    svg.querySelector('.line').setAttribute('d', d);
    svg.querySelector('.area').setAttribute('d', `${d}L${xs(pts.length - 1).toFixed(1)},32L0,32Z`);
  }

  updateFeed(sim) {
    const list = $('feed-list');
    const fresh = sim.events.filter((e) => e.seq > this.feedSeq && FEED_KINDS.has(e.kind));
    if (sim.events.length) this.feedSeq = Math.max(this.feedSeq, sim.events[sim.events.length - 1].seq);
    for (const e of fresh) {
      const li = document.createElement('li');
      let cell = e.cell ?? (e.robots?.length ? sim.robots[e.robots[0]].cell : undefined);
      if (e.mgr !== undefined) cell = cellOf((e.mgr % 4) * 12 + 6, ((e.mgr / 4) | 0) * 8 + 4);
      if (cell !== undefined) li.dataset.cell = cell;
      if (e.robots?.length && e.mgr === undefined) li.dataset.robot = e.kind === 'deadlock' ? e.victim : e.robots[0];
      li.innerHTML = `<i style="background:${EVENT_COLORS[e.kind] || '#888'}"></i><time>${fmtTime((e.tick * sim.cfg.tickMs) / 1000)}</time><span>${e.text}</span>`;
      list.prepend(li);
    }
    while (list.children.length > 40) list.lastChild.remove();
    $('feed-count').textContent = list.children.length ? '' : 'quiet so far';
  }

  // ───────────────────────────── inspector ─────────────────────────────

  onSelect() {
    const live = this.app.live;
    const panel = $('inspector');
    const none = live.selected < 0 && live.selectedCell < 0;
    document.querySelector('.right-col').classList.toggle('has-inspector', !none);
    if (none) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    this.inspectorKey = null;
    this.renderInspector();
  }

  renderInspector() {
    const { sim, live } = this.app;
    if ($('inspector').hidden) return;
    if (live.selected >= 0) this.renderRobot(sim, sim.robots[live.selected]);
    else if (live.selectedCell >= 0) this.renderCell(sim, live.selectedCell);
  }

  renderRobot(sim, r) {
    const t = sim.tick;
    const ms = sim.cfg.tickMs;
    const st = robotStatusKey(r, sim, this.app.live.cycleMembers);
    const color = STATUS[st].hex;
    $('ins-title').textContent = `Robot R${r.id}`;
    const task = r.task
      ? `${r.task.stage === 'pickup' ? 'Pick' : 'Drop'} → ${fmtCell(r.target)}`
      : '—';
    const aging = r.priority - r.basePrio;
    let wait = '—';
    if (r.waiting) {
      const holder = r.waitingFor >= 0 ? `<button class="linkish" data-act="robot" data-id="${r.waitingFor}">R${r.waitingFor}</button>` : 'manager';
      wait = `${fmtCell(r.waitCell)} · ${holder} · ${(((t - r.waitSince) * ms) / 1000).toFixed(1)}s`;
    }
    const zone = sim.deadZones.find((z) => sim.inZone(z, r));
    const offline = zone && !r.removed ? `${(((zone.until - t) * ms) / 1000).toFixed(1)}s left` : '';
    const leases = [...r.leases]
      .map(([cell, l]) => {
        const left = Math.max(0, l.expiry - t);
        const k = Math.min(1, left / sim.cfg.leaseTicks);
        const where = cell === r.cell ? 'here' : 'ahead';
        return `<div class="lease${k < 0.3 ? ' low' : ''}"><span>${fmtCell(cell)} <small>${where}</small></span><span>epoch ${fmtEpoch(l.epoch)} · ${((left * ms) / 1000).toFixed(1)}s</span><div class="bar"><b style="width:${(k * 100).toFixed(0)}%"></b></div></div>`;
      })
      .join('');
    const dynamic = `
      <span class="ins-chip" style="color:${color}"><i></i>${STATUS[st].label}</span>
      <dl class="kv">
        <dt>Task</dt><dd>${task}</dd>
        <dt>Carrying</dt><dd>${r.carrying ? 'yes' : 'no'}</dd>
        <dt>Priority</dt><dd>${r.priority} <span style="color:var(--muted)">(${r.basePrio} + ${aging} aging)</span></dd>
        <dt>Region</dt><dd>${sim.central ? `${regionOf(r.cell)} · server M0` : `M${regionOf(r.cell)}`} · ${fmtCell(r.cell)}</dd>
        <dt>Waiting for</dt><dd>${wait}</dd>
        ${offline ? `<dt>Network</dt><dd style="color:var(--red)">cut off · ${offline}</dd>` : ''}
      </dl>
      ${sim.cfg.mode === 'baseline' ? '<p class="ins-note">Baseline mode: robots move without leases.</p>' : `<div class="ins-h">Leases held (${r.leases.size})</div>${leases || '<p class="ins-note">None. This robot is not on the floor.</p>'}`}`;
    const key = `r${r.id}`;
    if (this.inspectorKey !== key) {
      this.inspectorKey = key;
      $('ins-body').innerHTML = `<div id="ins-dyn"></div>
        <div class="ins-actions">
          <button class="ghost danger" data-act="crash" title="Kill this robot's process">Crash</button>
          <button class="ghost" data-act="pause" title="Freeze right before its next move, for longer than a lease">Freeze</button>
          <button class="ghost" data-act="follow" id="ins-follow" title="Follow with the camera (F)">Follow</button>
          <button class="ghost" data-act="timeline" title="Show this robot's messages and leases over time (M)">Timeline</button>
        </div>
        <p class="ins-note">Use <b>Freeze</b> to make a stale lease get fenced by the world. Use <b>Crash</b> to leave a Blocked cell behind.</p>`;
    }
    $('ins-dyn').innerHTML = dynamic;
    const follow = $('ins-follow');
    if (follow) follow.textContent = this.app.follow ? 'Unfollow' : 'Follow';
    const disabled = !r.alive || r.removed;
    $('ins-body').querySelectorAll('[data-act="crash"],[data-act="pause"]').forEach((b) => (b.disabled = disabled || r.paused || r.pauseBeforeMove > 0));
  }

  renderCell(sim, cell) {
    const mgr = sim.managers[sim.mgrOf(cell)];
    const e = mgr.entries.get(cell) || { state: 'FREE', owner: -1, epoch: 0, expiry: 0, queue: [] };
    const t = sim.tick;
    const ms = sim.cfg.tickMs;
    const colors = { FREE: '#8b96a8', RESERVED: STATUS.moving.hex, OCCUPIED: STATUS.work.hex, BLOCKED: STATUS.wait.hex };
    const occupant = sim.robots.find((r) => !r.removed && r.footprint.includes(cell));
    $('ins-title').textContent = `Cell ${fmtCell(cell)}`;
    const key = `c${cell}`;
    if (this.inspectorKey !== key) {
      this.inspectorKey = key;
      $('ins-body').innerHTML = `<div id="ins-dyn"></div>
        <div class="ins-actions">
          <button class="ghost danger" data-act="crashmgr" data-id="${mgr.id}" title="${sim.central ? 'Crash the central server: the whole floor’s table is lost and must be rebuilt' : 'Crash this region’s manager: its table is lost and must be rebuilt'}">${sim.central ? 'Crash server' : `Crash manager M${mgr.id}`}</button>
          <button class="ghost danger" data-act="cutnet" data-x="${xOf(cell)}" data-y="${yOf(cell)}" title="Cut every robot in the 5×5 cells around here off the network for 8 s">Cut network here</button>
        </div>`;
    }
    const ownerBtn = (id) => (id >= 0 ? `<button class="linkish" data-act="robot" data-id="${id}">R${id}</button>` : '—');
    const L = sim.layout;
    const kind = L.station[cell] ? 'Packing station' : L.bay[cell] ? 'Station bay' : L.box[cell] ? 'Crossing box' : L.hwyRows.includes(yOf(cell)) || L.hwyCols.includes(xOf(cell)) ? 'Highway lane' : 'Aisle';
    const mgrState = mgr.state === 'UP' ? `up${mgr.gen ? `, incarnation ${mgr.gen}` : ''}` : mgr.state === 'DOWN' ? 'DOWN: table lost' : 'reconciling…';
    $('ins-dyn').innerHTML = `
      <span class="ins-chip" style="color:${mgr.state === 'UP' ? colors[e.state] : STATUS.deadlock.hex}"><i></i>${mgr.state === 'UP' ? e.state : 'UNKNOWN'}</span>
      <dl class="kv">
        <dt>Kind</dt><dd>${kind}</dd>
        <dt>Manager</dt><dd>M${mgr.id} · ${mgrState}</dd>
        <dt>Lease owner</dt><dd>${ownerBtn(e.owner)}</dd>
        <dt>Epoch</dt><dd>${fmtEpoch(e.epoch)}</dd>
        <dt>Lease expires</dt><dd>${e.owner >= 0 ? `${(((e.expiry - t) * ms) / 1000).toFixed(1)}s` : '—'}</dd>
        <dt>Physically here</dt><dd>${occupant ? ownerBtn(occupant.id) : 'nobody'}</dd>
        <dt>Queue</dt><dd><span class="queue">${e.queue.map((w) => `<span>R${w.robot}·p${w.prio === Infinity ? '∞' : w.prio}</span>`).join('') || '—'}</span></dd>
      </dl>
      <p class="ins-note">${
        mgr.state !== 'UP'
          ? sim.central
            ? 'The central server is down or rebuilding its table. No grants are issued anywhere on the floor until it has reconciled with the robots.'
            : 'This region\'s manager is down or rebuilding its table. No grants are issued until it has reconciled with the robots.'
          : e.state === 'BLOCKED'
            ? 'A lease expired while a robot was still physically inside. The cell stays out of service until the world sends an explicit Cleared event.'
            : 'Free → Reserved (lease + epoch) → Occupied → Free. A lease that expires while a robot is still inside sends the cell to Blocked.'
      }</p>`;
    const btn = $('ins-body').querySelector('[data-act="crashmgr"]');
    if (btn) btn.disabled = mgr.state !== 'UP';
  }

  // ───────────────────────────── scenarios ─────────────────────────────

  showNarration(sc) {
    $('narration').hidden = false;
    $('nar-title').textContent = sc.title;
    $('nar-dots').innerHTML = sc.steps.map(() => '<i></i>').join('');
    this.setStep(sc, 0);
  }

  hideNarration() {
    $('narration').hidden = true;
    document.querySelectorAll('.scn[data-scenario]').forEach((b) => b.classList.remove('on'));
  }

  setStep(sc, i) {
    const text = $('nar-text');
    text.innerHTML = sc.steps[i].text;
    text.classList.remove('fade');
    void text.offsetWidth;
    text.classList.add('fade');
    [...$('nar-dots').children].forEach((d, k) => {
      d.className = k < i ? 'done' : k === i ? 'on' : '';
    });
  }

  checkScenario(sc) {
    const { sim, ctx } = this.app;
    if (!ctx) return;
    let moved = false;
    while (ctx.step < sc.steps.length - 1) {
      const st = sc.steps[ctx.step];
      // Some steps stay up a minimum time so they can be read.
      if (st.dwell && sim.tick - ctx.shownAt < st.dwell) break;
      if (!st.done(sim, ctx)) break;
      ctx.step++;
      ctx.shownAt = sim.tick;
      this.app.history.stepAt[ctx.step] = sim.tick;
      moved = true;
    }
    if (moved) this.setStep(sc, ctx.step);
  }
}

function fmtTime(s) {
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
