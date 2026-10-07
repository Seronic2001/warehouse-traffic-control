// A lift manager runs one lift. It leases out the car the way a region
// manager leases out a cell: one holder at a time, a queue, epochs, fencing,
// expiry, crash and reconciliation are all inherited. What differs:
//
// * Every shaft cell of the lift (one per floor) is the same resource, the
//   car, so they share one table entry and one epoch, and a grant fences
//   them all.
// * Before granting, the manager sends the car to the waiting robot's floor
//   (it is wired to the lift's motor, not a network peer) and grants only
//   once the car is there, doors open.
// * There is no Wi-Fi in the shaft, so a car lease must outlast a whole ride:
//   it is granted for the normal lease plus the longest possible ride.
// * Releasing a shaft cell the robot has left by car (the boarding floor)
//   does not free the car; the robot is still inside. The car is free once
//   the robot has driven out.
// * If a car lease expires with a robot inside, the whole lift is Blocked
//   (out of service) until a crew clears it.
import { RegionManager } from './manager.js';

// A waiter on another floor is served before ones on the car's floor once it
// has waited this long (ticks): nearest-floor-first, but nobody starves.
const MAX_SKIP_WAIT = 160;
import { floorOf, fmtCell, rideTicks } from './layout.js';

export class LiftManager extends RegionManager {
  constructor(sim, id, lift) {
    super(sim, id);
    this.lift = lift;
    this.liftId = lift.id;
    this.name = `L${lift.id}`;
    this.peers = [];
    this.pending = null; // { robot, floor, cells, since, occupied }: car on its way to this robot
  }

  get car() {
    return this.sim.cars[this.liftId];
  }

  leaseLen() {
    return this.sim.cfg.leaseTicks + rideTicks(this.lift.shafts.length - 1);
  }

  crashText() {
    return `Lift manager M${this.id} (lift ${this.name}) crashed: who holds the car is lost`;
  }

  gossip() {}

  loadIn() {
    return 0;
  }

  // All shaft cells share one entry: the car.
  entry() {
    const shafts = this.lift.shafts;
    let e = this.entries.get(shafts[0]);
    if (!e) {
      e = super.entry(shafts[0]);
      for (const c of shafts) this.entries.set(c, e);
    }
    return e;
  }

  // Someone is physically in the shaft (on any floor).
  occupied(except = -1) {
    return this.lift.shafts.some((c) => this.sim.occupantOtherThan(c, except) >= 0);
  }

  fenceAll(owner, epoch) {
    for (const c of this.lift.shafts) this.sim.setFence(c, owner, epoch);
  }

  crash() {
    super.crash();
    this.pending = null;
  }

  onRequest({ robot, cell, prio, tryOnly, floor }) {
    const e = this.entry();
    const sim = this.sim;
    if (e.state === 'BLOCKED') return this.send('r' + robot, { type: 'BLOCKED', cell });
    if (e.owner === robot) return this.send('r' + robot, { type: 'GRANT', cell, epoch: e.epoch, expiry: e.expiry, dur: this.leaseLen() });
    if (this.pending?.robot === robot) {
      this.pending.cells.add(cell);
      return;
    }
    if (e.owner === -1 && !this.pending) {
      e.queue.push({ robot, prio, since: sim.tick, floor, cells: new Set([cell]) });
      return this.grant(e, robot, false);
    }
    const holder = e.owner >= 0 ? e.owner : this.pending.robot;
    if (tryOnly) return this.send('r' + robot, { type: 'DENIED', cell, holder });
    const q = e.queue.find((w) => w.robot === robot);
    if (q) {
      q.prio = prio;
      q.floor = floor;
      q.cells.add(cell);
    } else e.queue.push({ robot, prio, since: sim.tick, floor, cells: new Set([cell]) });
    e.queue.sort((a, b) => b.prio - a.prio || a.since - b.since || a.robot - b.robot);
    this.send('r' + robot, { type: 'QUEUED', cell, holder });
  }

  // Call the car for `robot`; the lease is granted when it arrives
  // (tryGrant). `occupied`: the robot is already inside (it lost its lease
  // and the world vouched for it), so the car is where the robot is and
  // `cell` is the shaft cell it stands in.
  grant(e, robot, occupied, cell = -1) {
    const sim = this.sim;
    const w = e.queue.find((x) => x.robot === robot);
    e.queue = e.queue.filter((x) => x.robot !== robot);
    if (this.pending && this.pending.robot !== robot) {
      // Someone else was waiting for the car: back to the head of the queue.
      const p = this.pending;
      e.queue.unshift({ robot: p.robot, prio: Infinity, since: p.since, floor: p.floor, cells: p.cells });
    }
    const floor = occupied ? floorOf(cell) : w ? w.floor : floorOf(sim.robots[robot].cell);
    const cells = occupied ? new Set([cell]) : w ? w.cells : new Set([this.lift.shafts[floor]]);
    this.pending = { robot, floor, cells, since: w ? w.since : sim.tick, occupied };
    if (!occupied) sim.callCar(this.liftId, floor);
    this.tryGrant();
  }

  tryGrant() {
    const p = this.pending;
    if (!p) return;
    const sim = this.sim;
    const car = this.car;
    if (car.moving || car.floor !== p.floor) return;
    // Floor sensor: nobody else may be in the shaft.
    if (this.occupied(p.robot)) return;
    this.pending = null;
    const e = this.entry();
    this.bump(e);
    e.owner = p.robot;
    e.state = p.occupied ? 'OCCUPIED' : 'RESERVED';
    e.expiry = sim.tick + this.leaseLen();
    this.owned.add(e.cell);
    for (const c of this.lift.shafts) this.blocked.delete(c);
    this.fenceAll(p.robot, e.epoch);
    sim.metrics.grants++;
    sim.metrics.liftWaits++;
    sim.metrics.liftWaitTicks += sim.tick - p.since;
    for (const c of p.cells) this.send('r' + p.robot, { type: 'GRANT', cell: c, epoch: e.epoch, expiry: e.expiry, dur: this.leaseLen() });
    for (const w of e.queue) this.send('r' + w.robot, { type: 'QUEUED', cell: [...w.cells][0], holder: p.robot });
  }

  // Who gets the car next: the highest-priority waiter on the floor the car
  // is at (no empty trip), unless the head of the queue has waited too long.
  next(e) {
    const head = e.queue[0];
    if (!head) return -1;
    if (this.sim.tick - head.since >= MAX_SKIP_WAIT) return head.robot;
    const here = e.queue.find((w) => w.floor === this.car.floor);
    return (here || head).robot;
  }

  free(e) {
    e.lastOwner = e.owner;
    e.owner = -1;
    e.state = 'FREE';
    this.owned.delete(e.cell);
    this.fenceAll(-1, e.epoch);
    if (e.queue.length && !this.pending) this.grant(e, this.next(e), false);
  }

  onRelease({ robot, epoch }) {
    const e = this.entry();
    if (e.owner !== robot || e.epoch !== epoch) return;
    // The robot left the boarding floor by car: it is still inside.
    if (this.lift.shafts.some((c) => this.sim.robots[robot].footprint.includes(c))) return;
    this.free(e);
  }

  onCancel({ robot }) {
    const e = this.entry();
    e.queue = e.queue.filter((w) => w.robot !== robot);
    if (this.pending?.robot === robot) {
      this.pending = null;
      if (e.queue.length) this.grant(e, this.next(e), false);
    }
    if (e.owner === robot && e.state === 'RESERVED') this.free(e);
  }

  onCleared({ cell, assignTo }) {
    const e = this.entry();
    const sim = this.sim;
    if (assignTo < 0 && e.state !== 'BLOCKED') return; // already cleared (a car has two cells mid-ride)
    if (assignTo >= 0 && e.state !== 'BLOCKED' && e.owner !== -1 && e.owner !== assignTo) return;
    const was = e.state === 'BLOCKED';
    for (const c of this.lift.shafts) this.blocked.delete(c);
    if (was || assignTo >= 0) {
      sim.event('cleared', `Lift ${this.name} ${assignTo >= 0 ? `returned to R${assignTo}, who is inside` : 'cleared: back in service'}`, { cell, robots: assignTo >= 0 ? [assignTo] : [] });
      sim.flag('cleared');
    }
    e.state = 'FREE';
    e.owner = -1;
    if (assignTo >= 0) return this.grant(e, assignTo, true, cell);
    this.bump(e);
    this.fenceAll(-1, e.epoch);
    if (e.queue.length && !this.pending) this.grant(e, this.next(e), false);
  }

  finishReconcile() {
    const sim = this.sim;
    const t = sim.tick;
    const e = this.entry();
    let restored = 0;
    let conflicts = 0;
    for (const rep of this.reports.values()) {
      for (let i = 0; i < rep.cells.length; i += 2) {
        const epoch = rep.cells[i + 1];
        if (e.owner >= 0 && e.owner !== rep.robot) {
          conflicts++;
          if (epoch < e.epoch) continue;
        }
        if (e.owner !== rep.robot) restored++;
        e.owner = rep.robot;
        e.epoch = Math.max(epoch, e.epoch);
        e.state = this.lift.shafts.includes(rep.at) ? 'OCCUPIED' : 'RESERVED';
        e.expiry = t + this.leaseLen();
      }
    }
    if (e.owner >= 0) {
      this.owned.add(e.cell);
      this.fenceAll(e.owner, e.epoch);
    } else if (this.occupied()) {
      // Someone is in the car and nobody claims it: out of service.
      e.state = 'BLOCKED';
      this.bump(e);
      e.blockedAt = t;
      for (const c of this.lift.shafts) this.blocked.add(c);
      this.fenceAll(-1, e.epoch);
    }
    this.state = 'UP';
    sim.recordRecovery('mgrReconcile', t - this.downTick);
    if (this.outageRobots) sim.recordOutage(this.outageRobots.size);
    this.outageRobots = null;
    sim.event('reconciled', `M${this.id} (lift ${this.name}) reconciled from ${this.reports.size} robot reports: ${e.owner >= 0 ? `car held by R${e.owner}` : e.state === 'BLOCKED' ? 'car occupied by nobody who claims it → out of service' : 'car free'}${conflicts ? `, ${conflicts} conflicts resolved by epoch` : ''}. Grants resume.`, { mgr: this.id });
    sim.flag('mgrReconciled');
    this.lastReconcile = { reports: this.reports.size, restored, blocked: e.state === 'BLOCKED' ? 1 : 0, conflicts };
    const backlog = this.backlog;
    this.backlog = [];
    for (const m of backlog) this.receive(m);
  }

  stepUp(t) {
    const sim = this.sim;
    this.tryGrant();
    const e = this.entries.get(this.lift.shafts[0]);
    if (e && e.owner >= 0 && e.expiry < t) {
      sim.metrics.expired++;
      const holder = e.owner;
      const hr = sim.robots[holder];
      if (hr && hr.alive && hr.leases.get(this.lift.shafts.find((c) => hr.leases.has(c)))?.epoch === e.epoch) sim.metrics.liveExpiries++;
      else if (hr) sim.onCrashedLeaseRecovered(hr);
      this.owned.delete(e.cell);
      e.lastOwner = holder;
      e.owner = -1;
      this.bump(e);
      if (this.occupied()) {
        e.state = 'BLOCKED';
        e.blockedAt = t;
        for (const c of this.lift.shafts) this.blocked.add(c);
        this.fenceAll(-1, e.epoch);
        for (const w of e.queue) for (const c of w.cells) this.send('r' + w.robot, { type: 'BLOCKED', cell: c });
        e.queue = [];
        sim.event('blocked', `Lease of R${holder} on lift ${this.name} expired with a robot inside → lift out of service`, { cell: this.lift.shafts[floorOf(hr?.cell ?? e.cell)] ?? e.cell, robots: [holder] });
        sim.flag('blocked');
      } else {
        e.state = 'FREE';
        this.fenceAll(-1, e.epoch);
        sim.event('expired', `Lease of R${holder} on lift ${this.name} expired → car free`, { cell: e.cell, robots: [holder] });
        if (e.queue.length && !this.pending) this.grant(e, this.next(e), false);
      }
    }
    this.activity *= 0.9;
  }
}

export const fmtLift = (L, c) => (L.lift && L.lift[c] ? `lift L${L.lift[c] - 1} ${fmtCell(c)}` : fmtCell(c));
