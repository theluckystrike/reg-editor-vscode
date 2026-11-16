'use strict';
// .reg files (Windows Registry Editor version 5.00 and REGEDIT4): read the text into a key tree with typed values and
// line numbers, report bad lines, and write keys and values back as .reg text. Written for this extension from the
// documented .reg syntax; nothing here touches a live registry. No vscode import.
const V = require('./values');

const HEADER5 = 'Windows Registry Editor Version 5.00';
const HEADER4 = 'REGEDIT4';
const ROOTS = ['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG', 'HKEY_PERFORMANCE_DATA', 'HKEY_DYN_DATA'];
const ROOT_SET = new Set(ROOTS);

// Windows-1252 for 0x80..0x9F (the rest of the byte range matches Latin-1). REGEDIT4 files hold ANSI text.
const CP1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
const FROM1252 = new Map(CP1252.map((c, i) => [c, 0x80 + i]));
function ansiDecode(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b >= 0x80 && b < 0xa0 ? CP1252[b - 0x80] : b); return s; }
function ansiEncode(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80 || (c >= 0xa0 && c < 0x100)) out.push(c);
    else if (FROM1252.has(c)) out.push(FROM1252.get(c));
    else out.push(0x3f); // "?" as Windows writes a character the code page lacks
  }
  return Buffer.from(out);
}

/** Text of a .reg file from its bytes: UTF-16LE or UTF-16BE with a BOM, UTF-8 (BOM optional), else Windows-1252. */
function decodeBytes(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { text: b.subarray(2).toString('utf16le'), encoding: 'UTF-16LE' };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { const c = Buffer.from(b.subarray(2)); c.swap16 && c.length % 2 === 0 && c.swap16(); return { text: c.toString('utf16le'), encoding: 'UTF-16BE' }; }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: b.subarray(3).toString('utf8'), encoding: 'UTF-8' };
  const u = b.toString('utf8');
  if (!u.includes('�')) return { text: u, encoding: 'UTF-8' };
  return { text: ansiDecode(b), encoding: 'Windows-1252' };
}

/** Reads a quoted string at s[i] === '"'. Returns { value, end } (end = index after the closing quote) or { error }. */
function readQuoted(s, i) {
  let out = '';
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && (s[j + 1] === '\\' || s[j + 1] === '"')) { out += s[j + 1]; j += 2; continue; }
    if (c === '"') return { value: out, end: j + 1 };
    out += c; j++;
  }
  return { error: 'The closing quote is missing.' };
}

function parseHexBytes(s) {
  const t = s.replace(/[\s\\]/g, '');
  if (!t) return { bytes: Buffer.alloc(0) };
  const parts = t.split(',');
  if (parts[parts.length - 1] === '') parts.pop();
  const out = Buffer.alloc(parts.length);
  for (let i = 0; i < parts.length; i++) {
    if (!/^[0-9a-f]{1,2}$/i.test(parts[i])) return { error: `"${parts[i].slice(0, 20)}" is not a byte: hex data is two hex digits per byte, with commas between.` };
    out[i] = parseInt(parts[i], 16);
  }
  return { bytes: out };
}

/** Parses value data text (after the "="). version 4 reads hex string types as ANSI. Returns { type, bytes, form } or { error }. */
function parseData(d, version) {
  const t = d.trim();
  if (t === '-') return { type: -1, bytes: null, form: 'delete' };
  if (t.startsWith('"')) {
    const q = readQuoted(t, 0);
    if (q.error) return q;
    if (t.slice(q.end).trim()) return { error: `Unexpected text after the closing quote: "${t.slice(q.end).trim().slice(0, 30)}".` };
    return { type: 1, bytes: V.utf16z(q.value), form: 'string' };
  }
  let m = /^dword:(.*)$/i.exec(t);
  if (m) {
    if (!/^[0-9a-f]{1,8}$/i.test(m[1].trim())) return { error: `"dword:${m[1].trim().slice(0, 20)}" is not a DWORD: write 1 to 8 hex digits, such as dword:0000002a.` };
    const b = Buffer.alloc(4); b.writeUInt32LE(parseInt(m[1].trim(), 16) >>> 0, 0);
    return { type: 4, bytes: b, form: 'dword' };
  }
  m = /^hex(?:\(([^)]*)\))?:([\s\S]*)$/i.exec(t);
  if (m) {
    let type = 3;
    if (m[1] !== undefined) {
      if (!/^[0-9a-f]{1,8}$/i.test(m[1].trim())) return { error: `"hex(${m[1].slice(0, 12)})" is not a value type: write hex(2), hex(7), hex(b) and so on.` };
      type = parseInt(m[1].trim(), 16) >>> 0;
    }
    const h = parseHexBytes(m[2]);
    if (h.error) return h;
    let bytes = h.bytes;
    if (version === 4 && (V.STRING_TYPES.has(type) || type === 7)) bytes = Buffer.from(ansiDecode(bytes), 'utf16le');
    return { type, bytes, form: 'hex' };
  }
  return { error: `Unknown value data "${t.slice(0, 30)}": use "text", dword:, hex:, hex(n): or - (delete).` };
}

/**
 * Parses .reg text. Returns { version, header, keys (Map lower path -> key), roots, errors, lineCount, counts }.
 * counts.keys counts keys the file sets (not the ones it deletes); counts.deletes counts deleted keys and values.
 * key: { id, path, name, parent, kids, values, valueMap, sections [{ line, last }], deleted, implicit }.
 * value: { name, type, bytes (null = delete), form, line, endLine }. Lines are 1-based.
 */
function parse(text) {
  const src = String(text).replace(/^﻿/, '');
  const lines = src.split(/\r\n|\n|\r/);
  const errors = [];
  const err = (line, message, endLine, severity) => errors.push({ line, endLine: endLine || line, message, severity: severity || 'error' });
  const keys = new Map();
  const roots = [];
  const counts = { keys: 0, values: 0, deletes: 0 };
  let version = 0;
  let header = '';

  const ensure = (parts) => {
    let parent = null;
    let p = '';
    for (const part of parts) {
      p = p ? `${p}\\${part}` : part;
      const id = p.toLowerCase();
      let k = keys.get(id);
      if (!k) {
        k = { id, path: p, name: part, parent, kids: [], values: [], valueMap: new Map(), sections: [], deleted: false, implicit: true };
        keys.set(id, k);
        if (parent) parent.kids.push(k); else roots.push(k);
      }
      parent = k;
    }
    return parent;
  };

  let first = lines.findIndex((l) => l.trim() !== '');
  if (first >= 0) {
    const h = lines[first].trim();
    if (h === HEADER5) version = 5;
    else if (h === HEADER4) version = 4;
    if (version) { header = h; if (first !== 0) err(1, 'The header line must be the first line of the file.'); }
    else { err(first + 1, `The first line must be "${HEADER5}" (or "${HEADER4}" for the older format).`); first = -1; }
  } else err(1, 'The file has no header line and no keys.');
  const readVersion = version || 5;

  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (i === first) continue;
    const startLine = i + 1;
    let line = lines[i];
    const lt = line.trim();
    if (!lt || lt.startsWith(';')) continue;
    if (lt.startsWith('[')) {
      if (!lt.endsWith(']')) { err(startLine, 'A key line must end with "]".'); cur = null; continue; }
      let p = lt.slice(1, -1);
      const del = p.startsWith('-');
      if (del) p = p.slice(1);
      const parts = p.split('\\');
      if (!p || parts.some((x) => x === '')) { err(startLine, `"${p.slice(0, 60)}" is not a key path: it has an empty part (two backslashes in a row, or one at the start or end).`); cur = null; continue; }
      if (!ROOT_SET.has(parts[0].toUpperCase())) err(startLine, `"${parts[0].slice(0, 40)}" is not a registry root. A .reg key starts with HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER, HKEY_CLASSES_ROOT, HKEY_USERS or HKEY_CURRENT_CONFIG.`, startLine, 'warning');
      const k = ensure(parts);
      k.implicit = false;
      k.deleted = del;
      if (del) { counts.deletes++; cur = null; k.sections.push({ line: startLine, last: startLine, del: true }); continue; }
      cur = { key: k, section: { line: startLine, last: startLine } };
      k.sections.push(cur.section);
      continue;
    }
    // A value line, possibly continued with a trailing backslash (hex data over several lines).
    let endLine = startLine;
    if (/^\s*(@|"(?:[^"\\]|\\.)*")\s*=\s*hex/i.test(line)) {
      while (/\\\s*$/.test(line) && i + 1 < lines.length) { line = line.replace(/\\\s*$/, '') + lines[i + 1].trim(); i++; endLine = i + 1; }
    }
    const t = line.trim();
    let name;
    let rest;
    if (t.startsWith('@')) { name = ''; rest = t.slice(1); }
    else if (t.startsWith('"')) {
      const q = readQuoted(t, 0);
      if (q.error) { err(startLine, `The value name has no closing quote.`, endLine); continue; }
      name = q.value; rest = t.slice(q.end);
    } else { err(startLine, `This line is not a key, a value or a comment: "${t.slice(0, 40)}". Values look like "Name"="text" or @="text"; comments start with ";".`, endLine); continue; }
    rest = rest.trimStart();
    if (!rest.startsWith('=')) { err(startLine, 'The "=" after the value name is missing.', endLine); continue; }
    if (!cur) { err(startLine, 'This value comes before any key line, so it belongs to no key.', endLine); continue; }
    const d = parseData(rest.slice(1), readVersion);
    if (d.error) { err(startLine, d.error, endLine); continue; }
    const v = { name, type: d.type, bytes: d.bytes, form: d.form, line: startLine, endLine };
    const lk = name.toLowerCase();
    const old = cur.key.valueMap.get(lk);
    if (old) cur.key.values[cur.key.values.indexOf(old)] = v; else cur.key.values.push(v);
    cur.key.valueMap.set(lk, v);
    cur.section.last = endLine;
    if (d.form === 'delete') counts.deletes++; else counts.values++;
  }
  for (const k of keys.values()) if (!k.implicit && !k.deleted) counts.keys++;
  return { version, header, keys, roots, errors, lineCount: lines.length, counts };
}

// ---------- writing ----------
function quote(s) { return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
const nameText = (n) => (n === '' ? '@' : quote(n));

function hexLines(prefix, bytes) {
  if (!bytes.length) return [prefix];
  const out = [];
  let cur = prefix;
  for (let i = 0; i < bytes.length; i++) {
    const piece = bytes[i].toString(16).padStart(2, '0') + (i < bytes.length - 1 ? ',' : '');
    if (cur.length + piece.length > 77 && cur.length > 2 && cur !== prefix) { out.push(`${cur}\\`); cur = '  '; }
    cur += piece;
  }
  out.push(cur);
  return out;
}

/** Lines of one value in .reg syntax for version 5 or 4. */
function valueLines(v, version = 5) {
  const head = `${nameText(v.name)}=`;
  if (!v.bytes) return [`${head}-`];
  const b = Buffer.from(v.bytes.buffer, v.bytes.byteOffset, v.bytes.byteLength);
  if (v.type === 1 && b.length >= 2 && b.length % 2 === 0) {
    const s = V.readUtf16(b);
    if (!/[\r\n\u0000]/.test(s) && Buffer.compare(V.utf16z(s), b) === 0 && (version !== 4 || ansiDecode(ansiEncode(s)) === s)) return [`${head}${quote(s)}`];
  }
  if (v.type === 4 && b.length === 4) return [`${head}dword:${b.readUInt32LE(0).toString(16).padStart(8, '0')}`];
  let data = b;
  if (version === 4 && (V.STRING_TYPES.has(v.type) || v.type === 7)) data = ansiEncode(b.subarray(0, b.length - (b.length % 2)).toString('utf16le'));
  const prefix = v.type === 3 ? `${head}hex:` : `${head}hex(${(v.type >>> 0).toString(16)}):`;
  return hexLines(prefix, data);
}

/** .reg text. entries: [{ path, values, deleted }] in order. Returns a string with CRLF line ends. */
function toRegText(entries, version = 5) {
  const out = [version === 4 ? HEADER4 : HEADER5, ''];
  for (const e of entries) {
    if (e.deleted) { out.push(`[-${e.path}]`, ''); continue; }
    out.push(`[${e.path}]`);
    for (const v of e.values) for (const l of valueLines(v, version)) out.push(l);
    out.push('');
  }
  return out.join('\r\n') + '\r\n';
}

/** Bytes of a .reg file as Windows writes it: version 5 in UTF-16LE with a BOM, REGEDIT4 in Windows-1252. */
function encodeReg(text, version = 5) {
  if (version === 4) return ansiEncode(text);
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

/** Every key with a section of its own, in file order (keys with no section of their own are left out). */
function entries(parsed) {
  const out = [];
  const walk = (k) => { if (!k.implicit) out.push({ path: k.path, values: k.values, deleted: k.deleted, key: k }); for (const c of k.kids) walk(c); };
  for (const r of parsed.roots) walk(r);
  return out;
}

/** Parses value text typed by the user for a type: { bytes } or { error }. */
function valueFromInput(type, input) {
  const s = String(input);
  if (V.STRING_TYPES.has(type)) return { bytes: V.utf16z(s) };
  if (type === 7) return { bytes: V.multiz(s.split(/\r\n|\n/).filter((x, i, a) => !(i === a.length - 1 && x === ''))) };
  if (type === 4 || type === 5 || type === 11) {
    const t = s.trim();
    let n;
    if (/^0x[0-9a-f]+$/i.test(t)) n = BigInt(t);
    else if (/^\d+$/.test(t)) n = BigInt(t);
    else return { error: 'Type a number, in decimal (42) or hex with 0x (0x2a).' };
    const max = type === 11 ? 0xffffffffffffffffn : 0xffffffffn;
    if (n > max) return { error: `The number is too large for ${V.typeName(type)}.` };
    const b = Buffer.alloc(type === 11 ? 8 : 4);
    if (type === 11) b.writeBigUInt64LE(n, 0); else if (type === 5) b.writeUInt32BE(Number(n), 0); else b.writeUInt32LE(Number(n), 0);
    return { bytes: b };
  }
  const h = parseHexBytes(s.replace(/\s+/g, ','));
  return h.error ? { error: 'Type hex bytes, such as 01 02 ff or 01,02,ff.' } : { bytes: h.bytes };
}

module.exports = { HEADER5, HEADER4, ROOTS, parse, parseData, readQuoted, decodeBytes, ansiDecode, ansiEncode, valueLines, toRegText, encodeReg, entries, valueFromInput, quote };
