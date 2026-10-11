// Every mode has to work on every building the sliders can ask for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './helpers.js';

const BUILDING = { robots: 90, floors: 3, lifts: 4, seed: 1 };

test('baseline on three floors: robots call the lift themselves, and nothing is "fenced"', () => {
  const sim = run({ ...BUILDING, mode: 'baseline' }, 6000);
  assert.equal(sim.metrics.fenced, 0);
  assert.equal(sim.eventSeq, 0, 'no events are logged for waiting at a lift');
  assert.ok(sim.metrics.rides > 300);
  const perMinute = [0, 0, 0, 0, 0];
  for (const t of sim.taskTicks) perMinute[Math.min(4, Math.floor((t - 1) / 1200))]++;
  assert.ok(perMinute[4] > perMinute[1] / 2, `throughput holds up: ${perMinute}`);
});

test('centralised on three floors: nobody is left waiting at a lift', () => {
  const sim = run({ ...BUILDING, mode: 'central' }, 6000);
  assert.equal(sim.metrics.collisions, 0);
  const stuck = sim.robots.filter((r) => r.alive && r.waiting && sim.tick - r.waitSince > 600);
  assert.equal(stuck.length, 0);
});

test('one floor is unaffected by multi-storey code: same run from the same seed', () => {
  const a = run({ mode: 'detect', robots: 120, seed: 42 }, 1200);
  const b = run({ mode: 'detect', robots: 120, seed: 42, lifts: 8 }, 1200);
  assert.equal(a.rng.state, b.rng.state);
  assert.equal(a.metrics.moves, b.metrics.moves);
});
