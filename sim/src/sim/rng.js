// Seeded PRNG (mulberry32). Every source of randomness in the simulation goes
// through one of these, so a run is fully replayable from its seed.
export class Rng {
  constructor(seed) {
    this.state = seed >>> 0;
  }
  float() {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n) {
    return Math.floor(this.float() * n);
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  chance(p) {
    return this.float() < p;
  }
}
