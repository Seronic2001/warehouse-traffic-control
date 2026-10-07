// Guided tour: introduces one part of the system at a time. Each step
// spotlights one component (everything else fades), flies the camera to a
// live example, and pins annotations onto real objects in the scene.
import { Simulation } from '../sim/simulation.js';
import { STATUS } from '../render/palette.js';
import { theme } from '../render/theme.js';
import { robotStatusKey } from '../render/live.js';
import { cellOf, xOf, yOf, fmtCell, regionOf } from '../sim/layout.js';
import { fmtEpoch } from '../sim/manager.js';

const $ = (id) => document.getElementById(id);
const sw = (hex, label, shape = 'dot') => `<span class="swi"><span class="swc swc-${shape}" style="--c:${hex}"></span>${label}</span>`;
const near = (r, x, y) => Math.abs(xOf(r.cell) - x) + Math.abs(yOf(r.cell) - y);

export class Tour {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.i = 0;
    this.steps = buildSteps();
    $('tour-next').addEventListener('click', () => this.next());
    $('tour-back').addEventListener('click', () => this.back());
    $('tour-skip').addEventListener('click', () => this.end());
    $('btn-tour').addEventListener('click', () => (this.active ? this.end() : this.start()));
    $('tour-dots').innerHTML = this.steps.map(() => '<i></i>').join('');
  }

  // Theme changed: rebuild step text so inline colour keys match.
  refresh() {
    this.steps = buildSteps();
    if (this.active) $('tour-body').innerHTML = this.steps[this.i].body;
  }

  start() {
    const app = this.app;
    if (app.scenario) app.exitScenario(false);
    this.active = true;
    document.body.classList.add('touring');
    $('tour').hidden = false;
    $('btn-tour').classList.add('on');
    this.freeRun(true);
    this.go(0);
  }

  end() {
    if (!this.active) return;
    const app = this.app;
    this.reset();
    this.active = false;
    document.body.classList.remove('touring', 'tour-dash');
    $('tour').hidden = true;
    $('btn-tour').classList.remove('on');
    try {
      localStorage.setItem('wtc-tour-v1', 'done');
    } catch {}
    app.scenario = null;
    app.ctx = null;
    app.restart();
    app.setRunning(true);
    app.setSpeed(1);
    app.flyHome();
  }

  next() {
    if (this.i >= this.steps.length - 1) return this.end();
    this.go(this.i + 1);
  }

  back() {
    if (this.i > 0) this.go(this.i - 1);
  }

  // A fresh free-running warehouse in detection mode, warmed up so traffic is flowing.
  freeRun(force = false) {
    const app = this.app;
    if (!force && !app.scenario && this.ownSim === app.sim) return;
    app.scenario = null;
    app.ctx = null;
    app.attach(new Simulation({ ...app.cfg, mode: 'detect', robots: 120, floors: 1 }));
    for (let i = 0; i < 1200; i++) app.step();
    this.ownSim = app.sim;
  }

  scenario(key, until) {
    const app = this.app;
    app.startScenario(key, { silent: true });
    for (let i = 0; i < 400 && !until(app.sim); i++) app.step();
  }

  reset() {
    const { live } = this.app;
    live.spot = null;
    live.beacons = null;
    live.annotations = [];
    live.showRegions = false;
    live.layers.network = false;
    live.selected = -1;
    live.selectedCell = -1;
    this.app.follow = false;
    this.app.setDim(1);
    document.body.classList.remove('tour-dash');
  }

  go(i) {
    this.reset();
    this.i = i;
    const step = this.steps[i];
    this.app.setRunning(true);
    this.app.setSpeed(1);
    $('tour-step').textContent = `${i + 1} / ${this.steps.length}`;
    $('tour-title').textContent = step.title;
    const body = $('tour-body');
    body.innerHTML = step.body;
    body.classList.remove('fade');
    void body.offsetWidth;
    body.classList.add('fade');
    $('tour-back').disabled = i === 0;
    $('tour-next').textContent = i === this.steps.length - 1 ? 'Start exploring' : 'Next →';
    [...$('tour-dots').children].forEach((d, k) => (d.className = k < i ? 'done' : k === i ? 'on' : ''));
    $('tour-status').textContent = '';
    this.state = {};
    step.enter(this, this.app, this.state);
  }

  update(now) {
    if (!this.active) return;
    const step = this.steps[this.i];
    if (step.update) {
      const status = step.update(this, this.app, this.state, now);
      if (status !== undefined && status !== this.lastStatus) {
        $('tour-status').innerHTML = status;
        this.lastStatus = status;
      }
    }
  }
}

// ───────────────────────────── picking examples ─────────────────────────────

function pickMover(sim) {
  const ok = sim.robots.filter((r) => r.alive && !r.removed && !r.waiting && r.workLeft === 0 && r.path.length > 8);
  ok.sort((a, b) => (b.carrying - a.carrying) * 4 + near(a, 24, 16) * 0.1 - near(b, 24, 16) * 0.1);
  return ok[0] || sim.robots[0];
}

function pickWaiter(sim) {
  const ok = sim.robots.filter((r) => {
    if (!r.alive || !r.waiting || r.waitingFor < 0 || sim.tick - r.waitSince < 12) return false;
    const h = sim.robots[r.waitingFor];
    return h && !h.removed && h.alive && h !== r;
  });
  // Prefer a short visible chain near the middle of the floor.
  ok.sort((a, b) => chainLen(sim, b) - chainLen(sim, a) || near(a, 24, 16) - near(b, 24, 16));
  return ok[0];
}

function chainLen(sim, r) {
  let n = 0;
  const seen = new Set();
  while (r && r.waiting && r.waitingFor >= 0 && !seen.has(r.id) && n < 4) {
    seen.add(r.id);
    r = sim.robots[r.waitingFor];
    n++;
  }
  return n;
}

function statusOf(app, r) {
  const st = robotStatusKey(r, app.sim, app.live.cycleMembers);
  return sw(STATUS[st].hex, STATUS[st].label);
}

// ───────────────────────────── steps ─────────────────────────────

function buildSteps() {
  return [
    {
      title: 'A warehouse with no traffic controller',
      body: `<p>This floor runs <b>120 robots</b>. Each one picks up an order from a shelf and drops it off at a packing station.</p>
        <p>No central computer steers them. Before a robot moves into a grid cell, it has to <b>ask for permission</b>. That permission system is what this project is about: it keeps every robot from colliding, even when robots crash, freeze or deadlock.</p>
        <p class="muted">This tour introduces each part one at a time. Use the arrow keys or the buttons below to move through it.</p>`,
      enter(t, app) {
        t.freeRun();
        app.flyTo(23.5, 15.5, app.fitDistance(), 0.74, -0.12, 1800);
      },
    },
    {
      title: 'The floor',
      body: `<p>The robots drive on a grid of cells:</p>
        <ul class="tour-list">
          <li><b>Shelf racks</b>: where orders are picked up, from the aisle beside them.</li>
          <li><b>Aisles</b> and <b>highways</b>: every lane is <b>one-way</b> (see the chevrons), so robots never meet head-on.</li>
          <li><b>Crossing boxes</b>: where two highways cross. A robot may only enter one if it can also get out.</li>
          <li><b>Packing stations</b>: drive-through bays in the walls, where orders are dropped off.</li>
        </ul>`,
      enter(t, app) {
        t.freeRun();
        app.live.spot = { robots: 'dim', managers: 'dim', overlays: false, keep: new Set() };
        app.flyTo(10, 5, 19, 0.72, -0.3);
        app.live.annotations = [
          { key: 'shelf', cell: cellOf(6, 5), h: 92, html: '<b>Shelf rack</b><small>orders are picked here</small>' },
          { key: 'aisle', cell: cellOf(8, 4), h: 44, html: '<b>Aisle</b><small>one-way</small>' },
          { key: 'hwy', cell: cellOf(12, 4), h: 70, html: '<b>Highway</b><small>two lanes, opposite ways</small>' },
          { key: 'box', cell: cellOf(11, 8), h: 52, html: '<b>Crossing box</b><small>enter only if you can leave</small>' },
          { key: 'station', cell: cellOf(6, 0), h: 60, html: '<b>Packing station</b><small>drop-off bay</small>' },
        ];
      },
    },
    {
      title: '16 regions, 16 owners',
      body: `<p>The floor is cut into a <b>4 × 4 grid of regions</b> of 12 × 8 cells each.</p>
        <p>Each region belongs to its own <b>region manager</b> process, and a manager only knows about the cells in its region. Nobody has a view of the whole floor.</p>
        <p>The highways run exactly along the region borders. That makes the hardest situations happen where regions meet.</p>`,
      enter(t, app) {
        t.freeRun();
        app.live.showRegions = true;
        app.live.spot = { robots: 'dim', managers: 'dim', overlays: false, keep: new Set() };
        app.setDim(0.55);
        app.flyTo(23.5, 15.5, app.fitDistance(0.6), 0.6, -0.05, 1600);
      },
    },
    {
      title: 'Region managers',
      body: `<p>Each glowing hexagon above a region is that region's <b>manager</b>. It keeps a reservation table with one row per cell: owner, epoch, lease expiry, and a queue of robots waiting.</p>
        <p>The dots streaming up and down are <b>network messages</b>. Every message passes through a network layer that can add delay and drop packets:</p>
        <div class="chips">${sw(theme.msg.REQ, 'request a cell')}${sw(theme.msg.GRANT, 'grant')}${sw(theme.msg.RELEASE, 'release')}${sw(theme.msg.RENEW, 'renew')}${sw(theme.msg.QUEUED, 'queued')}</div>`,
      enter(t, app) {
        t.freeRun();
        app.live.spot = { robots: 'normal', managers: 'hi', overlays: false, keep: new Set() };
        app.live.layers.network = true;
        app.setDim(0.45);
        app.flyTo(23.5, 15.5, app.fitDistance(1.0) * 0.82, 1.02, -0.2, 1600);
        const node = app.live.managers[5];
        app.live.annotations = [
          {
            key: 'mgr',
            pos: [node.pos.x, node.pos.y + 0.35, node.pos.z],
            h: 54,
            html: (sim) => `<b>Manager M5</b><small>${sim.managers[5].owned.size} live leases in region 5</small>`,
          },
        ];
      },
    },
    {
      title: 'Robots',
      body: `<p>Each robot is a separate process. It gets an order, plans a route with <b>A*</b> (the dotted line), then drives along it one cell at a time.</p>
        <p>The light ring around its base shows what it is doing:</p>
        <div class="chips">${Object.values(STATUS).map((s) => sw(s.hex, s.short, 'ring')).join('')}</div>
        <p class="muted">A box on top means it is carrying an order. The white light marks its front.</p>`,
      enter(t, app, st) {
        t.freeRun();
        const r = pickMover(app.sim);
        st.robot = r.id;
        t.robot = r.id;
        app.live.selected = r.id;
        app.follow = true;
        app.live.spot = { robots: 'dim', managers: 'dim', overlays: false, keep: new Set([r.id]) };
        app.live.beacons = new Set([r.id]);
        app.setDim(0.6);
        app.setSpeed(0.6);
        const [x, y] = app.sim.posOf(r, app.sim.tick);
        app.flyTo(x, y, 13, 0.7);
        app.live.annotations = [
          {
            key: 'robot',
            robot: r.id,
            h: 64,
            html: (sim) => {
              const rr = sim.robots[r.id];
              return `<b>Robot R${r.id}</b><small>${statusOf(app, rr)}</small><small>${rr.carrying ? 'carrying an order to a station' : 'heading to a shelf to pick an order'}</small>`;
            },
          },
        ];
      },
    },
    {
      title: 'Leases: permission to move',
      body: `<p>Before a robot enters a cell, it must hold a <b>lease</b> on that cell from the region's manager. The bright tile ahead of the robot is that lease.</p>
        <p>The robot holds <i>both</i> the cell it is in and the next one. Because of that, two robots can never end up in the same cell or swap places.</p>
        <p>A lease <b>expires</b> unless the robot renews it, so a dead robot cannot hold cells forever. Every new grant gets a higher <b>epoch</b> number.</p>
        <div class="flow"><span>Free</span><span class="c">Reserved</span><span class="g">Occupied</span><span>Free</span></div>`,
      enter(t, app, st) {
        t.freeRun();
        let r = app.sim.robots[t.robot];
        if (!r || !r.alive || r.removed) r = pickMover(app.sim);
        // Stop at the moment the next cell's lease has been granted but the
        // robot has not started moving into it yet.
        const ready = (x) => !x.motion && [...x.leases.keys()].some((c) => c !== x.cell);
        for (let i = 0; i < 300 && !ready(r); i++) {
          app.step();
          if (i === 150) r = app.sim.robots.find((x) => x.alive && ready(x)) || r;
        }
        app.setRunning(false);
        st.robot = r.id;
        app.live.selected = r.id;
        app.follow = true;
        app.live.spot = { robots: 'dim', managers: 'dim', overlays: false, keep: new Set([r.id]) };
        app.setDim(0.5);
        const [x, y] = app.sim.posOf(r, app.sim.tick);
        app.flyTo(x, y, 10, 0.72);
        app.live.annotations = [
          {
            key: 'lease',
            pos: [0, 0, 0],
            h: 70,
            html: () => null,
          },
          { key: 'own', robot: r.id, h: 40, html: '<b>Its own cell</b><small>also leased</small>', cls: 'al' },
        ];
      },
      update(t, app, st) {
        const sim = app.sim;
        const r = sim.robots[st.robot];
        const ahead = [...r.leases].find(([c]) => c !== r.cell);
        const a = app.live.annotations.find((x) => x.key === 'lease');
        if (!a) return;
        if (ahead) {
          const [cell, l] = ahead;
          delete a.pos;
          a.cell = cell;
          a.html = `<b>Lease on ${fmtCell(cell)}</b><small>epoch ${fmtEpoch(l.epoch)} · from manager M${regionOf(cell)}</small><small>expires in ${(((l.expiry - sim.tick) * sim.cfg.tickMs) / 1000).toFixed(1)} s unless renewed</small>`;
        } else {
          a.html = () => null;
        }
        return '<span class="pill">⏸ Paused: lease granted, robot about to move</span>';
      },
    },
    {
      title: 'Wait-for arrows',
      body: `<p>If the next cell is already taken, the manager <b>queues</b> the request and tells the robot who holds the cell.</p>
        <p>That creates a <b>wait-for edge</b>, drawn as an ${sw(theme.arcs.wait[0], 'amber arrow', 'line')}. The arrow points <b>from the waiting robot to the robot it is waiting for</b>.</p>
        <p>A queue behind a busy robot forms a chain of arrows. That is normal traffic and resolves on its own as the front robot moves.</p>`,
      enter(t, app, st) {
        t.freeRun();
        let w = pickWaiter(app.sim);
        for (let i = 0; i < 600 && !w; i++) {
          app.step();
          if (i % 20 === 0) w = pickWaiter(app.sim);
        }
        app.setRunning(false);
        if (!w) return;
        const chain = [w.id];
        let cur = w;
        while (cur.waiting && cur.waitingFor >= 0 && chain.length < 5 && !chain.includes(cur.waitingFor)) {
          chain.push(cur.waitingFor);
          cur = app.sim.robots[cur.waitingFor];
        }
        st.chain = chain;
        app.live.spot = { robots: 'dim', managers: 'dim', overlays: false, keep: new Set(chain) };
        app.setDim(0.5);
        const [x, y] = app.sim.posOf(w, app.sim.tick);
        app.flyTo(x, y, 11, 0.75);
        const h = app.sim.robots[chain[1]];
        app.live.annotations = [
          { key: 'w', robot: w.id, h: 58, html: `<b>R${w.id} is waiting</b><small>for cell ${fmtCell(w.waitCell)}</small>` },
          { key: 'h', robot: h.id, h: 96, html: `<b>R${h.id} holds that cell</b><small>${h.waiting ? `and is itself waiting for R${h.waitingFor}` : 'R' + w.id + ' moves once it leaves'}</small>` },
        ];
      },
      update() {
        return '<span class="pill">⏸ Simulation paused so you can look</span>';
      },
    },
    {
      title: 'Deadlock: a cycle of waits',
      body: `<p>Here four robots meet at a crossing. Each one holds its own cell and asks for the next cell counter-clockwise.</p>
        <p>R0 waits for R1, R1 for R2, R2 for R3, and R3 for R0. The arrows form a <b>cycle</b>, so none of them can ever move. That is a <b>deadlock</b>.</p>
        <p>Each of the four cells is in a <b>different region</b>. Every manager sees only one of them, so <b>no manager can see the cycle</b>.</p>`,
      enter(t, app) {
        setupDeadlock(t, app);
        app.setRunning(false);
        app.live.showRegions = { soft: true, only: [5, 6, 9, 10] };
        app.live.annotations = [0, 1, 2, 3].map((id, k) => ({
          key: 'd' + id,
          robot: id,
          h: [96, 96, 26, 26][k],
          cls: k === 0 || k === 3 ? 'ar' : 'al',
          html: (sim) => {
            const r = sim.robots[id];
            return r.waitingFor >= 0 ? `<b>R${id} → R${r.waitingFor}</b><small>region ${regionOf(r.cell)}</small>` : `<b>R${id}</b>`;
          },
        }));
      },
      update() {
        return '<span class="pill">⏸ Paused just after the cycle formed</span>';
      },
    },
    {
      title: 'Finding the cycle with probes',
      body: `<p>Detection uses <b>Chandy–Misra–Haas edge-chasing</b>. A robot that has waited too long sends a ${sw(theme.probe.tail[0], 'probe', 'dot')} along its wait-for arrow, and each waiting robot passes it on to the robot <i>it</i> is waiting for.</p>
        <p>If the probe gets back to the robot that sent it, the cycle is proven and the arrows turn ${sw(theme.arcs.cycle[0], 'red', 'line')}.</p>
        <p>The lowest-priority robot then ${sw(STATUS.yield.hex, 'yields', 'ring')}: it drops its request and plans a different route, which breaks the cycle.</p>`,
      enter(t, app, st) {
        setupDeadlock(t, app);
        app.setSpeed(0.3);
        st.start = app.sim.tick;
      },
      update(t, app) {
        const f = app.sim.flags;
        if (f.yielded !== undefined) return '<span class="pill ok">✓ R3 yielded and the cycle is broken. Traffic flows again.</span>';
        if (f.deadlock !== undefined) return '<span class="pill bad">● Probe returned: cycle detected</span>';
        if (app.sim.net.flights.some((x) => x.msg.type === 'PROBE')) return '<span class="pill">● Probe in flight…</span>';
        return '<span class="pill">Watching (slow motion)…</span>';
      },
    },
    {
      title: 'A robot crashes',
      body: `<p>When a robot crashes, its leases are not taken away. They <b>expire</b>.</p>
        <p>A cell it had reserved but not entered goes to the next robot in line, with a <b>new epoch</b>.</p>
        <p>The cell it is sitting in is different. Ownership is only a record in the manager's table, but the robot is physically there. That cell becomes ${sw(STATUS.wait.hex, 'Blocked', 'stripe')} and stays out of service until a maintenance crew removes the robot and sends an explicit <b>Cleared</b> event.</p>`,
      enter(t, app) {
        t.scenario('crash', (sim) => sim.flags.blocked !== undefined);
        app.setSpeed(0.6);
        app.live.spot = { robots: 'dim', managers: 'dim', overlays: false, keep: new Set([0, 1, 2]) };
        app.setDim(0.55);
        app.flyTo(30.5, 23, 11, 0.72, -0.3);
        app.live.annotations = [
          { key: 'dead', robot: 0, h: 84, html: '<b>R0 crashed</b><small>but it is still physically here</small>' },
          {
            key: 'blk',
            cell: cellOf(31, 23),
            h: 40,
            cls: 'ar',
            html: (sim) => (sim.managers[regionOf(cellOf(31, 23))].blocked.has(cellOf(31, 23)) ? '<b>Blocked</b><small>lease expired with the robot inside</small>' : '<b>Cleared</b><small>crew removed the robot</small>'),
          },
          { key: 'rg', cell: cellOf(30, 23), h: 60, cls: 'al', html: (sim) => `<b>Re-granted to R1</b><small>epoch ${sim.managers[regionOf(cellOf(30, 23))].entry(cellOf(30, 23)).epoch}</small>` },
        ];
      },
      update(t, app) {
        const f = app.sim.flags;
        if (f.cleared !== undefined) return '<span class="pill ok">✓ Cleared: the cell is back in service</span>';
        return '<span class="pill">Crew on the way…</span>';
      },
    },
    {
      title: 'A robot freezes: fencing',
      body: `<p>This one is harder to catch. R0 checked its lease, then <b>froze</b> (think of a long GC pause) for longer than the lease lasts.</p>
        <p>While it was frozen, the lease expired and R1 got the cell with <b>epoch 2</b>. When R0 wakes up, it still believes it owns the cell with epoch 1, and it drives in.</p>
        <p>The world checks the epoch on every move, so R0's <b>stale epoch is rejected</b>. That check is <b>fencing</b>. Without it, this would be a collision.</p>`,
      enter(t, app) {
        t.scenario('pause', (sim) => sim.flags.regrant !== undefined && sim.tick > (sim.flags.regrant ?? 0) + 18);
        app.setSpeed(0.4);
        app.live.spot = { robots: 'dim', managers: 'dim', overlays: false, keep: new Set([0, 1]) };
        app.setDim(0.55);
        app.flyTo(30.5, 23, 10, 0.72, -0.3);
        app.live.annotations = [
          {
            key: 'p0',
            robot: 0,
            h: 70,
            cls: 'ar',
            html: (sim) => {
              const r = sim.robots[0];
              if (r.paused) return `<b>R0 is frozen</b><small>thinks it still owns ${fmtCell(cellOf(30, 23))} with epoch 1</small>`;
              if (sim.flags.fenced !== undefined) return `<b>R0's move was rejected</b><small>stale epoch 1, so it resyncs</small>`;
              return '<b>R0</b>';
            },
          },
          { key: 'p1', robot: 1, h: 44, cls: 'al', html: '<b>R1 owns the cell now</b><small>epoch 2</small>' },
        ];
      },
      update(t, app) {
        const sim = app.sim;
        const r = sim.robots[0];
        if (sim.flags.fenced !== undefined) return '<span class="pill ok">✓ Fenced: the stale move was rejected and nobody collided</span>';
        if (r.paused) return `<span class="pill">R0 wakes up in ${(((r.pauseUntil - sim.tick) * sim.cfg.tickMs) / 1000).toFixed(1)} s…</span>`;
        return '';
      },
    },
    {
      title: 'A region manager crashes',
      body: `<p>Managers can fail too. When <b>M5</b> crashes, its whole reservation table is gone, and robots in region 5 can't get or renew leases. As each lease runs low, the robot <b>stops</b> rather than move without permission.</p>
        <p>M5 restarts with a new <b>incarnation number</b>, the one thing it keeps on disk. It asks every robot what it holds and <b>refuses all grants</b> until it has rebuilt its table from their reports.</p>
        <p>Every epoch it issues afterwards is stamped with the new incarnation, so it is higher than anything issued before the crash. A stale lease can never pass fencing.</p>`,
      enter(t, app) {
        t.scenario('manager', (sim) => sim.tick >= 100);
        app.setSpeed(0.7);
        app.flyTo(17.5, 11.5, 22, 0.8, -0.2);
        const node = app.live.managers[5];
        app.live.annotations = [
          {
            key: 'm5',
            pos: [node.pos.x, node.pos.y + 0.35, node.pos.z],
            h: 46,
            html: (sim) => {
              const m = sim.managers[5];
              if (m.state === 'DOWN') return '<b>M5 is down</b><small>its table is lost; region 5 cannot get grants</small>';
              if (m.state === 'RECONCILING') return `<b>M5 is reconciling</b><small>${m.reports.size} robot reports so far · incarnation ${m.gen}</small>`;
              if (m.lastReconcile) return `<b>M5 is back</b><small>${m.lastReconcile.restored} leases restored · incarnation ${m.gen}</small>`;
              return '<b>Manager M5</b><small>region 5, running normally</small>';
            },
          },
        ];
      },
      update(t, app) {
        const f = app.sim.flags;
        if (f.mgrReconciled !== undefined) return '<span class="pill ok">✓ Reconciled: grants resumed with no duplicate owners</span>';
        if (f.mgrRestart !== undefined) return '<span class="pill">● Restarted: collecting robot reports…</span>';
        if (f.mgrDown !== undefined) {
          const left = (app.sim.managers[5].downTick + app.sim.cfg.mgrDownTicks - app.sim.tick) * app.sim.cfg.tickMs / 1000;
          return `<span class="pill bad">● M5 down: restarts in ${Math.max(0, left).toFixed(1)} s</span>`;
        }
        return '<span class="pill">Watching region 5…</span>';
      },
    },
    {
      title: 'Your dashboard',
      body: `<p><b>Top right:</b> <b>protected collisions</b>, the one number that must always be 0. Below it are throughput, deadlocks, messages per move, fenced moves and an event log.</p>
        <p><b>Bottom:</b> replay any of the five failure stories, rewind the run with the <b>scrubber</b> (<b>[</b> and <b>]</b> jump 5 s), or run the <b>benchmark</b>: strategies against density, the lease safety margin, and recovery times after failures.</p>
        <p><b>Top:</b> switch to <b>Baseline</b> to watch robots without leases collide. Click any robot to inspect it, then press <b>M</b> for its message timeline.</p>`,
      enter(t, app) {
        t.freeRun(true);
        document.body.classList.add('tour-dash');
        app.flyTo(23.5, 15.5, app.fitDistance(), 0.74, -0.12, 1600);
      },
    },
  ];
}

function setupDeadlock(t, app) {
  t.scenario('deadlock', (sim) => sim.robots.slice(0, 4).every((r) => r.waitingFor >= 0 && sim.tick - r.waitSince >= 12));
  app.live.spot = { robots: 'dim', managers: 'dim', overlays: false, keep: new Set([0, 1, 2, 3]) };
  app.setDim(0.5);
  app.flyTo(23.5, 15.5, 12, 0.72, -0.2);
}
