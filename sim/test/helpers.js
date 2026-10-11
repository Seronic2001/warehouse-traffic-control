import { Simulation } from '../src/sim/simulation.js';

export function run(cfg, ticks, eachTick) {
  const sim = new Simulation(cfg);
  for (let t = 0; t < ticks; t++) {
    eachTick?.(sim);
    sim.step();
  }
  return sim;
}

// Everything that has to match for two runs to count as the same run.
export const signature = (sim) =>
  JSON.stringify([sim.tick, sim.rng.state, sim.metrics, sim.robots.map((r) => [r.cell, r.state, r.alive, [...r.leases]])]);
