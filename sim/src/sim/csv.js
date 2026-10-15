// Benchmark results as CSV: one row per run, one column per summary field.
// Nested fields become dotted columns (recovery.crashOwnership), arrays a
// space-separated list (waitShare), null an empty cell. `tab` and `id` say
// which Benchmark tab and job the row is; `generated` and `seed` describe
// the whole file.
export function toCsv(rows) {
  const flat = rows.map((r) => flatten(r));
  const cols = [];
  for (const f of flat) for (const k of Object.keys(f)) if (!cols.includes(k)) cols.push(k);
  const lines = [cols.join(',')];
  for (const f of flat) lines.push(cols.map((c) => f[c] ?? '').join(','));
  return lines.join('\n') + '\n';
}

export function fromCsv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    const row = {};
    cols.forEach((c, i) => setPath(row, c, parse(c, cells[i])));
    return row;
  });
}

const TEXT = new Set(['tab', 'id', 'generated']);
const LISTS = new Set(['waitShare']);

function parse(col, v) {
  if (TEXT.has(col)) return v;
  if (LISTS.has(col)) return v ? v.split(' ').map(Number) : null;
  return v === '' || v === undefined ? null : Number(v);
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + k;
    if (Array.isArray(v)) out[key] = v.map(round).join(' ');
    else if (v && typeof v === 'object') flatten(v, key + '.', out);
    else out[key] = typeof v === 'number' ? round(v) : v ?? '';
  }
  return out;
}

const round = (v) => (Number.isInteger(v) ? v : +v.toPrecision(6));

function setPath(obj, path, v) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ??= {};
  o[parts[parts.length - 1]] = v;
}
