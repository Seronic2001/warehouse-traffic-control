// Recorder for the message timeline. Only the live view turns it on: for
// every robot it keeps the messages it sent or received, the leases it
// believed it held, and what it was doing, over the last TRACE_WINDOW ticks.
export const TRACE_WINDOW = 400; // 20 s

const MARK_KINDS = new Set(['fenced', 'crash', 'pause', 'deadlock', 'blocked', 'regrant', 'cleared', 'collision', 'respawn', 'partition', 'healed']);

export class Trace {
  constructor() {
    this.msgs = new Map(); // robot id -> [{ msg, t0, t1, lost }]
    this.leases = new Map(); // robot id -> [{ cell, epoch, t0, t1, exp }]
    this.open = new Map(); // robot id -> Map(cell -> open lease interval)
    this.status = new Map(); // robot id -> [{ kind, t0, t1 }]
    this.mgr = new Map(); // manager id -> [{ state, t0, t1 }]
    this.marks = new Map(); // robot id -> [{ tick, kind, text }]
    this.lastSeq = 0;
  }

  // Called by the network for every message, lost or not.
  onSend(msg, t0, t1, lost) {
    const e = { msg, t0, t1, lost };
    if (msg.from[0] === 'r') push(this.msgs, +msg.from.slice(1), e);
    if (msg.to[0] === 'r' && msg.to !== msg.from) push(this.msgs, +msg.to.slice(1), e);
    return e;
  }

  afterStep(sim) {
    const t = sim.tick;
    if (!this.lastSeq) this.lastSeq = sim.eventSeq - sim.events.length;
    for (const r of sim.robots) {
      this.sampleLeases(r, t);
      this.sampleStatus(r, sim, t);
    }
    for (const m of sim.managers) {
      let list = this.mgr.get(m.id);
      if (!list) this.mgr.set(m.id, (list = []));
      const cur = list[list.length - 1];
      if (cur && cur.t1 === null && cur.state === m.state) continue;
      if (cur && cur.t1 === null) cur.t1 = t;
      if (m.state !== 'UP') list.push({ state: m.state, t0: t, t1: null });
    }
    for (const e of sim.events) {
      if (e.seq <= this.lastSeq) continue;
      this.lastSeq = e.seq;
      if (!MARK_KINDS.has(e.kind)) continue;
      for (const id of e.robots || []) push(this.marks, id, { tick: e.tick, kind: e.kind, text: e.text });
    }
    if (t % 50 === 0) this.prune(t - TRACE_WINDOW);
  }

  sampleLeases(r, t) {
    let open = this.open.get(r.id);
    if (!open) this.open.set(r.id, (open = new Map()));
    for (const [cell, l] of r.leases) {
      let iv = open.get(cell);
      if (iv && iv.epoch !== l.epoch) {
        iv.t1 = t;
        iv = null;
      }
      if (!iv) {
        iv = { cell, epoch: l.epoch, t0: t, t1: null, exp: l.expiry };
        open.set(cell, iv);
        push(this.leases, r.id, iv);
      }
      iv.exp = l.expiry;
    }
    for (const [cell, iv] of open) {
      if (r.leases.get(cell)?.epoch === iv.epoch) continue;
      if (iv.t1 === null) iv.t1 = t;
      open.delete(cell);
    }
  }

  sampleStatus(r, sim, t) {
    const kind = statusOf(r, sim, t);
    let list = this.status.get(r.id);
    if (!list) this.status.set(r.id, (list = []));
    const cur = list[list.length - 1];
    if (cur && cur.kind === kind && cur.t1 === null) return;
    if (cur && cur.t1 === null) cur.t1 = t;
    list.push({ kind, t0: t, t1: null });
  }

  prune(before) {
    for (const list of this.msgs.values()) cut(list, (e) => e.t1 < before);
    for (const list of this.leases.values()) cut(list, (e) => e.t1 !== null && e.t1 < before);
    for (const list of this.status.values()) cut(list, (e) => e.t1 !== null && e.t1 < before);
    for (const list of this.mgr.values()) cut(list, (e) => e.t1 !== null && e.t1 < before);
    for (const list of this.marks.values()) cut(list, (e) => e.tick < before);
  }
}

// What a robot is doing, for the coloured band on its timeline lane.
export function statusOf(r, sim, t) {
  if (r.removed) return 'removed';
  if (!r.alive) return 'crashed';
  if (r.paused) return 'paused';
  if (sim.deadZones.length && sim.isOffline(r.addr)) return 'offline';
  if (r.state === 'REJOIN') return 'rejoin';
  if (r.waiting && t - r.waitSince > 6) return 'wait';
  if (r.workLeft > 0) return 'work';
  if (r.motion) return 'moving';
  return 'idle';
}

function push(map, key, v) {
  let list = map.get(key);
  if (!list) map.set(key, (list = []));
  list.push(v);
}

// Drop the leading entries that match (lists are roughly in time order).
function cut(list, old) {
  let i = 0;
  while (i < list.length && old(list[i])) i++;
  if (i) list.splice(0, i);
}
