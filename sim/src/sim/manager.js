// A region manager owns the reservation table for its 12×8 block of cells.
// Each cell moves Free → Reserved (lease, epoch N) → Occupied → Free, and to
// Blocked if a lease expires while a robot is still physically inside.
//
// A manager can crash and lose its whole table. On restart it bumps its
// incarnation number (the one thing it keeps on stable storage), asks every
// robot what it holds, and refuses all grants until that reconciliation is
// done. Every epoch it issues afterwards is above GEN_STRIDE × incarnation,
// so it is larger than any epoch issued before the crash.
import { fmtCell, regionOf } from './layout.js';

export const GEN_STRIDE = 1_000_000;
export const fmtEpoch = (e) => (e >= GEN_STRIDE ? `${e % GEN_STRIDE}·i${Math.floor(e / GEN_STRIDE)}` : `${e}`);

export class RegionManager {
  constructor(sim, id) {
    this.sim = sim;
    this.id = id;
    this.addr = 'm' + id;
    this.entries = new Map();
    this.owned = new Set(); // cells with a live lease
    this.blocked = new Set();
    this.activity = 0; // decays in the view; bumped on each message
    this.state = 'UP'; // 'UP' | 'DOWN' | 'RECONCILING'
    this.gen = 0; // incarnation number, survives crashes
    this.backlog = [];
    this.held = new Set(); // free cells whose floor sensor still sees a robot
  }

  // Next epoch for a cell: always above anything issued in an earlier life.
  bump(e) {
    e.epoch = Math.max(e.epoch, this.gen * GEN_STRIDE) + 1;
  }

  crash() {
    if (this.state !== 'UP') return;
    const sim = this.sim;
    this.state = 'DOWN';
    this.downTick = sim.tick;
    this.entries = new Map();
    this.owned.clear();
    this.blocked.clear();
    this.held.clear();
    this.backlog = [];
    sim.event('mgrdown', `Region manager M${this.id} crashed: its reservation table for region ${this.id} is lost`, { mgr: this.id });
    sim.flag('mgrDown');
  }

  restart() {
    const sim = this.sim;
    this.gen++;
    this.state = 'RECONCILING';
    this.reconcileStart = sim.tick;
    this.reports = new Map();
    for (const r of sim.robots) this.send('r' + r.id, { type: 'RECONCILE', mgr: this.id, gen: this.gen });
    sim.event('mgrrestart', `M${this.id} restarted as incarnation ${this.gen}: asking all robots what they hold, refusing grants until reconciled`, { mgr: this.id });
    sim.flag('mgrRestart');
  }

  finishReconcile() {
    const sim = this.sim;
    const t = sim.tick;
    let restored = 0;
    let conflicts = 0;
    for (const rep of this.reports.values()) {
      for (let i = 0; i < rep.cells.length; i += 2) {
        const cell = rep.cells[i], epoch = rep.cells[i + 1];
        const e = this.entry(cell);
        if (e.owner >= 0 && e.owner !== rep.robot) {
          // Two robots claim the cell: the higher epoch is the newer grant.
          conflicts++;
          if (epoch < e.epoch) continue;
        }
        e.owner = rep.robot;
        e.epoch = epoch;
        e.state = rep.at === cell ? 'OCCUPIED' : 'RESERVED';
        e.expiry = t + sim.cfg.leaseTicks;
        this.owned.add(cell);
        sim.setFence(cell, rep.robot, epoch);
        restored++;
      }
    }
    // Anything physically occupied that nobody claimed stays out of service.
    let blocked = 0;
    for (let c = 0; c < sim.layout.N; c++) {
      if (regionOf(c) !== this.id || sim.physCount[c] === 0) continue;
      const e = this.entry(c);
      if (e.owner >= 0) continue;
      e.state = 'BLOCKED';
      this.bump(e);
      e.blockedAt = t;
      this.blocked.add(c);
      sim.setFence(c, -1, e.epoch);
      blocked++;
    }
    this.state = 'UP';
    sim.recordRecovery('mgrReconcile', t - this.downTick);
    sim.event('reconciled', `M${this.id} reconciled from ${this.reports.size} robot reports: ${restored} leases restored, ${blocked} cells Blocked${conflicts ? `, ${conflicts} conflicts resolved by epoch` : ''}. Grants resume.`, { mgr: this.id });
    sim.flag('mgrReconciled');
    this.lastReconcile = { reports: this.reports.size, restored, blocked, conflicts };
    const backlog = this.backlog;
    this.backlog = [];
    for (const m of backlog) this.receive(m);
  }

  entry(cell) {
    let e = this.entries.get(cell);
    if (!e) {
      e = { cell, state: 'FREE', owner: -1, epoch: this.gen * GEN_STRIDE, expiry: 0, queue: [], blockedAt: 0, lastOwner: -1 };
      this.entries.set(cell, e);
    }
    return e;
  }

  send(to, msg) {
    this.sim.net.send(this.addr, to, msg);
  }

  receive(m) {
    if (this.state === 'DOWN') {
      this.sim.metrics.dropped++;
      return;
    }
    if (this.state === 'RECONCILING') {
      if (m.type === 'REPORT') {
        if (m.gen === this.gen) this.reports.set(m.robot, m);
        if (this.reports.size >= this.sim.robots.filter((r) => r.alive).length) this.finishReconcile();
      } else this.backlog.push(m); // no grants until the table is rebuilt
      return;
    }
    this.activity++;
    switch (m.type) {
      case 'REQ': return this.onRequest(m);
      case 'RELEASE': return this.onRelease(m);
      case 'RENEW': return this.onRenew(m);
      case 'CANCEL': return this.onCancel(m);
      case 'CLEARED': return this.onCleared(m);
    }
  }

  onRequest({ robot, cell, prio, tryOnly }) {
    const e = this.entry(cell);
    if (e.state === 'BLOCKED') return this.send('r' + robot, { type: 'BLOCKED', cell });
    if (e.owner === robot) {
      // Duplicate request (e.g. our grant was lost): re-send the same grant.
      return this.send('r' + robot, { type: 'GRANT', cell, epoch: e.epoch, expiry: e.expiry });
    }
    if (e.owner === -1) return this.grant(e, robot, false);
    // Ordered acquisition never waits in a queue: it is told who holds the
    // cell, backs off, and retries.
    if (tryOnly) return this.send('r' + robot, { type: 'DENIED', cell, holder: e.owner });
    const q = e.queue.find((w) => w.robot === robot);
    if (q) q.prio = prio;
    else e.queue.push({ robot, prio, since: this.sim.tick });
    e.queue.sort((a, b) => b.prio - a.prio || a.since - b.since || a.robot - b.robot);
    this.send('r' + robot, { type: 'QUEUED', cell, holder: e.owner });
  }

  grant(e, robot, occupied) {
    const sim = this.sim;
    // Defence in depth: never hand out a cell the floor sensor says another
    // robot is physically in. Keep the request queued until the cell empties.
    const other = sim.occupantOtherThan(e.cell, robot);
    if (other >= 0) {
      if (!e.queue.some((w) => w.robot === robot)) e.queue.unshift({ robot, prio: Infinity, since: sim.tick });
      this.held.add(e.cell);
      sim.metrics.sensorHolds++;
      this.send('r' + robot, { type: 'QUEUED', cell: e.cell, holder: other });
      return;
    }
    this.bump(e);
    e.owner = robot;
    e.state = occupied ? 'OCCUPIED' : 'RESERVED';
    e.expiry = sim.tick + sim.cfg.leaseTicks;
    e.queue = e.queue.filter((w) => w.robot !== robot);
    this.owned.add(e.cell);
    this.blocked.delete(e.cell);
    sim.setFence(e.cell, robot, e.epoch);
    sim.metrics.grants++;
    this.send('r' + robot, { type: 'GRANT', cell: e.cell, epoch: e.epoch, expiry: e.expiry });
    // Waiters now wait on the new holder (keeps wait-for edges accurate).
    for (const w of e.queue) this.send('r' + w.robot, { type: 'QUEUED', cell: e.cell, holder: robot });
  }

  // Direct grant used when the world places a robot on the floor.
  place(cell, robot, state = 'OCCUPIED') {
    const e = this.entry(cell);
    this.bump(e);
    e.owner = robot;
    e.state = state;
    e.expiry = this.sim.tick + this.sim.cfg.leaseTicks;
    this.owned.add(cell);
    this.sim.setFence(cell, robot, e.epoch);
    return e;
  }

  free(e) {
    e.lastOwner = e.owner;
    e.owner = -1;
    e.state = 'FREE';
    this.owned.delete(e.cell);
    this.sim.setFence(e.cell, -1, e.epoch);
    if (e.queue.length) this.grant(e, e.queue[0].robot, false);
  }

  onRelease({ robot, cell, epoch }) {
    const e = this.entry(cell);
    if (e.owner === robot && e.epoch === epoch) this.free(e);
  }

  onCancel({ robot, cell }) {
    const e = this.entry(cell);
    e.queue = e.queue.filter((w) => w.robot !== robot);
    if (e.owner === robot && e.state === 'RESERVED') this.free(e);
  }

  onRenew({ robot, cells, sentAt }) {
    const t = this.sim.tick;
    const ok = [], lost = [];
    for (const { cell, epoch } of cells) {
      const e = this.entry(cell);
      if (e.owner === robot && e.epoch === epoch && e.state !== 'BLOCKED') {
        e.expiry = t + this.sim.cfg.leaseTicks;
        ok.push(cell, epoch);
      } else lost.push(cell, epoch);
    }
    // The robot computes its own expiry from when it *sent* the renewal,
    // which is always earlier than ours: a built-in safety margin.
    this.send('r' + robot, { type: 'RENEWED', ok, lost, sentAt });
  }

  // From the world simulator: the cell is physically empty again, or the
  // robot inside was verified alive and gets the cell back.
  onCleared({ cell, assignTo }) {
    const e = this.entry(cell);
    const sim = this.sim;
    if (e.state !== 'BLOCKED' && e.owner !== -1 && e.owner !== assignTo) return;
    this.blocked.delete(cell);
    sim.event('cleared', `Cell ${fmtCell(cell)} cleared → ${assignTo >= 0 ? `returned to R${assignTo}` : 'Free'}`, { cell, robots: assignTo >= 0 ? [assignTo] : [] });
    sim.flag('cleared');
    if (assignTo >= 0) {
      e.state = 'FREE';
      e.owner = -1;
      this.grant(e, assignTo, true);
    } else {
      e.state = 'FREE';
      e.owner = -1;
      this.bump(e);
      sim.setFence(cell, -1, e.epoch);
      if (e.queue.length) this.grant(e, e.queue[0].robot, false);
    }
  }

  markOccupied(cell, robot) {
    const e = this.entry(cell);
    if (e.owner === robot) e.state = 'OCCUPIED';
  }

  step() {
    const sim = this.sim;
    const t = sim.tick;
    if (this.state === 'DOWN') {
      if (t - this.downTick >= sim.cfg.mgrDownTicks) this.restart();
      return;
    }
    if (this.state === 'RECONCILING') {
      if (t - this.reconcileStart >= sim.cfg.reconcileTicks) this.finishReconcile();
      return;
    }
    for (const cell of this.held) {
      const e = this.entries.get(cell);
      if (e.owner >= 0 || e.state === 'BLOCKED') this.held.delete(cell);
      else if (sim.occupantOtherThan(cell, e.queue[0]?.robot ?? -1) < 0) {
        this.held.delete(cell);
        if (e.queue.length) this.grant(e, e.queue[0].robot, false);
      }
    }
    for (const cell of this.owned) {
      const e = this.entries.get(cell);
      if (e.expiry >= t) continue;
      sim.metrics.expired++;
      const holder = e.owner;
      const hr = sim.robots[holder];
      // A live robot lost a lease it still believed it held (renewals failed).
      if (hr && hr.alive && hr.leases.get(cell)?.epoch === e.epoch) sim.metrics.liveExpiries++;
      else if (hr) sim.onCrashedLeaseRecovered(hr);
      this.owned.delete(cell);
      e.lastOwner = holder;
      if (sim.physCount[cell] > 0) {
        // Logical ownership can move on; physical occupancy cannot.
        e.state = 'BLOCKED';
        e.owner = -1;
        this.bump(e);
        e.blockedAt = t;
        this.blocked.add(cell);
        sim.setFence(cell, -1, e.epoch);
        for (const w of e.queue) this.send('r' + w.robot, { type: 'BLOCKED', cell });
        e.queue = [];
        sim.event('blocked', `Lease of R${holder} on ${fmtCell(cell)} expired with robot inside → BLOCKED`, { cell, robots: [holder] });
        sim.flag('blocked');
      } else {
        e.state = 'FREE';
        e.owner = -1;
        const next = e.queue[0]?.robot;
        sim.setFence(cell, -1, e.epoch);
        if (next !== undefined) {
          this.grant(e, next, false);
          sim.event('regrant', `Lease of R${holder} on ${fmtCell(cell)} expired → re-granted to R${next} (epoch ${fmtEpoch(e.epoch)})`, { cell, robots: [holder, next] });
          sim.flag('regrant');
        } else {
          sim.event('expired', `Lease of R${holder} on ${fmtCell(cell)} expired → Free`, { cell, robots: [holder] });
        }
      }
    }
    this.activity *= 0.9;
  }
}
