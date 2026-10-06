// Every robot ↔ manager ↔ robot message passes through here, with injectable
// delay (in ticks) and loss. Delivery order within a tick is send order.
export class Network {
  constructor(sim) {
    this.sim = sim;
    this.buckets = new Map();
    // When `record` is on, in-flight messages are kept for the live view.
    this.record = false;
    this.flights = [];
  }

  send(from, to, msg) {
    const sim = this.sim;
    const { delayMin, delayMax, loss } = sim.cfg;
    msg.from = from;
    msg.to = to;
    sim.metrics.msgs++;
    const lost = loss > 0 && sim.rng.chance(loss);
    const at = sim.tick + Math.max(1, delayMin + sim.rng.int(delayMax - delayMin + 1));
    if (this.record) this.flights.push({ msg, t0: sim.tick, t1: at, lost });
    if (lost) {
      sim.metrics.dropped++;
      return;
    }
    let b = this.buckets.get(at);
    if (!b) this.buckets.set(at, (b = []));
    b.push(msg);
  }

  deliver(tick) {
    const b = this.buckets.get(tick);
    if (!b) return EMPTY;
    this.buckets.delete(tick);
    return b;
  }

  pruneFlights(tick) {
    if (this.flights.length) this.flights = this.flights.filter((f) => f.t1 > tick - 1);
  }
}

const EMPTY = [];
