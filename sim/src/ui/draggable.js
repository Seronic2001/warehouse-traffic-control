// Lets a floating card be dragged out of the way by its header. The offset
// lives in the CSS `translate` property, so it composes with each card's own
// `transform` centring and entry animation. Double-click a handle to reset.
const INTERACTIVE = 'button, a, input, select, textarea, [role="tab"]';
const MARGIN = 8;

export function makeDraggable(el, handles) {
  let dx = 0, dy = 0;
  const apply = () => { el.style.translate = dx || dy ? `${dx}px ${dy}px` : ''; };

  // Keep the whole card on screen given a wanted offset.
  const clamp = (x, y) => {
    const r = el.getBoundingClientRect();
    const baseL = r.left - dx, baseT = r.top - dy;
    const maxX = window.innerWidth - MARGIN - r.width - baseL;
    const maxY = window.innerHeight - MARGIN - r.height - baseT;
    return [
      Math.min(Math.max(x, MARGIN - baseL), Math.max(maxX, MARGIN - baseL)),
      Math.min(Math.max(y, MARGIN - baseT), Math.max(maxY, MARGIN - baseT)),
    ];
  };

  for (const h of handles) {
    h.classList.add('drag-handle');
    h.title ||= 'Drag to move · double-click to reset';
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest(INTERACTIVE)) return;
      e.preventDefault();
      const sx = e.clientX - dx, sy = e.clientY - dy;
      h.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      const move = (ev) => { [dx, dy] = clamp(ev.clientX - sx, ev.clientY - sy); apply(); };
      const up = () => {
        el.classList.remove('dragging');
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
    h.addEventListener('dblclick', (e) => {
      if (e.target.closest(INTERACTIVE)) return;
      dx = dy = 0; apply();
    });
  }

  window.addEventListener('resize', () => {
    if (!dx && !dy) return;
    [dx, dy] = clamp(dx, dy); apply();
  });
}
