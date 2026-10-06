// Warehouse floor: a 48×32 grid split into 4×4 regions of 12×8 cells.
// Two-lane highways run along every region border (so the busiest crossings
// are exactly where regions meet), shelf blocks sit between them, and packing
// stations sit in one-way drive-through bays cut into the four walls.

export const W = 48;
export const H = 32;
export const RW = 12;
export const RH = 8;
export const RX = W / RW; // regions across
export const RY = H / RH; // regions down

const HWY_COLS = [1, 2, 11, 12, 23, 24, 35, 36, 45, 46];
const HWY_ROWS = [1, 2, 7, 8, 15, 16, 23, 24, 29, 30];
const STATION_ROWS = [4, 12, 19, 27];
const STATION_COLS = [6, 18, 29, 41];

export const cellOf = (x, y) => y * W + x;
export const xOf = (c) => c % W;
export const yOf = (c) => (c / W) | 0;
export const regionOf = (c) => ((yOf(c) / RH) | 0) * RX + ((xOf(c) / RW) | 0);
export const fmtCell = (c) => `(${xOf(c)},${yOf(c)})`;

let cached = null;

export function getLayout() {
  if (cached) return cached;
  const N = W * H;
  const shelf = new Uint8Array(N);
  const wall = new Uint8Array(N); // outer ring, except the station bays
  const solid = new Uint8Array(N); // shelf | wall: impassable for robots
  const station = new Uint8Array(N);
  const bay = new Uint8Array(N);
  // Preferred travel direction per cell: laneH = +1 east / -1 west,
  // laneV = +1 south / -1 north, 0 = two-way.
  const laneH = new Int8Array(N);
  const laneV = new Int8Array(N);

  const hwyCol = new Set(HWY_COLS);
  const hwyRow = new Set(HWY_ROWS);

  // Shelves: inside each block, columns go shelf, shelf, aisle, repeating.
  const aisleCols = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x === 0 || x === W - 1 || y === 0 || y === H - 1) {
        wall[cellOf(x, y)] = 1;
        continue;
      }
      if (hwyCol.has(x) || hwyRow.has(y)) continue;
      let bx = x;
      while (!hwyCol.has(bx - 1)) bx--;
      const rel = x - bx;
      if (rel % 3 !== 2) shelf[cellOf(x, y)] = 1;
      else if (!aisleCols.includes(x)) aisleCols.push(x);
    }
  }

  // Highway lanes: in each two-lane pair, the first lane runs one way and
  // the second the other way (a soft rule the planner prefers to obey).
  for (let i = 0; i < HWY_ROWS.length; i += 2) {
    for (let x = 0; x < W; x++) {
      laneH[cellOf(x, HWY_ROWS[i])] = -1;
      laneH[cellOf(x, HWY_ROWS[i + 1])] = 1;
    }
  }
  for (let i = 0; i < HWY_COLS.length; i += 2) {
    for (let y = 0; y < H; y++) {
      laneV[cellOf(HWY_COLS[i], y)] = 1;
      laneV[cellOf(HWY_COLS[i + 1], y)] = -1;
    }
  }
  // Aisles alternate direction so robots rarely meet head-on inside them.
  aisleCols.sort((a, b) => a - b);
  aisleCols.forEach((x, i) => {
    for (let y = 0; y < H; y++) {
      const c = cellOf(x, y);
      if (!hwyRow.has(y) && !shelf[c]) laneV[c] = i % 2 ? -1 : 1;
    }
  });

  // Station bays: drive in at one end, stop at the station, drive out at the
  // other end. Each bay flows the same way as the ring lane beside it, so a
  // drop-off never blocks through-traffic. f = flow along the wall,
  // n = from the lane into the bay.
  const stations = [];
  const bays = [];
  for (const y of STATION_ROWS) {
    bays.push([0, y, 0, 1, -1, 0], [W - 1, y, 0, -1, 1, 0]);
  }
  for (const x of STATION_COLS) {
    bays.push([x, 0, -1, 0, 0, -1], [x, H - 1, 1, 0, 0, 1]);
  }
  for (const [x, y, fx, fy, nx, ny] of bays) {
    const along = fx ? laneH : laneV;
    const across = nx ? laneH : laneV;
    const inward = nx || ny;
    for (let k = -1; k <= 1; k++) {
      const c = cellOf(x + fx * k, y + fy * k);
      wall[c] = 0;
      bay[c] = 1;
      along[c] = fx || fy;
      across[c] = k === 1 ? -inward : inward; // enter at k=-1 or 0, leave at k=1
    }
    const c = cellOf(x, y);
    station[c] = 1;
    stations.push(c);
  }
  for (let c = 0; c < N; c++) solid[c] = shelf[c] | wall[c];

  // Crossing boxes: the 2×2 cells where two highways meet. Robots may only
  // enter one after reserving every cell through it, exit included.
  // Lane changes are only allowed inside a box, never midway along a road.
  const box = new Uint8Array(N);
  const noCrossH = new Uint8Array(N);
  const noCrossV = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    const x = xOf(c), y = yOf(c);
    if (hwyRow.has(y) && hwyCol.has(x)) box[c] = 1;
    else if (hwyCol.has(x)) noCrossH[c] = 1;
    else if (hwyRow.has(y)) noCrossV[c] = 1;
  }

  // Pickup spots: floor cells next to a shelf face.
  const pickups = [];
  const free = [];
  for (let c = 0; c < N; c++) {
    if (solid[c]) continue;
    if (!bay[c]) free.push(c);
    const x = xOf(c), y = yOf(c);
    const nearShelf =
      (x > 0 && shelf[c - 1]) || (x < W - 1 && shelf[c + 1]) ||
      (y > 0 && shelf[c - W]) || (y < H - 1 && shelf[c + W]);
    if (nearShelf && !hwyRow.has(y) && !hwyCol.has(x)) pickups.push(c);
  }

  cached = { W, H, N, RW, RH, RX, RY, shelf, wall, solid, station, bay, box, noCrossH, noCrossV, laneH, laneV, stations, pickups, free, aisleCols, hwyRows: HWY_ROWS, hwyCols: HWY_COLS };
  return cached;
}
