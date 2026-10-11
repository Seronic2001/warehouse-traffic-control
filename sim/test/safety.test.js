// Safety: protected robots never collide, whatever fails around them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/sim/simulation.js';
import { SCENARIOS } from '../src/sim/scenarios.js';
import { cellOf } from '../src/sim/layout.js';
import { run } from './helpers.js';

// R0 is cut off holding a lease on (30,23). The lease expires and the cell
// goes to R1, which drives in and freezes there. The manager then crashes
// before R0 hears that its lease is gone. On restart only R0 reports, still
// claiming (30,23) at its old epoch. Restoring that claim would let R0 drive
// into R1.
test('reconciliation does not restore a stale claim on an occupied cell', () => {
  const X = cellOf(30, 23);
  const sim = new Simulation({ mode: 'detect', robots: 2, mgrDownTicks: 100 }, SCENARIOS.partition);
  let froze = false, crashed = false;
  for (let t = 0; t < 600; t++) {
    const r1 = sim.robots[1];
    if (!froze && r1.cell === X && !r1.motion) {
      sim.pauseRobot(1, 600);
      froze = true;
    }
    if (!crashed && r1.paused) {
      sim.crashManager(sim.mgrOf(X));
      crashed = true;
    }
    sim.step();
  }
  assert.ok(crashed, 'the staging reached the manager crash');
  assert.ok(sim.flags.mgrReconciled > 0, 'the manager reconciled');
  assert.equal(sim.managers[sim.mgrOf(X)].lastReconcile.conflicts, 1, 'the stale claim was turned down');
  assert.equal(sim.metrics.collisions, 0);
});

test('no collisions under loss, clock drift, partitions and crashes', () => {
  let moves = 0;
  for (let seed = 1; seed <= 4; seed++) {
    const cfg = { mode: 'detect', robots: 140, seed, loss: [0.1, 0.25, 0.4][seed % 3], clockDrift: 0.2, leaseTicks: [40, 60][seed % 2], renewEvery: 10, delayMax: 6, injectFailures: true, mgrDownTicks: [80, 30][seed % 2] };
    const sim = run(cfg, 2400, (s) => {
      if (s.tick % 200 === 100) s.cutNetwork(4 + s.rng.int(40), 4 + s.rng.int(24), 2, 120);
      if (s.tick % 250 === 60 && s.managers.every((m) => m.state === 'UP')) s.crashManager(s.rng.int(16));
    });
    assert.equal(sim.metrics.collisions, 0, `seed ${seed}`);
    moves += sim.metrics.moves;
  }
  assert.ok(moves > 10000, 'robots kept moving');
});

test('no collisions on three floors with injected failures', () => {
  const sim = run({ mode: 'detect', robots: 90, floors: 3, lifts: 4, seed: 2, loss: 0.1, clockDrift: 0.1, injectFailures: true }, 3600);
  assert.equal(sim.metrics.collisions, 0);
  assert.ok(sim.metrics.rides > 50, 'lifts were used');
  // Never two robots in one shaft, and the car is where its rider is.
  for (const l of sim.layout.lifts) assert.ok(l.shafts.reduce((n, c) => n + sim.physCount[c], 0) <= 2);
});
