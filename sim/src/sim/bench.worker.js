// Runs benchmark jobs headless, off the main thread.
import { Simulation } from './simulation.js';

self.onmessage = (e) => {
  const { jobs } = e.data;
  jobs.forEach((job, i) => {
    const sim = new Simulation(job.cfg);
    for (let t = 0; t < job.ticks; t++) sim.step();
    self.postMessage({ type: 'result', id: job.id, summary: sim.summary(), done: i + 1, total: jobs.length });
  });
  self.postMessage({ type: 'done' });
};
