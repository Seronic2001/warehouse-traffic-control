// A styled menu in place of a <select>'s browser-drawn option list. The
// <select> stays in the page (hidden) as the source of truth: picking an
// item sets its value and fires the usual 'input' and 'change' events, so
// code that listens to the select needs no changes. Call sync() after
// setting the select's value from code.
//
// `describe(value)` gives each item { dot, note }: a colour and a short line
// under the label.
export function dropdown(select, describe) {
  const wrap = select.parentElement;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dd-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const label = select.closest('.field')?.querySelector('span')?.textContent;
  if (label) button.setAttribute('aria-label', label);
  wrap.appendChild(button);
  select.hidden = true;
  select.tabIndex = -1;

  // The list lives on <body>: the side panel scrolls, and would clip it.
  const list = document.createElement('ul');
  list.className = 'dd-list';
  list.setAttribute('role', 'listbox');
  list.tabIndex = -1;
  list.hidden = true;
  document.body.appendChild(list);

  const opts = [...select.options];
  const items = opts.map((o, i) => {
    const d = describe(o.value);
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.id = `${select.id}-opt-${i}`;
    li.innerHTML = `<i style="--c:${d.dot}"></i><span><b></b><small></small></span>`;
    li.querySelector('b').textContent = o.textContent;
    li.querySelector('small').textContent = d.note;
    li.addEventListener('mousemove', () => setActive(i));
    li.addEventListener('click', () => pick(i));
    list.appendChild(li);
    return li;
  });

  let active = -1;
  const setActive = (i) => {
    active = i;
    items.forEach((li, k) => li.classList.toggle('active', k === i));
    if (i >= 0) {
      list.setAttribute('aria-activedescendant', items[i].id);
      items[i].scrollIntoView({ block: 'nearest' });
    }
  };

  const sync = () => {
    const i = select.selectedIndex;
    const d = describe(select.value);
    button.innerHTML = `<i style="--c:${d.dot}"></i><span></span>`;
    button.querySelector('span').textContent = opts[i]?.textContent ?? '';
    items.forEach((li, k) => li.setAttribute('aria-selected', k === i));
  };

  const place = () => {
    const r = button.getBoundingClientRect();
    const w = Math.max(r.width, Math.min(320, window.innerWidth - 16));
    list.style.width = `${w}px`;
    list.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    // Below the button if it fits, otherwise above.
    const h = list.offsetHeight;
    const below = r.bottom + 6 + h <= window.innerHeight - 8;
    list.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - h)}px`;
  };

  const open = () => {
    if (!list.hidden) return;
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('open');
    place();
    setActive(select.selectedIndex);
    list.focus({ preventScroll: true });
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
    window.addEventListener('resize', close);
    select.closest('.panel')?.addEventListener('scroll', close, { once: true });
  };

  const close = (refocus = false) => {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('open');
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', close);
    if (refocus === true) button.focus();
  };

  const outside = (e) => {
    if (!list.contains(e.target) && !button.contains(e.target)) close();
  };

  const pick = (i) => {
    const changed = i !== select.selectedIndex;
    select.selectedIndex = i;
    sync();
    close(true);
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  button.addEventListener('click', () => (list.hidden ? open() : close()));
  // Keys stay here: Space, digits and letters are also app shortcuts.
  button.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      open();
    }
  });
  list.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const n = items.length;
    if (e.key === 'ArrowDown') setActive((active + 1) % n);
    else if (e.key === 'ArrowUp') setActive((active - 1 + n) % n);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(n - 1);
    else if (e.key === 'Enter' || e.key === ' ') active >= 0 && pick(active);
    else if (e.key === 'Escape') close(true);
    else if (e.key === 'Tab') return close();
    else {
      // Type to jump to the next item starting with that letter.
      const k = e.key.length === 1 && e.key.toLowerCase();
      const j = k ? opts.findIndex((o, idx) => idx > active && o.textContent.toLowerCase().startsWith(k)) : -1;
      const first = k ? opts.findIndex((o) => o.textContent.toLowerCase().startsWith(k)) : -1;
      if (j >= 0 || first >= 0) setActive(j >= 0 ? j : first);
      else return;
    }
    e.preventDefault();
  });

  sync();
  return { sync, close };
}
