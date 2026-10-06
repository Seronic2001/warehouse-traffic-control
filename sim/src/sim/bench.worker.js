// Runs one benchmark job at a time, headless, off the main thread. The page
// keeps a pool of these workers and hands each a new job when it finishes.
import { Simulation } from './simulation.js';

self.onmessage = (e) => {
  const { job } = e.data;
  const sim = new Simulation(job.cfg);
  for (let t = 0; t < job.ticks; t++) sim.step();
  self.postMessage({ type: 'result', id: job.id, summary: sim.summary() });
};
