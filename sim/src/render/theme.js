// Every colour the 3D view and the HUD use, for both themes. `theme` is a
// live object: setThemeMode() swaps its contents and listeners re-apply.
import { STATUS, EVENT_COLORS, MODE_SERIES } from './palette.js';

const LIGHT = {
  mode: 'light',
  scene: {
    bg: 0xe9edf2, fogNear: 75, fogFar: 160, env: 0.6, exposure: 1.0,
    hemi: [0xffffff, 0xb8c2d0, 1.4], sun: [0xfff8ee, 2.0], fill: [0xdbe7ff, 0.6],
    bloom: [0.18, 0.3, 1.6],
  },
  ground: 0xe2e7ee, grid: [0xd3dae3, 0xd9dfe7],
  floor: {
    base: '#f3f5f8', wall: '#cfd6df', shelf: '#e1e6ec', bay: '#ddf1f6', hwy: '#e6eaf0', aisle: '#f7f8fa',
    grid: 'rgba(15,23,42,0.06)', hatch: 'rgba(217,119,6,0.10)', boxLine: 'rgba(217,119,6,0.45)',
    divider: 'rgba(234,179,8,0.85)', chevron: 'rgba(30,41,59,0.22)',
    stationLine: 'rgba(8,145,178,0.85)', stationFill: 'rgba(8,145,178,0.10)',
    regionLine: 'rgba(37,99,235,0.40)', regionText: 'rgba(37,99,235,0.55)',
  },
  rack: { frame: 0x3f6db3, deck: 0xd3d9e1, totes: [0xd8b98c, 0xcfae80, 0xe2c79f, 0x9fb6cf, 0xc5ccd6, 0xd3b48a] },
  wall: 0xc6ced9,
  station: { body: 0xdfe5ec, belt: 0x475569, screen: ['#0891b2', 1], lamp: ['#16a34a', 1] },
  fade: { to: 0xeef1f5, amount: 0.8 },
  manager: { base: '#2563eb', blocked: '#d97706', selected: '#0f172a', glow: false, beam: 0.25 },
  robot: {
    body: 0x2f3742, dead: 0x9aa3ae, paused: 0x3d5a8a, skirt: 0x1b2028, disc: 0xaab3bf, eye: ['#ffffff', 1],
    dimBody: 0xd3d9e1, dimBand: 0xc5cdd7,
  },
  band: {
    moving: ['#06b6d4', 1.15], work: ['#22c55e', 1.15], wait: ['#f59e0b', 1.2], deadlock: ['#f43f5e', 1.3],
    yield: ['#8b5cf6', 1.2], paused: ['#60a5fa', 1.2], crashed: ['#94a3b8', 1], crashedBlink: ['#e11d48', 1.2],
  },
  additive: false,
  tile: { opacity: 0.75, fill: 0.55, moving: ['#22d3ee', 1], waiting: ['#67e8f9', 1], selected: ['#0891b2', 1], keep: ['#06b6d4', 1], own: ['#94a3b8', 1] },
  stripe: { bg: 'rgba(255,247,230,0.9)', line: 'rgba(217,119,6,0.95)' },
  arcs: { wait: ['#e08a00', 1], cycle: ['#e11d48', 1], waitWidth: 3 },
  probe: { head: ['#a21caf', 1], tail: ['#d946ef', 1] },
  msg: {
    REQ: '#334155', GRANT: '#0891b2', QUEUED: '#d97706', DENIED: '#ea580c', RELEASE: '#16a34a', RENEW: '#94a3b8',
    RENEWED: '#94a3b8', CANCEL: '#7c3aed', BLOCKED: '#d97706', CLEARED: '#16a34a', REJOIN: '#7c3aed', lost: '#e11d48', k: 1,
  },
  burst: { collision: '#e11d48', fenced: '#be123c', cleared: '#16a34a', yield: '#7c3aed', other: '#334155', deadlock: '#e11d48', k: 1 },
  cordon: ['#d97706', 1], marker: ['#0f172a', 1], pathDot: ['#0891b2', 1], beacon: '#0891b2',
  regions: { tints: ['#0ea5e9', '#8b5cf6'], k: 1, edgeK: 1, opacity: 0.16, softOpacity: 0.05 },
  status: {
    moving: '#0891b2', work: '#16a34a', wait: '#f59e0b', deadlock: '#e11d48', yield: '#7c3aed', paused: '#3b82f6', crashed: '#64748b',
  },
  events: {
    deadlock: '#e11d48', fenced: '#be123c', blocked: '#d97706', regrant: '#0891b2', expired: '#94a3b8', cleared: '#16a34a',
    respawn: '#16a34a', crash: '#ea580c', pause: '#3b82f6', collision: '#e11d48',
    mgrdown: '#e11d48', mgrrestart: '#7c3aed', reconciled: '#16a34a',
  },
  mgrState: { down: '#e11d48', reconciling: '#7c3aed' },
  series: { baseline: '#2a78d6', detect: '#eb6834', ordered: '#1baf7a' },
};

// Night: a calm charcoal palette with matte materials and no bloom, mirroring
// the light theme's structure rather than a neon "glow" look.
const DARK = {
  mode: 'dark',
  scene: {
    bg: 0x15181d, fogNear: 80, fogFar: 170, env: 0.4, exposure: 1.0,
    hemi: [0xd6dde8, 0x2a2f37, 1.05], sun: [0xfff4e6, 1.6], fill: [0x9fb3d1, 0.35],
    bloom: [0, 0, 10],
  },
  ground: 0x1a1d22, grid: [0x1f2329, 0x1d2025],
  floor: {
    base: '#262a31', wall: '#1c1f24', shelf: '#22262c', bay: '#233238', hwy: '#2d3139', aisle: '#292d34',
    grid: 'rgba(255,255,255,0.045)', hatch: 'rgba(245,158,11,0.09)', boxLine: 'rgba(245,158,11,0.32)',
    divider: 'rgba(234,179,8,0.5)', chevron: 'rgba(226,232,240,0.15)',
    stationLine: 'rgba(125,190,214,0.55)', stationFill: 'rgba(125,190,214,0.07)',
    regionLine: 'rgba(140,165,210,0.32)', regionText: 'rgba(150,170,205,0.5)',
  },
  rack: { frame: 0x4d6a93, deck: 0x3b4048, totes: [0x8a7356, 0x7b6a54, 0x957f60, 0x5d6f84, 0x6b717a, 0x84704f] },
  wall: 0x30353d,
  station: { body: 0x363b44, belt: 0x1d2026, screen: ['#6cb6cf', 1], lamp: ['#4fae7c', 1] },
  fade: { to: 0x15181d, amount: 0.8 },
  manager: { base: '#7896d6', blocked: '#e0a030', selected: '#ffffff', glow: false, beam: 0.25 },
  robot: {
    body: 0xd3d8df, dead: 0x4d535c, paused: 0x9db3d6, skirt: 0x2a2e35, disc: 0x8d95a0, eye: ['#ffffff', 1],
    dimBody: 0x2c3037, dimBand: 0x32363d,
  },
  band: {
    moving: ['#38bdf8', 1], work: ['#4ade80', 1], wait: ['#fbbf24', 1], deadlock: ['#f87171', 1],
    yield: ['#a78bfa', 1], paused: ['#93c5fd', 1], crashed: ['#4b5563', 1], crashedBlink: ['#ef4444', 1],
  },
  additive: false,
  tile: { opacity: 0.6, fill: 0.4, moving: ['#38bdf8', 1], waiting: ['#7dd3fc', 0.75], selected: ['#e0f2fe', 1], keep: ['#38bdf8', 1], own: ['#64748b', 1] },
  stripe: { bg: 'rgba(40,30,10,0.85)', line: 'rgba(251,191,36,0.9)' },
  arcs: { wait: ['#fbbf24', 1], cycle: ['#f87171', 1], waitWidth: 2.6 },
  probe: { head: ['#f5d0fe', 1], tail: ['#d946ef', 1] },
  msg: {
    REQ: '#cbd5e1', GRANT: '#38bdf8', QUEUED: '#fbbf24', DENIED: '#fb923c', RELEASE: '#4ade80', RENEW: '#64748b',
    RENEWED: '#64748b', CANCEL: '#a78bfa', BLOCKED: '#fbbf24', CLEARED: '#4ade80', REJOIN: '#a78bfa', lost: '#f87171', k: 1,
  },
  burst: { collision: '#f87171', fenced: '#fb7185', cleared: '#4ade80', yield: '#a78bfa', other: '#cbd5e1', deadlock: '#f87171', k: 1 },
  cordon: ['#fbbf24', 1], marker: ['#f1f5f9', 1], pathDot: ['#38bdf8', 1], beacon: '#38bdf8',
  regions: { tints: ['#38bdf8', '#a78bfa'], k: 1, edgeK: 1, opacity: 0.12, softOpacity: 0.05 },
  status: {
    moving: '#38bdf8', work: '#4ade80', wait: '#fbbf24', deadlock: '#f87171', yield: '#a78bfa', paused: '#93c5fd', crashed: '#6b7280',
  },
  events: {
    deadlock: '#f87171', fenced: '#fb7185', blocked: '#fbbf24', regrant: '#38bdf8', expired: '#7a818c', cleared: '#4ade80',
    respawn: '#4ade80', crash: '#fb923c', pause: '#93c5fd', collision: '#f87171',
    mgrdown: '#f87171', mgrrestart: '#a78bfa', reconciled: '#4ade80',
  },
  mgrState: { down: '#f87171', reconciling: '#a78bfa' },
  series: { baseline: '#3987e5', detect: '#d95926', ordered: '#199e70' },
};

export const theme = {};
const listeners = [];

export function onThemeChange(fn) {
  listeners.push(fn);
}

export function setThemeMode(mode) {
  const src = mode === 'dark' ? DARK : LIGHT;
  for (const k of Object.keys(theme)) delete theme[k];
  Object.assign(theme, structuredClone(src));
  // The shared HUD palettes are mutated in place so existing imports see them.
  for (const [k, hex] of Object.entries(src.status)) STATUS[k].hex = hex;
  Object.assign(EVENT_COLORS, src.events);
  for (const [k, hex] of Object.entries(src.series)) MODE_SERIES[k].hex = hex;
  document.documentElement.dataset.theme = mode;
  for (const fn of listeners) fn(theme);
}

setThemeMode('light');
