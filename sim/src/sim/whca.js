// Windowed Hierarchical Cooperative A* (Silver, 2005), adapted to leases.
//
// Robots share a space-time reservation table: "cell c is taken during time
// slot s". Before setting off, a robot searches space *and* time for the next
// `window` slots, steering around everyone else's reservations (waiting a
// slot is a move too), then reserves its own route. It replans every half
// window, or as soon as it falls a slot behind its schedule.
//
// The reservations only steer routing. Safety still comes from the leases,
// and edge-chasing probes still catch any deadlock the plans miss: robots
// run late (lease round trips, failures), so plans and reality drift apart.
//
// The table is a planning service every robot consults (two messages per
// plan); it holds intentions, not ownership.
import { W, H, NF } from './layout.js';
import { TURN_COST, STATION_COST, RIDE_COST } from './astar.js';

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const MAX_EXPAND = 40000;

export class Reservations {
  constructor(slotTicks) {
    this.slot = slotTicks;
    this.bySlot = new Map(); // slot -> Map(cell -> robot)
    this.mine = new Map(); // robot -> [slot, cell, slot, cell, …]
    this.oldest = 0;
  }

  owner(slot, cell) {
    const m = this.bySlot.get(slot);
    if (!m) return -1;
    const o = m.get(cell);
    return o === undefined ? -1 : o;
  }

  free(slot, cell, robot) {
    const o = this.owner(slot, cell);
    return o < 0 || o === robot;
  }

  reserve(robot, slot, cell) {
    let m = this.bySlot.get(slot);
    if (!m) this.bySlot.set(slot, (m = new Map()));
    if (m.has(cell)) return;
    m.set(cell, robot);
    let l = this.mine.get(robot);
    if (!l) this.mine.set(robot, (l = []));
    l.push(slot, cell);
  }

  clear(robot) {
    const l = this.mine.get(robot);
    if (!l) return;
    for (let i = 0; i < l.length; i += 2) {
      const m = this.bySlot.get(l[i]);
      if (m && m.get(l[i + 1]) === robot) m.delete(l[i + 1]);
    }
    this.mine.delete(robot);
  }

  // Forget slots that are over.
  prune(now) {
    while (this.oldest < now - 1) this.bySlot.delete(this.oldest++);
  }
}

// ───────────────────────── true-distance heuristic ─────────────────────────

// Distance to a goal from every cell, on the same graph astar() searches
// (strict one-way lanes, crossing rules, lift bays and rides) minus turn and
// congestion costs, so it never overestimates. Found by searching backwards
// from the goal; cached per layout and goal (goals are shelves and stations).
const cache = new WeakMap();

export function distanceTo(L, goal) {
  let per = cache.get(L);
  if (!per) cache.set(L, (per = new Map()));
  let d = per.get(goal);
  if (!d) per.set(goal, (d = reverseSearch(L, goal)));
  return d;
}

// Is the forward step c → n (direction d, same floor) allowed?
function stepOk(L, c, n, d) {
  if (L.solid[n]) return false;
  if (L.lift) {
    if (L.lift[c] && n !== L.liftOut[c]) return false;
    if (L.lift[n] && !L.lift[c] && c !== L.liftIn[n]) return false;
  }
  if (DX[d] && L.noCrossH[c] && L.noCrossH[n]) return false;
  if (DY[d] && L.noCrossV[c] && L.noCrossV[n]) return false;
  if (DX[d] && ((L.laneH[c] && L.laneH[c] !== DX[d]) || (L.laneH[n] && L.laneH[n] !== DX[d]))) return false;
  if (DY[d] && ((L.laneV[c] && L.laneV[c] !== DY[d]) || (L.laneV[n] && L.laneV[n] !== DY[d]))) return false;
  return true;
}

function reverseSearch(L, goal) {
  const dist = new Float32Array(L.N).fill(Infinity);
  const heap = new Heap();
  dist[goal] = 0;
  heap.push(0, goal);
  while (heap.n) {
    const dn = heap.topKey();
    const n = heap.pop();
    if (dn > dist[n]) continue;
    const step = 1 + (L.bay[n] && n !== goal ? STATION_COST : 0);
    const base = n - (n % NF);
    const x = n % W, y = ((n - base) / W) | 0;
    for (let d = 0; d < 4; d++) {
      // Predecessor c, one step against direction d: c → n moves along d.
      const cx = x - DX[d], cy = y - DY[d];
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
      const c = base + cy * W + cx;
      if (L.solid[c] || !stepOk(L, c, n, d)) continue;
      if (dn + step < dist[c]) {
        dist[c] = dn + step;
        heap.push(dist[c], c);
      }
    }
    // Rides: from any other shaft of the same lift.
    if (L.lift && L.lift[n]) {
      const shafts = L.lifts[L.lift[n] - 1].shafts;
      const f = (n / NF) | 0;
      for (let f2 = 0; f2 < shafts.length; f2++) {
        if (f2 === f) continue;
        const c = shafts[f2];
        const v = dn + RIDE_COST(Math.abs(f2 - f));
        if (v < dist[c]) {
          dist[c] = v;
          heap.push(v, c);
        }
      }
    }
  }
  return dist;
}

// ─────────────────────────── space-time search ───────────────────────────

// States are (time step k, cell, arrival direction, turned), as in astar()
// plus time. Buffers are reused between searches.
let cap = 0;
let g, parent, seen, closed;
let stamp = 0;
const open = new Heap();

function ensure(n) {
  if (n <= cap) return;
  cap = n;
  g = new Float32Array(n);
  parent = new Int32Array(n);
  seen = new Uint32Array(n);
  closed = new Uint32Array(n);
  stamp = 0;
}

/**
 * Plan `window` time slots ahead from `start`, starting in slot `slot0`,
 * avoiding cells other robots reserved. Returns cells[0..K] (the robot's
 * cell during slots slot0..slot0+K), stopping early at the goal, or null.
 * Lift shafts are never entered: the window stops at the lift's door and the
 * ride itself is planned normally.
 */
export function spaceTimePlan({ L, res, robot, start, goal, slot0, window, avoid, regionCost }) {
  const N = L.N;
  ensure(N * 10 * (window + 1));
  stamp++;
  open.n = 0;
  const h = distanceTo(L, goal);
  if (!Number.isFinite(h[start])) return null;
  const at = (k, c, sub) => (k * N + c) * 10 + sub;
  const s0 = at(0, start, 8);
  g[s0] = 0;
  parent[s0] = -1;
  seen[s0] = stamp;
  open.push(h[start], s0);
  let expanded = 0;
  let best = -1;

  const relax = (s, ns, cost, hn) => {
    const ng = g[s] + cost;
    if (seen[ns] === stamp && g[ns] <= ng) return;
    seen[ns] = stamp;
    g[ns] = ng;
    parent[ns] = s;
    open.push(ng + hn, ns);
  };

  while (open.n) {
    const s = open.pop();
    if (closed[s] === stamp) continue;
    closed[s] = stamp;
    const sub = s % 10;
    const c = ((s / 10) | 0) % N;
    const k = ((s / 10 / N) | 0);
    // Done at the goal, or at the end of the window (never inside a crossing
    // box: the robot must hold the whole box run, so a plan can't stop there).
    if (c === goal || (k === window && !L.box[c])) {
      best = s;
      break;
    }
    if (k === window || ++expanded > MAX_EXPAND) continue;
    const slot = slot0 + k + 1;
    const dir = sub >> 1;
    const turned = sub & 1;
    // Wait a slot (not inside a crossing box: it would block the crossing).
    if (!L.box[c] && res.free(slot, c, robot)) relax(s, at(k + 1, c, sub === 8 ? 8 : dir * 2), 1, h[c]);
    const base = c - (c % NF);
    const rbase = (base / NF) * L.RX * L.RY;
    const x = c % W, y = ((c - base) / W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = base + ny * W + nx;
      if (!Number.isFinite(h[n]) || (L.lift && L.lift[n])) continue;
      if (n !== goal && avoid && avoid(n)) continue;
      if (!stepOk(L, c, n, d)) continue;
      const turn = sub !== 8 && dir !== d;
      if (turn && turned && L.box[c]) continue; // no U-turns through a crossing
      if (!res.free(slot, n, robot)) continue;
      let cost = 1;
      if (turn) cost += TURN_COST;
      if (L.bay[n] && n !== goal) cost += STATION_COST;
      if (regionCost) cost += regionCost[rbase + ((ny / L.RH) | 0) * L.RX + ((nx / L.RW) | 0)];
      relax(s, at(k + 1, n, d * 2 + (turn && L.box[n] ? 1 : 0)), cost, h[n]);
    }
  }
  if (best < 0) return null;
  const cells = [];
  for (let s = best; s !== -1; s = parent[s]) cells.push(((s / 10) | 0) % N);
  return cells.reverse();
}

// Binary min-heap of (key, value) pairs.
function Heap() {
  this.k = new Float64Array(1024);
  this.v = new Int32Array(1024);
  this.n = 0;
}
Heap.prototype.push = function (key, val) {
  if (this.n === this.k.length) {
    const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2);
    k.set(this.k);
    v.set(this.v);
    this.k = k;
    this.v = v;
  }
  let i = this.n++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (this.k[p] <= key) break;
    this.k[i] = this.k[p];
    this.v[i] = this.v[p];
    i = p;
  }
  this.k[i] = key;
  this.v[i] = val;
};
Heap.prototype.topKey = function () {
  return this.k[0];
};
Heap.prototype.pop = function () {
  const top = this.v[0];
  const key = this.k[--this.n];
  const val = this.v[this.n];
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= this.n) break;
    if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
    if (this.k[c] >= key) break;
    this.k[i] = this.k[c];
    this.v[i] = this.v[c];
    i = c;
  }
  this.k[i] = key;
  this.v[i] = val;
  return top;
};
