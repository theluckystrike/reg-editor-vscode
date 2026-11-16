'use strict';
// One interface over a parsed .reg file and a binary hive, for the viewer and the Pro tools: tree nodes on demand,
// key details with decoded values, search, and flat key lists for export and comparison. No vscode import.
const V = require('./values');
const R = require('./regtext');
const H = require('./hive');

const MAX_TABLE_HEX = 1024;
const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function valueRow(v) {
  const d = V.describe(v.type, v.bytes, MAX_TABLE_HEX);
  return {
    name: v.name, type: v.type, typeName: v.bytes ? V.typeName(v.type) : 'delete', kind: d.kind, text: d.text, parts: d.parts,
    number: d.number, size: v.bytes ? v.bytes.length : 0, line: v.line || 0, endLine: v.endLine || 0, cut: !!d.cut, damaged: !!v.damaged,
  };
}

function matchText(v) {
  if (!v.bytes) return '';
  const d = V.describe(v.type, v.bytes, 256);
  return d.kind === 'number' ? `${d.text} ${d.number}` : d.text;
}

// ---------- .reg ----------
class RegSource {
  constructor(parsed, name) { this.kind = 'reg'; this.p = parsed; this.name = name; }
  node(k) { return { id: k.id, name: k.name, n: k.kids.length, v: k.values.length, del: k.deleted, imp: k.implicit }; }
  roots() { return this.p.roots.map((k) => this.node(k)); }
  children(id) { const k = this.p.keys.get(String(id)); return k ? k.kids.map((c) => this.node(c)) : []; }
  find(id) { return this.p.keys.get(String(id)) || null; }
  key(id) {
    const k = this.find(id);
    if (!k) return null;
    const info = [];
    if (k.deleted) info.push({ k: 'Status', v: 'Deleted by this file ([-...] line): importing removes the key and its subkeys.' });
    else if (k.implicit) info.push({ k: 'Status', v: 'No section of its own in this file; it holds the keys below it.' });
    if (k.sections.length) info.push({ k: k.sections.length > 1 ? 'Lines' : 'Line', v: k.sections.map((s) => (s.last > s.line ? `${s.line}-${s.last}` : `${s.line}`)).join(', ') });
    info.push({ k: 'Subkeys', v: String(k.kids.length) }, { k: 'Values', v: String(k.values.length) });
    return { id: k.id, path: k.path, name: k.name, values: k.values.map(valueRow), info, line: k.sections.length ? k.sections[0].line : 0, editable: !k.deleted && !k.implicit };
  }
  chain(id) {
    const out = [];
    for (let k = this.find(id); k; k = k.parent) out.unshift(k.id);
    return out;
  }
  search(q, max = 500) {
    const s = String(q).toLowerCase();
    const hits = [];
    let more = false;
    for (const k of this.p.keys.values()) {
      if (k.name.toLowerCase().includes(s)) { if (hits.length >= max) { more = true; break; } hits.push({ id: k.id, path: k.path, what: 'key' }); }
      for (const v of k.values) {
        const nm = v.name.toLowerCase().includes(s);
        if (nm || matchText(v).toLowerCase().includes(s)) { if (hits.length >= max) { more = true; break; } hits.push({ id: k.id, path: k.path, what: nm ? 'value' : 'data', value: v.name }); }
      }
      if (more) break;
    }
    return { hits, more };
  }
  facts(extra) {
    const p = this.p;
    return [
      { k: 'Format', v: p.version === 4 ? 'REGEDIT4' : p.version === 5 ? 'Registry Editor 5.00' : 'No valid header' },
      ...(extra && extra.encoding ? [{ k: 'Encoding', v: extra.encoding }] : []),
      { k: 'Keys', v: String(p.counts.keys) },
      { k: 'Values', v: String(p.counts.values) },
      { k: 'Deletions', v: String(p.counts.deletes) },
      { k: 'Lines', v: String(p.lineCount) },
      { k: 'Problems', v: String(p.errors.length) },
    ];
  }
  /** Keys for export and comparison: [{ path, values, deleted }]. scope: a key id (that key and the keys below it). */
  entries(scope) {
    const all = R.entries(this.p);
    if (scope === undefined || scope === null || scope === '') return all;
    const k = this.find(scope);
    if (!k) return all;
    const pre = `${k.id}\\`;
    return all.filter((e) => e.path.toLowerCase() === k.id || e.path.toLowerCase().startsWith(pre));
  }
  pathOf(id) { const k = this.find(id); return k ? k.path : ''; }
}

// ---------- hive ----------
class HiveSource {
  constructor(hive, name) { this.kind = 'hive'; this.h = hive; this.name = name; }
  node(k) { return { id: k.off, name: k.name, n: k.nSub, v: k.nVal, time: k.time }; }
  roots() { return [this.node(this.h.rootKey)]; }
  children(id) { const k = this.h.key(Number(id)); return k ? this.h.subkeys(k).map((c) => this.node(c)) : []; }
  key(id) {
    const k = this.h.key(Number(id));
    if (!k) return null;
    const cls = this.h.className(k);
    const info = [
      { k: 'Last write', v: V.timeText(k.time) },
      { k: 'Subkeys', v: String(k.nSub) }, { k: 'Values', v: String(k.nVal) },
      ...(cls ? [{ k: 'Class', v: cls }] : []),
      { k: 'Cell offset', v: `0x${k.off.toString(16)}` },
    ];
    return { id: k.off, path: this.h.path(k), name: k.name, values: this.h.values(k).map(valueRow), info, line: 0, editable: false, time: k.time };
  }
  chain(id) {
    const out = [];
    let k = this.h.key(Number(id));
    for (let i = 0; k && i < 512; i++) {
      out.unshift(k.off);
      if (k.off === this.h.header.root || (k.flags & 0x4)) break;
      k = this.h.key(k.parent);
    }
    return out;
  }
  search(q, max = 500) {
    const s = String(q).toLowerCase();
    const hits = [];
    let more = false;
    const root = this.h.rootKey.name;
    this.h.walk((k, rel) => {
      const path = rel ? `${root}\\${rel}` : root;
      if (k.name.toLowerCase().includes(s)) { if (hits.length >= max) { more = true; return false; } hits.push({ id: k.off, path, what: 'key' }); }
      if (k.nVal) for (const v of this.h.values(k)) {
        const nm = v.name.toLowerCase().includes(s);
        if (nm || matchText(v).toLowerCase().includes(s)) { if (hits.length >= max) { more = true; return false; } hits.push({ id: k.off, path, what: nm ? 'value' : 'data', value: v.name }); }
      }
      return true;
    });
    return { hits, more };
  }
  facts(extra) {
    const h = this.h.header;
    const st = this.h.stats();
    const f = [
      { k: 'Format', v: `Registry hive (regf ${this.h.version})` },
      { k: 'State', v: h.dirty ? `Not closed cleanly (sequence numbers ${h.seq1} and ${h.seq2})` : 'Clean' },
      { k: 'Root key', v: this.h.rootKey.name },
      ...(h.fileName ? [{ k: 'Name in header', v: h.fileName }] : []),
      { k: 'Last written', v: V.timeText(h.written) },
      { k: 'Hive type', v: H.HIVE_TYPES[h.type] || String(h.type) },
      { k: 'Keys', v: String(st.keys) }, { k: 'Values', v: String(st.values) },
      ...(st.newest ? [{ k: 'Newest key write', v: V.timeText(st.newest) }] : []),
      ...(st.oldest ? [{ k: 'Oldest key write', v: V.timeText(st.oldest) }] : []),
      { k: 'Header checksum', v: h.checksumOk ? 'OK' : 'Does not match' },
    ];
    if (extra && extra.size) f.splice(1, 0, { k: 'Size', v: sizeText(extra.size) });
    return f;
  }
  entries(scope, prefix) {
    const out = [];
    const start = scope !== undefined && scope !== null && scope !== '' ? this.h.key(Number(scope)) : this.h.rootKey;
    if (!start) return out;
    const base = start.off === this.h.rootKey.off ? '' : this.relPath(start);
    const pre = prefix === undefined ? this.h.rootKey.name : prefix;
    const visit = (k, rel) => {
      const r = base ? (rel ? `${base}\\${rel}` : base) : rel;
      out.push({ path: pre ? (r ? `${pre}\\${r}` : pre) : r, rel: r, values: this.h.values(k), time: k.time, nSub: k.nSub });
    };
    if (start.off === this.h.rootKey.off) this.h.walk(visit);
    else {
      const stack = [[start, '']];
      const seen = new Set();
      while (stack.length) {
        const [k, rel] = stack.pop();
        if (seen.has(k.off)) continue;
        seen.add(k.off);
        visit(k, rel);
        const kids = this.h.subkeys(k);
        for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], rel ? `${rel}\\${kids[i].name}` : kids[i].name]);
      }
    }
    return out;
  }
  relPath(k) { const p = this.h.path(k); const root = this.h.rootKey.name; return p === root ? '' : p.slice(root.length + 1); }
  pathOf(id) { const k = this.h.key(Number(id)); return k ? this.h.path(k) : ''; }
}

/**
 * Loads a file: { kind: 'reg' | 'hive' | 'notregf' | 'empty' | 'error', source, error, notes, encoding }.
 * asHive: the file was opened as a hive (no .reg reading). text: unsaved .reg text that wins over the bytes.
 */
function load(bytes, name, { asHive, text } = {}) {
  const out = { kind: 'error', source: null, error: '', notes: [], encoding: '' };
  if (typeof text === 'string') {
    const parsed = R.parse(text);
    out.kind = 'reg'; out.source = new RegSource(parsed, name); return out;
  }
  if (!bytes || !bytes.length) { out.kind = 'empty'; out.error = 'This file is empty.'; return out; }
  if (asHive || H.isHive(bytes)) {
    if (!H.isHive(bytes)) { out.kind = 'notregf'; out.error = 'This file is not a registry hive: it does not start with the "regf" signature.'; return out; }
    try {
      const h = new H.Hive(bytes);
      out.kind = 'hive';
      out.source = new HiveSource(h, name);
      if (h.header.dirty) out.notes.push(`This hive was not closed cleanly: the sequence numbers in its header differ (${h.header.seq1} and ${h.header.seq2}). Changes that Windows kept in the transaction logs (.LOG1, .LOG2) are not applied, so the newest changes can be missing. It opens read-only, as it is on disk.`);
      out.source.facts();
      for (const p of h.problems) out.notes.push(p);
    } catch (e) {
      out.kind = 'error'; out.error = String((e && e.message) || e);
    }
    return out;
  }
  const d = R.decodeBytes(bytes);
  out.kind = 'reg'; out.encoding = d.encoding; out.source = new RegSource(R.parse(d.text), name);
  return out;
}

module.exports = { RegSource, HiveSource, load, valueRow, sizeText };
