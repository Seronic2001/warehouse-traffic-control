// Rewind. The simulation is deterministic: the same seed and the same user
// actions at the same ticks always give the same run. So history only needs
// a full copy of the simulation every few seconds (a checkpoint) plus the log
// of user actions. Any earlier moment is rebuilt by restoring the nearest
// checkpoint and stepping forward, replaying the actions on the way.
//
// Playing on from an earlier moment replays the same future. Acting there
// (crashing a robot, cutting the network…) starts a new branch and discards
// the old future.
const EVERY = 50; // ticks between checkpoints (2.5 s): a drag seek replays at most this many
const MAX_CHECKPOINTS = 360;

export class History {
  constructor(sim) {
    this.inputs = []; // { tick, name, args }, in tick order
    this.cursor = 0; // next input to replay
    this.marks = []; // notable events for the scrubber: { tick, kind, text, seq }
    this.maxSeq = sim.eventSeq;
    this.stepAt = [0]; // tick at which each scenario narration step was reached
    this.head = sim.tick; // furthest tick simulated
    this.checkpoints = [{ tick: sim.tick, sim: cloneSim(sim) }];
  }

  // Advance one tick, replaying any recorded action due now.
  step(sim) {
    const inputs = this.inputs;
    while (this.cursor < inputs.length && inputs[this.cursor].tick <= sim.tick) {
      const a = inputs[this.cursor++];
      if (a.tick === sim.tick) sim[a.name](...a.args);
    }
    sim.step();
    sim.net.pruneFlights(sim.tick);
    if (sim.tick > this.head) this.head = sim.tick;
    this.collect(sim);
    if (sim.tick % EVERY === 0 && !this.checkpoints.some((c) => c.tick === sim.tick)) {
      this.checkpoints.push({ tick: sim.tick, sim: cloneSim(sim) });
      this.checkpoints.sort((a, b) => a.tick - b.tick);
      if (this.checkpoints.length > MAX_CHECKPOINTS) this.thin();
    }
  }

  collect(sim) {
    const ev = sim.events;
    let i = ev.length;
    while (i > 0 && ev[i - 1].seq > this.maxSeq) i--;
    for (; i < ev.length; i++) {
      const e = ev[i];
      if (MARK_KINDS.has(e.kind)) this.marks.push({ tick: e.tick, kind: e.kind, text: e.text, seq: e.seq });
      this.maxSeq = e.seq;
    }
  }

  // A user action. Taken while behind the head, it replaces the old future.
  act(sim, name, args) {
    if (sim.tick < this.head || this.cursor < this.inputs.length) this.branch(sim);
    this.inputs.push({ tick: sim.tick, name, args });
    this.cursor = this.inputs.length;
    const out = sim[name](...args);
    this.collect(sim);
    return out;
  }

  branch(sim) {
    const tick = sim.tick;
    this.maxSeq = sim.eventSeq;
    this.inputs = this.inputs.slice(0, this.cursor);
    this.checkpoints = this.checkpoints.filter((c) => c.tick <= tick);
    this.marks = this.marks.filter((m) => m.tick <= tick);
    this.stepAt = this.stepAt.filter((s) => s <= tick);
    this.head = tick;
  }

  // Rebuild the simulation as it was at `tick`. `warm` extra ticks are
  // replayed before it so the timeline recorder has some history to show.
  seek(tick, { warm = 0, prepare } = {}) {
    tick = Math.max(0, Math.min(tick, this.head));
    let cp = this.checkpoints[0];
    for (const c of this.checkpoints) if (c.tick <= tick - warm) cp = c;
    if (cp.tick > tick) cp = this.checkpoints[0];
    const sim = cloneSim(cp.sim);
    prepare?.(sim);
    this.cursor = 0;
    while (this.cursor < this.inputs.length && this.inputs[this.cursor].tick < sim.tick) this.cursor++;
    const head = this.head;
    while (sim.tick < tick) this.step(sim);
    this.head = head;
    // Actions recorded exactly at `tick` happened after that tick's step.
    while (this.cursor < this.inputs.length && this.inputs[this.cursor].tick === tick) {
      const a = this.inputs[this.cursor++];
      sim[a.name](...a.args);
    }
    return sim;
  }

  // Keep memory bounded on very long runs: drop every other old checkpoint.
  thin() {
    const keep = this.checkpoints.length - 40;
    this.checkpoints = this.checkpoints.filter((c, i) => i === 0 || i >= keep || i % 2 === 0);
  }
}

const MARK_KINDS = new Set(['deadlock', 'crash', 'pause', 'fenced', 'collision', 'mgrdown', 'reconciled', 'partition', 'healed']);

// Deep copy of a whole simulation, preserving classes and shared references.
// The static layout and the scenario script are shared; the timeline
// recorder is not copied.
export function cloneSim(sim) {
  const seen = new Map([[sim.layout, sim.layout]]);
  if (sim.script) seen.set(sim.script, sim.script);
  if (sim.trace) seen.set(sim.trace, null);
  return copy(sim, seen);
}

function copy(v, seen) {
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return seen.get(v);
  let out;
  if (Array.isArray(v)) {
    out = new Array(v.length);
    seen.set(v, out);
    for (let i = 0; i < v.length; i++) out[i] = copy(v[i], seen);
  } else if (ArrayBuffer.isView(v)) {
    out = v.slice();
    seen.set(v, out);
  } else if (v instanceof Map) {
    out = new Map();
    seen.set(v, out);
    for (const [k, x] of v) out.set(copy(k, seen), copy(x, seen));
  } else if (v instanceof Set) {
    out = new Set();
    seen.set(v, out);
    for (const x of v) out.add(copy(x, seen));
  } else {
    out = Object.create(Object.getPrototypeOf(v));
    seen.set(v, out);
    for (const k of Object.keys(v)) out[k] = copy(v[k], seen);
  }
  return out;
}
