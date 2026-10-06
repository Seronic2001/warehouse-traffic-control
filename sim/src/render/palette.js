// One status vocabulary shared by the 3D view, the HUD and the legend.
export const STATUS = {
  moving: { hex: '#0891b2', label: 'Moving', short: 'Moving' },
  work: { hex: '#16a34a', label: 'Picking / dropping', short: 'Working' },
  wait: { hex: '#f59e0b', label: 'Waiting for a lease', short: 'Waiting' },
  deadlock: { hex: '#e11d48', label: 'In a deadlock cycle', short: 'Deadlocked' },
  yield: { hex: '#7c3aed', label: 'Yielding / resyncing', short: 'Yielding' },
  paused: { hex: '#3b82f6', label: 'Paused (frozen)', short: 'Frozen' },
  crashed: { hex: '#64748b', label: 'Crashed', short: 'Crashed' },
};

export const EVENT_COLORS = {
  deadlock: '#e11d48',
  fenced: '#be123c',
  blocked: '#d97706',
  regrant: '#0891b2',
  expired: '#94a3b8',
  cleared: '#16a34a',
  respawn: '#16a34a',
  crash: '#ea580c',
  pause: '#3b82f6',
  collision: '#e11d48',
};

// Benchmark series: categorical slots 1–3 of the validated light palette.
export const MODE_SERIES = {
  baseline: { hex: '#2a78d6', label: 'Baseline (no coordination)' },
  detect: { hex: '#eb6834', label: 'Leases + edge-chasing' },
  ordered: { hex: '#1baf7a', label: 'Ordered acquisition' },
};
