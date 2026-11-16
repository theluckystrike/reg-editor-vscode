'use strict';
// Pro tools' data work: comparing two key lists (from .reg files or hives), the .reg patch and Markdown report of a
// comparison, JSON and CSV exports, and the last write timeline. Key and value names compare without regard to case,
// as Windows does. No vscode import.
const V = require('./values');
const R = require('./regtext');

const low = (s) => String(s).toLowerCase();
const DEL = { kind: 'delete', text: '(delete)' };
const show = (v) => (v ? (v.bytes ? V.describe(v.type, v.bytes, 512) : DEL) : null);
const typeOf = (v) => (v && v.bytes ? V.typeName(v.type) : v ? 'delete' : '');

function index(entries) {
  const m = new Map();
  for (const e of entries) {
    const vals = new Map();
    for (const v of e.values || []) vals.set(low(v.name), v);
    const old = m.get(low(e.path));
    if (old) { for (const [k, v] of vals) old.values.set(k, v); old.deleted = !!e.deleted; } else m.set(low(e.path), { path: e.path, values: vals, deleted: !!e.deleted });
  }
  return m;
}

function sameValue(a, b) {
  if (!a.bytes || !b.bytes) return !a.bytes && !b.bytes;
  return V.sameData(a, b);
}

/** Compares key lists A and B. Returns { onlyA, onlyB, changed: [{ path, changes }], same, keysA, keysB, valueChanges }. */
function diff(entriesA, entriesB) {
  const A = index(entriesA), B = index(entriesB);
  const onlyA = [], onlyB = [], changed = [];
  let same = 0, valueChanges = 0;
  for (const [k, a] of A) {
    const b = B.get(k);
    if (!b || (b.deleted && !a.deleted)) { onlyA.push(a.path); continue; }
    if (a.deleted && !b.deleted) { onlyB.push(b.path); continue; }
    const changes = [];
    for (const [n, va] of a.values) {
      const vb = b.values.get(n);
      if (!vb) changes.push({ name: va.name, kind: 'removed', a: va, b: null });
      else if (!sameValue(va, vb)) changes.push({ name: vb.name, kind: 'changed', a: va, b: vb });
    }
    for (const [n, vb] of b.values) if (!a.values.has(n)) changes.push({ name: vb.name, kind: 'added', a: null, b: vb });
    if (changes.length) { changed.push({ path: b.path, changes }); valueChanges += changes.length; } else same++;
  }
  for (const [k, b] of B) if (!A.has(k)) onlyB.push(b.path);
  const live = (m) => [...m.values()].filter((x) => !x.deleted).length;
  return { onlyA, onlyB, changed, same, keysA: live(A), keysB: live(B), valueChanges, B };
}

/** Rows for tables: [{ path, name, kind, type, a, b }] with the data as text. */
function rows(r) {
  const out = [];
  for (const c of r.changed) for (const x of c.changes) {
    const a = show(x.a), b = show(x.b);
    out.push({ path: c.path, name: x.name === '' ? '(Default)' : x.name, kind: x.kind, type: typeOf(x.b || x.a), a: a ? a.text : '', b: b ? b.text : '' });
  }
  return out;
}

/** Topmost paths of a list (a key whose parent is in the list is left out). */
function topmost(paths) {
  const set = new Set(paths.map(low));
  return paths.filter((p) => { const parts = low(p).split('\\'); for (let i = 1; i < parts.length; i++) if (set.has(parts.slice(0, i).join('\\'))) return false; return true; });
}

/** A .reg patch (version 5.00 text) that turns A into B: deletes keys only in A, adds keys only in B, sets changed values. */
function patchText(r, version = 5) {
  const entries = [];
  for (const p of topmost(r.onlyA)) entries.push({ path: p, deleted: true });
  const onlyB = new Set(r.onlyB.map(low));
  const changed = new Map(r.changed.map((c) => [low(c.path), c]));
  for (const [k, b] of r.B) {
    if (b.deleted) { if (onlyB.has(k)) entries.push({ path: b.path, deleted: true }); continue; }
    if (onlyB.has(k)) entries.push({ path: b.path, values: [...b.values.values()] });
    else if (changed.has(k)) entries.push({ path: b.path, values: changed.get(k).changes.map((x) => (x.kind === 'removed' ? { name: x.a.name, type: -1, bytes: null } : x.b)) });
  }
  return R.toRegText(entries, version);
}

const mdCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' / ').slice(0, 300);

function toMarkdown(r, nameA, nameB, note) {
  const out = ['# Registry comparison', '', `- A: ${nameA} (${r.keysA} ${r.keysA === 1 ? 'key' : 'keys'})`, `- B: ${nameB} (${r.keysB} ${r.keysB === 1 ? 'key' : 'keys'})`,
    `- Keys only in A: ${r.onlyA.length}`, `- Keys only in B: ${r.onlyB.length}`, `- Changed keys: ${r.changed.length} (${r.valueChanges} value changes)`, `- Keys the same: ${r.same}`];
  if (note) out.push('', note);
  out.push('', '## Keys only in A', '');
  out.push(...(r.onlyA.length ? r.onlyA.map((p) => `- \`${p}\``) : ['None.']));
  out.push('', '## Keys only in B', '');
  out.push(...(r.onlyB.length ? r.onlyB.map((p) => `- \`${p}\``) : ['None.']));
  out.push('', '## Changed values', '');
  const rs = rows(r);
  if (rs.length) { out.push('| Key | Value | Change | Type | A | B |', '|---|---|---|---|---|---|'); for (const x of rs) out.push(`| ${mdCell(x.path)} | ${mdCell(x.name)} | ${x.kind} | ${x.type} | ${mdCell(x.a)} | ${mdCell(x.b)} |`); } else out.push('None.');
  return `${out.join('\n')}\n`;
}

// ---------- exports ----------
function toJson(entries, meta) {
  return `${JSON.stringify({
    ...meta,
    keys: entries.map((e) => ({
      path: e.path, ...(e.time ? { lastWrite: e.time } : {}), ...(e.deleted ? { deleted: true } : {}),
      values: (e.values || []).map((v) => ({ name: v.name, type: v.bytes ? V.typeName(v.type) : 'delete', data: V.jsonData(v.type, v.bytes) })),
    })),
  }, null, 2)}\n`;
}

const csvCell = (s) => { const t = String(s === undefined || s === null ? '' : s); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
function csvData(v) {
  if (!v.bytes) return '(delete)';
  const d = V.describe(v.type, v.bytes, 0);
  if (d.kind === 'number') return d.number;
  if (d.kind === 'multi') return d.parts.join('\n');
  return d.kind === 'hex' && !v.bytes.length ? '' : d.text;
}
function toCsv(entries) {
  const out = ['key,last_write,value,type,data'];
  for (const e of entries) {
    if (e.deleted) { out.push([e.path, e.time || '', '', 'delete key', ''].map(csvCell).join(',')); continue; }
    if (!e.values || !e.values.length) { out.push([e.path, e.time || '', '', '', ''].map(csvCell).join(',')); continue; }
    for (const v of e.values) out.push([e.path, e.time || '', v.name === '' ? '(Default)' : v.name, v.bytes ? V.typeName(v.type) : 'delete', csvData(v)].map(csvCell).join(','));
  }
  return `${out.join('\r\n')}\r\n`;
}

// ---------- timeline ----------
/** entries with time -> rows sorted newest first. */
function timeline(entries) {
  return entries.filter((e) => e.time).map((e) => ({ path: e.path, time: e.time, values: e.values.length, subkeys: e.nSub || 0 }))
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : a.path < b.path ? -1 : 1));
}
/** from / to: YYYY-MM-DD (to is inclusive) or ''; text: part of the key path. */
function filterTimeline(rows, { from, to, text } = {}) {
  const f = from ? `${from}T00:00:00Z` : '';
  const t = to ? `${to}T23:59:59.999Z` : '';
  const q = text ? low(text) : '';
  return rows.filter((r) => (!f || r.time >= f) && (!t || r.time <= t) && (!q || low(r.path).includes(q)));
}
function timelineCsv(rows) {
  return `${['last_write_utc,key,values,subkeys', ...rows.map((r) => [r.time, r.path, r.values, r.subkeys].map(csvCell).join(','))].join('\r\n')}\r\n`;
}

module.exports = { diff, rows, patchText, toMarkdown, toJson, toCsv, timeline, filterTimeline, timelineCsv, topmost };
