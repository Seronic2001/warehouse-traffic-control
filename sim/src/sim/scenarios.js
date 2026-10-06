// Scripted failure stories from the proposal. Each scenario stages a few
// robots by hand, lets normal traffic run around them, and narrates progress
// by watching the flags the simulation raises.
import { astar } from './astar.js';
import { cellOf, regionOf, getLayout, xOf, yOf } from './layout.js';

function nearestPickup(x, y) {
  const L = getLayout();
  let best = L.pickups[0], bd = Infinity;
  for (const c of L.pickups) {
    const d = Math.abs(xOf(c) - x) + Math.abs(yOf(c) - y);
    if (d < bd) (bd = d), (best = c);
  }
  return best;
}

function nearestStation(x, y) {
  const L = getLayout();
  let best = L.stations[0], bd = Infinity;
  for (const c of L.stations) {
    const d = Math.abs(xOf(c) - x) + Math.abs(yOf(c) - y);
    if (d < bd) (bd = d), (best = c);
  }
  return best;
}

function neighborhood(cx, cy, r) {
  const out = [];
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) if (x >= 0 && y >= 0 && x < 48 && y < 32) out.push(cellOf(x, y));
  return out;
}

// Place a robot with a fixed first step, then a normal A* route to its task.
function stage(sim, x, y, nx, ny, goal, prio, opts = {}) {
  const r = sim.addRobot(cellOf(x, y));
  const first = cellOf(nx, ny);
  r.basePrio = prio;
  r.task = { stage: 'pickup', pickup: goal, dropoff: sim.rng.pick(sim.layout.stations), work: opts.work };
  r.path = [first, ...(first === goal ? [] : astar(first, goal, null) || [])];
  r.heading = Math.atan2(nx - x, ny - y);
  r.tag = opts.tag;
  return r;
}

function preGrant(sim, r, cell) {
  const e = sim.managers[regionOf(cell)].place(cell, r.id, 'RESERVED');
  r.leases.set(cell, { epoch: e.epoch, expiry: e.expiry });
}

const since = (sim, ctx, f) => sim.flags[f] !== undefined && sim.flags[f] >= ctx.start;

export const SCENARIOS = {
  deadlock: {
    title: 'Four-robot deadlock',
    focus: { x: 23.5, y: 15.5, dist: 13 },
    cfg: { mode: 'detect', probeAfter: 30, probeEvery: 30, maxBackground: 70 },
    labels: [0, 1, 2, 3],
    keepClear: neighborhood(23, 15, 3),
    setup(sim) {
      // Counter-clockwise around the crossing where regions 5, 6, 9, 10 meet.
      stage(sim, 24, 15, 23, 15, nearestPickup(5, 14), 3);
      stage(sim, 23, 15, 23, 16, nearestPickup(22, 28), 2);
      stage(sim, 23, 16, 24, 16, nearestPickup(42, 18), 3);
      stage(sim, 24, 16, 24, 15, nearestPickup(26, 3), 1);
    },
    steps: [
      {
        text: 'Four robots meet where regions <b>5, 6, 9 and 10</b> touch. Each one holds its own cell and asks for the next cell counter-clockwise.',
        done: (sim) => sim.robots.slice(0, 4).every((r) => r.waitingFor >= 0),
      },
      {
        text: 'A <b>wait-for cycle</b> has formed: R0 → R1 → R2 → R3 → R0. Each region manager sees only one of the four cells, so none of them can see the cycle.',
        done: (sim) => sim.metrics.probes > 0 && sim.robots.slice(0, 4).some((r) => r.lastProbe > 0),
      },
      {
        text: '<b>Chandy–Misra–Haas edge-chasing.</b> A blocked robot sends a probe along its wait-for edge, and each blocked robot passes it on to the robot it waits for.',
        done: (sim, ctx) => since(sim, ctx, 'deadlock'),
      },
      {
        text: 'The probe got back to the robot that sent it, so there is a <b>cycle</b>. The lowest-priority robot (<b>R3</b>) cancels its request and plans a new route.',
        done: (sim, ctx) => since(sim, ctx, 'yielded') && sim.tick - sim.flags.yielded > 60,
      },
      { text: 'The cycle is broken and traffic is moving again. Collisions stay at <b>0</b>.', done: () => false },
    ],
  },

  crash: {
    title: 'Crash while holding a lease',
    focus: { x: 30.5, y: 23, dist: 12 },
    cfg: { mode: 'detect', maxBackground: 70 },
    labels: [0, 1, 2],
    keepClear: neighborhood(31, 23, 3),
    // Staged on a plain westbound lane (not a crossing box): R1 comes down
    // the southbound aisle at x=30, R2 follows R0 along the lane.
    setup(sim) {
      const c = stage(sim, 31, 23, 30, 23, nearestPickup(4, 21), 2);
      preGrant(sim, c, cellOf(30, 23));
      c.yieldUntil = 8;
      stage(sim, 30, 22, 30, 23, nearestPickup(22, 28), 2);
      stage(sim, 32, 23, 31, 23, nearestPickup(5, 26), 2);
    },
    onTick(sim) {
      if (sim.tick === 4) sim.crashRobot(0);
    },
    steps: [
      {
        text: '<b>R0</b> holds two leases: its own cell and the next one. <b>R1</b> and <b>R2</b> are queued behind it.',
        done: (sim, ctx) => since(sim, ctx, 'crashed') && sim.tick > 25,
      },
      {
        text: '<b>R0 crashed.</b> It no longer renews its leases, but they are still valid until they expire, so no other robot can enter those cells yet.',
        done: (sim, ctx) => since(sim, ctx, 'blocked') || since(sim, ctx, 'regrant'),
      },
      {
        text: 'The leases expired. The empty cell goes to <b>R1</b> with a new epoch. R0\'s own cell becomes <b>BLOCKED</b>: ownership of the cell moved on, but the dead robot is still physically inside it.',
        done: (sim, ctx) => since(sim, ctx, 'cleared'),
      },
      { text: 'A maintenance crew removed R0, and the world sent an explicit <b>Cleared</b> event. The cell is Free again, and R0 will return to service once repaired.', done: () => false },
    ],
  },

  pause: {
    title: 'Pause past the lease → fencing',
    focus: { x: 30.5, y: 23, dist: 11 },
    cfg: { mode: 'detect', maxBackground: 70 },
    labels: [0, 1],
    keepClear: neighborhood(31, 23, 3),
    // Same plain-lane staging as the crash scenario: a robot frozen inside a
    // crossing box would break the box rule and cause an unrelated deadlock.
    setup(sim) {
      const p = stage(sim, 31, 23, 30, 23, nearestPickup(4, 21), 2);
      preGrant(sim, p, cellOf(30, 23));
      p.pauseBeforeMove = 100;
      stage(sim, 30, 22, 30, 23, cellOf(30, 23), 2, { work: 90 });
    },
    steps: [
      {
        text: '<b>R0</b> confirmed its lease on the next cell (epoch 1), then <b>froze</b> just before moving, as a process does during a long GC pause.',
        done: (sim, ctx) => since(sim, ctx, 'regrant'),
      },
      {
        text: 'R0\'s lease expired. The manager gave the cell to <b>R1</b> with <b>epoch 2</b>. R0 is still frozen and still believes it owns the cell with epoch 1.',
        done: (sim, ctx) => since(sim, ctx, 'fenced'),
      },
      {
        text: 'R0 resumed and tried to move on its stale lease. <b>The world rejected the move</b> because epoch 1 is older than epoch 2. Without fencing, R0 would have driven into R1.',
        done: (sim, ctx) => since(sim, ctx, 'rejoined'),
      },
      { text: 'R0 resynchronised. The world checked where it really is, gave it back its blocked cell with a fresh epoch, and R0 carried on.', done: () => false },
    ],
  },

  partition: {
    title: 'Network partition',
    focus: { x: 32, y: 23, dist: 13 },
    cfg: { mode: 'detect', maxBackground: 70 },
    labels: [0, 1],
    keepClear: neighborhood(32, 23, 3),
    // Same plain westbound lane as the crash scenario. R0 is finishing a pick
    // and has already reserved the cell it will pull out into (30,23). A dead
    // zone then cuts it off; R1 is outside the zone, waiting for that cell.
    setup(sim) {
      const r0 = sim.addRobot(cellOf(31, 23));
      r0.basePrio = 2;
      r0.heading = -Math.PI / 2;
      r0.task = { stage: 'pickup', pickup: cellOf(31, 23), dropoff: nearestStation(0, 23) };
      r0.workLeft = 50;
      r0.state = 'WORK';
      preGrant(sim, r0, cellOf(30, 23));
      stage(sim, 30, 22, 30, 23, nearestPickup(22, 28), 2);
    },
    onTick(sim) {
      if (sim.tick === 4) sim.cutNetwork(33, 23, 2, 160);
    },
    steps: [
      {
        text: 'A <b>Wi-Fi dead zone</b> (red) cuts every robot inside it off from the network. <b>R0</b> is inside, finishing a pick. It already holds a lease on the cell it will pull out into, and <b>R1</b> is queued for that same cell.',
        done: (sim) => sim.robots[0].lastHold > 0,
      },
      {
        text: 'R0 finished its pick, but its renewals never got through. By <b>its own clock</b> the lease is about to run out, so it <b>refuses to move</b>, even though no one has told it the cell is gone. Watch the cell ahead of it.',
        dwell: 50, // ticks: the re-grant follows half a second later
        done: (sim, ctx) => since(sim, ctx, 'regrant'),
      },
      {
        text: 'A moment later the manager\'s copy of the lease expired too. To the manager, R0 looks exactly like a crashed robot: the empty cell went to <b>R1</b> with a higher epoch, and R0\'s own cell is <b>Blocked</b> because R0 is still inside.',
        done: (sim, ctx) => since(sim, ctx, 'healed'),
      },
      {
        text: 'The network healed. R0\'s renewals come back <b>lost</b>, so it drops its stale leases and asks the world to confirm where it is.',
        done: (sim, ctx) => since(sim, ctx, 'rejoined'),
      },
      { text: 'R0 got its own cell back with a fresh epoch and carries on. Nobody entered a cell without a valid lease, before, during or after the partition.', done: () => false },
    ],
  },

  manager: {
    title: 'Region manager crash',
    focus: { x: 17.5, y: 11.5, dist: 21 },
    cfg: { mode: 'detect', maxBackground: 140 },
    labels: [],
    keepClear: [],
    setup() {},
    onTick(sim) {
      if (sim.tick === 120) sim.crashManager(5);
    },
    steps: [
      {
        text: 'Region 5 is busy. Its manager <b>M5</b> holds the reservation table for every cell in the region.',
        done: (sim, ctx) => since(sim, ctx, 'mgrDown'),
      },
      {
        text: '<b>M5 crashed</b> and its whole table is gone. Robots in region 5 can no longer get or renew leases. As each lease nears expiry, the robot <b>stops</b> because of the safety margin. Nobody enters a cell without permission.',
        done: (sim, ctx) => since(sim, ctx, 'mgrRestart'),
      },
      {
        text: 'M5 restarted with an empty table and a new <b>incarnation number</b>. It asks every robot what it holds and <b>refuses all grants</b> until it has rebuilt the table.',
        done: (sim, ctx) => since(sim, ctx, 'mgrReconciled'),
      },
      {
        text: 'The table has been rebuilt from the robots\' reports. Leases they still hold are restored, and occupied cells nobody claimed are <b>Blocked</b>. Every new epoch is stamped with the new incarnation, so it is higher than any epoch issued before the crash. A stale lease can never pass fencing, and traffic resumes.',
        done: () => false,
      },
    ],
  },
};
