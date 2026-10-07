// The world simulator: ground truth for robot positions. It advances in
// ticks, delivers network messages, detects collisions (including head-on
// swaps), and enforces fencing by rejecting moves carrying a stale epoch.
import { Rng } from './rng.js';
import { getLayout, regionOf, fmtCell, xOf, yOf, floorOf, cellOf } from './layout.js';
import { Network } from './network.js';
import { RegionManager, fmtEpoch } from './manager.js';
import { Robot } from './robot.js';

export const DEFAULTS = {
  seed: 42,
  robots: 120,
  floors: 1,
  mode: 'detect', // 'baseline' | 'detect' | 'ordered' | 'central'
  tickMs: 50,
  moveTicks: 6,
  turnTicks: 2,
  delayMin: 1,
  delayMax: 3,
  loss: 0,
  leaseTicks: 60,
  renewEvery: 15,
  safetyMargin: 8,
  retryTicks: 12,
  probeAfter: 16,
  probeEvery: 24,
  agingTicks: 40,
  workTicks: 14,
  orderedLookahead: 2,
  clearAfter: 90, // ticks a crashed robot's Blocked cell waits for the crew
  respawnAfter: 60,
  clockDrift: 0, // max fraction each robot's clock runs fast or slow (0.05 = ±5%)
  mgrDownTicks: 80, // how long a crashed region manager stays down
  reconcileTicks: 30, // how long a restarted manager waits for robot reports
  injectFailures: false, // benchmark: periodically crash/pause robots and managers ('managers': managers only)
  // Congestion control: managers gossip region loads; robots route around
  // crowded regions and don't dispatch themselves into full ones.
  congestion: true,
  gossipEvery: 20, // ticks between a manager's load gossip rounds
  crowdedAt: 0.3, // region load (leased cells / open cells) where routing starts to detour
  detourWeight: 6, // extra planning cost per cell, per unit of load above crowdedAt
  admitBelow: 0.32, // a robot won't pick a job in a region at or above this load
  // Messages one coordinator process (a region manager, or the central
  // server) can handle per tick. Every node gets the same hardware; excess
  // messages wait in that node's inbox. 0 = unlimited.
  mgrRate: 0,
  centralDetectEvery: 8, // ticks between the central coordinator's cycle searches
};

const WAIT_BIN = 0.25; // seconds per wait-histogram bin
const WAIT_BINS = 17; // last bin collects everything ≥ 4 s

export class Simulation {
  constructor(cfg = {}, script = null) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.rng = new Rng(this.cfg.seed);
    this.layout = getLayout(this.cfg.floors);
    this.tick = 0;
    this.net = new Network(this);
    this.managers = [];
    // Centralised mode: one coordinator (M0) owns every cell on the floor.
    this.central = this.cfg.mode === 'central';
    const nMgr = this.central ? 1 : this.layout.R;
    for (let i = 0; i < nMgr; i++) this.managers.push(new RegionManager(this, i));
    this.robots = [];
    this.physCount = new Uint16Array(this.layout.N);
    this.fenceEpoch = new Int32Array(this.layout.N);
    this.fenceOwner = new Int32Array(this.layout.N).fill(-1);
    this.events = [];
    this.eventSeq = 0;
    this.flags = {};
    this.cycles = []; // recently detected deadlock cycles (for the view)
    this.bursts = []; // one-shot visual effects: collision, fenced, …
    this.recentDeadlocks = new Map();
    this.openCycles = new Map(); // key -> { formed, detected }
    this.contacts = new Set();
    this.taskTicks = [];
    this.maintenance = [];
    this.deadZones = []; // network partitions: { x0, y0, x1, y1, from, until }
    this.metrics = {
      moves: 0, tasks: 0, msgs: 0, dropped: 0, grants: 0, expired: 0,
      collisions: 0, deadlocks: 0, resolved: 0, resolveTicks: 0, probes: 0,
      fenced: 0, waitTicks: 0, waits: 0, yields: 0, backoffs: 0,
      riskyMoves: 0, liveExpiries: 0, sensorHolds: 0,
      mgrMsgs: 0, mgrQueueTicks: 0, mgrPeak: 0,
    };
    this.waitHist = new Array(WAIT_BINS).fill(0);
    this.recovery = { crashOwnership: [], crashCleared: [], pauseResync: [], mgrReconcile: [] };
    this.outages = []; // robots cut off from their manager, per manager crash

    this.script = script;
    const keepClear = new Set(script?.keepClear || []);
    if (script?.setup) script.setup(this);
    // Fill the rest of the floor with randomly placed robots.
    const taken = new Set(this.robots.map((r) => r.cell));
    const spots = this.layout.free.filter((c) => !taken.has(c) && !keepClear.has(c));
    const n = Math.max(0, this.cfg.robots - this.robots.length);
    for (let i = 0; i < n && spots.length; i++) {
      const k = this.rng.int(spots.length);
      const c = spots[k];
      spots[k] = spots[spots.length - 1];
      spots.pop();
      this.addRobot(c);
    }
  }

  get mode() {
    return this.cfg.mode;
  }

  // The manager that owns a cell.
  mgrOf(cell) {
    return this.central ? 0 : regionOf(cell);
  }

  addRobot(cell) {
    const r = new Robot(this, this.robots.length, cell);
    this.robots.push(r);
    this.physCount[cell]++;
    r.footprint = [cell];
    if (this.mode !== 'baseline') {
      const e = this.managers[this.mgrOf(cell)].place(cell, r.id);
      r.leases.set(cell, { epoch: e.epoch, expiry: e.expiry });
    }
    return r;
  }

  endpoint(addr) {
    const k = addr[0];
    const id = +addr.slice(1);
    if (k === 'r') return this.robots[id];
    if (k === 'm') return this.managers[id];
    return this;
  }

  // ───────────────────────────── tick ─────────────────────────────

  step() {
    this.tick++;
    const t = this.tick;
    this.script?.onTick?.(this);
    if (this.cfg.injectFailures && this.mode !== 'baseline') this.injectFailures();

    if (this.deadZones.length) this.healZones();
    for (const m of this.net.deliver(t)) {
      // A robot that drove into a dead zone while the message was in flight
      // never hears it.
      if (this.deadZones.length && this.isOffline(m.to)) {
        this.net.drop(m);
        continue;
      }
      this.endpoint(m.to).receive(m);
    }
    for (const mgr of this.managers) mgr.step();

    for (const r of this.robots) {
      const mo = r.motion;
      if (mo && r.alive && !r.paused && t >= mo.t1) this.arrive(r);
    }
    for (const r of this.robots) r.step();

    this.detectCollisions();
    this.runMaintenance();
    this.trace?.afterStep(this);

    if (this.cycles.length) this.cycles = this.cycles.filter((c) => t - c.tick < 50);
    if (this.bursts.length) this.bursts = this.bursts.filter((b) => t - b.tick < 40);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  // World-side message handler (REJOIN requests from robots).
  receive(m) {
    if (m.type !== 'REJOIN') return;
    const r = this.robots[m.robot];
    // Ground truth check: is this robot alive and physically where it says?
    if (!r.alive || r.motion || r.cell !== m.cell) return;
    this.net.send('w', 'm' + this.mgrOf(m.cell), { type: 'CLEARED', cell: m.cell, assignTo: r.id });
  }

  // ───────────────────────────── physics ─────────────────────────────

  setFence(cell, owner, epoch) {
    this.fenceOwner[cell] = owner;
    this.fenceEpoch[cell] = epoch;
  }

  // A robot (other than `id`) physically in this cell, or -1. Floor sensor.
  occupantOtherThan(cell, id) {
    if (this.physCount[cell] === 0) return -1;
    for (const r of this.robots) if (r.id !== id && r.footprint.includes(cell)) return r.id;
    return -1;
  }

  setFootprint(r, cells) {
    for (const c of r.footprint) this.physCount[c]--;
    r.footprint = cells;
    for (const c of cells) this.physCount[c]++;
  }

  // The actuator. Returns false if the move is fenced off.
  tryMove(r, to, epoch) {
    const t = this.tick;
    if (this.mode !== 'baseline') {
      if (this.fenceOwner[to] !== r.id || this.fenceEpoch[to] !== epoch) {
        this.metrics.fenced++;
        const cur = this.fenceEpoch[to];
        const holder = this.fenceOwner[to];
        this.event('fenced', `World rejected R${r.id} → ${fmtCell(to)}: epoch ${fmtEpoch(epoch)} is stale (current ${fmtEpoch(cur)}${holder >= 0 ? `, owner R${holder}` : ''})`, { cell: to, robots: holder >= 0 ? [r.id, holder] : [r.id] });
        this.burst('fenced', to, { epoch, cur });
        this.flag('fenced');
        return false;
      }
      this.managers[this.mgrOf(to)].markOccupied(to, r.id);
    }
    const dx = xOf(to) - xOf(r.cell), dy = yOf(to) - yOf(r.cell);
    const heading = Math.atan2(dx, dy);
    let turn = 0;
    if (Math.abs(angleDiff(heading, r.heading)) > 0.1) turn = this.cfg.turnTicks;
    r.motion = { from: r.cell, to, t0: t, start: t + turn, t1: t + turn + this.cfg.moveTicks, h0: r.heading, h1: heading };
    if (this.mode !== 'baseline') {
      // Ground truth: would this lease run out before the robot is inside?
      const e = this.managers[this.mgrOf(to)].entries.get(to);
      if (e && e.expiry - t < turn + this.cfg.moveTicks) this.metrics.riskyMoves++;
    }
    r.heading = heading;
    this.setFootprint(r, [r.cell, to]);
    return true;
  }

  arrive(r) {
    const to = r.motion.to;
    this.setFootprint(r, [to]);
    this.metrics.moves++;
    r.onArrive(to);
  }

  // Continuous position at a (possibly fractional) tick.
  posOf(r, t) {
    const mo = r.motion;
    if (!mo) return [xOf(r.cell), yOf(r.cell)];
    let tt = t;
    if (!r.alive) tt = Math.min(tt, r.crashTick);
    if (r.paused) tt = Math.min(tt, r.pauseTick ?? tt);
    const k = Math.min(1, Math.max(0, (tt - mo.start) / (mo.t1 - mo.start)));
    return [xOf(mo.from) + (xOf(mo.to) - xOf(mo.from)) * k, yOf(mo.from) + (yOf(mo.to) - yOf(mo.from)) * k];
  }

  detectCollisions() {
    const t = this.tick;
    const grid = new Map();
    const pos = [];
    for (const r of this.robots) {
      if (r.removed) continue;
      const p = this.posOf(r, t);
      pos[r.id] = p;
      const key = cellKey(floorOf(r.cell), Math.round(p[0]), Math.round(p[1]));
      let b = grid.get(key);
      if (!b) grid.set(key, (b = []));
      b.push(r.id);
    }
    const now = new Set();
    for (const r of this.robots) {
      if (r.removed) continue;
      const [x, y] = pos[r.id];
      const cx = Math.round(x), cy = Math.round(y), f = floorOf(r.cell);
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const b = grid.get(cellKey(f, cx + ox, cy + oy));
          if (!b) continue;
          for (const o of b) {
            if (o <= r.id) continue;
            const q = pos[o];
            const d = Math.hypot(q[0] - x, q[1] - y);
            if (d < 0.72) {
              const key = r.id * 4096 + o;
              now.add(key);
              if (!this.contacts.has(key)) {
                this.metrics.collisions++;
                this.burst('collision', -1, { x: (x + q[0]) / 2, y: (y + q[1]) / 2 });
                if (this.mode !== 'baseline') this.event('collision', `COLLISION between R${r.id} and R${o}`, { robots: [r.id, o] });
              }
            }
          }
        }
      }
    }
    this.contacts = now;
  }

  // ───────────────────────────── failures ─────────────────────────────

  crashRobot(id) {
    const r = this.robots[id];
    if (!r || !r.alive) return;
    r.crash();
    r.ownRecovered = false;
    this.event('crash', `R${id} crashed holding ${r.leases.size} lease${r.leases.size === 1 ? '' : 's'}`, { cell: r.cell, robots: [id] });
    this.flag('crashed');
    this.maintenance.push({ robot: id, stage: 'down', since: this.tick });
  }

  crashManager(id) {
    const m = this.managers[id];
    if (m) m.crash();
  }

  // Benchmark failure injection: a robot crash, a robot pause and (less
  // often) a region-manager crash, spread over the run.
  // With injectFailures === 'managers', only the manager crashes happen.
  injectFailures() {
    const t = this.tick;
    const robotsToo = this.cfg.injectFailures !== 'managers';
    const live = () => this.robots.filter((r) => r.alive && !r.removed && !r.paused && r.leases.size > 1);
    if (robotsToo && t % 300 === 150) {
      const c = live();
      if (c.length) this.crashRobot(this.rng.pick(c).id);
    }
    if (robotsToo && t % 300 === 0) {
      const c = live();
      if (c.length) this.pauseRobot(this.rng.pick(c).id, Math.round(this.cfg.leaseTicks * 1.6));
    }
    if (t % 900 === 450 && this.managers.every((m) => m.state === 'UP')) this.crashManager(this.rng.int(this.managers.length));
  }

  // ───────────────────────────── partitions ─────────────────────────────

  // A Wi-Fi dead zone: every robot physically inside the rectangle can neither
  // send nor receive. Managers and the world keep running; to a manager, a
  // robot behind a partition looks exactly like a crashed one.
  cutNetwork(cx, cy, r = 2, ticks = 160, f = 0) {
    const z = { f, x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r, from: this.tick, until: this.tick + ticks };
    this.deadZones.push(z);
    const inside = this.robots.filter((rb) => !rb.removed && this.inZone(z, rb)).map((rb) => rb.id);
    this.event('partition', `Network partition: robots in ${fmtCell(cellOf(cx - r, cy - r, f))}–${fmtCell(cellOf(cx + r, cy + r, f))} are cut off for ${((ticks * this.cfg.tickMs) / 1000).toFixed(0)}s (${inside.length} inside)`, { cell: cellOf(cx, cy, f), robots: inside });
    this.flag('partition');
    return z;
  }

  healZones() {
    const t = this.tick;
    for (const z of this.deadZones) {
      if (z.until > t) continue;
      this.event('healed', `Network partition healed after ${(((t - z.from) * this.cfg.tickMs) / 1000).toFixed(0)}s: cut-off robots can talk again`, { cell: cellOf((z.x0 + z.x1) >> 1, (z.y0 + z.y1) >> 1, z.f) });
      this.flag('healed');
    }
    this.deadZones = this.deadZones.filter((z) => z.until > t);
  }

  inZone(z, r) {
    for (const c of r.footprint) {
      const x = xOf(c), y = yOf(c);
      if (floorOf(c) === z.f && x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1) return true;
    }
    return false;
  }

  // Is this network address a robot behind a partition?
  isOffline(addr) {
    if (!this.deadZones.length || addr[0] !== 'r') return false;
    const r = this.robots[+addr.slice(1)];
    return !!r && this.deadZones.some((z) => this.inZone(z, r));
  }

  recordOutage(robots) {
    this.outages.push(robots);
  }

  recordRecovery(kind, ticks) {
    this.recovery[kind].push(ticks);
  }

  // First lease of a crashed robot that the manager took back.
  onCrashedLeaseRecovered(r) {
    if (r.ownRecovered || !r.crashTick) return;
    r.ownRecovered = true;
    this.recordRecovery('crashOwnership', this.tick - r.crashTick);
  }

  pauseRobot(id, ticks) {
    const r = this.robots[id];
    if (!r || !r.alive || r.paused) return;
    r.pauseBeforeMove = ticks;
  }

  // A crashed robot's cells stay Blocked until a crew physically removes it;
  // only then does the world emit the explicit Cleared event.
  runMaintenance() {
    const t = this.tick;
    for (const job of this.maintenance) {
      const r = this.robots[job.robot];
      if (job.stage === 'down') {
        const blocked = r.footprint.every((c) => this.managers[this.mgrOf(c)].blocked.has(c));
        if (blocked && this.mode !== 'baseline') {
          job.stage = 'blocked';
          job.since = t;
        } else if (this.mode === 'baseline' && t - job.since > this.cfg.leaseTicks) {
          job.stage = 'blocked';
          job.since = t;
        }
      } else if (job.stage === 'blocked' && t - job.since >= this.cfg.clearAfter) {
        const cells = r.footprint;
        this.setFootprint(r, []);
        r.removed = true;
        r.motion = null;
        for (const c of cells) this.net.send('w', 'm' + this.mgrOf(c), { type: 'CLEARED', cell: c, assignTo: -1 });
        this.recordRecovery('crashCleared', t - r.crashTick);
        if (this.mode === 'baseline') this.event('cleared', `Crew removed R${r.id}`, { cell: cells[0], robots: [r.id] });
        this.burst('cleared', cells[0]);
        job.stage = 'removed';
        job.since = t;
      } else if (job.stage === 'removed' && t - job.since >= this.cfg.respawnAfter) {
        const spot = this.findSpawn();
        if (spot < 0) continue;
        r.reset(spot);
        r.footprint = [];
        this.setFootprint(r, [spot]);
        if (this.mode !== 'baseline') {
          const e = this.managers[this.mgrOf(spot)].place(spot, r.id);
          r.leases.set(spot, { epoch: e.epoch, expiry: e.expiry });
        }
        this.event('respawn', `R${r.id} repaired and back in service at ${fmtCell(spot)}`, { cell: spot, robots: [r.id] });
        job.stage = 'done';
      }
    }
    if (this.maintenance.length) this.maintenance = this.maintenance.filter((j) => j.stage !== 'done');
  }

  findSpawn() {
    const L = this.layout;
    for (let i = 0; i < 50; i++) {
      const c = this.rng.pick(L.free);
      const e = this.managers[this.mgrOf(c)].entry(c);
      if (this.physCount[c] === 0 && e.owner === -1 && e.state === 'FREE' && !e.queue.length) return c;
    }
    return -1;
  }

  // ───────────────────────────── deadlocks ─────────────────────────────

  onDeadlock(cycle, detector, alts = [], rel = []) {
    const t = this.tick;
    const key = [...cycle].sort((a, b) => a - b).join(',');
    const last = this.recentDeadlocks.get(key);
    if (last !== undefined && t - last < 80) return;
    this.recentDeadlocks.set(key, t);
    if (this.recentDeadlocks.size > 500) this.recentDeadlocks.clear();
    this.metrics.deadlocks++;
    const members = cycle.map((id) => this.robots[id]);
    const formed = Math.max(...members.map((r) => r.waitSince));
    // Lowest priority yields (ties: higher robot ID), but only among robots
    // whose yield actually breaks the cycle. Best: a robot that merely
    // *reserved* the cell the robot behind it wants, since yielding releases
    // it. (A robot standing in that cell can cancel requests all day without
    // freeing anything.) Next best, in a ring of robots each wanting the next
    // one's cell: a robot that has another way to go.
    const lower = (a, b) => a.priority < b.priority || (a.priority === b.priority && a.id > b.id);
    const releasing = members.filter((r, i) => rel[i]);
    const movable = members.filter((r, i) => alts[i]);
    const pool = releasing.length ? releasing : movable.length ? movable : members;
    let victim = pool[0];
    for (const r of pool) if (lower(r, victim)) victim = r;
    this.openCycles.set(key, { formed, detected: t });
    this.cycles.push({ robots: cycle.slice(), tick: t, victim: victim.id, key });
    const by = detector.addr[0] === 'm' ? `Coordinator M${detector.id} found` : `Probe from R${detector.id} returned:`;
    this.event('deadlock', `${by} cycle ${cycle.map((i) => 'R' + i).join(' → ')} → R${cycle[0]}. R${victim.id} yields (priority ${victim.priority})`, { robots: cycle.slice(), victim: victim.id });
    this.flag('deadlock');
    // If the victim can't release anything (it stands in the cell the robot
    // behind it wants), it is told to step aside instead of just cancelling.
    const standing = !rel[members.indexOf(victim)];
    if (victim === detector) victim.yieldNow(key, standing);
    else detector.send('r' + victim.id, { type: 'ABORT', key, standing });
  }

  onYield(r, key, cell) {
    this.metrics.yields++;
    const open = key && this.openCycles.get(key);
    if (open) {
      this.metrics.resolved++;
      this.metrics.resolveTicks += this.tick - open.formed;
      this.openCycles.delete(key);
    }
    this.flag('yielded');
    this.burst('yield', cell);
  }

  // ───────────────────────────── bookkeeping ─────────────────────────────

  onTaskDone(r) {
    this.metrics.tasks++;
    this.taskTicks.push(this.tick);
    if (this.taskTicks.length > 4000) this.taskTicks.splice(0, 2000);
  }

  recordWait(w) {
    this.metrics.waits++;
    const s = (w * this.cfg.tickMs) / 1000;
    const bin = Math.min(WAIT_BINS - 1, Math.floor(s / WAIT_BIN));
    this.waitHist[bin]++;
  }

  event(kind, text, extra = {}) {
    this.events.push({ seq: ++this.eventSeq, tick: this.tick, kind, text, ...extra });
  }

  burst(kind, cell, extra = {}) {
    this.bursts.push({ tick: this.tick, kind, cell, ...extra });
  }

  flag(name) {
    this.flags[name] = this.tick;
  }

  // Tasks completed per minute over the trailing minute of simulated time.
  throughput() {
    const win = Math.round(60000 / this.cfg.tickMs);
    const from = this.tick - win;
    let n = 0;
    for (let i = this.taskTicks.length - 1; i >= 0 && this.taskTicks[i] > from; i--) n++;
    const span = Math.min(this.tick, win);
    return span > 0 ? (n * win) / span : 0;
  }

  // Share of waits per bin, plus median and 95th percentile (bin upper edges).
  waitStats() {
    const total = this.waitHist.reduce((a, b) => a + b, 0);
    const share = this.waitHist.map((n) => (total ? (n * 100) / total : 0));
    const pct = (q) => {
      if (!total) return null;
      let acc = 0;
      for (let i = 0; i < WAIT_BINS; i++) {
        acc += this.waitHist[i];
        if (acc >= q * total) return (i + 1) * WAIT_BIN;
      }
      return WAIT_BINS * WAIT_BIN;
    };
    return { waitShare: share, waitP50: pct(0.5), waitP95: pct(0.95) };
  }

  summary() {
    const m = this.metrics;
    const per1k = (v) => (m.moves ? (v * 1000) / m.moves : 0);
    return {
      tick: this.tick,
      seconds: (this.tick * this.cfg.tickMs) / 1000,
      moves: m.moves,
      tasks: m.tasks,
      throughput: this.throughput(),
      collisions: m.collisions,
      collisionsPer1k: per1k(m.collisions),
      deadlocks: m.deadlocks,
      deadlocksPer1k: per1k(m.deadlocks),
      resolved: m.resolved,
      avgResolve: m.resolved ? (m.resolveTicks * this.cfg.tickMs) / 1000 / m.resolved : null,
      msgsPerMove: m.moves ? m.msgs / m.moves : 0,
      fenced: m.fenced,
      expired: m.expired,
      avgWait: m.waits ? (m.waitTicks * this.cfg.tickMs) / 1000 / m.waits : 0,
      blocked: this.managers.reduce((s, mg) => s + mg.blocked.size, 0),
      dropped: m.dropped,
      backoffsPer1k: per1k(m.backoffs),
      riskyPer1k: per1k(m.riskyMoves),
      liveExpiriesPer1k: per1k(m.liveExpiries),
      ...this.waitStats(),
      recovery: Object.fromEntries(Object.entries(this.recovery).map(([k, v]) => [k, v.length ? (v.reduce((a, b) => a + b, 0) / v.length) * this.cfg.tickMs / 1000 : null])),
      // Coordinator load: the busiest single node, and how long messages sat
      // in a node's inbox because it was at capacity.
      mgrNodes: this.managers.length,
      mgrPeak: m.mgrPeak,
      mgrBusiest: Math.max(...this.managers.map((mg) => mg.handled)) / ((this.tick * this.cfg.tickMs) / 1000 || 1),
      mgrQueueMs: m.mgrMsgs ? (m.mgrQueueTicks * this.cfg.tickMs) / m.mgrMsgs : 0,
      outageRobots: this.outages.length ? this.outages.reduce((a, b) => a + b, 0) / this.outages.length : null,
      robots: this.robots.length,
      recoveryCounts: Object.fromEntries(Object.entries(this.recovery).map(([k, v]) => [k, v.length])),
    };
  }
}

export const WAIT_BIN_SECONDS = WAIT_BIN;

// Collision-grid bucket: floor, then row and column with a one-cell border.
const cellKey = (f, x, y) => (f * 64 + y + 1) * 64 + x + 1;

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
