// Replay: a rewound run ends in exactly the same state as an uninterrupted
// one, including after user actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/sim/simulation.js';
import { History } from '../src/sim/history.js';
import { signature } from './helpers.js';

const ACTIONS = [
  [300, 'crashRobot', [5]],
  [450, 'cutNetwork', [20, 15, 2, 160, 0]],
  [700, 'crashManager', [5]],
  [900, 'pauseRobot', [9, 96]],
];

for (const cfg of [{ robots: 120, seed: 7 }, { robots: 90, floors: 3, lifts: 4, seed: 3 }, { mode: 'central', robots: 100, seed: 5 }]) {
  test(`rewinding replays the same run: ${JSON.stringify(cfg)}`, () => {
    const straight = new Simulation(cfg);
    while (straight.tick < 1500) {
      for (const [tick, name, args] of ACTIONS) if (straight.tick === tick) straight[name](...args);
      straight.step();
    }

    let sim = new Simulation(cfg);
    const history = new History(sim);
    while (sim.tick < 1100) {
      for (const [tick, name, args] of ACTIONS) if (sim.tick === tick) history.act(sim, name, args);
      history.step(sim);
    }
    sim = history.seek(520);
    assert.equal(sim.tick, 520);
    while (sim.tick < 1500) history.step(sim);
    assert.equal(signature(sim), signature(straight));
  });
}

test('acting after a rewind starts a new branch', () => {
  let sim = new Simulation({ robots: 80, seed: 9 });
  const history = new History(sim);
  while (sim.tick < 600) history.step(sim);
  sim = history.seek(300);
  history.act(sim, 'crashRobot', [3]);
  assert.equal(history.head, 300);
  while (sim.tick < 600) history.step(sim);

  const straight = new Simulation({ robots: 80, seed: 9 });
  while (straight.tick < 600) {
    if (straight.tick === 300) straight.crashRobot(3);
    straight.step();
  }
  assert.equal(signature(sim), signature(straight));
});
