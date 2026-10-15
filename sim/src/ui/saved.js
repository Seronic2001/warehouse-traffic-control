// "Saved results" tab of the Benchmark window: every run of the other two
// tabs, computed ahead of time (`npm run precompute`, default settings) into
// src/data/precomputed.csv, and drawn with the very same charts. For
// presenting without waiting minutes. The CSV is a separate chunk, loaded the
// first time the tab opens.
import { Bench } from './bench.js';
import { Compare } from './compare.js';
import { fromCsv } from '../sim/csv.js';

const $ = (id) => document.getElementById(id);

export class Saved {
  constructor(app, bench) {
    this.app = app;
    this.data = null;
    // Renderers that draw into this tab instead of the live ones.
    this.bench = Object.assign(Object.create(Bench.prototype), { app, results: new Map(), el: { grid: $('saved-grid'), table: $('saved-table') } });
    this.compare = Object.assign(Object.create(Compare.prototype), { app, results: new Map(), el: { grid: $('saved-cmp-grid') } });
    const prev = bench.onTab;
    bench.onTab = (name) => {
      prev?.(name);
      if (name === 'saved') this.load();
    };
    $('saved-table-btn').addEventListener('click', () => {
      const t = $('saved-table');
      t.hidden = !t.hidden;
      $('saved-table-btn').textContent = t.hidden ? 'Table' : 'Charts';
      $('saved-grid').hidden = !t.hidden;
    });
    for (const b of document.querySelectorAll('.saved-jump button')) {
      b.addEventListener('click', () => {
        const id = b.dataset.jump;
        // The deadlock section is a heading inside the strategies grid.
        const el = id === 'saved-dl' ? [...$('saved-grid').querySelectorAll('.bench-section h3')].find((h) => h.textContent.startsWith('Deadlock'))?.parentElement : $(id);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  async load() {
    if (this.data || this.loading) return;
    this.loading = true;
    try {
      const rows = fromCsv((await import('../data/precomputed.csv?raw')).default);
      this.data = { runs: rows.length, seed: rows[0]?.seed, generated: rows[0]?.generated, bench: {}, compare: {} };
      for (const { tab, id, generated, seed, ...summary } of rows) this.data[tab][id] = summary;
    } catch {
      $('saved-grid').innerHTML = '<div class="bench-empty">No saved results in this build. Run <code>npm run precompute</code> in <code>sim/</code>, then rebuild.</div>';
      this.loading = false;
      return;
    }
    const d = this.data;
    $('saved-meta').innerHTML = `<b>${d.runs} runs</b> of 30 simulated minutes each, seed ${d.seed}, computed ${d.generated}.`;
    this.bench.results = new Map(Object.entries(d.bench));
    this.compare.results = new Map(Object.entries(d.compare));
    this.refresh();
  }

  refresh() {
    if (!this.data) return;
    // Legends: copy the live tabs', which never change.
    $('saved-legend').innerHTML = $('bench-legend').innerHTML;
    $('saved-cmp-legend').innerHTML = $('cmp-legend').innerHTML;
    this.bench.draw();
    this.compare.draw();
  }
}
