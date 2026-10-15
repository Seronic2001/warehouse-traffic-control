// The deadlock strategies of lease + detection mode: each one keeps robots
// safe, breaks the scripted four-robot cycle, and replays exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/sim/simulation.js';
import { History } from '../src/sim/history.js';
import { SCENARIOS } from '../src/sim/scenarios.js';
import { run, signature } from './helpers.js';

const STRATEGIES = ['cmh', 'mm', 'waitdie', 'timeout', 'whca'];

for (const deadlock of STRATEGIES) {
  test(`${deadlock}: the four-robot cycle is broken`, () => {
    const sc = SCENARIOS.deadlock;
    const { maxBackground, ...cfg } = sc.cfg;
    const sim = new Simulation({ ...cfg, deadlock, robots: 4 }, sc);
    for (let t = 0; t < 600; t++) sim.step();
    assert.equal(sim.metrics.collisions, 0);
    assert.ok(sim.metrics.yields > 0, 'someone gave way');
    assert.equal(sim.inCycle.size, 0, 'no cycle left standing');
  });

  test(`${deadlock}: no collisions under loss, drift and crashes`, () => {
    const sim = run({ mode: 'detect', deadlock, robots: 120, seed: 3, loss: 0.15, clockDrift: 0.1, delayMax: 5, injectFailures: true }, 2400, (s) => {
      if (s.tick % 400 === 200) s.cutNetwork(4 + s.rng.int(40), 4 + s.rng.int(24), 2, 120);
    });
    assert.equal(sim.metrics.collisions, 0);
    assert.ok(sim.metrics.moves > 5000, 'robots kept moving');
  });
}

test('detectors find the scripted cycle; the others never detect anything', () => {
  for (const deadlock of STRATEGIES) {
    const sc = SCENARIOS.deadlock;
    const { maxBackground, ...cfg } = sc.cfg;
    const sim = new Simulation({ ...cfg, deadlock, robots: 4 }, sc);
    for (let t = 0; t < 600; t++) sim.step();
    if (deadlock === 'waitdie' || deadlock === 'timeout') assert.equal(sim.metrics.detections, 0, deadlock);
    else assert.ok(sim.metrics.deadlocks > 0, deadlock);
  }
});

test('Mitchell–Merritt: one detection per cycle, not one per member', () => {
  const sc = SCENARIOS.deadlock;
  const { maxBackground, ...cfg } = sc.cfg;
  const sim = new Simulation({ ...cfg, deadlock: 'mm', robots: 4 }, sc);
  while (!sim.metrics.detections && sim.tick < 600) sim.step();
  for (let t = 0; t < 40; t++) sim.step();
  assert.equal(sim.metrics.detections, 1);
});

test('Wait-Die: no real cycle outlives the messages that break it', () => {
  const sim = run({ mode: 'detect', deadlock: 'waitdie', robots: 120, seed: 4 }, 3000);
  assert.ok(sim.metrics.longestCycle <= 20, `longest ${sim.metrics.longestCycle} ticks`);
  assert.equal(sim.metrics.detections, 0);
});

for (const deadlock of ['mm', 'waitdie', 'whca']) {
  test(`${deadlock}: rewinding replays the same run`, () => {
    const cfg = { deadlock, robots: 120, seed: 6 };
    const straight = new Simulation(cfg);
    while (straight.tick < 1000) {
      if (straight.tick === 300) straight.crashRobot(5);
      straight.step();
    }
    let sim = new Simulation(cfg);
    const history = new History(sim);
    while (sim.tick < 800) {
      if (sim.tick === 300) history.act(sim, 'crashRobot', [5]);
      history.step(sim);
    }
    sim = history.seek(420);
    while (sim.tick < 1000) history.step(sim);
    assert.equal(signature(sim), signature(straight));
  });
}
