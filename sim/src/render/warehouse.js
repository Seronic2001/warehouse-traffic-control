// Static scenery: painted floor, pallet racks with totes, perimeter wall,
// packing stations in the bays, and the floating region-manager nodes.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { W, H, RW, RH, RX, RY, xOf, yOf, cellOf } from '../sim/layout.js';
import { theme } from './theme.js';

export const wx = (x) => x - W / 2 + 0.5;
export const wz = (y) => y - H / 2 + 0.5;

const PX = 64; // floor texture pixels per cell

// Materials the guided tour can fade down to spotlight something else.
// `key` names the theme colour each one takes (see applyTheme).
const dimmables = [];
function dimmable(mat, key) {
  dimmables.push({ mat, key, color: mat.color.clone() });
  return mat;
}
const themed = {}; // other theme-coloured materials, by role

export function buildWarehouse(scene, L, renderer) {
  const group = new THREE.Group();
  scene.add(group);

  // ── surrounding ground ──
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: theme.ground, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  group.add(ground);

  let grid = null;
  const makeGrid = () => {
    if (grid) (grid.removeFromParent(), grid.geometry.dispose(), grid.material.dispose());
    grid = new THREE.GridHelper(200, 100, theme.grid[0], theme.grid[1]);
    grid.position.y = -0.015;
    group.add(grid);
  };
  makeGrid();

  // ── painted warehouse floor ──
  const canvas = document.createElement('canvas');
  const tex = new THREE.CanvasTexture(paintFloor(L, canvas));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82, metalness: 0.05 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'floor';
  group.add(floor);

  buildRacks(group, L);
  buildWalls(group, L);
  buildStations(group, L);
  const managers = buildManagerNodes(group);
  const central = buildCentralNode(group);
  dimmable(floor.material, null);
  let current = 1;
  let target = 1;
  const fadeTo = new THREE.Color();
  const applyDim = () => {
    fadeTo.setHex(theme.fade.to);
    for (const d of dimmables) d.mat.color.copy(d.color).lerp(fadeTo, (1 - current) * theme.fade.amount);
  };
  // Fade the static scene towards the background (1 = normal).
  const setDim = (k) => (target = k);
  const tickDim = () => {
    if (Math.abs(current - target) < 0.002) return;
    current += (target - current) * 0.12;
    applyDim();
  };
  const applyTheme = () => {
    ground.material.color.setHex(theme.ground);
    makeGrid();
    paintFloor(L, canvas);
    tex.needsUpdate = true;
    for (const d of dimmables) {
      if (d.key === 'tote') continue;
      if (d.key) d.color.setHex(d.key.split('.').reduce((o, k) => o[k], theme));
    }
    themed.retint();
    themed.stationScreen.color.set(theme.station.screen[0]).multiplyScalar(theme.station.screen[1]);
    themed.stationLamp.color.set(theme.station.lamp[0]).multiplyScalar(theme.station.lamp[1]);
    themed.stationBelt.color.setHex(theme.station.belt);
    for (const n of [...managers, central]) n.beamMat.color.set(theme.manager.base);
    applyDim();
  };
  return { group, floor, managers, central, setDim, tickDim, applyTheme };
}

// ───────────────────────────── floor paint ─────────────────────────────

function paintFloor(L, cv) {
  const F = theme.floor;
  cv.width = W * PX;
  cv.height = H * PX;
  const g = cv.getContext('2d');
  const hwyRow = new Set(L.hwyRows);
  const hwyCol = new Set(L.hwyCols);

  g.fillStyle = F.base;
  g.fillRect(0, 0, cv.width, cv.height);

  for (let c = 0; c < L.N; c++) {
    const x = xOf(c), y = yOf(c);
    const px = x * PX, py = y * PX;
    if (L.wall[c]) {
      g.fillStyle = F.wall;
      g.fillRect(px, py, PX, PX);
    } else if (L.shelf[c]) {
      g.fillStyle = F.shelf;
      g.fillRect(px, py, PX, PX);
    } else if (L.bay[c]) {
      g.fillStyle = F.bay;
      g.fillRect(px, py, PX, PX);
    } else if (hwyRow.has(y) || hwyCol.has(x)) {
      g.fillStyle = F.hwy;
      g.fillRect(px, py, PX, PX);
    } else {
      g.fillStyle = F.aisle;
      g.fillRect(px, py, PX, PX);
    }
  }

  // cell grid
  g.strokeStyle = F.grid;
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x <= W; x++) (g.moveTo(x * PX + 0.5, 0), g.lineTo(x * PX + 0.5, cv.height));
  for (let y = 0; y <= H; y++) (g.moveTo(0, y * PX + 0.5), g.lineTo(cv.width, y * PX + 0.5));
  g.stroke();

  // crossing boxes: keep-clear hatch
  for (let c = 0; c < L.N; c++) {
    if (!L.box[c]) continue;
    const px = xOf(c) * PX, py = yOf(c) * PX;
    g.save();
    g.beginPath();
    g.rect(px, py, PX, PX);
    g.clip();
    g.strokeStyle = F.hatch;
    g.lineWidth = 3;
    for (let k = -PX; k < PX * 2; k += 12) {
      g.beginPath();
      g.moveTo(px + k, py);
      g.lineTo(px + k - PX, py + PX);
      g.stroke();
    }
    g.restore();
  }
  // outline each 2×2 box
  g.strokeStyle = F.boxLine;
  g.lineWidth = 2;
  for (let i = 0; i < L.hwyCols.length; i += 2)
    for (let j = 0; j < L.hwyRows.length; j += 2) {
      g.strokeRect(L.hwyCols[i] * PX + 4, L.hwyRows[j] * PX + 4, PX * 2 - 8, PX * 2 - 8);
    }

  // lane dividers (dashed, between the two lanes of each road)
  g.strokeStyle = F.divider;
  g.lineWidth = 2;
  g.setLineDash([PX * 0.35, PX * 0.3]);
  for (let i = 0; i < L.hwyRows.length; i += 2) {
    const y = (L.hwyRows[i] + 1) * PX;
    g.beginPath();
    g.moveTo(PX, y);
    g.lineTo(cv.width - PX, y);
    g.stroke();
  }
  for (let i = 0; i < L.hwyCols.length; i += 2) {
    const x = (L.hwyCols[i] + 1) * PX;
    g.beginPath();
    g.moveTo(x, PX);
    g.lineTo(x, cv.height - PX);
    g.stroke();
  }
  g.setLineDash([]);

  // direction chevrons on lanes and aisles
  g.strokeStyle = F.chevron;
  g.lineWidth = 3;
  g.lineCap = 'round';
  for (let c = 0; c < L.N; c++) {
    if (L.solid[c] || L.box[c]) continue;
    const x = xOf(c), y = yOf(c);
    const h = L.laneH[c], v = L.laneV[c];
    const onRow = hwyRow.has(y), onCol = hwyCol.has(x);
    let dx = 0, dy = 0;
    if (L.bay[c]) continue;
    if (onRow && h && x % 3 === 0) dx = h;
    else if (onCol && v && y % 3 === 0) dy = v;
    else if (!onRow && !onCol && v && y % 2 === 0) dy = v;
    if (!dx && !dy) continue;
    const cx = x * PX + PX / 2, cy = y * PX + PX / 2, s = PX * 0.16;
    g.beginPath();
    g.moveTo(cx - dx * s - dy * s, cy - dy * s - dx * s);
    g.lineTo(cx + dx * s, cy + dy * s);
    g.lineTo(cx - dx * s + dy * s, cy - dy * s + dx * s);
    g.stroke();
  }

  // station bays
  for (const c of L.stations) {
    const px = xOf(c) * PX, py = yOf(c) * PX;
    g.strokeStyle = F.stationLine;
    g.lineWidth = 3;
    roundRect(g, px + 7, py + 7, PX - 14, PX - 14, 8);
    g.stroke();
    g.fillStyle = F.stationFill;
    g.fill();
  }

  // region borders + labels
  g.strokeStyle = F.regionLine;
  g.lineWidth = 3;
  g.setLineDash([PX * 0.6, PX * 0.25]);
  for (let i = 1; i < RX; i++) {
    g.beginPath();
    g.moveTo(i * RW * PX, 0);
    g.lineTo(i * RW * PX, cv.height);
    g.stroke();
  }
  for (let j = 1; j < RY; j++) {
    g.beginPath();
    g.moveTo(0, j * RH * PX);
    g.lineTo(cv.width, j * RH * PX);
    g.stroke();
  }
  g.setLineDash([]);
  g.font = `600 ${PX * 0.32}px "JetBrains Mono", ui-monospace, monospace`;
  g.fillStyle = F.regionText;
  g.textBaseline = 'top';
  for (let j = 0; j < RY; j++)
    for (let i = 0; i < RX; i++) {
      const id = j * RX + i;
      const tx = i * RW * PX + PX * (i === 0 ? 1.25 : 0.25), ty = j * RH * PX + PX * (j === 0 ? 1.25 : 0.25);
      g.fillText(`REGION ${String(id).padStart(2, '0')}`, tx + PX * 2, ty + PX * 0.18);
    }
  return cv;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ───────────────────────────── racks ─────────────────────────────

function buildRacks(group, L) {
  const cells = [];
  for (let c = 0; c < L.N; c++) if (L.shelf[c]) cells.push(c);

  const RACK_H = 1.05;
  const parts = [];
  for (const sx of [-0.43, 0.43])
    for (const sz of [-0.43, 0.43]) {
      const post = new THREE.BoxGeometry(0.06, RACK_H, 0.06);
      post.translate(sx, RACK_H / 2, sz);
      parts.push(post);
    }
  const frame = mergeGeometries(parts);
  const beams = [];
  for (const h of [0.08, 0.52, 0.98]) {
    const b = new THREE.BoxGeometry(0.92, 0.035, 0.92);
    b.translate(0, h, 0);
    beams.push(b);
  }
  const deck = mergeGeometries(beams);

  const frameMesh = new THREE.InstancedMesh(frame, dimmable(new THREE.MeshStandardMaterial({ color: theme.rack.frame, roughness: 0.5, metalness: 0.35 }), 'rack.frame'), cells.length);
  const deckMesh = new THREE.InstancedMesh(deck, dimmable(new THREE.MeshStandardMaterial({ color: theme.rack.deck, roughness: 0.6, metalness: 0.25 }), 'rack.deck'), cells.length);
  const m = new THREE.Matrix4();
  cells.forEach((c, i) => {
    m.makeTranslation(wx(xOf(c)), 0, wz(yOf(c)));
    frameMesh.setMatrixAt(i, m);
    deckMesh.setMatrixAt(i, m);
  });
  for (const mesh of [frameMesh, deckMesh]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Totes on the two upper levels, deterministic pseudo-random fill.
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const totes = [];
  for (const c of cells)
    for (const level of [0.1, 0.54])
      for (const off of [-0.22, 0.22]) {
        if (rnd() < 0.35) continue;
        const h = 0.24 + rnd() * 0.16;
        totes.push({ x: wx(xOf(c)) + (rnd() - 0.5) * 0.06, z: wz(yOf(c)) + off, y: level + 0.02 + h / 2, h, col: (rnd() * 6) | 0 });
      }
  const tote = new THREE.InstancedMesh(new RoundedBoxGeometry(0.8, 1, 0.36, 2, 0.03), dimmable(new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.1 }), 'tote'), totes.length);
  const col = new THREE.Color();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  totes.forEach((t, i) => {
    m.compose(p.set(t.x, t.y, t.z), q, s.set(1, t.h, 1));
    tote.setMatrixAt(i, m);
  });
  themed.retint = () => {
    totes.forEach((t, i) => tote.setColorAt(i, col.setHex(theme.rack.totes[t.col])));
    tote.instanceColor.needsUpdate = true;
  };
  themed.retint();
  tote.castShadow = true;
  tote.receiveShadow = true;
  group.add(tote);
}

// ───────────────────────────── walls & stations ─────────────────────────────

function buildWalls(group, L) {
  const cells = [];
  for (let c = 0; c < L.N; c++) if (L.wall[c]) cells.push(c);
  const geo = new RoundedBoxGeometry(1, 0.55, 1, 2, 0.04);
  const mesh = new THREE.InstancedMesh(geo, dimmable(new THREE.MeshStandardMaterial({ color: theme.wall, roughness: 0.8, metalness: 0.05 }), 'wall'), cells.length);
  const m = new THREE.Matrix4();
  cells.forEach((c, i) => mesh.setMatrixAt(i, m.makeTranslation(wx(xOf(c)), 0.275, wz(yOf(c)))));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  // Safety stripe along the top of the wall. Each wall cell draws a short arm
  // from its centre towards every neighbouring wall cell, plus a square cap at
  // the centre, so straight runs are continuous and corners form a clean L.
  const W_STRIPE = 0.18;
  const arms = [];
  const isWall = (x, y) => x >= 0 && y >= 0 && x < W && y < H && L.wall[cellOf(x, y)];
  for (const c of cells) {
    const x = xOf(c), y = yOf(c);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isWall(x + dx, y + dy)) arms.push([x, y, dx, dy]);
  }
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0x332000, roughness: 0.6 });
  const armGeo = new THREE.BoxGeometry(0.5, 0.03, W_STRIPE).translate(0.25, 0, 0);
  const capGeo = new THREE.BoxGeometry(W_STRIPE, 0.03, W_STRIPE);
  const armMesh = new THREE.InstancedMesh(armGeo, stripeMat, arms.length);
  const capMesh = new THREE.InstancedMesh(capGeo, stripeMat, cells.length);
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  arms.forEach(([x, y, dx, dy], i) => {
    // The arm points along +x before rotation; turn it towards the neighbour.
    q.setFromAxisAngle(up, Math.atan2(-dy, dx));
    m.compose(new THREE.Vector3(wx(x), 0.565, wz(y)), q, one);
    armMesh.setMatrixAt(i, m);
  });
  cells.forEach((c, i) => capMesh.setMatrixAt(i, m.makeTranslation(wx(xOf(c)), 0.565, wz(yOf(c)))));
  group.add(armMesh, capMesh);
}

function buildStations(group, L) {
  const body = new RoundedBoxGeometry(1.6, 1.0, 2.6, 3, 0.08);
  const bodyMat = dimmable(new THREE.MeshStandardMaterial({ color: theme.station.body, roughness: 0.5, metalness: 0.2 }), 'station.body');
  const screenMat = (themed.stationScreen = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.station.screen[0]).multiplyScalar(theme.station.screen[1]) }));
  const beltMat = (themed.stationBelt = new THREE.MeshStandardMaterial({ color: theme.station.belt, roughness: 0.9 }));
  const lampMat = (themed.stationLamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.station.lamp[0]).multiplyScalar(theme.station.lamp[1]) }));
  for (const c of L.stations) {
    const x = xOf(c), y = yOf(c);
    let ox = 0, oz = 0, rot = 0;
    if (x === 0) (ox = -1.35), (rot = 0);
    else if (x === W - 1) (ox = 1.35), (rot = Math.PI);
    else if (y === 0) (oz = -1.35), (rot = -Math.PI / 2);
    else (oz = 1.35), (rot = Math.PI / 2);
    const g = new THREE.Group();
    g.position.set(wx(x) + ox, 0, wz(y) + oz);
    g.rotation.y = rot;
    const m = new THREE.Mesh(body, bodyMat);
    m.position.y = 0.5;
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    const belt = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 2.2), beltMat);
    belt.position.set(0.05, 1.03, 0);
    g.add(belt);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.3), screenMat);
    screen.position.set(0.81, 0.72, 0.85);
    screen.rotation.y = Math.PI / 2;
    g.add(screen);
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 12), lampMat);
    lamp.position.set(-0.55, 1.3, -1.0);
    g.add(lamp);
    group.add(g);
  }
}

// ───────────────────────────── region managers ─────────────────────────────

export const MANAGER_Y = 4.4;

function buildManagerNodes(group) {
  const nodes = [];
  const hex = new THREE.CylinderGeometry(0.42, 0.42, 0.14, 6);
  const ringGeo = new THREE.TorusGeometry(0.62, 0.025, 8, 48);
  const beamGeo = new THREE.CylinderGeometry(0.012, 0.012, MANAGER_Y - 1.2, 6);
  for (let j = 0; j < RY; j++)
    for (let i = 0; i < RX; i++) {
      const id = j * RX + i;
      const g = new THREE.Group();
      const cx = wx(i * RW + RW / 2 - 0.5), cz = wz(j * RH + RH / 2 - 0.5);
      g.position.set(cx, MANAGER_Y, cz);
      const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.manager.base), transparent: true, opacity: 0.9 });
      const core = new THREE.Mesh(hex, coreMat);
      g.add(core);
      const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.manager.base), transparent: true, opacity: 0.5 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
      const beamMat = new THREE.MeshBasicMaterial({ color: theme.manager.base, transparent: true, opacity: theme.manager.beam });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.y = -(MANAGER_Y - 1.2) / 2 - 0.1;
      g.add(beam);
      group.add(g);
      nodes.push({ id, group: g, core, ring, coreMat, ringMat, beamMat, baseY: MANAGER_Y, pos: new THREE.Vector3(cx, MANAGER_Y, cz) });
    }
  return nodes;
}

// Centralised mode: one server tower over the middle of the floor, standing
// in for all sixteen region managers. Same parts as a region node (core,
// ring, beam), so the live view drives it the same way. Hidden until a
// centralised run is shown.
export const CENTRAL_Y = 8.2;

function buildCentralNode(group) {
  const g = new THREE.Group();
  const cx = wx(W / 2 - 0.5), cz = wz(H / 2 - 0.5);
  g.position.set(cx, CENTRAL_Y, cz);
  const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.manager.base), transparent: true, opacity: 0.9 });
  // A stack of three server blades.
  const core = new THREE.Group();
  const blade = new THREE.CylinderGeometry(1.5, 1.5, 0.3, 6);
  for (let k = 0; k < 3; k++) {
    const m = new THREE.Mesh(blade, coreMat);
    m.position.y = (k - 1) * 0.46;
    m.scale.setScalar(1 - Math.abs(k - 1) * 0.12);
    core.add(m);
  }
  g.add(core);
  const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.manager.base), transparent: true, opacity: 0.5 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.06, 8, 64), ringMat);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  // The tower: a mast from the floor up to the server.
  const beamMat = new THREE.MeshBasicMaterial({ color: theme.manager.base, transparent: true, opacity: theme.manager.beam });
  const mastH = CENTRAL_Y - 0.7;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.32, mastH, 8), beamMat);
  beam.position.y = -mastH / 2 - 0.7;
  g.add(beam);
  g.visible = false;
  group.add(g);
  return { id: 0, central: true, group: g, core, ring, coreMat, ringMat, beamMat, baseY: CENTRAL_Y, pos: new THREE.Vector3(cx, CENTRAL_Y, cz) };
}

export { cellOf };
