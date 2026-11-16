'use strict';
// Test helper: writes a small regf hive (version 1.5) from a tree, the way Windows lays one out (base block, one hive
// bin, nk/vk/lh/value-list/db cells). Used to make samples/zovo-demo.hiv and the test hives. Not shipped.
const LH_SEGMENT = 16344;

function filetimeOf(iso) {
  const ms = BigInt(Date.parse(iso));
  const t = (ms + 11644473600000n) * 10000n;
  return [Number(t & 0xffffffffn), Number(t >> 32n)];
}

function lhHash(name) { let h = 0; for (const ch of name.toUpperCase()) h = (Math.imul(h, 37) + ch.charCodeAt(0)) >>> 0; return h; }

/**
 * tree: { name, time, values: [{ name, type, bytes }], kids: [tree] }
 * opts: { dirty, fileName, written, minor }
 */
function makeHive(tree, opts = {}) {
  const chunks = [];
  let used = 0;
  const alloc = (len) => { const size = Math.ceil((len + 4) / 8) * 8; const off = used; const b = Buffer.alloc(size); b.writeInt32LE(-size, 0); chunks.push(b); used += size; return { off: off + 32, b, data: b.subarray(4) }; };
  // offsets are relative to the start of the hive bins; the first bin's 32-byte header comes first.
  const minor = opts.minor === undefined ? 5 : opts.minor;

  function writeData(bytes) {
    if (bytes.length > LH_SEGMENT && minor >= 4) {
      const segs = [];
      for (let i = 0; i < bytes.length; i += LH_SEGMENT) { const s = alloc(Math.min(LH_SEGMENT, bytes.length - i)); bytes.copy(s.data, 0, i, Math.min(bytes.length, i + LH_SEGMENT)); segs.push(s.off); }
      const list = alloc(segs.length * 4); segs.forEach((o, i) => list.data.writeUInt32LE(o, i * 4));
      const db = alloc(8); db.data.write('db', 0, 'latin1'); db.data.writeUInt16LE(segs.length, 2); db.data.writeUInt32LE(list.off, 4);
      return db.off;
    }
    const c = alloc(bytes.length); bytes.copy(c.data, 0); return c.off;
  }

  function writeKey(node, parentOff, isRoot) {
    const nameB = Buffer.from(node.name, 'latin1');
    const nk = alloc(76 + nameB.length);
    const d = nk.data;
    d.write('nk', 0, 'latin1');
    d.writeUInt16LE(isRoot ? 0x2c : 0x20, 2);
    const [lo, hi] = filetimeOf(node.time || '2026-01-01T00:00:00Z');
    d.writeUInt32LE(lo, 4); d.writeUInt32LE(hi, 8);
    d.writeUInt32LE(parentOff, 16);
    d.writeUInt32LE(0xffffffff, 32); d.writeUInt32LE(0xffffffff, 44); d.writeUInt32LE(0xffffffff, 48);
    d.writeUInt16LE(nameB.length, 72);
    nameB.copy(d, 76);
    const kids = (node.kids || []).slice().sort((a, b) => (a.name.toUpperCase() < b.name.toUpperCase() ? -1 : 1));
    const kidOffs = kids.map((k) => writeKey(k, nk.off, false));
    d.writeUInt32LE(kids.length, 20);
    if (kids.length) {
      const lh = alloc(4 + kids.length * 8);
      lh.data.write('lh', 0, 'latin1'); lh.data.writeUInt16LE(kids.length, 2);
      kids.forEach((k, i) => { lh.data.writeUInt32LE(kidOffs[i], 4 + i * 8); lh.data.writeUInt32LE(lhHash(k.name), 8 + i * 8); });
      d.writeUInt32LE(lh.off, 28);
    } else d.writeUInt32LE(0xffffffff, 28);
    const vals = node.values || [];
    d.writeUInt32LE(vals.length, 36);
    if (vals.length) {
      const offs = vals.map((v) => {
        const nb = Buffer.from(v.name, 'latin1');
        const vk = alloc(20 + nb.length);
        vk.data.write('vk', 0, 'latin1');
        vk.data.writeUInt16LE(nb.length, 2);
        const bytes = Buffer.from(v.bytes);
        if (bytes.length <= 4) { vk.data.writeUInt32LE((bytes.length | 0x80000000) >>> 0, 4); const r = Buffer.alloc(4); bytes.copy(r); vk.data.writeUInt32LE(r.readUInt32LE(0), 8); }
        else { vk.data.writeUInt32LE(bytes.length, 4); vk.data.writeUInt32LE(writeData(bytes), 8); }
        vk.data.writeUInt32LE(v.type, 12);
        vk.data.writeUInt16LE(nb.length ? 1 : 0, 16);
        nb.copy(vk.data, 20);
        return vk.off;
      });
      const list = alloc(vals.length * 4);
      offs.forEach((o, i) => list.data.writeUInt32LE(o, i * 4));
      d.writeUInt32LE(list.off, 40);
    } else d.writeUInt32LE(0xffffffff, 40);
    return nk.off;
  }

  const rootOff = writeKey(tree, 0xffffffff, true);
  const cells = Buffer.concat(chunks);
  const binSize = Math.ceil((cells.length + 32 + 8) / 4096) * 4096;
  const bin = Buffer.alloc(binSize);
  bin.write('hbin', 0, 'latin1'); bin.writeUInt32LE(0, 4); bin.writeUInt32LE(binSize, 8);
  cells.copy(bin, 32);
  const freeLen = binSize - 32 - cells.length;
  if (freeLen >= 8) bin.writeInt32LE(freeLen, 32 + cells.length);
  const base = Buffer.alloc(4096);
  base.write('regf', 0, 'latin1');
  base.writeUInt32LE(7, 4); base.writeUInt32LE(opts.dirty ? 6 : 7, 8);
  const [lo, hi] = filetimeOf(opts.written || '2026-11-16T09:00:00Z');
  base.writeUInt32LE(lo, 12); base.writeUInt32LE(hi, 16);
  base.writeUInt32LE(1, 20); base.writeUInt32LE(minor, 24); base.writeUInt32LE(0, 28); base.writeUInt32LE(1, 32);
  base.writeUInt32LE(rootOff, 36); base.writeUInt32LE(binSize, 40); base.writeUInt32LE(1, 44);
  Buffer.from(opts.fileName || '\\??\\C:\\zovo\\demo.hiv', 'utf16le').copy(base, 48, 0, 64);
  let sum = 0;
  for (let i = 0; i < 508; i += 4) sum = (sum ^ base.readUInt32LE(i)) >>> 0;
  if (sum === 0xffffffff) sum = 0xfffffffe; else if (sum === 0) sum = 1;
  base.writeUInt32LE(sum, 508);
  return Buffer.concat([base, bin]);
}

const sz = (s) => Buffer.from(`${s}\u0000`, 'utf16le');
const dword = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const qword = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; };
const multi = (list) => Buffer.from(list.map((x) => `${x}\u0000`).join('') + '\u0000', 'utf16le');

module.exports = { makeHive, lhHash, sz, dword, qword, multi };
