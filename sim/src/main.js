import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import { Simulation, DEFAULTS } from './sim/simulation.js';
import { SCENARIOS } from './sim/scenarios.js';
import { getLayout, cellOf, W, H } from './sim/layout.js';
import { buildWarehouse, wx, wz, levelOf } from './render/warehouse.js';
import { LiveView } from './render/live.js';
import { Hud } from './ui/hud.js';
import { Bench } from './ui/bench.js';
import { Compare } from './ui/compare.js';
import { Tour } from './ui/tour.js';
import { Scrubber } from './ui/scrubber.js';
import { Timeline } from './ui/timeline.js';
import { History } from './sim/history.js';
import { Trace } from './sim/trace.js';
import { theme, setThemeMode, onThemeChange } from './render/theme.js';

const layout = getLayout();

// ───────────────────────────── renderer & scene ─────────────────────────────

const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
stage.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer({ element: document.getElementById('labels') });
labelRenderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9edf2);
scene.fog = new THREE.Fog(0xe9edf2, 75, 160);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(-6, 46, 40);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = 1.32;
controls.minDistance = 6;
controls.maxDistance = 95;
controls.target.set(0, 0, 1.5);
controls.screenSpacePanning = false;

const hemi = new THREE.HemisphereLight(0xffffff, 0xb8c2d0, 1.4);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff8ee, 2.0);
sun.position.set(-22, 38, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -30;
sun.shadow.camera.right = 30;
sun.shadow.camera.top = 24;
sun.shadow.camera.bottom = -24;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 90;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 3;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xdbe7ff, 0.6);
fill.position.set(20, 12, -24);
scene.add(fill);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.18, 0.3, 1.6);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const warehouse = buildWarehouse(scene, layout, renderer);
const resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
const live = new LiveView(scene, warehouse, resolution);

// ───────────────────────────── app state ─────────────────────────────

const app = {
  cfg: { ...DEFAULTS, robots: 120, seed: 42 },
  speed: 1,
  running: true,
  scenario: null,
  ctx: null,
  follow: false,
  sim: null,
  live,
};

const hud = new Hud(app);
const tour = new Tour(app);
app.tour = tour;
if (import.meta.env.DEV) window.__app = app;
const bench = new Bench(app);
const compare = new Compare(app);
const scrubber = new Scrubber(app);
const timeline = new Timeline(app);
app.timeline = timeline;
let acc = 0;

app.restart = () => {
  if (app.scenario) return app.startScenario(app.scenario);
  app.attach(new Simulation(app.cfg));
};

app.attach = (sim) => {
  const relaid = warehouse.layout !== sim.layout;
  app.sim = sim;
  sim.net.record = true;
  sim.trace = new Trace();
  app.history = new History(sim);
  acc = 0;
  live.setSim(sim);
  live.focusRobots = new Set(app.scenario ? SCENARIOS[app.scenario].labels : []);
  app.follow = false;
  hud.onSim(sim);
  scrubber.onSim();
  // A different number of floors or lifts: frame the new building.
  if (relaid && !app.scenario) flyHome();
};

// One tick, through history so recorded actions replay and checkpoints are kept.
app.step = () => app.history.step(app.sim);

// A user action on the simulation (crash, freeze, cut the network…). Going
// through history makes it part of the replayable record.
app.act = (name, ...args) => {
  const out = app.history.act(app.sim, name, args);
  scrubber.onHistory();
  return out;
};

// Jump to an earlier (or later, up to the furthest point reached) moment.
// With the message timeline open, a few extra seconds are replayed first so
// it has history to show; `fast` (while dragging) skips that.
app.seek = (tick, fast = false) => {
  const h = app.history;
  const sim = h.seek(tick, {
    warm: fast || !timeline.open ? 0 : 160,
    prepare: (s) => {
      s.net.record = true;
      s.trace = new Trace();
    },
  });
  app.sim = sim;
  acc = 0;
  live.adoptSim(sim);
  if (app.scenario && app.ctx) {
    let k = 0;
    while (k + 1 < h.stepAt.length && h.stepAt[k + 1] <= sim.tick) k++;
    app.ctx.step = k;
    app.ctx.shownAt = h.stepAt[k];
    hud.setStep(SCENARIOS[app.scenario], k);
  }
  hud.onSeek(sim);
  scrubber.onHistory();
};
app.setMode = (mode) => {
  app.cfg.mode = mode;
  if (app.tour?.active) app.tour.end();
  if (app.scenario) app.exitScenario(false);
  app.restart();
};

app.startScenario = (key, opts = {}) => {
  const sc = SCENARIOS[key];
  const { maxBackground, ...over } = sc.cfg;
  // Scenarios are scripted on a single floor.
  const cfg = { ...app.cfg, floors: 1, ...over, robots: Math.min(app.cfg.robots, maxBackground ?? 999) };
  app.scenario = key;
  app.ctx = { start: 0, step: 0, shownAt: 0 };
  app.attach(new Simulation(cfg, sc));
  if (opts.silent) return;
  if (tour.active) tour.end();
  hud.showNarration(sc);
  if (cfg.floors > 1) app.setFloorView(-1);
  flyTo(new THREE.Vector3(wx(sc.focus.x), sc.focus.h ?? 0, wz(sc.focus.y)), sc.focus.dist, sc.focus.h ? 1.1 : 0.82);
  app.running = true;
  hud.syncTransport();
};

app.exitScenario = (restart = true) => {
  app.scenario = null;
  app.ctx = null;
  hud.hideNarration();
  if (restart) {
    app.restart();
    flyHome();
  }
};

app.select = (robot, cell = -1) => {
  live.selected = robot;
  live.selectedCell = robot >= 0 ? -1 : cell;
  if (robot < 0) app.follow = false;
  hud.onSelect();
};

// Show every floor (-1) or just one, and frame it.
app.setFloorView = (view) => {
  live.setView(view);
  hud.syncFloors();
  flyHome();
};

// Camera moves to a cell on the floor on show (the ground floor in "All").
const viewY = () => levelOf(Math.max(0, live.view));
app.focusCell = (x, y, dist = 14) => flyTo(new THREE.Vector3(wx(x), viewY(), wz(y)), dist, 0.85);
app.flyTo = (x, y, dist, polar = 0.85, azimuth = null, dur = 1500) => flyTo(new THREE.Vector3(wx(x), viewY(), wz(y)), dist, polar, azimuth, dur);
app.flyHome = () => flyHome();
app.fitDistance = (polar = 0.74) => fitDistance(polar);
app.setDim = (k) => warehouse.setDim(k);
app.setSpeed = (v) => {
  app.speed = v;
  hud.syncTransport();
};
app.setRunning = (v) => {
  app.running = v;
  hud.syncTransport();
};
app.togglePlay = () => {
  app.running = !app.running;
  hud.syncTransport();
};

// ───────────────────────────── camera moves ─────────────────────────────

let tween = null;
function flyTo(target, dist, polar = 0.9, azimuth = null, dur = 1500) {
  const off = camera.position.clone().sub(controls.target);
  const sph = new THREE.Spherical().setFromVector3(off);
  const to = new THREE.Spherical(dist, polar, azimuth ?? sph.theta);
  tween = { t0: performance.now(), dur, fromT: controls.target.clone(), toT: target, from: sph, to };
}
// Distance at which the whole floor fits between the side panels.
function fitDistance(polar = 0.74) {
  const aspect = window.innerWidth / window.innerHeight;
  const vh = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const usable = Math.max(0.45, (window.innerWidth - 600) / window.innerWidth);
  const byWidth = (W / 2 + 2) / (vh * aspect * usable);
  const byDepth = ((H / 2 + 3) * Math.cos(polar) + 1.5 * Math.sin(polar)) / (vh * 0.86);
  return THREE.MathUtils.clamp(Math.max(byWidth, byDepth), 28, 90);
}
// Frame the floor on show, or the whole stack of floors from lower down
// so the gaps between storeys are visible.
function flyHome() {
  const floors = app.sim?.layout.floors ?? 1;
  if (floors > 1 && live.view < 0) {
    const top = levelOf(floors - 1);
    flyTo(new THREE.Vector3(0, top / 2, 1.5), fitDistance(1.05) + top * 1.1, 1.05, -0.35, 1600);
  } else flyTo(new THREE.Vector3(0, levelOf(Math.max(0, live.view)), 1.5), fitDistance(), 0.74, -0.12, 1600);
}
controls.addEventListener('start', () => {
  tween = null;
});

function updateTween(now) {
  if (!tween) return;
  const k = Math.min(1, (now - tween.t0) / tween.dur);
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  controls.target.lerpVectors(tween.fromT, tween.toT, e);
  let dt = tween.to.theta - tween.from.theta;
  while (dt > Math.PI) dt -= 2 * Math.PI;
  while (dt < -Math.PI) dt += 2 * Math.PI;
  const s = new THREE.Spherical(
    tween.from.radius + (tween.to.radius - tween.from.radius) * e,
    tween.from.phi + (tween.to.phi - tween.from.phi) * e,
    tween.from.theta + dt * e,
  );
  camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(s));
  if (k >= 1) tween = null;
}

// ───────────────────────────── picking ─────────────────────────────

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.button !== 0) return;
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  live.rm.body.boundingSphere = null; // robots move between floors
  const hits = ray.intersectObject(live.rm.body, false);
  const hit = hits.find((h) => !app.sim.robots[h.instanceId]?.removed && live.showsRobot(app.sim.robots[h.instanceId]));
  if (hit) return app.select(hit.instanceId);
  // The nearest floor on show under the pointer.
  const floors = warehouse.floors.filter((m) => m.parent.visible);
  const fh = ray.intersectObjects(floors, false)[0];
  if (fh) {
    const p = fh.point, f = fh.object.userData.f;
    const x = Math.floor(p.x + W / 2), y = Math.floor(p.z + H / 2);
    const c = cellOf(x, y, f);
    if (x >= 0 && y >= 0 && x < W && y < H && !app.sim.layout.solid[c]) return app.select(-1, c);
  }
  app.select(-1);
});

// ───────────────────────────── keyboard ─────────────────────────────

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    app.togglePlay();
  } else if (tour.active && ['1', '2', '3', '4', '5', '6', 'b', 'B', 'c', 'C', 'r', 'R'].includes(e.key)) {
    return;
  } else if (e.key === '1') app.startScenario('deadlock');
  else if (e.key === '2') app.startScenario('crash');
  else if (e.key === '3') app.startScenario('pause');
  else if (e.key === '4') app.startScenario('manager');
  else if (e.key === '5') app.startScenario('partition');
  else if (e.key === '6') app.startScenario('lift');
  else if (e.key === 'b' || e.key === 'B') bench.open();
  else if (e.key === 'c' || e.key === 'C') compare.open();
  else if (e.key === 't' || e.key === 'T') tour.active ? tour.end() : tour.start();
  else if (e.key === 'd' || e.key === 'D') app.toggleTheme();
  else if (tour.active && e.key === 'ArrowRight') tour.next();
  else if (tour.active && e.key === 'ArrowLeft') tour.back();
  else if (e.key === 'r' || e.key === 'R') app.restart();
  else if (e.key === 'f' || e.key === 'F') {
    if (live.selected >= 0) app.follow = !app.follow;
    hud.onSelect();
  } else if (e.key === 'Escape') {
    if (tour.active) tour.end();
    else if (bench.isOpen) bench.close();
    else if (compare.isOpen) compare.close();
    else if (timeline.open) timeline.close();
    else if (live.selected >= 0 || live.selectedCell >= 0) app.select(-1);
    else if (app.scenario) app.exitScenario();
  } else if (e.key === '.') {
    // single-step while paused
    if (!app.running) app.step();
  } else if (e.key === '[' && !tour.active) app.seek(app.sim.tick - 100);
  else if (e.key === ']' && !tour.active) app.seek(app.sim.tick + 100);
  else if ((e.key === 'm' || e.key === 'M') && !tour.active) timeline.toggle();
  else if ((e.key === 'v' || e.key === 'V') && !tour.active && app.sim.layout.floors > 1) {
    // Cycle the floor view: all floors, then each floor from the top.
    const n = app.sim.layout.floors;
    const order = [-1, ...[...Array(n).keys()].reverse()];
    app.setFloorView(order[(order.indexOf(live.view) + 1) % order.length]);
  }
});

// ───────────────────────────── resize ─────────────────────────────

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  resolution.set(w, h);
  live.setResolution(resolution);
}
window.addEventListener('resize', resize);

// ───────────────────────────── main loop ─────────────────────────────

app.restart();
let last = performance.now();
const followTarget = new THREE.Vector3();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const sim = app.sim;
  const tickMs = sim.cfg.tickMs;
  if (app.running && !app.scrubbing) {
    acc += dt * 1000 * app.speed;
    let n = 0;
    while (acc >= tickMs && n < 16) {
      app.history.step(sim);
      acc -= tickMs;
      n++;
    }
    if (n === 16) acc = 0;
  }
  if (app.scenario) hud.checkScenario(SCENARIOS[app.scenario]);
  sim.net.pruneFlights(sim.tick);
  const t = sim.tick + Math.min(acc / tickMs, 0.999);
  live.update(t, now, dt);
  warehouse.tickDim();
  tour.update(now);
  scrubber.update();
  timeline.update(t);

  if (app.follow && live.selected >= 0) {
    const [x, y] = live.robotPos(live.selected);
    followTarget.set(wx(x), live.robotY(live.selected), wz(y));
    const delta = followTarget.clone().sub(controls.target).multiplyScalar(0.08);
    controls.target.add(delta);
    camera.position.add(delta);
  }
  updateTween(now);
  controls.update();
  composer.render();
  labelRenderer.render(scene, camera);
  hud.update(now);
}

// Opening shot: sweep down onto the floor, then offer the guided tour.
flyTo(new THREE.Vector3(0, 0, 1.5), fitDistance(), 0.74, -0.12, 2600);
requestAnimationFrame(frame);
document.getElementById('btn-home').addEventListener('click', () => flyHome());

// ───────────────────────────── light / dark ─────────────────────────────

function applySceneTheme() {
  const S = theme.scene;
  scene.background.setHex(S.bg);
  scene.fog.color.setHex(S.bg);
  scene.fog.near = S.fogNear;
  scene.fog.far = S.fogFar;
  scene.environmentIntensity = S.env;
  renderer.toneMappingExposure = S.exposure;
  hemi.color.setHex(S.hemi[0]);
  hemi.groundColor.setHex(S.hemi[1]);
  hemi.intensity = S.hemi[2];
  sun.color.setHex(S.sun[0]);
  sun.intensity = S.sun[1];
  fill.color.setHex(S.fill[0]);
  fill.intensity = S.fill[1];
  [bloom.strength, bloom.radius, bloom.threshold] = S.bloom;
}
onThemeChange(() => {
  applySceneTheme();
  warehouse.applyTheme();
  live.applyTheme();
  hud.buildLegend();
  tour.refresh();
  bench.refresh();
  compare.refresh();
  timeline.refresh();
  scrubber.refresh();
});
app.toggleTheme = () => {
  const next = theme.mode === 'dark' ? 'light' : 'dark';
  setThemeMode(next);
  try {
    localStorage.setItem('wtc-theme', next);
  } catch {}
};
document.getElementById('btn-theme').addEventListener('click', () => app.toggleTheme());
let savedTheme = 'light';
try {
  savedTheme = localStorage.getItem('wtc-theme') || 'light';
} catch {}
setThemeMode(savedTheme);
let seen = false;
try {
  seen = localStorage.getItem('wtc-tour-v1') === 'done';
} catch {}
if (!seen) setTimeout(() => !tour.active && tour.start(), 2200);
