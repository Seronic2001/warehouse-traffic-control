// A* over the grid. Search states are (cell, arrival direction, turned) so
// turns can carry a small cost (clean straight runs, like real AGVs) and two
// consecutive turns inside a crossing box — a U-turn — can be forbidden.
//
// With lifts, a ride is an edge between two shaft cells of the same lift.
// The arrival direction slot then encodes where a robot is in a lift trip:
// 8 = start of the search, 9 = just arrived by car. A shaft can only be
// entered from its bay's entry cell, a robot that drove in must ride, and
// it leaves by the exit cell only after the ride.
import { W, H, RW, RH, RX, RF, NF, LIFT_FLOOR_TICKS, rideTicks, getLayout } from './layout.js';

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const TURN_COST = 0.35;
const WRONG_WAY_COST = 3;
const STATION_COST = 8;
const CELL_TICKS = 6; // a one-cell move (default cfg.moveTicks), to price rides in cells
const RIDE_COST = (floors) => rideTicks(floors) / CELL_TICKS;
const FLOOR_H = LIFT_FLOOR_TICKS / CELL_TICKS; // heuristic per floor apart

// Search buffers, sized for the largest layout seen so far.
let S = 0;
let g, parent, seen, closed, heapF, heapS;
let stamp = 0;
let heapN = 0; // binary min-heap on f, stored in two parallel arrays

function ensure(cells) {
  if (cells * 10 <= S) return;
  S = cells * 10;
  g = new Float32Array(S);
  parent = new Int32Array(S);
  seen = new Uint32Array(S);
  closed = new Uint32Array(S);
  heapF = new Float32Array(S * 4);
  heapS = new Int32Array(S * 4);
  stamp = 0;
}

function push(f, s) {
  let i = heapN++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapF[p] <= f) break;
    heapF[i] = heapF[p];
    heapS[i] = heapS[p];
    i = p;
  }
  heapF[i] = f;
  heapS[i] = s;
}

function pop() {
  const top = heapS[0];
  const f = heapF[--heapN];
  const s = heapS[heapN];
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= heapN) break;
    if (c + 1 < heapN && heapF[c + 1] < heapF[c]) c++;
    if (heapF[c] >= f) break;
    heapF[i] = heapF[c];
    heapS[i] = heapS[c];
    i = c;
  }
  heapF[i] = f;
  heapS[i] = s;
  return top;
}

/**
 * Plan a path from start to goal. Returns the list of cells after start
 * (ending at goal), or null if unreachable.
 * `avoid(cell)` returning true makes a cell impassable for this search.
 * With `strict`, one-way lanes are hard rules instead of a penalty.
 * `regionCost[r]`, if given, is added for every step into region r.
 * `L` is the warehouse layout (one floor unless given).
 */
export function astar(start, goal, avoid, strict = true, regionCost = null, L = getLayout()) {
  if (start === goal) return [];
  ensure(L.N);
  stamp++;
  heapN = 0;
  const gx = goal % W, gy = ((goal % NF) / W) | 0, gf = (goal / NF) | 0;
  const s0 = start * 10 + 8;
  g[s0] = 0;
  parent[s0] = -1;
  seen[s0] = stamp;
  push(0, s0);

  while (heapN) {
    const s = pop();
    if (closed[s] === stamp) continue;
    closed[s] = stamp;
    const c = (s / 10) | 0;
    const dir = (s % 10) >> 1;
    const turned = s & 1;
    if (c === goal) {
      const path = [];
      for (let k = s; parent[k] !== -1; k = parent[k]) path.push((k / 10) | 0);
      return path.reverse();
    }
    const base = c - (c % NF); // first cell of this floor
    const rbase = (base / NF) * RF;
    const x = c % W, y = ((c - base) / W) | 0;
    const shaft = L.lift ? L.lift[c] : 0;
    const sub = s % 10;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = base + ny * W + nx;
      if (L.solid[n]) continue;
      if (n !== goal && avoid && avoid(n)) continue;
      if (L.lift) {
        if (shaft && ((sub !== 8 && sub !== 9) || n !== L.liftOut[c])) continue;
        if (L.lift[n] && !shaft && c !== L.liftIn[n]) continue;
      }
      if (DX[d] && L.noCrossH[c] && L.noCrossH[n]) continue;
      if (DY[d] && L.noCrossV[c] && L.noCrossV[n]) continue;
      const turn = dir !== 4 && dir !== d;
      if (turn && turned && L.box[c]) continue; // no U-turns through a crossing
      let cost = 1;
      if (turn) cost += TURN_COST;
      const lh = DX[d] && ((L.laneH[c] && L.laneH[c] !== DX[d]) || (L.laneH[n] && L.laneH[n] !== DX[d]));
      const lv = DY[d] && ((L.laneV[c] && L.laneV[c] !== DY[d]) || (L.laneV[n] && L.laneV[n] !== DY[d]));
      const wrong = lh || lv;
      if (wrong) {
        if (strict) continue;
        cost += WRONG_WAY_COST;
      }
      if (L.bay[n] && n !== goal) cost += STATION_COST;
      if (regionCost) cost += regionCost[rbase + ((ny / RH) | 0) * RX + ((nx / RW) | 0)];
      const ns = n * 10 + d * 2 + (turn && L.box[n] ? 1 : 0);
      const ng = g[s] + cost;
      if (seen[ns] === stamp && g[ns] <= ng) continue;
      seen[ns] = stamp;
      g[ns] = ng;
      parent[ns] = s;
      push(ng + Math.abs(nx - gx) + Math.abs(ny - gy) + Math.abs(base / NF - gf) * FLOOR_H, ns);
    }
    // Ride the car to another floor.
    if (shaft && sub !== 9) {
      const f = base / NF;
      const shafts = L.lifts[shaft - 1].shafts;
      for (let f2 = 0; f2 < shafts.length; f2++) {
        if (f2 === f) continue;
        const n = shafts[f2];
        if (n !== goal && avoid && avoid(n)) continue;
        const ns = n * 10 + 9;
        const ng = g[s] + RIDE_COST(Math.abs(f2 - f));
        if (seen[ns] === stamp && g[ns] <= ng) continue;
        seen[ns] = stamp;
        g[ns] = ng;
        parent[ns] = s;
        push(ng + Math.abs(x - gx) + Math.abs(y - gy) + Math.abs(f2 - gf) * FLOOR_H, ns);
      }
    }
  }
  return null;
}
