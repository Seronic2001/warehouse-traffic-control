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
import { getLayout, W, H } from './sim/layout.js';
import { buildWarehouse, wx, wz } from './render/warehouse.js';
import { LiveView } from './render/live.js';
import { Hud } from './ui/hud.js';
import { Bench } from './ui/bench.js';
import { Tour } from './ui/tour.js';
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
const live = new LiveView(scene, warehouse.managers, resolution);

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
let acc = 0;

app.restart = () => {
  if (app.scenario) return app.startScenario(app.scenario);
  app.attach(new Simulation(app.cfg));
};

app.attach = (sim) => {
  app.sim = sim;
  sim.net.record = true;
  acc = 0;
  live.setSim(sim);
  live.focusRobots = new Set(app.scenario ? SCENARIOS[app.scenario].labels : []);
  app.follow = false;
  hud.onSim(sim);
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
  const cfg = { ...app.cfg, ...over, robots: Math.min(app.cfg.robots, maxBackground ?? 999) };
  app.scenario = key;
  app.ctx = { start: 0, step: 0 };
  app.attach(new Simulation(cfg, sc));
  if (opts.silent) return;
  if (tour.active) tour.end();
  hud.showNarration(sc);
  flyTo(new THREE.Vector3(wx(sc.focus.x), 0, wz(sc.focus.y)), sc.focus.dist, 0.82);
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

app.focusCell = (x, y, dist = 14) => flyTo(new THREE.Vector3(wx(x), 0, wz(y)), dist, 0.85);
app.flyTo = (x, y, dist, polar = 0.85, azimuth = null, dur = 1500) => flyTo(new THREE.Vector3(wx(x), 0, wz(y)), dist, polar, azimuth, dur);
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
function flyHome() {
  flyTo(new THREE.Vector3(0, 0, 1.5), fitDistance(), 0.74, -0.12, 1600);
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
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.button !== 0) return;
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObject(live.rm.body, false);
  const hit = hits.find((h) => !app.sim.robots[h.instanceId]?.removed);
  if (hit) return app.select(hit.instanceId);
  const p = new THREE.Vector3();
  if (ray.ray.intersectPlane(floorPlane, p)) {
    const x = Math.floor(p.x + W / 2), y = Math.floor(p.z + H / 2);
    if (x >= 0 && y >= 0 && x < W && y < H && !layout.solid[y * W + x]) return app.select(-1, y * W + x);
  }
  app.select(-1);
});

// ───────────────────────────── keyboard ─────────────────────────────

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    app.togglePlay();
  } else if (tour.active && ['1', '2', '3', '4', 'b', 'B', 'r', 'R'].includes(e.key)) {
    return;
  } else if (e.key === '1') app.startScenario('deadlock');
  else if (e.key === '2') app.startScenario('crash');
  else if (e.key === '3') app.startScenario('pause');
  else if (e.key === '4') app.startScenario('manager');
  else if (e.key === 'b' || e.key === 'B') bench.open();
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
    else if (live.selected >= 0 || live.selectedCell >= 0) app.select(-1);
    else if (app.scenario) app.exitScenario();
  } else if (e.key === '.') {
    // single-step while paused
    if (!app.running) app.sim.step();
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
  if (app.running) {
    acc += dt * 1000 * app.speed;
    let n = 0;
    while (acc >= tickMs && n < 16) {
      sim.step();
      acc -= tickMs;
      n++;
    }
    if (n === 16) acc = 0;
    if (app.scenario) hud.checkScenario(SCENARIOS[app.scenario]);
  }
  sim.net.pruneFlights(sim.tick);
  const t = sim.tick + Math.min(acc / tickMs, 0.999);
  live.update(t, now, dt);
  warehouse.tickDim();
  tour.update(now);

  if (app.follow && live.selected >= 0) {
    const [x, y] = live.robotPos(live.selected);
    followTarget.set(wx(x), 0, wz(y));
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
