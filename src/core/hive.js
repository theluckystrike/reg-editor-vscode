'use strict';
// Binary registry hives (the "regf" format of NTUSER.DAT, UsrClass.dat, SYSTEM, SOFTWARE, SAM and .hiv files), read
// only. Written for this extension from the public notes on the format (base block, hive bins, nk/vk/sk cells, lf/lh/
// li/ri subkey lists and db big data). Keys are read on demand by cell offset, so a large hive opens fast. Damaged
// cells are reported, not thrown, and the rest of the hive stays readable. No vscode import.
const V = require('./values');

const BASE = 4096;
const BIG_SEGMENT = 16344;
const MAX_LIST = 2000000;

class HiveError extends Error {}

/** True when bytes start with the "regf" signature. */
function isHive(bytes) { return bytes && bytes.length >= 4 && bytes[0] === 0x72 && bytes[1] === 0x65 && bytes[2] === 0x67 && bytes[3] === 0x66; }

class Hive {
  constructor(bytes) {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!isHive(b)) throw new HiveError('This file is not a registry hive: it does not start with the "regf" signature.');
    if (b.length < BASE + 32) throw new HiveError(`This hive is cut off: it has ${b.length} bytes, less than the 4096-byte header and one hive bin.`);
    this.b = b;
    this.problems = [];
    this.keyCache = new Map();
    const seq1 = b.readUInt32LE(4), seq2 = b.readUInt32LE(8);
    let sum = 0;
    for (let i = 0; i < 508; i += 4) sum = (sum ^ b.readUInt32LE(i)) >>> 0;
    if (sum === 0xffffffff) sum = 0xfffffffe; else if (sum === 0) sum = 1;
    const nameRaw = b.subarray(48, 112);
    this.header = {
      seq1, seq2, dirty: seq1 !== seq2,
      written: V.filetime(b.readUInt32LE(12), b.readUInt32LE(16)),
      major: b.readUInt32LE(20), minor: b.readUInt32LE(24), type: b.readUInt32LE(28), format: b.readUInt32LE(32),
      root: b.readUInt32LE(36), dataSize: b.readUInt32LE(40),
      fileName: V.readUtf16(nameRaw).replace(/[^\x20-￿]/g, ''),
      checksum: b.readUInt32LE(508), checksumOk: b.readUInt32LE(508) === sum,
    };
    if (b.toString('latin1', BASE, BASE + 4) !== 'hbin') throw new HiveError('The first hive bin is missing: there is no "hbin" signature at offset 4096.');
    if (BASE + this.header.dataSize > b.length) this.problems.push(`The header says the hive bins take ${this.header.dataSize} bytes, but the file ends after ${b.length - BASE}. The hive is cut off; keys past the end are not shown.`);
    if (!this.header.checksumOk) this.problems.push('The header checksum does not match. The header may be damaged.');
    this.rootKey = this.key(this.header.root);
    if (!this.rootKey) throw new HiveError(`The root key at cell offset 0x${this.header.root.toString(16)} could not be read.`);
  }

  get version() { return `${this.header.major}.${this.header.minor}`; }

  problem(msg) { if (this.problems.length < 200 && !this.problems.includes(msg)) this.problems.push(msg); }

  /** The data of the cell at offset off (relative to the first hive bin), or null when it is out of range. */
  cell(off) {
    if (off === 0xffffffff || off === undefined) return null;
    const abs = BASE + off;
    if (off < 0 || abs + 4 > this.b.length) return null;
    const size = this.b.readInt32LE(abs);
    const len = Math.abs(size);
    if (len < 8 || abs + len > this.b.length) return null;
    return this.b.subarray(abs + 4, abs + len);
  }

  key(off) {
    if (this.keyCache.has(off)) return this.keyCache.get(off);
    const c = this.cell(off);
    if (!c || c.length < 76 || c[0] !== 0x6e || c[1] !== 0x6b) { this.problem(`A key cell at offset 0x${(off >>> 0).toString(16)} is damaged or is not a key.`); return null; }
    const flags = c.readUInt16LE(2);
    const nameLen = c.readUInt16LE(72);
    const raw = c.subarray(76, Math.min(c.length, 76 + nameLen));
    const k = {
      off, flags,
      name: flags & 0x20 ? raw.toString('latin1') : V.readUtf16(Buffer.concat([raw, Buffer.alloc(2)])),
      time: V.filetime(c.readUInt32LE(4), c.readUInt32LE(8)),
      parent: c.readUInt32LE(16),
      nSub: c.readUInt32LE(20), subList: c.readUInt32LE(28),
      nVal: c.readUInt32LE(36), valList: c.readUInt32LE(40),
      sec: c.readUInt32LE(44), classOff: c.readUInt32LE(48), classLen: c.readUInt16LE(74),
    };
    if (this.keyCache.size > 200000) this.keyCache.clear();
    this.keyCache.set(off, k);
    return k;
  }

  /** Cell offsets of the subkeys of key k, in the order the hive stores them (sorted by name). */
  subkeyOffsets(k) {
    if (!k || !k.nSub) return [];
    const out = [];
    const seen = new Set();
    const list = (off, depth) => {
      if (depth > 4 || seen.has(off)) return;
      seen.add(off);
      const c = this.cell(off);
      if (!c || c.length < 4) { this.problem(`The subkey list of ${k.name} is damaged.`); return; }
      const sig = c.toString('latin1', 0, 2);
      const n = c.readUInt16LE(2);
      if (sig === 'lf' || sig === 'lh') { for (let i = 0; i < n && 4 + i * 8 + 4 <= c.length && out.length < MAX_LIST; i++) out.push(c.readUInt32LE(4 + i * 8)); }
      else if (sig === 'li') { for (let i = 0; i < n && 4 + i * 4 + 4 <= c.length && out.length < MAX_LIST; i++) out.push(c.readUInt32LE(4 + i * 4)); }
      else if (sig === 'ri') { for (let i = 0; i < n && 4 + i * 4 + 4 <= c.length; i++) list(c.readUInt32LE(4 + i * 4), depth + 1); }
      else this.problem(`The subkey list of ${k.name} has an unknown signature "${sig.replace(/[^\x20-\x7e]/g, '?')}".`);
    };
    list(k.subList, 0);
    return out;
  }

  subkeys(k) { return this.subkeyOffsets(k).map((o) => this.key(o)).filter(Boolean); }

  className(k) {
    if (!k || !k.classLen || k.classOff === 0xffffffff) return '';
    const c = this.cell(k.classOff);
    if (!c) return '';
    return V.readUtf16(Buffer.concat([c.subarray(0, Math.min(c.length, k.classLen)), Buffer.alloc(2)]));
  }

  /** Values of key k: [{ name, type, bytes, size }]. */
  values(k) {
    if (!k || !k.nVal) return [];
    const c = this.cell(k.valList);
    if (!c) { this.problem(`The value list of ${k.name} is damaged.`); return []; }
    const out = [];
    const n = Math.min(k.nVal, Math.floor(c.length / 4));
    for (let i = 0; i < n; i++) {
      const v = this.value(c.readUInt32LE(i * 4), k);
      if (v) out.push(v);
    }
    return out;
  }

  value(off, k) {
    const c = this.cell(off);
    if (!c || c.length < 20 || c[0] !== 0x76 || c[1] !== 0x6b) { this.problem(`A value cell of ${k ? k.name : 'a key'} is damaged.`); return null; }
    const nameLen = c.readUInt16LE(2);
    const sizeRaw = c.readUInt32LE(4);
    const dataOff = c.readUInt32LE(8);
    const type = c.readUInt32LE(12);
    const flags = c.readUInt16LE(16);
    const raw = c.subarray(20, Math.min(c.length, 20 + nameLen));
    const name = flags & 1 ? raw.toString('latin1') : V.readUtf16(Buffer.concat([raw, Buffer.alloc(2)]));
    const resident = (sizeRaw & 0x80000000) !== 0;
    const size = sizeRaw & 0x7fffffff;
    let bytes;
    if (resident) { const d = Buffer.alloc(4); d.writeUInt32LE(dataOff, 0); bytes = d.subarray(0, Math.min(4, size)); }
    else if (size === 0) bytes = Buffer.alloc(0);
    else bytes = this.data(dataOff, size, name);
    return { name, type, bytes: bytes || Buffer.alloc(0), size, damaged: !bytes };
  }

  data(off, size, name) {
    const c = this.cell(off);
    if (!c) { this.problem(`The data of value "${name}" is outside the hive.`); return null; }
    if (size > BIG_SEGMENT && c.length >= 8 && c[0] === 0x64 && c[1] === 0x62 && (this.header.minor >= 4)) {
      const n = c.readUInt16LE(2);
      const list = this.cell(c.readUInt32LE(4));
      if (!list) { this.problem(`The big data list of value "${name}" is damaged.`); return null; }
      const parts = [];
      let left = size;
      for (let i = 0; i < n && left > 0 && i * 4 + 4 <= list.length; i++) {
        const seg = this.cell(list.readUInt32LE(i * 4));
        if (!seg) { this.problem(`A big data segment of value "${name}" is damaged.`); return null; }
        const take = Math.min(left, BIG_SEGMENT, seg.length);
        parts.push(seg.subarray(0, take));
        left -= take;
      }
      return Buffer.concat(parts);
    }
    if (size > c.length) { this.problem(`The data of value "${name}" is cut off (${c.length} of ${size} bytes).`); return c; }
    return c.subarray(0, size);
  }

  /** Path from the root (the root key's own name first). */
  path(k) {
    const names = [];
    let cur = k;
    for (let i = 0; cur && i < 512; i++) {
      names.push(cur.name);
      if (cur.off === this.header.root || (cur.flags & 0x4)) break;
      cur = this.key(cur.parent);
    }
    return names.reverse().join('\\');
  }

  /** Visits every key depth first: fn(key, relPath) where relPath leaves out the root key name. */
  walk(fn, max = Infinity) {
    let n = 0;
    const seen = new Set();
    const stack = [[this.rootKey, '']];
    while (stack.length && n < max) {
      const [k, rel] = stack.pop();
      if (seen.has(k.off)) continue;
      seen.add(k.off);
      n++;
      if (fn(k, rel) === false) return n;
      const kids = this.subkeys(k);
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], rel ? `${rel}\\${kids[i].name}` : kids[i].name]);
    }
    return n;
  }

  stats() {
    if (this._stats) return this._stats;
    let keys = 0, values = 0, newest = '', oldest = '';
    this.walk((k) => { keys++; values += k.nVal; if (k.time) { if (!newest || k.time > newest) newest = k.time; if (!oldest || k.time < oldest) oldest = k.time; } });
    this._stats = { keys, values, newest, oldest };
    return this._stats;
  }
}

const HIVE_TYPES = { 0: 'primary', 1: 'alternate', 2: 'log', 3: 'external', 4: 'disk image', 5: 'layered', 6: 'log (new)' };

/** The registry path a hive is usually loaded at, from its file name (used as the prefix of .reg exports). */
function mountGuess(fileName) {
  const n = String(fileName).replace(/^.*[\\/]/, '').toUpperCase();
  if (/^NTUSER/.test(n)) return 'HKEY_CURRENT_USER';
  if (/^USRCLASS/.test(n)) return 'HKEY_CURRENT_USER\\Software\\Classes';
  const stem = n.replace(/\.(DAT|HIV|HVE|SAV|BAK|OLD)$/i, '');
  if (['SYSTEM', 'SOFTWARE', 'SAM', 'SECURITY', 'HARDWARE', 'COMPONENTS', 'DRIVERS', 'BCD00000000'].includes(stem)) return `HKEY_LOCAL_MACHINE\\${stem}`;
  if (stem === 'DEFAULT') return 'HKEY_USERS\\.DEFAULT';
  return `HKEY_LOCAL_MACHINE\\${(stem.replace(/[^A-Za-z0-9_.-]/g, '_') || 'HIVE')}`;
}

module.exports = { Hive, HiveError, isHive, mountGuess, HIVE_TYPES, BASE };
