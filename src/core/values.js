'use strict';
// Registry value types and how their data reads. Shared by the .reg parser, the hive reader, the exports and the
// comparison. A value is { name, type, bytes } where bytes holds the data as Windows stores it (strings as UTF-16LE
// with the closing nul). No vscode import.

const TYPES = {
  0: 'REG_NONE', 1: 'REG_SZ', 2: 'REG_EXPAND_SZ', 3: 'REG_BINARY', 4: 'REG_DWORD', 5: 'REG_DWORD_BIG_ENDIAN', 6: 'REG_LINK',
  7: 'REG_MULTI_SZ', 8: 'REG_RESOURCE_LIST', 9: 'REG_FULL_RESOURCE_DESCRIPTOR', 10: 'REG_RESOURCE_REQUIREMENTS_LIST', 11: 'REG_QWORD',
};
const STRING_TYPES = new Set([1, 2, 6]);
const typeName = (t) => TYPES[t] || `type 0x${(t >>> 0).toString(16)}`;

/** UTF-16LE bytes of s with one closing nul. */
function utf16z(s) { return Buffer.from(`${s}\u0000`, 'utf16le'); }
/** UTF-16LE bytes of a list of strings, each nul-terminated, plus the final empty string. */
function multiz(list) { return Buffer.from(list.map((x) => `${x}\u0000`).join('') + '\u0000', 'utf16le'); }

/** A UTF-16LE string from bytes, cut at the first nul. */
function readUtf16(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength - (bytes.byteLength % 2));
  const s = b.toString('utf16le');
  const z = s.indexOf('\u0000');
  return z >= 0 ? s.slice(0, z) : s;
}
function readMulti(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength - (bytes.byteLength % 2));
  let s = b.toString('utf16le');
  s = s.replace(/\u0000+$/, '');
  return s ? s.split('\u0000') : [];
}

function hex(bytes, max) {
  const n = max && bytes.length > max ? max : bytes.length;
  const parts = new Array(n);
  for (let i = 0; i < n; i++) parts[i] = bytes[i].toString(16).padStart(2, '0');
  return parts.join(' ');
}

function u32(bytes, be) { const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); return be ? b.readUInt32BE(0) : b.readUInt32LE(0); }
function u64(bytes) { return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readBigUInt64LE(0); }

/** The value data as text: { kind, text, parts?, number? }. max cuts long hex data (the full bytes stay in the value). */
function describe(type, bytes, max = 1024) {
  if (!bytes) return { kind: 'delete', text: '(deleted by this file)' };
  if (STRING_TYPES.has(type)) return { kind: 'string', text: readUtf16(bytes) };
  if (type === 7) { const parts = readMulti(bytes); return { kind: 'multi', text: parts.join('\n'), parts }; }
  if ((type === 4 || type === 5) && bytes.length === 4) { const v = u32(bytes, type === 5); return { kind: 'number', text: `0x${v.toString(16).padStart(8, '0')} (${v})`, number: String(v) }; }
  if (type === 11 && bytes.length === 8) { const v = u64(bytes); return { kind: 'number', text: `0x${v.toString(16).padStart(16, '0')} (${v})`, number: v.toString() }; }
  const cut = max && bytes.length > max;
  return { kind: 'hex', text: bytes.length ? hex(bytes, max) + (cut ? ' ...' : '') : '(zero-length binary value)', cut };
}

/** True when two values hold the same data (strings compared as text, so a missing closing nul is no change). */
function sameData(a, b) {
  if (!a.bytes || !b.bytes) return !a.bytes && !b.bytes;
  if (a.type !== b.type) return false;
  if (STRING_TYPES.has(a.type)) return readUtf16(a.bytes) === readUtf16(b.bytes);
  if (a.type === 7) return readMulti(a.bytes).join('\u0000') === readMulti(b.bytes).join('\u0000');
  return Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)) === 0;
}

/** JSON-friendly data: string, list of strings, number (or decimal string past 2^53), or hex text. */
function jsonData(type, bytes) {
  if (!bytes) return null;
  if (STRING_TYPES.has(type)) return readUtf16(bytes);
  if (type === 7) return readMulti(bytes);
  if ((type === 4 || type === 5) && bytes.length === 4) return u32(bytes, type === 5);
  if (type === 11 && bytes.length === 8) { const v = u64(bytes); return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString(); }
  return hex(bytes).replace(/ /g, '');
}

/** Windows FILETIME (100 ns since 1601) as an ISO time, or '' when zero or out of range. */
function filetime(lo, hi) {
  const ticks = BigInt(hi >>> 0) * 4294967296n + BigInt(lo >>> 0);
  if (ticks === 0n) return '';
  const ms = Number(ticks / 10000n) - 11644473600000;
  if (!Number.isFinite(ms) || ms < -11644473600000 || ms > 32503680000000) return '';
  return new Date(ms).toISOString();
}
/** A FILETIME ISO string for people: "2026-11-16 09:00:00 UTC" (milliseconds only when set). */
function timeText(iso) { return iso ? iso.replace('T', ' ').replace(/\.000Z$/, 'Z').replace('Z', ' UTC') : 'not set'; }

module.exports = { TYPES, STRING_TYPES, typeName, utf16z, multiz, readUtf16, readMulti, hex, describe, sameData, jsonData, filetime, timeText };
