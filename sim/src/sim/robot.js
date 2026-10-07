// One robot = one lightweight "process". It only talks to the outside world
// through network messages (to region managers and other robots) and through
// the world simulator's actuator (tryMove), which enforces fencing.
import { astar } from './astar.js';
import { regionOf, fmtCell, xOf, yOf, cellOf, floorOf, rideTicks, W, H } from './layout.js';


const URGENT_RENEW_GAP = 4; // ticks

export class Robot {
  constructor(sim, id, cell) {
    this.sim = sim;
    this.id = id;
    this.addr = 'r' + id;
    this.reset(cell);
    this.basePrio = 1 + sim.rng.int(3);
    // Clock drift: this robot's clock runs fast or slow by up to ±clockDrift.
    // A positive drift makes it believe its leases last longer than they do,
    // which is exactly what the safety margin has to absorb.
    this.drift = sim.cfg.clockDrift ? (sim.rng.float() * 2 - 1) * sim.cfg.clockDrift : 0;
    // This robot's (possibly stale) view of every region's load, picked up
    // from the managers' replies.
    this.loads = new Array(sim.layout.R).fill(0);
    this.loadStamp = new Array(sim.layout.R).fill(-1);
  }

  mergeLoads(view) {
    for (let i = 0; i < view.util.length; i++) {
      if (view.stamp[i] > this.loadStamp[i]) {
        this.loads[i] = view.util[i];
        this.loadStamp[i] = view.stamp[i];
      }
    }
  }

  // Extra planning cost per step into each region: zero until a region is
  // crowded, then growing with its load. Views older than 20 s are ignored.
  regionCost() {
    const cfg = this.sim.cfg;
    if (!cfg.congestion) return null;
    const t = this.sim.tick;
    const cost = new Float32Array(this.loads.length);
    for (let i = 0; i < cost.length; i++) {
      if (this.loadStamp[i] < 0 || t - this.loadStamp[i] > 400) continue;
      cost[i] = Math.max(0, this.loads[i] - cfg.crowdedAt) * cfg.detourWeight;
    }
    return cost;
  }

  loadOf(cell) {
    const r = regionOf(cell);
    return this.loadStamp[r] < 0 || this.sim.tick - this.loadStamp[r] > 400 ? 0 : this.loads[r];
  }

  // When this robot believes a lease of `dur` ticks that started at `start`
  // runs out. Car leases last longer than cell leases (they cover a ride).
  localExpiry(start, dur = this.sim.cfg.leaseTicks) {
    return start + Math.round(dur * (1 + this.drift));
  }

  // Ticks the move into `next` takes: a cell, or a whole lift ride.
  moveTicks(next) {
    const L = this.sim.layout;
    if (L.lift && L.lift[next] && L.lift[this.cell]) return rideTicks(Math.abs(floorOf(next) - floorOf(this.cell)));
    return this.sim.cfg.moveTicks;
  }

  reset(cell) {
    const sim = this.sim;
    this.cell = cell;
    this.heading = 0;
    this.state = 'IDLE';
    this.alive = true;
    this.removed = false;
    this.paused = false;
    this.pauseUntil = 0;
    this.pauseBeforeMove = 0;
    this.pendingMove = null;
    this.leases = new Map(); // cell -> { epoch, expiry }
    this.pending = new Map(); // cell -> tick the request was last sent
    this.firstAsked = new Map(); // cell -> tick it was first requested
    this.inbox = [];
    this.path = [];
    this.task = null;
    this.carrying = false;
    this.workLeft = 0;
    this.waitCell = -1;
    this.waitingFor = -1;
    this.waitSince = 0;
    this.taskWait = 0;
    this.lastProbe = -1e9;
    this.lastYield = -1e9;
    this.yieldUntil = 0;
    this.avoid = new Map(); // cell -> until tick
    this.lastRenew = sim.tick - sim.rng.int(sim.cfg.renewEvery);
    this.renewSoon = false;
    this.lastRejoin = -1e9;
    this.lastHold = -1e9;
    this.renewSince = null; // first renewal still waiting for an answer // last tick a move was refused for lack of lease time
    this.motion = null;
    this.crashTick = 0;
  }

  get protocol() {
    return this.sim.cfg.mode !== 'baseline';
  }

  // Priority with aging: the longer a robot has waited on its current task,
  // the higher it ranks, so low-priority robots never starve.
  get priority() {
    const cur = this.waitCell >= 0 ? this.sim.tick - this.waitSince : 0;
    return this.basePrio + Math.floor((this.taskWait + cur) / this.sim.cfg.agingTicks);
  }

  get waiting() {
    return this.waitCell >= 0;
  }

  send(to, msg) {
    this.sim.net.send(this.addr, to, msg);
  }

  receive(m) {
    if (this.alive) this.inbox.push(m);
  }

  // ───────────────────────────── main loop ─────────────────────────────

  step() {
    const sim = this.sim;
    const t = sim.tick;
    const cfg = sim.cfg;
    if (!this.alive) return;
    if (this.paused) {
      if (t < this.pauseUntil) return;
      this.resume();
      return;
    }

    const inbox = this.inbox;
    this.inbox = [];
    for (const m of inbox) this.handle(m);
    if (!this.alive || this.paused) return;

    if (this.protocol) this.maybeRenew();
    if (this.motion) return;

    if (this.state === 'REJOIN') {
      if (t - this.lastRejoin > 20) {
        this.lastRejoin = t;
        this.send('w', { type: 'REJOIN', robot: this.id, cell: this.cell });
      }
      return;
    }
    if (this.workLeft > 0) {
      if (--this.workLeft === 0) this.finishWork();
      return;
    }
    if (t < this.yieldUntil) return;
    if (!this.task) this.newTask();

    if (this.path.length === 0) {
      if (this.cell === this.target) return this.startWork();
      this.plan();
      if (!this.path.length) {
        this.yieldUntil = t + 10;
        return;
      }
    }

    const next = this.path[0];
    if (!this.protocol) {
      this.state = 'MOVING';
      sim.tryMove(this, next, 0);
      return;
    }

    // Acquire leases one at a time, in global cell order.
    // Detection mode asks for one cell at a time (in global order) and
    // queues. Ordered mode queues only for the next cell, then grabs the rest
    // of its segment in global order, all-or-nothing, never queueing.
    const want = this.segment();
    let missing = -1;
    const L = sim.layout;
    if (cfg.mode === 'ordered' && !this.leases.has(next) && !L.box[next]) {
      missing = next;
      this.request(next, false);
    } else {
      for (const c of want) {
        if (this.leases.has(c)) continue;
        if (missing < 0) missing = c;
        this.request(c, cfg.mode === 'ordered');
        // Both shaft cells of a ride belong to the same lift manager, so they
        // can be asked for together without breaking the global order.
        if (cfg.mode !== 'ordered' && !(L.lift && L.lift[c])) break;
      }
    }
    if (missing >= 0) {
      this.setWaiting(missing);
      this.maybeProbe();
      return;
    }

    const lease = this.leases.get(next);
    if (lease.expiry - t < cfg.safetyMargin + this.moveTicks(next)) {
      // Too close to expiry to start a move safely: renew first. Before a
      // lift ride this matters most: there is no network in the shaft.
      this.renewSoon = true;
      this.lastHold = t;
      return;
    }
    this.clearWaiting();

    if (this.pauseBeforeMove) {
      // The lease check above has passed; now the process freezes (a GC
      // pause, a stalled CPU…) right before acting on it.
      this.pendingMove = { cell: next, epoch: lease.epoch };
      this.paused = true;
      this.pauseUntil = t + this.pauseBeforeMove;
      this.pauseBeforeMove = 0;
      this.state = 'PAUSED';
      sim.event('pause', `R${this.id} froze for ${((this.pauseUntil - t) * cfg.tickMs / 1000).toFixed(1)}s holding ${fmtCell(next)} (epoch ${lease.epoch})`, { cell: next, robots: [this.id] });
      sim.flag('paused');
      return;
    }

    this.state = 'MOVING';
    if (!sim.tryMove(this, next, lease.epoch)) this.onFenced(next);
  }

  get target() {
    return this.task.stage === 'pickup' ? this.task.pickup : this.task.dropoff;
  }

  // How many path cells must be held before the next move: the next cell,
  // or the whole run through a crossing box plus its exit cell. "ordered"
  // mode always reserves a short lookahead segment.
  aheadCount() {
    const L = this.sim.layout;
    const p = this.path;
    let n = 1;
    if (L.box[p[0]]) {
      while (n < p.length && L.box[p[n]]) n++;
      if (n < p.length) n++;
    }
    // About to drive into a lift: the car (both shaft cells) first.
    if (L.lift && L.lift[p[0]] && p.length > 1 && L.lift[p[1]]) n = 2;
    if (this.sim.cfg.mode === 'ordered') n = Math.max(n, this.sim.cfg.orderedLookahead);
    return Math.min(n, p.length);
  }

  // Cells to acquire, always requested in global cell order.
  segment() {
    return this.path.slice(0, this.aheadCount()).sort((a, b) => a - b);
  }

  wanted(c) {
    if (c === this.cell) return true;
    if (!this.path.length) return false;
    const n = this.aheadCount();
    for (let i = 0; i < n; i++) if (this.path[i] === c) return true;
    return false;
  }

  request(c, tryOnly = false) {
    const t = this.sim.tick;
    const last = this.pending.get(c);
    if (last !== undefined && t - last < this.sim.cfg.retryTicks) return;
    this.pending.set(c, t);
    if (!this.firstAsked.has(c)) this.firstAsked.set(c, t);
    this.send('m' + this.sim.mgrOf(c), { type: 'REQ', robot: this.id, cell: c, prio: this.priority, tryOnly, floor: floorOf(this.cell) });
  }

  setWaiting(c) {
    if (this.waitCell !== c) {
      this.clearWaiting();
      this.waitCell = c;
      this.waitSince = this.sim.tick;
      this.waitingFor = -1;
    }
    this.state = 'WAIT';
  }

  clearWaiting() {
    if (this.waitCell < 0) return;
    const w = this.sim.tick - this.waitSince;
    this.taskWait += w;
    this.sim.metrics.waitTicks += w;
    this.sim.recordWait(w);
    this.waitCell = -1;
    this.waitingFor = -1;
  }

  // Chandy–Misra–Haas: a robot blocked for a while sends a probe along its
  // wait-for edge. Probes travel robot → robot through the network.
  maybeProbe() {
    const t = this.sim.tick;
    const cfg = this.sim.cfg;
    // Centralised mode: the coordinator sees the whole wait-for graph and
    // finds cycles itself, so robots never probe.
    if (cfg.mode === 'central') return;
    if (this.waitingFor < 0 || t - this.waitSince < cfg.probeAfter || t - this.lastProbe < cfg.probeEvery) return;
    this.lastProbe = t;
    this.sim.metrics.probes++;
    this.send('r' + this.waitingFor, { type: 'PROBE', initiator: this.id, path: [this.id], alts: [this.hasAlternative()], rel: [], wants: this.waitCell });
  }

  // Would yielding actually free `cell` (the cell the previous robot in the
  // cycle wants from us)? Only if we merely reserved it: a robot can cancel a
  // reservation, but it cannot give up a cell it is standing in.
  releasable(cell) {
    return this.leases.has(cell) && !this.footprint.includes(cell);
  }

  // Could this robot reach its target without the cell it is waiting for?
  // Probes carry this so the cycle can pick a victim that is able to move.
  hasAlternative() {
    const key = this.cell * 4096 + this.waitCell;
    if (this.altKey === key) return this.altValue;
    const wc = this.waitCell;
    const path = astar(this.cell, this.target, (c) => c === wc, true, null, this.sim.layout);
    this.altKey = key;
    this.altValue = !!path && path[0] !== wc;
    return this.altValue;
  }

  maybeRenew() {
    const t = this.sim.tick;
    if (!this.leases.size) return;
    if (!this.renewSoon && t - this.lastRenew < this.sim.cfg.renewEvery) return;
    // An urgent renewal (lease nearly out) goes every tick, as before, except
    // once renewals have gone unanswered for longer than any round trip can
    // take: the robot is evidently cut off, so it slows to one every few ticks
    // instead of flooding the network. On a healthy network this never kicks
    // in, so normal traffic is unaffected.
    const cfg = this.sim.cfg;
    const silent = this.renewSince !== null && t - this.renewSince > 2 * cfg.delayMax + 2;
    if (this.renewSoon && silent && t - this.lastRenew < URGENT_RENEW_GAP) return;
    if (this.renewSince === null) this.renewSince = t;
    this.lastRenew = t;
    this.renewSoon = false;
    const byMgr = new Map();
    for (const [cell, l] of this.leases) {
      const m = this.sim.mgrOf(cell);
      if (!byMgr.has(m)) byMgr.set(m, []);
      byMgr.get(m).push({ cell, epoch: l.epoch });
    }
    for (const [m, cells] of byMgr) this.send('m' + m, { type: 'RENEW', robot: this.id, cells, sentAt: t });
  }

  // ───────────────────────────── messages ─────────────────────────────

  handle(m) {
    const sim = this.sim;
    if (m.loads) this.mergeLoads(m.loads);
    switch (m.type) {
      case 'GRANT': {
        // The robot cannot read the manager's clock. It conservatively assumes
        // the lease started when it first asked, measured on its own clock.
        const asked = this.firstAsked.get(m.cell);
        this.pending.delete(m.cell);
        this.firstAsked.delete(m.cell);
        if (!this.wanted(m.cell)) {
          this.send('m' + this.sim.mgrOf(m.cell), { type: 'RELEASE', robot: this.id, cell: m.cell, epoch: m.epoch });
          return;
        }
        const dur = m.dur ?? sim.cfg.leaseTicks;
        const start = asked ?? m.expiry - dur;
        this.leases.set(m.cell, { epoch: m.epoch, expiry: this.localExpiry(start, dur), dur });
        if (this.state === 'REJOIN' && m.cell === this.cell) {
          this.state = 'IDLE';
          sim.flag('rejoined');
          if (this.resumeTick !== undefined) {
            sim.recordRecovery('pauseResync', sim.tick - this.resumeTick);
            this.resumeTick = undefined;
          }
        }
        return;
      }
      case 'RECONCILE': {
        // A restarted manager is rebuilding its table: report what we hold there.
        const cells = [];
        for (const [cell, l] of this.leases) if (this.sim.mgrOf(cell) === m.mgr) cells.push(cell, l.epoch);
        this.send('m' + m.mgr, { type: 'REPORT', robot: this.id, cells, at: this.cell, gen: m.gen });
        return;
      }
      case 'QUEUED':
        if (m.cell === this.waitCell) this.waitingFor = m.holder;
        return;
      case 'DENIED': {
        // All-or-nothing: give back the segment cells beyond the next one,
        // then retry after a short random backoff.
        this.pending.delete(m.cell);
        this.firstAsked.delete(m.cell);
        if (m.cell === this.waitCell) this.waitingFor = m.holder;
        for (const [cell, l] of this.leases) {
          if (cell === this.cell || (cell === this.path[0] && !sim.layout.box[cell])) continue;
          this.leases.delete(cell);
          this.send('m' + this.sim.mgrOf(cell), { type: 'RELEASE', robot: this.id, cell, epoch: l.epoch });
        }
        this.yieldUntil = sim.tick + 2 + sim.rng.int(5);
        sim.metrics.backoffs++;
        return;
      }
      case 'BLOCKED':
        this.pending.delete(m.cell);
        this.firstAsked.delete(m.cell);
        this.avoid.set(m.cell, sim.tick + 200);
        if (this.wanted(m.cell) && m.cell !== this.cell) {
          this.clearWaiting();
          this.path = [];
          this.releaseUnwanted();
        }
        return;
      case 'RENEWED': {
        this.renewSince = null;
        for (let i = 0; i < m.ok.length; i += 2) {
          const l = this.leases.get(m.ok[i]);
          if (l && l.epoch === m.ok[i + 1]) l.expiry = this.localExpiry(m.sentAt, l.dur);
        }
        for (let i = 0; i < m.lost.length; i += 2) {
          const cell = m.lost[i];
          const l = this.leases.get(cell);
          if (!l || l.epoch !== m.lost[i + 1]) continue;
          this.leases.delete(cell);
          const inside = cell === this.cell || (this.motion && this.motion.to === cell);
          if (inside) this.startRejoin('lease lost');
        }
        return;
      }
      case 'PROBE': {
        if (m.initiator === this.id) {
          // The probe came back: the wait-for graph has a cycle through us.
          if (this.waiting) sim.onDeadlock(m.path, this, m.alts, [this.releasable(m.wants), ...m.rel]);
          return;
        }
        if (this.waiting && this.waitingFor >= 0 && !m.path.includes(this.id) && m.path.length < 300) {
          this.send('r' + this.waitingFor, {
            type: 'PROBE', initiator: m.initiator, path: [...m.path, this.id], alts: [...m.alts, this.hasAlternative()],
            rel: [...m.rel, this.releasable(m.wants)], wants: this.waitCell,
          });
        }
        return;
      }
      case 'ABORT':
        if (this.waiting && sim.tick - this.lastYield > 30) this.yieldNow(m.key, m.standing);
        return;
    }
  }

  // Deadlock victim: give up the request, avoid that cell for a while, replan.
  yieldNow(key, standing = false) {
    const sim = this.sim;
    this.wasWanted = standing;
    const t = sim.tick;
    const c = this.waitCell;
    this.send('m' + this.sim.mgrOf(c), { type: 'CANCEL', robot: this.id, cell: c });
    this.pending.delete(c);
    this.firstAsked.delete(c);
    this.avoid.set(c, t + 60);
    this.clearWaiting();
    this.path = [];
    this.releaseUnwanted();
    // Standing in the cell the robot behind wants: cancelling frees nothing,
    // so step aside into an empty neighbouring cell (a normal leased move).
    if (this.wasWanted) {
      const esc = this.escapeCell();
      if (esc >= 0) this.path = [esc];
    }
    this.yieldUntil = t + 2 + sim.rng.int(6);
    this.lastYield = t;
    this.state = 'YIELD';
    sim.onYield(this, key, c);
  }

  // An empty, open neighbouring cell to pull into (seen by the robot's own
  // proximity sensor), avoiding crossing boxes and the cells it just gave up.
  escapeCell() {
    const sim = this.sim;
    const L = sim.layout;
    if (L.lift && L.lift[this.cell]) return -1; // nowhere to step aside inside a car
    const x = xOf(this.cell), y = yOf(this.cell);
    const opts = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const c = cellOf(nx, ny, floorOf(this.cell));
      if (L.solid[c] || L.box[c] || L.station[c] || (L.lift && L.lift[c]) || sim.physCount[c] > 0 || this.avoid.has(c)) continue;
      opts.push(c);
    }
    return opts.length ? opts[sim.rng.int(opts.length)] : -1;
  }

  // Return any lease we no longer need (other than the cell we stand on),
  // and withdraw stale requests.
  releaseUnwanted() {
    for (const [cell, l] of this.leases) {
      if (this.wanted(cell)) continue;
      this.leases.delete(cell);
      this.send('m' + this.sim.mgrOf(cell), { type: 'RELEASE', robot: this.id, cell, epoch: l.epoch });
    }
    for (const cell of this.pending.keys()) {
      if (this.wanted(cell)) continue;
      this.pending.delete(cell);
      this.firstAsked.delete(cell);
      this.send('m' + this.sim.mgrOf(cell), { type: 'CANCEL', robot: this.id, cell });
    }
  }

  plan() {
    const t = this.sim.tick;
    const avoid = this.avoid;
    for (const [c, until] of avoid) if (until < t) avoid.delete(c);
    const avoiding = (c) => avoid.has(c);
    const rc = this.regionCost();
    const L = this.sim.layout;
    let path = avoid.size ? astar(this.cell, this.target, avoiding, true, rc, L) : null;
    if (!path) path = astar(this.cell, this.target, null, true, rc, L);
    if (!path) path = astar(this.cell, this.target, avoiding, false, rc, L);
    this.path = path || [];
    if (this.protocol) this.releaseUnwanted();
  }

  // ───────────────────────────── world callbacks ─────────────────────────────

  onArrive(to) {
    const from = this.cell;
    this.cell = to;
    this.path.shift();
    this.motion = null;
    if (this.state === 'MOVING') this.state = 'IDLE';
    const l = this.leases.get(from);
    if (l) {
      this.leases.delete(from);
      this.send('m' + this.sim.mgrOf(from), { type: 'RELEASE', robot: this.id, cell: from, epoch: l.epoch });
    }
    if (this.rejoinAfterArrive) {
      this.rejoinAfterArrive = false;
      this.startRejoin('deferred');
    }
  }

  onFenced(cell) {
    this.leases.delete(cell);
    this.state = 'IDLE';
    this.startRejoin('fenced');
  }

  // Our view of ownership is stale. Drop every lease and ask the world to
  // verify where we physically are so the cell can be handed back to us.
  startRejoin(why) {
    // Never resync mid-move: the robot still physically occupies both cells.
    if (this.motion) {
      this.rejoinAfterArrive = true;
      return;
    }
    for (const [cell, l] of this.leases) {
      if (cell !== this.cell) this.send('m' + this.sim.mgrOf(cell), { type: 'RELEASE', robot: this.id, cell, epoch: l.epoch });
    }
    this.leases.clear();
    this.clearWaiting();
    this.path = [];
    this.state = 'REJOIN';
    this.lastRejoin = this.sim.tick;
    this.send('w', { type: 'REJOIN', robot: this.id, cell: this.cell });
  }

  resume() {
    const sim = this.sim;
    this.paused = false;
    this.state = 'IDLE';
    this.resumeTick = sim.tick;
    sim.flag('resumed');
    const pm = this.pendingMove;
    this.pendingMove = null;
    if (pm) {
      // Still believes it owns the cell: acts on the stale lease.
      this.state = 'MOVING';
      if (!sim.tryMove(this, pm.cell, pm.epoch)) this.onFenced(pm.cell);
    }
  }

  crash() {
    this.alive = false;
    this.paused = false;
    this.state = 'CRASHED';
    this.inbox = [];
    this.crashTick = this.sim.tick;
  }

  // ───────────────────────────── tasks ─────────────────────────────

  newTask() {
    const sim = this.sim;
    const L = sim.layout;
    // Pick from anywhere; drop at one of the two nearest packing stations.
    // Admission control: draw a few candidate jobs and skip any in a region
    // this robot believes is full, taking the least loaded otherwise.
    let pickup = sim.rng.pick(L.pickups);
    if (sim.cfg.congestion) {
      for (let i = 0; i < 5 && this.loadOf(pickup) >= sim.cfg.admitBelow; i++) {
        const alt = sim.rng.pick(L.pickups);
        if (this.loadOf(alt) < this.loadOf(pickup)) pickup = alt;
      }
    }
    // Drop at one of the two nearest packing stations. With several floors
    // the ground and first floor both have stations, and any job can end on
    // either: the floor is drawn at random, then the two nearest stations
    // on it are candidates.
    const px = xOf(pickup), py = yOf(pickup);
    let stations = L.stations;
    const stationFloors = [...new Set(stations.map(floorOf))];
    if (stationFloors.length > 1) {
      const f = sim.rng.pick(stationFloors);
      stations = stations.filter((s) => floorOf(s) === f);
    }
    const near = [...stations].sort((a, b) => Math.abs(xOf(a) - px) + Math.abs(yOf(a) - py) - Math.abs(xOf(b) - px) - Math.abs(yOf(b) - py));
    this.task = { stage: 'pickup', pickup, dropoff: near[sim.rng.int(2)] };
    this.taskWait = 0;
    this.path = [];
  }

  startWork() {
    this.workLeft = this.task.work ?? this.sim.cfg.workTicks;
    this.state = 'WORK';
  }

  finishWork() {
    this.state = 'IDLE';
    if (this.task.stage === 'pickup') {
      this.carrying = true;
      this.task.stage = 'dropoff';
      this.task.work = undefined;
    } else {
      this.carrying = false;
      this.sim.onTaskDone(this);
      this.task = null;
    }
    this.path = [];
  }
}
