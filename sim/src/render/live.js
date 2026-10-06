// Everything that moves: robots, lease tiles, Blocked cells, the wait-for
// graph, probes in flight, network messages, bursts and floating callouts.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { xOf, yOf, regionOf, fmtCell } from '../sim/layout.js';
import { wx, wz, MANAGER_Y } from './warehouse.js';
import { theme } from './theme.js';

const C = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
const CK = ([hex, k]) => C(hex, k);

// Colour tables, rebuilt from the active theme by refreshPalette().
const BAND = {};
const BODY = {};
const MSG_COLORS = {};
const P = {};

function refreshPalette() {
  for (const [k, v] of Object.entries(theme.band)) BAND[k] = CK(v);
  BODY.ok = new THREE.Color(theme.robot.body);
  BODY.dead = new THREE.Color(theme.robot.dead);
  BODY.paused = new THREE.Color(theme.robot.paused);
  for (const [k, v] of Object.entries(theme.msg)) if (k !== 'k' && k !== 'lost') MSG_COLORS[k] = C(v, theme.msg.k);
  P.msgLost = C(theme.msg.lost, theme.msg.k);
  P.tile = Object.fromEntries(['moving', 'waiting', 'selected', 'keep', 'own'].map((k) => [k, CK(theme.tile[k])]));
  P.waitArc = CK(theme.arcs.wait);
  P.cycleArc = CK(theme.arcs.cycle);
  P.probeHead = CK(theme.probe.head);
  P.probeTail = CK(theme.probe.tail);
  P.burst = Object.fromEntries(Object.entries(theme.burst).filter(([k]) => k !== 'k').map(([k, v]) => [k, C(v, theme.burst.k)]));
  P.beacon = new THREE.Color(theme.beacon);
  P.bg = new THREE.Color(theme.scene.bg);
  P.dimBody = new THREE.Color(theme.robot.dimBody);
  P.dimBand = new THREE.Color(theme.robot.dimBand);
}
refreshPalette();

const MAX_TILES = 1200;
const MAX_ARCS = 900;
const MAX_PROBES = 400;
const MAX_MSGS = 900;
const ARC_SEG = 10;

export class LiveView {
  constructor(scene, managers, resolution) {
    this.scene = scene;
    this.managers = managers;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.layers = { reservations: true, waits: true, network: false, managers: true, labels: true };
    this.selected = -1;
    this.selectedCell = -1;
    this.focusRobots = new Set();
    this.lastSeq = 0;
    this.callouts = [];
    this.bursts = [];
    this.seenBursts = new WeakSet();
    this.labels = new Map();
    // Guided-tour controls: spotlight (dim everything but `keep`), pulsing
    // beacons, pinned annotations and the region overlay.
    this.spot = null; // { robots: 'dim'|'normal', managers: 'dim'|'hi'|'normal', overlays: bool, keep: Set }
    this.beacons = null; // Set of robot ids, or 'all'
    this.annotations = []; // { key, html, robot?, cell?, pos?, h? }
    this.showRegions = false;
    this.toteScale = new THREE.Vector3();
    this.white = new THREE.Color(1, 1, 1);
    this.tmp = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3(), e: new THREE.Euler() };

    this.buildTiles();
    this.buildArcs(resolution);
    this.buildFx();
    this.buildTourFx();
    this.applyTheme();
  }

  // Re-read every colour from the active theme.
  applyTheme() {
    refreshPalette();
    const blending = theme.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    const tileMat = this.tileMesh.material;
    tileMat.map?.dispose();
    tileMat.map = softSquareTexture();
    tileMat.opacity = theme.tile.opacity;
    tileMat.blending = blending;
    tileMat.needsUpdate = true;
    this.blockMat.map?.dispose();
    this.blockMat.map = stripeTexture();
    this.blockMat.needsUpdate = true;
    this.cordonMat.color.copy(CK(theme.cordon));
    this.selRing.material.color.copy(CK(theme.marker));
    this.cellCursor.material.color.copy(CK(theme.marker));
    this.pathDots.material.color.copy(CK(theme.pathDot));
    this.waitArcs.mat.linewidth = theme.arcs.waitWidth;
    for (const b of this.burstPool) {
      b.material.blending = blending;
      b.material.needsUpdate = true;
    }
    this.beaconMesh.material.blending = blending;
    this.beaconMesh.material.needsUpdate = true;
    const R = theme.regions;
    let i = 0;
    for (const c of this.regionGroup.children) {
      const tint = R.tints[((i >> 1) % 4 + ((i >> 1) / 4 | 0)) % 2];
      if (c.isMesh) {
        c.material.color.copy(C(tint, R.k));
        c.material.blending = blending;
        c.material.needsUpdate = true;
      } else c.material.color.copy(C(tint, R.edgeK));
      i++;
    }
    if (this.rm) {
      this.rm.skirt.material.color.setHex(theme.robot.skirt);
      this.rm.disc.material.color.setHex(theme.robot.disc);
      this.rm.eye.material.color.copy(CK(theme.robot.eye));
    }
  }

  buildTourFx() {
    this.beaconMesh = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.55, 0.66, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }),
      260,
    );
    this.beaconMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.beaconMesh.count = 0;
    this.beaconMesh.frustumCulled = false;
    this.group.add(this.beaconMesh);

    // One tinted plane per region, checkerboarded, for the "regions" step.
    this.regionGroup = new THREE.Group();
    const tints = theme.regions.tints;
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const mat = new THREE.MeshBasicMaterial({ color: C(tints[(i + j) % 2]), transparent: true, opacity: 0.16, depthWrite: false });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(12 - 0.25, 8 - 0.25).rotateX(-Math.PI / 2), mat);
        mesh.position.set(wx(i * 12 + 5.5), 1.12, wz(j * 8 + 3.5));
        this.regionGroup.add(mesh);
        const edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.PlaneGeometry(12 - 0.25, 8 - 0.25).rotateX(-Math.PI / 2)),
          new THREE.LineBasicMaterial({ color: C(tints[(i + j) % 2]) }),
        );
        edge.position.copy(mesh.position);
        this.regionGroup.add(edge);
      }
    this.regionGroup.visible = false;
    this.group.add(this.regionGroup);

    // Alert overlay for a region whose manager is down or reconciling.
    this.alertPlanes = [];
    for (let id = 0; id < 16; id++) {
      const i = id % 4, j = (id / 4) | 0;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(12 - 0.2, 8 - 0.2).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.15, depthWrite: false }),
      );
      mesh.position.set(wx(i * 12 + 5.5), 0.03, wz(j * 8 + 3.5));
      mesh.renderOrder = 1;
      mesh.visible = false;
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(12 - 0.2, 8 - 0.2).rotateX(-Math.PI / 2)), new THREE.LineBasicMaterial({ transparent: true }));
      edge.position.y = 0.01;
      mesh.add(edge);
      this.group.add(mesh);
      this.alertPlanes.push(mesh);
    }
  }

  kept(id) {
    return !this.spot || this.spot.robots !== 'dim' || (this.spot.keep && this.spot.keep.has(id));
  }

  overlayOn(id) {
    return !this.spot || this.spot.overlays !== false || (this.spot.keep && this.spot.keep.has(id));
  }

  // ───────────────────────────── construction ─────────────────────────────

  setSim(sim) {
    this.sim = sim;
    this.lastSeq = 0;
    for (const c of this.callouts) c.obj.removeFromParent();
    this.callouts = [];
    for (const b of this.bursts) b.mesh.visible = false;
    this.bursts = [];
    this.selected = -1;
    this.selectedCell = -1;
    this.buildRobots(sim.robots.length);
  }

  buildRobots(n) {
    if (this.robotMeshes) for (const m of this.robotMeshes) (m.removeFromParent(), m.dispose());
    const mk = (geo, mat, shadow = true) => {
      const m = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = shadow;
      m.receiveShadow = shadow;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    const skirt = mk(new RoundedBoxGeometry(0.72, 0.1, 0.72, 2, 0.04), new THREE.MeshStandardMaterial({ color: theme.robot.skirt, roughness: 0.6, metalness: 0.3 }));
    const body = mk(new RoundedBoxGeometry(0.7, 0.2, 0.7, 3, 0.07), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.15 }));
    const band = mk(new RoundedBoxGeometry(0.74, 0.04, 0.74, 2, 0.06), new THREE.MeshBasicMaterial({ color: 0xffffff }), false);
    const disc = mk(new THREE.CylinderGeometry(0.22, 0.24, 0.04, 32), new THREE.MeshStandardMaterial({ color: theme.robot.disc, roughness: 0.3, metalness: 0.6 }));
    const eye = mk(new THREE.BoxGeometry(0.28, 0.045, 0.02), new THREE.MeshBasicMaterial({ color: CK(theme.robot.eye) }), false);
    const tote = mk(new RoundedBoxGeometry(0.5, 0.3, 0.5, 2, 0.035), new THREE.MeshStandardMaterial({ color: 0xc08a4e, roughness: 0.85 }));
    for (let i = 0; i < n; i++) {
      body.setColorAt(i, BODY.ok);
      band.setColorAt(i, BAND.moving);
      tote.setColorAt(i, new THREE.Color(1, 1, 1));
      eye.setColorAt(i, new THREE.Color(1, 1, 1));
    }
    this.robotMeshes = [skirt, body, band, disc, eye, tote];
    this.rm = { skirt, body, band, disc, eye, tote };
    body.name = 'robots';
    this.headings = new Float32Array(n);
    this.positions = new Float32Array(n * 2);
  }

  buildTiles() {
    const tex = softSquareTexture();
    this.tileMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.92, 0.92).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.75, depthWrite: false }),
      MAX_TILES,
    );
    this.tileMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.tileMesh.count = 0;
    this.tileMesh.frustumCulled = false;
    this.tileMesh.renderOrder = 1;
    this.group.add(this.tileMesh);

    this.blockMat = new THREE.MeshBasicMaterial({ map: stripeTexture(), transparent: true, depthWrite: false, opacity: 0.9 });
    this.blockMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.96, 0.96).rotateX(-Math.PI / 2), this.blockMat, 128);
    this.blockMesh.count = 0;
    this.blockMesh.frustumCulled = false;
    this.blockMesh.renderOrder = 2;
    this.group.add(this.blockMesh);

    // Cordon posts around Blocked cells.
    const frameGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.94, 0.5, 0.94));
    this.cordonGeo = frameGeo;
    this.cordonMat = new THREE.LineBasicMaterial({ color: C('#d97706'), transparent: true, opacity: 0.95 });
    this.cordons = [];

    this.selRing = new THREE.Mesh(
      new THREE.RingGeometry(0.52, 0.6, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: C('#0f172a'), transparent: true, depthWrite: false }),
    );
    this.selRing.visible = false;
    this.group.add(this.selRing);

    this.cellCursor = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.68, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: C('#0f172a'), transparent: true, depthWrite: false }),
    );
    this.cellCursor.visible = false;
    this.group.add(this.cellCursor);

    this.pathDots = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.07, 16).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: C('#0891b2'), transparent: true, depthWrite: false }),
      160,
    );
    this.pathDots.count = 0;
    this.pathDots.frustumCulled = false;
    this.group.add(this.pathDots);
  }

  buildArcs(resolution) {
    const mk = (width, opacity) => {
      const mat = new LineMaterial({ linewidth: width, vertexColors: true, transparent: true, opacity, depthWrite: false, worldUnits: false });
      mat.resolution.copy(resolution);
      const geo = new LineSegmentsGeometry();
      const line = new LineSegments2(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 3;
      this.group.add(line);
      return { line, mat, pos: new Float32Array(MAX_ARCS * ARC_SEG * 6), col: new Float32Array(MAX_ARCS * ARC_SEG * 6) };
    };
    this.waitArcs = mk(3, 0.95);
    this.cycleArcs = mk(4.5, 1);
    this.msgArcs = null;

    this.heads = new THREE.InstancedMesh(new THREE.ConeGeometry(0.09, 0.24, 12).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_ARCS);
    this.heads.setColorAt(0, new THREE.Color(1, 1, 1));
    this.heads.count = 0;
    this.heads.frustumCulled = false;
    this.group.add(this.heads);
  }

  buildFx() {
    this.probeMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PROBES);
    this.probeMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.probeMesh.count = 0;
    this.probeMesh.frustumCulled = false;
    this.group.add(this.probeMesh);

    this.msgMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_MSGS);
    this.msgMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.msgMesh.count = 0;
    this.msgMesh.frustumCulled = false;
    this.group.add(this.msgMesh);

    const ringGeo = new THREE.RingGeometry(0.42, 0.5, 64).rotateX(-Math.PI / 2);
    this.burstPool = [];
    for (let i = 0; i < 48; i++) {
      const mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
      mesh.visible = false;
      this.group.add(mesh);
      this.burstPool.push(mesh);
    }
  }

  setResolution(res) {
    this.waitArcs.mat.resolution.copy(res);
    this.cycleArcs.mat.resolution.copy(res);
  }

  // ───────────────────────────── per frame ─────────────────────────────

  robotPos(id) {
    return [this.positions[id * 2], this.positions[id * 2 + 1]];
  }

  update(t, now, dt) {
    const sim = this.sim;
    if (!sim) return;
    this.now = now;
    this.cycleMembers = new Map();
    for (const cy of sim.cycles) for (const id of cy.robots) this.cycleMembers.set(id, cy);

    this.updateRobots(t, now, dt);
    this.updateTiles(t, now);
    this.updateArcs(t, now);
    this.updateMessages(t, now);
    this.updateBursts(now);
    this.updateManagers(now);
    this.updateEvents(now);
    this.updateBeacons(now);
    this.updateLabels(t, now);
  }

  updateBeacons(now) {
    const sim = this.sim;
    const { m, q, s, p } = this.tmp;
    this.regionGroup.visible = !!this.showRegions;
    const soft = this.showRegions && this.showRegions.soft;
    this.regionGroup.children.forEach((c) => {
      if (c.isMesh) c.material.opacity = soft ? theme.regions.softOpacity : theme.regions.opacity;
    });
    let n = 0;
    if (this.beacons) {
      const ids = this.beacons === 'all' ? sim.robots.map((r) => r.id) : [...this.beacons];
      const k = (now % 1600) / 1600;
      const sc = 0.75 + k * 0.6;
      const col = theme.additive ? P.beacon.clone().multiplyScalar(1.8 * (1 - k)) : P.beacon.clone().lerp(P.bg, k);
      for (const id of ids) {
        const r = sim.robots[id];
        if (!r || r.removed || n >= 260) continue;
        const [x, y] = this.robotPos(id);
        m.compose(p.set(wx(x), 0.03, wz(y)), q.identity(), s.set(sc, 1, sc));
        this.beaconMesh.setMatrixAt(n, m);
        this.beaconMesh.setColorAt(n++, col);
      }
    }
    this.beaconMesh.count = n;
    this.beaconMesh.instanceMatrix.needsUpdate = true;
    if (this.beaconMesh.instanceColor) this.beaconMesh.instanceColor.needsUpdate = true;
  }

  updateRobots(t, now, dt) {
    const sim = this.sim;
    const { m, q, s, p } = this.tmp;
    const { skirt, body, band, disc, eye, tote } = this.rm;
    const up = new THREE.Vector3(0, 1, 0);
    const blink = (Math.sin(now * 0.008) + 1) / 2;
    const n = sim.robots.length;
    for (let i = 0; i < n; i++) {
      const r = sim.robots[i];
      const [x, y] = sim.posOf(r, t);
      this.positions[i * 2] = x;
      this.positions[i * 2 + 1] = y;
      // heading: rotate during the turn phase, then hold
      let h = r.heading;
      const mo = r.motion;
      if (mo) {
        const k = mo.start > mo.t0 ? Math.min(1, Math.max(0, (t - mo.t0) / (mo.start - mo.t0))) : 1;
        h = lerpAngle(mo.h0, mo.h1, easeInOut(k));
      }
      this.headings[i] = h;
      const px = wx(x), pz = wz(y);
      q.setFromAxisAngle(up, h);
      const sc = r.removed ? 0.0001 : 1;
      s.set(sc, sc, sc);
      const place = (mesh, yy, scale = s) => {
        m.compose(p.set(px, yy, pz), q, scale);
        mesh.setMatrixAt(i, m);
      };
      place(skirt, 0.065);
      place(body, 0.2);
      place(band, 0.115);
      place(disc, 0.318 + (r.carrying ? 0.03 : 0));
      // eye sits on the front face
      const fx = Math.sin(h) * 0.352, fz = Math.cos(h) * 0.352;
      m.compose(p.set(px + fx, 0.22, pz + fz), q, s);
      eye.setMatrixAt(i, m);
      const ts = r.carrying && !r.removed ? 1 : 0.0001;
      place(tote, 0.5, this.toteScale.set(ts, ts, ts));

      // status colour
      let col;
      if (!r.alive) col = blink > 0.5 ? BAND.crashedBlink : BAND.crashed;
      else if (r.paused) col = BAND.paused.clone().multiplyScalar(0.6 + 0.6 * blink);
      else if (this.cycleMembers.has(r.id)) col = BAND.deadlock;
      else if (r.state === 'YIELD' || r.state === 'REJOIN' || sim.tick - r.lastYield < 30) col = BAND.yield;
      else if (r.waiting && sim.tick - r.waitSince > 6) col = BAND.wait;
      else if (r.workLeft > 0) col = BAND.work;
      else col = BAND.moving;
      let bodyCol = !r.alive ? BODY.dead : r.paused ? BODY.paused : BODY.ok;
      if (!this.kept(i)) {
        col = P.dimBand;
        bodyCol = P.dimBody;
      }
      band.setColorAt(i, col);
      body.setColorAt(i, bodyCol);
      tote.setColorAt(i, this.kept(i) ? this.white : P.dimBody);
      eye.setColorAt(i, this.kept(i) ? this.white : P.dimBody);
    }
    for (const mesh of this.robotMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    // selection ring
    if (this.selected >= 0 && this.selected < n && !sim.robots[this.selected].removed) {
      const [x, y] = this.robotPos(this.selected);
      this.selRing.visible = true;
      this.selRing.position.set(wx(x), 0.02, wz(y));
      const k = 1 + 0.06 * Math.sin(now * 0.006);
      this.selRing.scale.set(k, 1, k);
    } else this.selRing.visible = false;

    if (this.selectedCell >= 0) {
      this.cellCursor.visible = true;
      this.cellCursor.position.set(wx(xOf(this.selectedCell)), 0.025, wz(yOf(this.selectedCell)));
    } else this.cellCursor.visible = false;
  }

  updateTiles(t, now) {
    const sim = this.sim;
    const { m } = this.tmp;
    let n = 0;
    const col = new THREE.Color();
    if (this.layers.reservations && sim.mode !== 'baseline') {
      // A tile for every lease on a cell the holder has not physically reached.
      for (const r of sim.robots) {
        if (!r.alive || r.removed || !this.overlayOn(r.id)) continue;
        for (const [cell] of r.leases) {
          if (cell === r.cell || n >= MAX_TILES) continue;
          const moving = r.motion && r.motion.to === cell;
          m.makeTranslation(wx(xOf(cell)), 0.012, wz(yOf(cell)));
          this.tileMesh.setMatrixAt(n, m);
          col.copy(moving ? P.tile.moving : P.tile.waiting);
          if (r.id === this.selected) col.copy(P.tile.selected);
          if (this.spot && this.spot.keep && this.spot.keep.has(r.id)) col.copy(P.tile.keep);
          this.tileMesh.setColorAt(n++, col);
        }
      }
    }
    // the selected robot's own cell lease
    if (this.selected >= 0 && sim.mode !== 'baseline') {
      const r = sim.robots[this.selected];
      if (r && r.leases.has(r.cell) && n < MAX_TILES) {
        m.makeTranslation(wx(xOf(r.cell)), 0.012, wz(yOf(r.cell)));
        this.tileMesh.setMatrixAt(n, m);
        this.tileMesh.setColorAt(n++, col.copy(P.tile.own));
      }
    }
    this.tileMesh.count = n;
    this.tileMesh.instanceMatrix.needsUpdate = true;
    if (this.tileMesh.instanceColor) this.tileMesh.instanceColor.needsUpdate = true;

    // Blocked cells
    let b = 0;
    const blocked = [];
    for (const mgr of sim.managers) for (const c of mgr.blocked) blocked.push(c);
    for (const c of blocked) {
      if (b >= 128) break;
      m.makeTranslation(wx(xOf(c)), 0.015, wz(yOf(c)));
      this.blockMesh.setMatrixAt(b++, m);
    }
    this.blockMesh.count = b;
    this.blockMesh.instanceMatrix.needsUpdate = true;
    this.blockMat.opacity = 0.55 + 0.35 * (Math.sin(now * 0.006) + 1) / 2;
    while (this.cordons.length < blocked.length) {
      const l = new THREE.LineSegments(this.cordonGeo, this.cordonMat);
      this.group.add(l);
      this.cordons.push(l);
    }
    this.cordons.forEach((l, i) => {
      l.visible = i < blocked.length;
      if (l.visible) l.position.set(wx(xOf(blocked[i])), 0.25, wz(yOf(blocked[i])));
    });
    this.blockedCells = blocked;

    // selected robot's planned path
    let d = 0;
    if (this.selected >= 0) {
      const r = sim.robots[this.selected];
      if (r && !r.removed) {
        for (const c of r.path) {
          if (d >= 160) break;
          m.makeTranslation(wx(xOf(c)), 0.02, wz(yOf(c)));
          this.pathDots.setMatrixAt(d++, m);
        }
      }
    }
    this.pathDots.count = d;
    this.pathDots.instanceMatrix.needsUpdate = true;
  }

  // Arc between two floor points, lifted in the middle.
  arcPoint(ax, az, bx, bz, k, lift, out) {
    const h = 0.55 + lift;
    out[0] = ax + (bx - ax) * k;
    out[2] = az + (bz - az) * k;
    out[1] = 0.45 + 4 * h * k * (1 - k) * 0.5;
    return out;
  }

  updateArcs(t, now) {
    const sim = this.sim;
    const W8 = this.waitArcs, CY = this.cycleArcs;
    let nw = 0, nc = 0, nh = 0;
    const { m, q, p, s } = this.tmp;
    const a = [0, 0, 0], b = [0, 0, 0];
    const amber = P.waitArc;
    const red = P.cycleArc;
    const pulse = 0.75 + 0.25 * Math.sin(now * 0.012);
    const cycleEdges = new Set();
    for (const cy of sim.cycles) {
      for (let i = 0; i < cy.robots.length; i++) cycleEdges.add(cy.robots[i] * 4096 + cy.robots[(i + 1) % cy.robots.length]);
    }
    const push = (buf, idx, ax, az, bx, bz, lift, col) => {
      for (let k = 0; k < ARC_SEG; k++) {
        this.arcPoint(ax, az, bx, bz, k / ARC_SEG, lift, a);
        this.arcPoint(ax, az, bx, bz, (k + 1) / ARC_SEG, lift, b);
        const o = (idx * ARC_SEG + k) * 6;
        buf.pos[o] = a[0]; buf.pos[o + 1] = a[1]; buf.pos[o + 2] = a[2];
        buf.pos[o + 3] = b[0]; buf.pos[o + 4] = b[1]; buf.pos[o + 5] = b[2];
        buf.col[o] = buf.col[o + 3] = col.r;
        buf.col[o + 1] = buf.col[o + 4] = col.g;
        buf.col[o + 2] = buf.col[o + 5] = col.b;
      }
    };
    const head = (ax, az, bx, bz, lift, col, scale) => {
      if (nh >= MAX_ARCS) return;
      this.arcPoint(ax, az, bx, bz, 0.8, lift, a);
      this.arcPoint(ax, az, bx, bz, 0.84, lift, b);
      const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      m.compose(p.set(b[0], b[1], b[2]), q, s.set(scale, scale, scale));
      this.heads.setMatrixAt(nh, m);
      this.heads.setColorAt(nh++, col);
    };

    if (this.layers.waits && sim.mode !== 'baseline') {
      for (const r of sim.robots) {
        if (!r.alive || r.removed || !r.waiting || r.waitingFor < 0) continue;
        const holder = sim.robots[r.waitingFor];
        if (!holder || holder.removed || holder === r) continue;
        const isCycle = cycleEdges.has(r.id * 4096 + holder.id);
        if (!isCycle && sim.tick - r.waitSince < 10) continue;
        if (!this.overlayOn(r.id) && !this.overlayOn(holder.id)) continue;
        const [x1, y1] = this.robotPos(r.id);
        const [x2, y2] = this.robotPos(holder.id);
        const ax = wx(x1), az = wz(y1), bx = wx(x2), bz = wz(y2);
        const dist = Math.hypot(bx - ax, bz - az);
        const lift = Math.min(1.2, dist * 0.18);
        if (isCycle) {
          if (nc < MAX_ARCS) push(CY, nc++, ax, az, bx, bz, lift + 0.15, red.clone().multiplyScalar(pulse));
          head(ax, az, bx, bz, lift + 0.15, red, 1.4);
        } else {
          if (nw < MAX_ARCS) push(W8, nw++, ax, az, bx, bz, lift, amber);
          head(ax, az, bx, bz, lift, amber, 1);
        }
      }
    }
    for (const [buf, n] of [[W8, nw], [CY, nc]]) {
      buf.line.visible = n > 0;
      if (!n) continue;
      buf.line.geometry.dispose();
      const g = new LineSegmentsGeometry();
      g.setPositions(buf.pos.subarray(0, n * ARC_SEG * 6));
      g.setColors(buf.col.subarray(0, n * ARC_SEG * 6));
      buf.line.geometry = g;
    }
    this.heads.count = nh;
    this.heads.instanceMatrix.needsUpdate = true;
    if (this.heads.instanceColor) this.heads.instanceColor.needsUpdate = true;

    // Probes: comets running along the wait-for edges.
    let np = 0;
    const white = P.probeHead;
    const magenta = P.probeTail;
    const flights = sim.net.flights;
    for (const f of flights) {
      if (f.msg.type !== 'PROBE' || f.lost) continue;
      const k = (t - f.t0) / (f.t1 - f.t0);
      if (k < 0 || k > 1) continue;
      const from = +f.msg.from.slice(1), to = +f.msg.to.slice(1);
      if (!this.overlayOn(from) && !this.overlayOn(to)) continue;
      const [x1, y1] = this.robotPos(from);
      const [x2, y2] = this.robotPos(to);
      const ax = wx(x1), az = wz(y1), bx = wx(x2), bz = wz(y2);
      const lift = Math.min(1.2, Math.hypot(bx - ax, bz - az) * 0.18) + 0.15;
      for (let tail = 0; tail < 4 && np < MAX_PROBES; tail++) {
        const kk = k - tail * 0.06;
        if (kk < 0) break;
        this.arcPoint(ax, az, bx, bz, kk, lift, a);
        const sc = 0.85 - tail * 0.17;
        m.compose(p.set(a[0], a[1], a[2]), q.identity(), s.set(sc, sc, sc));
        this.probeMesh.setMatrixAt(np, m);
        this.probeMesh.setColorAt(np++, tail === 0 ? white : magenta.clone().multiplyScalar(1 - tail * 0.15));
      }
    }
    this.probeMesh.count = np;
    this.probeMesh.instanceMatrix.needsUpdate = true;
    if (this.probeMesh.instanceColor) this.probeMesh.instanceColor.needsUpdate = true;
  }

  endpointPos(addr, out) {
    const k = addr[0];
    const id = +addr.slice(1);
    if (k === 'r') {
      const [x, y] = this.robotPos(id);
      out.set(wx(x), 0.45, wz(y));
      return true;
    }
    if (k === 'm') {
      out.copy(this.managers[id].pos);
      return true;
    }
    return false;
  }

  updateMessages(t) {
    const sim = this.sim;
    const { m, q, p, s } = this.tmp;
    let n = 0;
    const sel = this.selected >= 0 ? 'r' + this.selected : null;
    const A = new THREE.Vector3(), B = new THREE.Vector3();
    for (const f of sim.net.flights) {
      if (n >= MAX_MSGS) break;
      const type = f.msg.type;
      if (type === 'PROBE' || type === 'ABORT') continue;
      const mine = sel && (f.msg.from === sel || f.msg.to === sel);
      if (!this.layers.network && !mine) continue;
      if (!this.layers.network && type.startsWith('RENEW')) continue;
      const k = (t - f.t0) / (f.t1 - f.t0);
      if (k < 0 || k > 1) continue;
      if (f.lost && k > 0.5) continue;
      if (!this.endpointPos(f.msg.from, A) || !this.endpointPos(f.msg.to, B)) continue;
      p.lerpVectors(A, B, k);
      p.y += Math.sin(k * Math.PI) * 0.6;
      const sc = mine ? 1.6 : 1;
      m.compose(p, q.identity(), s.set(sc, sc, sc));
      this.msgMesh.setMatrixAt(n, m);
      this.msgMesh.setColorAt(n++, f.lost ? P.msgLost : MSG_COLORS[type] || MSG_COLORS.REQ);
    }
    this.msgMesh.count = n;
    this.msgMesh.instanceMatrix.needsUpdate = true;
    if (this.msgMesh.instanceColor) this.msgMesh.instanceColor.needsUpdate = true;
  }

  updateManagers(now) {
    const sim = this.sim;
    const vis = this.layers.managers;
    const sel = this.selected >= 0 ? sim.robots[this.selected] : null;
    const selRegion = sel ? regionOf(sel.cell) : -1;
    for (const node of this.managers) {
      node.group.visible = vis && this.spot?.managers !== 'dim';
      if (!node.group.visible) continue;
      const mgr = sim.managers[node.id];
      const act = Math.min(1, mgr.activity / 6);
      const hasBlocked = mgr.blocked.size > 0;
      const M = theme.manager;
      const base = hasBlocked ? M.blocked : node.id === selRegion ? M.selected : M.base;
      const alert = this.alertPlanes[node.id];
      if (mgr.state !== 'UP') {
        const down = mgr.state === 'DOWN';
        const hex = down ? theme.mgrState.down : theme.mgrState.reconciling;
        const blink = (Math.sin(now * (down ? 0.012 : 0.006)) + 1) / 2;
        node.coreMat.color.set(hex).multiplyScalar(theme.additive ? 1 + blink * 1.5 : 1);
        node.coreMat.opacity = down ? 0.35 + blink * 0.6 : 0.9;
        node.ringMat.color.set(hex);
        node.ringMat.opacity = down ? 0.15 : 0.5 + blink * 0.4;
        node.ring.scale.setScalar(down ? 1 : 1.1 + blink * 0.35);
        node.ring.rotation.z = now * 0.004;
        node.beamMat.opacity = 0.35;
        node.beamMat.color.set(hex);
        node.group.position.y = MANAGER_Y + (down ? -0.25 : 0);
        alert.visible = true;
        alert.material.color.set(hex);
        alert.material.opacity = (down ? 0.1 : 0.07) + blink * 0.08;
        alert.children[0].material.color.set(hex);
        continue;
      }
      alert.visible = false;
      node.coreMat.opacity = 0.9;
      node.ring.rotation.z = 0;
      node.beamMat.color.set(theme.manager.base);
      const mode = this.spot?.managers || 'normal';
      const k = mode === 'dim' ? 0.15 : mode === 'hi' ? 1.8 : 1;
      if (M.glow) {
        node.coreMat.color.set(base).multiplyScalar((0.9 + act * 1.8) * k);
        node.ringMat.color.set(base).multiplyScalar((0.6 + act * 1.2) * k);
      } else {
        node.coreMat.color.set(base);
        node.ringMat.color.set(base);
      }
      node.ringMat.opacity = mode === 'dim' ? 0.08 : 0.25 + act * 0.6;
      node.beamMat.opacity = mode === 'hi' ? 0.45 : mode === 'dim' ? 0.03 : M.beam;
      const pulse = mode === 'hi' ? 1.25 + 0.25 * Math.sin(now * 0.005 + node.id) : 1;
      node.ring.scale.setScalar((1 + act * 0.25) * pulse);
      node.core.rotation.y = now * 0.0004 + node.id;
      node.group.position.y = MANAGER_Y + Math.sin(now * 0.0012 + node.id) * 0.06;
    }
  }

  // ───────────────────────────── bursts & callouts ─────────────────────────────

  spawnBurst(x, z, color, size = 1, dur = 900) {
    const mesh = this.burstPool.find((b) => !b.visible);
    if (!mesh) return;
    mesh.visible = true;
    mesh.position.set(x, 0.03, z);
    mesh.material.color.copy(color);
    this.bursts.push({ mesh, born: this.now, dur, size });
  }

  updateBursts(now) {
    const sim = this.sim;
    for (const b of sim.bursts) {
      if (this.seenBursts.has(b)) continue;
      this.seenBursts.add(b);
      let x, y;
      if (b.cell >= 0) (x = xOf(b.cell)), (y = yOf(b.cell));
      else (x = b.x), (y = b.y);
      const color = P.burst[b.kind] || P.burst.other;
      this.spawnBurst(wx(x), wz(y), color, b.kind === 'collision' ? 1.4 : 1.8);
      if (b.kind === 'fenced' || b.kind === 'cleared') {
        setTimeout(() => this.spawnBurst(wx(x), wz(y), color, 2.4, 1100), 160);
      }
    }
    this.bursts = this.bursts.filter((b) => {
      const k = (now - b.born) / b.dur;
      if (k >= 1) {
        b.mesh.visible = false;
        return false;
      }
      const e = 1 - Math.pow(1 - k, 3);
      const sc = 0.6 + e * b.size;
      b.mesh.scale.set(sc, 1, sc);
      b.mesh.material.opacity = 1 - k;
      return true;
    });
  }

  updateEvents(now) {
    const sim = this.sim;
    const fresh = sim.events.filter((e) => e.seq > this.lastSeq);
    if (!fresh.length) return;
    this.lastSeq = fresh[fresh.length - 1].seq;
    for (const e of fresh) {
      const important = this.focusRobots.size === 0 || (e.robots || []).some((id) => this.focusRobots.has(id) || id === this.selected);
      let text = null;
      let cell = e.cell;
      switch (e.kind) {
        case 'fenced': text = `<b>FENCED</b> stale epoch rejected`; break;
        case 'blocked': text = `<b>BLOCKED</b> lease expired, robot inside`; break;
        case 'cleared': text = `<b>CLEARED</b>`; break;
        case 'crash': text = `<b>R${e.robots[0]} CRASHED</b>`; break;
        case 'pause': text = `<b>R${e.robots[0]} FROZE</b>`; break;
        case 'regrant': text = `<b>RE-GRANTED</b> to R${e.robots[1]}`; break;
        case 'collision': text = `<b>COLLISION</b>`; break;
        case 'mgrdown':
        case 'mgrrestart':
        case 'reconciled': {
          const node = this.managers[e.mgr];
          const label = { mgrdown: `<b>M${e.mgr} DOWN</b> table lost`, mgrrestart: `<b>M${e.mgr} RESTARTED</b> reconciling…`, reconciled: `<b>M${e.mgr} RECONCILED</b> grants resume` }[e.kind];
          this.addCallout(label, node.pos.x, node.pos.z, e.kind === 'mgrdown' ? 'collision' : e.kind === 'reconciled' ? 'cleared' : 'pause', now);
          break;
        }
        case 'deadlock': {
          if (!important && this.callouts.length > 3) break;
          text = `<b>DEADLOCK</b> ${e.robots.length}-cycle · R${e.victim} yields`;
          const pos = e.robots.map((id) => this.robotPos(id));
          const cx = pos.reduce((s, p) => s + p[0], 0) / pos.length;
          const cy = pos.reduce((s, p) => s + p[1], 0) / pos.length;
          this.spawnBurst(wx(cx), wz(cy), P.burst.deadlock, 2.6, 1200);
          this.addCallout(text, wx(cx), wz(cy), 'deadlock', now);
          text = null;
          break;
        }
      }
      if (text && cell !== undefined && (important || this.callouts.length < 4)) {
        this.addCallout(text, wx(xOf(cell)), wz(yOf(cell)), e.kind, now);
      }
    }
  }

  addCallout(html, x, z, kind, now) {
    const el = document.createElement('div');
    el.className = `callout callout-${kind}`;
    el.innerHTML = html;
    const obj = new CSS2DObject(el);
    obj.position.set(x, 1.2, z);
    this.group.add(obj);
    this.callouts.push({ obj, born: now });
    if (this.callouts.length > 7) this.callouts.shift().obj.removeFromParent();
  }

  // ───────────────────────────── labels ─────────────────────────────

  label(key, cls, html, x, y, z) {
    let l = this.labels.get(key);
    if (!l) {
      const el = document.createElement('div');
      el.className = cls;
      const obj = new CSS2DObject(el);
      this.group.add(obj);
      l = { obj, el, html: '' };
      this.labels.set(key, l);
    }
    if (l.html !== html) (l.el.innerHTML = html), (l.html = html);
    if (l.el.className !== cls) l.el.className = cls;
    l.obj.position.set(x, y, z);
    l.obj.visible = true;
    l.used = true;
  }

  updateLabels(t, now) {
    const sim = this.sim;
    for (const l of this.labels.values()) l.used = false;

    // callouts age out
    this.callouts = this.callouts.filter((c) => {
      if (now - c.born > 2800) {
        c.obj.removeFromParent();
        return false;
      }
      c.obj.position.y = 1.2 + (now - c.born) / 2800 * 0.6;
      return true;
    });

    if (this.layers.labels) {
      const ids = new Set(this.focusRobots);
      if (this.selected >= 0) ids.add(this.selected);
      for (const id of this.cycleMembers.keys()) if (ids.size < 12) ids.add(id);
      const annotated = new Set(this.annotations.map((a) => a.robot).filter((x) => x !== undefined));
      for (const id of ids) {
        const r = sim.robots[id];
        if (!r || r.removed || annotated.has(id)) continue;
        const [x, y] = this.robotPos(id);
        const st = robotStatusKey(r, sim, this.cycleMembers);
        this.label('r' + id, `rlabel st-${st}${id === this.selected ? ' sel' : ''}`, `<i></i>R${id}`, wx(x), 1.1, wz(y));
      }
      // blocked cells with the crew's countdown
      for (const c of this.blockedCells || []) {
        const job = sim.maintenance.find((j) => j.stage === 'blocked' && sim.robots[j.robot].footprint.includes(c));
        let html = 'BLOCKED';
        if (job) {
          const k = Math.min(1, (sim.tick - job.since) / sim.cfg.clearAfter);
          html = `<span class="pie" style="--k:${k}"></span>BLOCKED · crew ${(((1 - k) * sim.cfg.clearAfter * sim.cfg.tickMs) / 1000).toFixed(1)}s`;
        }
        this.label('b' + c, 'blabel', html, wx(xOf(c)), 0.02, wz(yOf(c)) + 0.62);
      }
    }
    if (this.layers.managers) {
      for (const node of this.managers) {
        const mgr = sim.managers[node.id];
        if (this.spot?.managers === 'dim') continue;
        const st = mgr.state === 'DOWN' ? ' down' : mgr.state === 'RECONCILING' ? ' recon' : '';
        const txt = mgr.state === 'DOWN' ? `M${node.id} · DOWN` : mgr.state === 'RECONCILING' ? `M${node.id} · reconciling ${mgr.reports?.size ?? 0}/${sim.robots.filter((r) => r.alive).length}` : `M${node.id}`;
        this.label('m' + node.id, `mlabel${this.spot?.managers === 'hi' ? ' hi' : ''}${st}`, txt, node.pos.x, node.group.position.y + 0.45, node.pos.z);
      }
    }
    if (this.showRegions) {
      const only = this.showRegions.only;
      for (let id = 0; id < 16; id++) {
        if (only && !only.includes(id)) continue;
        const i = id % 4, j = (id / 4) | 0;
        this.label('reg' + id, 'reglabel', `<b>${id}</b><span>Region</span>`, wx(i * 12 + 5.5), 1.2, wz(j * 8 + 3.5));
      }
    }
    for (const a of this.annotations) {
      let x, y, z;
      if (a.robot !== undefined) {
        const r = sim.robots[a.robot];
        if (!r || r.removed) continue;
        const [rx, ry] = this.robotPos(a.robot);
        (x = wx(rx)), (y = 0.45), (z = wz(ry));
      } else if (a.cell !== undefined) {
        (x = wx(xOf(a.cell))), (y = 0.05), (z = wz(yOf(a.cell)));
      } else [x, y, z] = a.pos;
      const html = typeof a.html === 'function' ? a.html(sim) : a.html;
      if (!html) continue;
      this.label('a' + a.key, `anno${a.cls ? ' ' + a.cls : ''}`, `<div class="in" style="--h:${a.h ?? 46}px"><div class="card">${html}</div><i class="stem"></i><b class="dot"></b></div>`, x, y, z);
    }
    for (const [key, l] of this.labels) {
      if (!l.used) {
        l.obj.removeFromParent();
        this.labels.delete(key);
      }
    }
  }
}

export function robotStatusKey(r, sim, cycles) {
  if (!r.alive) return 'crashed';
  if (r.paused) return 'paused';
  if (cycles && cycles.has(r.id)) return 'deadlock';
  if (r.state === 'YIELD' || r.state === 'REJOIN' || sim.tick - r.lastYield < 30) return 'yield';
  if (r.waiting && sim.tick - r.waitSince > 6) return 'wait';
  if (r.workLeft > 0) return 'work';
  return 'moving';
}

// ───────────────────────────── helpers ─────────────────────────────

function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * k;
}

function easeInOut(k) {
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
}

function softSquareTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, s, s);
  const r = 22, pad = 10;
  g.beginPath();
  g.moveTo(pad + r, pad);
  g.arcTo(s - pad, pad, s - pad, s - pad, r);
  g.arcTo(s - pad, s - pad, pad, s - pad, r);
  g.arcTo(pad, s - pad, pad, pad, r);
  g.arcTo(pad, pad, s - pad, pad, r);
  g.closePath();
  g.fillStyle = `rgba(255,255,255,${theme.tile.fill})`;
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.stroke();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function stripeTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  g.fillStyle = theme.stripe.bg;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = theme.stripe.line;
  g.lineWidth = 14;
  for (let k = -s; k < s * 2; k += 36) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + s, s);
    g.stroke();
  }
  g.lineWidth = 6;
  g.strokeRect(3, 3, s - 6, s - 6);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export { fmtCell };
