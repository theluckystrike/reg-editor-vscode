'use strict';
// Core tests: value decoding, the .reg reader and writer, the hive reader, the shared model, comparison, exports and
// the timeline. Real third-party files are read from REG_REAL_DIR (default ~/plugin-market-intel-work/newb14-work/reg/dl)
// when it exists; those tests skip otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../src/core/values');
const R = require('../src/core/regtext');
const H = require('../src/core/hive');
const M = require('../src/core/model');
const C = require('../src/core/compare');
const { makeHive, sz, dword, qword, multi } = require('./support/mkhive');
const S = require('../scripts/make-samples');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const FIX = path.join(__dirname, 'fixtures');
const REAL = process.env.REG_REAL_DIR || path.join(os.homedir(), 'plugin-market-intel-work', 'newb14-work', 'reg', 'dl');
const real = (f) => path.join(REAL, f);
const hasReal = (f) => fs.existsSync(real(f));
const regText = (f) => R.decodeBytes(fs.readFileSync(f)).text;

// ---------- values ----------
test('values: every common type reads as Windows shows it', () => {
  assert.equal(V.describe(1, sz('hello')).text, 'hello');
  assert.equal(V.describe(4, dword(42)).text, '0x0000002a (42)');
  assert.equal(V.describe(5, Buffer.from([0, 0, 0, 42])).text, '0x0000002a (42)');
  assert.equal(V.describe(11, qword(2n ** 40n)).text, '0x0000010000000000 (1099511627776)');
  assert.deepEqual(V.describe(7, multi(['a', 'b c'])).parts, ['a', 'b c']);
  assert.equal(V.describe(3, Buffer.from([1, 0xab])).text, '01 ab');
  assert.equal(V.describe(3, Buffer.alloc(0)).text, '(zero-length binary value)');
  assert.equal(V.describe(4, Buffer.from([1, 2])).kind, 'hex');
  assert.equal(V.describe(3, Buffer.alloc(2000), 1024).cut, true);
  assert.equal(V.typeName(0x12345), 'type 0x12345');
  assert.equal(V.filetime(0, 0), '');
  assert.ok(V.sameData({ type: 1, bytes: sz('x') }, { type: 1, bytes: Buffer.from('x', 'utf16le') }));
  assert.ok(!V.sameData({ type: 1, bytes: sz('x') }, { type: 2, bytes: sz('x') }));
  assert.equal(V.jsonData(11, qword(2n ** 60n)), '1152921504606846976');
  assert.equal(V.timeText('2026-11-16T08:00:00.000Z'), '2026-11-16 08:00:00 UTC');
});

// ---------- .reg reading ----------
test('reg: the sample (UTF-16LE with BOM) reads into keys, values, deletions and line numbers', () => {
  const d = R.decodeBytes(fs.readFileSync(path.join(SAMPLES, 'zovo-demo.reg')));
  assert.equal(d.encoding, 'UTF-16LE');
  const p = R.parse(d.text);
  assert.equal(p.version, 5);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.counts, { keys: 5, values: 13, deletes: 2 });
  const app = p.keys.get('hkey_current_user\\software\\zovo demo');
  assert.deepEqual(app.values.map((v) => [v.name, v.type]), [['', 1], ['InstallPath', 1], ['Version', 4], ['LaunchCount', 11], ['LogPath', 2], ['RecentProjects', 7], ['WindowPlacement', 3]]);
  const log = app.valueMap.get('logpath');
  assert.equal(V.describe(log.type, log.bytes).text, '%LOCALAPPDATA%\\Zovo\\logs');
  assert.ok(log.endLine > log.line);
  assert.deepEqual(V.readMulti(app.valueMap.get('recentprojects').bytes), ['D:\\work\\billing', 'D:\\work\\site', 'C:\\Users\\demo\\notes']);
  assert.equal(p.keys.get('hkey_current_user\\software\\zovo demo\\oldcache').deleted, true);
  assert.equal(p.keys.get('hkey_current_user\\software\\zovo demo\\features').valueMap.get('telemetry').bytes, null);
  assert.equal(p.keys.get('hkey_current_user').implicit, true);
  const run = p.keys.get('hkey_current_user\\software\\microsoft\\windows\\currentversion\\run');
  assert.equal(V.readUtf16(run.values[0].bytes), '"C:\\Program Files\\Zovo Demo\\demo.exe" --tray');
});
test('reg: bad lines are reported with their line and the rest still reads', () => {
  const p = R.parse(regText(path.join(FIX, 'broken.reg')));
  assert.deepEqual(p.errors.map((e) => [e.line, e.severity]), [[5, 'error'], [6, 'error'], [7, 'error'], [8, 'error'], [9, 'error'], [10, 'warning']]);
  assert.match(p.errors[0].message, /is not a DWORD/);
  assert.match(p.errors[1].message, /"zz" is not a byte/);
  assert.match(p.errors[3].message, /closing quote is missing/);
  assert.match(p.errors[4].message, /must end with "\]"/);
  assert.match(p.errors[5].message, /"HKEY_WRONG" is not a registry root/);
  assert.equal(p.keys.get('hkey_current_user\\software\\broken demo').values.length, 1);
  assert.equal(p.keys.get('hkey_wrong\\software').values[0].name, 'Later');
});
test('reg: header rules, a value before any key, and REGEDIT4 ANSI text', () => {
  assert.match(R.parse('[HKEY_CURRENT_USER\\X]\n').errors[0].message, /first line must be/);
  assert.match(R.parse('\nREGEDIT4\n').errors[0].message, /must be the first line/);
  assert.match(R.parse('REGEDIT4\n"a"="b"\n').errors[0].message, /before any key line/);
  const d = R.decodeBytes(fs.readFileSync(path.join(FIX, 'regedit4-ansi.reg')));
  assert.equal(d.encoding, 'Windows-1252');
  const p = R.parse(d.text);
  assert.equal(p.version, 4);
  const k = p.keys.get('hkey_current_user\\software\\café');
  assert.equal(V.readUtf16(k.valueMap.get('name').bytes), 'Café € price');
  assert.equal(V.readUtf16(k.valueMap.get('path').bytes), 'C:\\é');
  assert.deepEqual(V.readMulti(k.valueMap.get('list').bytes), ['a', 'bé']);
});
test('reg: UTF-8 with and without BOM, UTF-16BE, spaces around "=", a value set twice keeps the last', () => {
  const t = 'Windows Registry Editor Version 5.00\n\n[HKEY_CURRENT_USER\\A]\n"x" = "1"\n"x"="2"\n';
  assert.equal(R.decodeBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t)])).encoding, 'UTF-8');
  const be = Buffer.from(t, 'utf16le'); be.swap16();
  assert.equal(R.decodeBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).text, t);
  const p = R.parse(t);
  const k = p.keys.get('hkey_current_user\\a');
  assert.equal(k.values.length, 1);
  assert.equal(V.readUtf16(k.values[0].bytes), '2');
  assert.equal(k.values[0].line, 5);
});

// ---------- .reg writing ----------
test('reg writer: version 5 round trip keeps every value byte for byte, with lines of 80 characters or less', () => {
  const p = R.parse(regText(path.join(SAMPLES, 'zovo-demo.reg')));
  const text = R.toRegText(R.entries(p), 5);
  for (const l of text.split('\r\n')) assert.ok(l.length <= 80, l);
  const q = R.parse(text);
  assert.deepEqual(q.errors, []);
  for (const [id, k] of p.keys) {
    const k2 = q.keys.get(id);
    assert.ok(k2, id);
    assert.equal(k2.deleted, k.deleted);
    assert.deepEqual(k2.values.map((v) => [v.name, v.type, v.bytes && v.bytes.toString('hex')]), k.values.map((v) => [v.name, v.type, v.bytes && v.bytes.toString('hex')]));
  }
});
test('reg writer: REGEDIT4 writes strings as ANSI and reads back to the same text; 5.00 is UTF-16LE with a BOM', () => {
  const p = R.parse(regText(path.join(FIX, 'regedit4-ansi.reg')));
  const v5 = R.encodeReg(R.toRegText(R.entries(p), 5), 5);
  assert.deepEqual([...v5.subarray(0, 2)], [0xff, 0xfe]);
  const back5 = R.parse(R.decodeBytes(v5).text);
  assert.equal(back5.version, 5);
  const v4 = R.encodeReg(R.toRegText(R.entries(back5), 4), 4);
  assert.equal(v4.toString('latin1', 0, 8), 'REGEDIT4');
  const back4 = R.parse(R.decodeBytes(v4).text);
  const k = back4.keys.get('hkey_current_user\\software\\café');
  assert.equal(V.readUtf16(k.valueMap.get('name').bytes), 'Café € price');
  assert.match(R.decodeBytes(v4).text, /"Path"=hex\(2\):43,3a,5c,e9,00/);
  // a character Windows-1252 lacks becomes "?" in REGEDIT4
  assert.match(R.toRegText([{ path: 'HKEY_CURRENT_USER\\A', values: [{ name: 'n', type: 1, bytes: sz('日本') }] }], 4), /"n"=hex\(1\):3f,3f,00/);
});
test('reg writer: names and strings are escaped; odd strings and DWORDs of the wrong size fall back to hex(n)', () => {
  const lines = (v) => R.valueLines(v, 5).join('\n');
  assert.equal(lines({ name: 'a"b\\c', type: 1, bytes: sz('x"y\\z') }), '"a\\"b\\\\c"="x\\"y\\\\z"');
  assert.equal(lines({ name: '', type: 4, bytes: dword(0xdeadbeef) }), '@=dword:deadbeef');
  assert.equal(lines({ name: 'n', type: 1, bytes: Buffer.from('ab', 'utf16le') }), '"n"=hex(1):61,00,62,00');
  assert.equal(lines({ name: 'n', type: 1, bytes: sz('two\nlines') }), '"n"=hex(1):74,00,77,00,6f,00,0a,00,6c,00,69,00,6e,00,65,00,73,00,00,00');
  assert.equal(lines({ name: 'n', type: 4, bytes: Buffer.from([1, 2]) }), '"n"=hex(4):01,02');
  assert.equal(lines({ name: 'n', type: 0, bytes: Buffer.alloc(0) }), '"n"=hex(0):');
  assert.equal(lines({ name: 'n', type: -1, bytes: null }), '"n"=-');
});
test('reg: values typed by the user', () => {
  assert.equal(R.valueFromInput(4, '0x2a').bytes.readUInt32LE(0), 42);
  assert.equal(R.valueFromInput(4, '42').bytes.readUInt32LE(0), 42);
  assert.match(R.valueFromInput(4, '4294967296').error, /too large/);
  assert.match(R.valueFromInput(4, 'abc').error, /Type a number/);
  assert.equal(R.valueFromInput(11, '0x10000000000').bytes.readBigUInt64LE(0), 2n ** 40n);
  assert.deepEqual(V.readMulti(R.valueFromInput(7, 'a\nb\n').bytes), ['a', 'b']);
  assert.equal(R.valueFromInput(3, '01 ff').bytes.toString('hex'), '01ff');
  assert.match(R.valueFromInput(3, 'xyz').error, /hex bytes/);
  assert.equal(V.readUtf16(R.valueFromInput(2, '%TEMP%\\x').bytes), '%TEMP%\\x');
});

// ---------- hives ----------
test('hive: the sample hive reads keys, values, times, big data in segments and the header', () => {
  const h = new H.Hive(fs.readFileSync(path.join(SAMPLES, 'zovo-demo.hiv')));
  assert.equal(h.version, '1.5');
  assert.equal(h.header.dirty, false);
  assert.equal(h.header.checksumOk, true);
  assert.equal(h.rootKey.name, 'ZovoDemo');
  assert.deepEqual(h.subkeys(h.rootKey).map((k) => k.name), ['Control Panel', 'Environment', 'Software']);
  assert.deepEqual(h.stats(), { keys: 16, values: 19, newest: '2026-11-16T07:59:12.000Z', oldest: '2026-08-30T06:00:00.000Z' });
  let app;
  h.walk((k, rel) => { if (rel === 'Software\\Zovo Demo') app = k; });
  const vals = h.values(app);
  const thumb = vals.find((v) => v.name === 'Thumbnail');
  assert.equal(thumb.bytes.length, 20000);
  assert.equal(thumb.bytes[19999], (19999 * 7) & 0xff);
  assert.equal(V.describe(4, vals.find((v) => v.name === 'Version').bytes).text, '0x00010203 (66051)');
  assert.equal(h.path(app), 'ZovoDemo\\Software\\Zovo Demo');
  assert.equal(app.time, '2026-11-14T16:42:10.000Z');
  assert.deepEqual(h.problems, []);
});
test('hive: not a hive, cut off, a dirty header and a damaged subkey list', () => {
  assert.throws(() => new H.Hive(Buffer.from('nothing here')), /does not start with the "regf" signature/);
  const good = fs.readFileSync(path.join(SAMPLES, 'zovo-demo.hiv'));
  assert.throws(() => new H.Hive(good.subarray(0, 4100)), /cut off/);
  const dirty = makeHive({ name: 'R', values: [{ name: 'a', type: 4, bytes: dword(1) }] }, { dirty: true });
  const l = M.load(dirty, 'NTUSER.DAT', { asHive: true });
  assert.equal(l.kind, 'hive');
  assert.match(l.notes[0], /not closed cleanly.*transaction logs.*read-only/);
  // break the lh list signature of the root
  const b = Buffer.from(good);
  const h = new H.Hive(b);
  const abs = H.BASE + h.rootKey.subList + 4;
  b.write('zz', abs, 'latin1');
  const h2 = new H.Hive(b);
  assert.deepEqual(h2.subkeys(h2.rootKey), []);
  assert.match(h2.problems[0], /unknown signature "zz"/);
  const cut = M.load(Buffer.concat([good.subarray(0, 4096 + 4096)]), 'cut.hiv', { asHive: true });
  assert.equal(cut.kind, 'hive');
  assert.ok(cut.notes.some((n) => /cut off/.test(n)));
});
test('hive: an li subkey list reads like an lh list', () => {
  // patch the sample: turn the root's lh list into an li list in place (offsets only)
  const b = Buffer.from(fs.readFileSync(path.join(SAMPLES, 'zovo-demo.hiv')));
  const h = new H.Hive(b);
  const abs = H.BASE + h.rootKey.subList + 4;
  const n = b.readUInt16LE(abs + 2);
  const offs = []; for (let i = 0; i < n; i++) offs.push(b.readUInt32LE(abs + 4 + i * 8));
  b.write('li', abs, 'latin1');
  offs.forEach((o, i) => b.writeUInt32LE(o, abs + 4 + i * 4));
  const h2 = new H.Hive(b);
  assert.deepEqual(h2.subkeys(h2.rootKey).map((k) => k.name), ['Control Panel', 'Environment', 'Software']);
});
test('hive: mount point guesses from the file name', () => {
  assert.equal(H.mountGuess('NTUSER.DAT'), 'HKEY_CURRENT_USER');
  assert.equal(H.mountGuess('/x/UsrClass.dat'), 'HKEY_CURRENT_USER\\Software\\Classes');
  assert.equal(H.mountGuess('SYSTEM'), 'HKEY_LOCAL_MACHINE\\SYSTEM');
  assert.equal(H.mountGuess('software.hiv'), 'HKEY_LOCAL_MACHINE\\SOFTWARE');
  assert.equal(H.mountGuess('DEFAULT'), 'HKEY_USERS\\.DEFAULT');
  assert.equal(H.mountGuess('my hive.hiv'), 'HKEY_LOCAL_MACHINE\\MY_HIVE');
});

// ---------- model ----------
test('model: .reg and hive sources give tree nodes, key details, search hits and the chain to a key', () => {
  const r = M.load(fs.readFileSync(path.join(SAMPLES, 'zovo-demo.reg')), 'zovo-demo.reg');
  assert.equal(r.kind, 'reg');
  assert.equal(r.encoding, 'UTF-16LE');
  const src = r.source;
  assert.deepEqual(src.roots().map((n) => [n.name, n.imp]), [['HKEY_CURRENT_USER', true]]);
  assert.deepEqual(src.children('hkey_current_user').map((n) => n.name), ['Software', 'Environment']);
  const k = src.key('hkey_current_user\\software\\zovo demo');
  assert.equal(k.editable, true);
  assert.equal(k.values.find((v) => v.name === 'Version').text, '0x00010203 (66051)');
  assert.equal(src.key('hkey_current_user\\software\\zovo demo\\oldcache').editable, false);
  const s = src.search('billing');
  assert.deepEqual(s.hits.map((x) => [x.path, x.what, x.value]), [['HKEY_CURRENT_USER\\Software\\Zovo Demo', 'data', 'RecentProjects']]);
  assert.deepEqual(src.chain('hkey_current_user\\software\\zovo demo\\editor'), ['hkey_current_user', 'hkey_current_user\\software', 'hkey_current_user\\software\\zovo demo', 'hkey_current_user\\software\\zovo demo\\editor']);
  assert.deepEqual(src.entries('hkey_current_user\\software\\zovo demo').map((e) => e.path.split('\\').pop()), ['Zovo Demo', 'Editor', 'Features', 'OldCache']);
  const h = M.load(fs.readFileSync(path.join(SAMPLES, 'zovo-demo.hiv')), 'zovo-demo.hiv').source;
  const hit = h.search('updater').hits[0];
  assert.equal(hit.path, 'ZovoDemo\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
  assert.equal(h.chain(hit.id).length, 6);
  const kd = h.key(hit.id);
  assert.equal(kd.info[0].v, '2026-11-12 19:05:33 UTC');
  assert.equal(h.entries(undefined, 'HKEY_CURRENT_USER')[0].path, 'HKEY_CURRENT_USER');
  assert.equal(h.entries(hit.id, 'HKEY_CURRENT_USER')[0].path, 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
  assert.ok(h.facts().some((f) => f.k === 'Keys' && f.v === '16'));
});
test('model: empty files and files that are not hives', () => {
  assert.equal(M.load(Buffer.alloc(0), 'x.reg').kind, 'empty');
  assert.equal(M.load(fs.readFileSync(path.join(FIX, 'not-a-hive.dat')), 'not-a-hive.dat', { asHive: true }).kind, 'notregf');
});

// ---------- compare and exports ----------
function hiveB() {
  const tree = { name: 'ZovoDemo', kids: [{ name: 'Software', kids: [{ name: 'Zovo Demo', values: [{ name: 'Version', type: 4, bytes: dword(0x00010300) }, { name: 'NewSetting', type: 1, bytes: sz('on') }], kids: [{ name: 'Plugins', values: [{ name: 'Count', type: 4, bytes: dword(2) }] }] }] }] };
  return makeHive(tree);
}
test('compare: two hives give keys only in A and B and value changes; the .reg patch turns A into B', () => {
  const a = M.load(fs.readFileSync(path.join(SAMPLES, 'zovo-demo.hiv')), 'NTUSER.DAT').source;
  const b = M.load(hiveB(), 'NTUSER-after.DAT').source;
  const r = C.diff(a.entries(undefined, 'HKEY_CURRENT_USER'), b.entries(undefined, 'HKEY_CURRENT_USER'));
  assert.deepEqual(r.onlyB, ['HKEY_CURRENT_USER\\Software\\Zovo Demo\\Plugins']);
  assert.ok(r.onlyA.includes('HKEY_CURRENT_USER\\Environment'));
  const app = r.changed.find((c) => c.path === 'HKEY_CURRENT_USER\\Software\\Zovo Demo');
  assert.deepEqual(app.changes.filter((x) => x.kind !== 'removed').map((x) => [x.name, x.kind]), [['Version', 'changed'], ['NewSetting', 'added']]);
  const patch = C.patchText(r);
  assert.match(patch, /^Windows Registry Editor Version 5\.00\r\n/);
  assert.match(patch, /\[-HKEY_CURRENT_USER\\Environment\]/);
  assert.doesNotMatch(patch, /\[-HKEY_CURRENT_USER\\Control Panel\\Desktop\]/); // its parent is deleted already
  assert.match(patch, /"Version"=dword:00010300/);
  assert.match(patch, /"InstallPath"=-/);
  assert.match(patch, /\[HKEY_CURRENT_USER\\Software\\Zovo Demo\\Plugins\]\r\n"Count"=dword:00000002/);
  // applying the patch's values over A's keys gives B's values
  const pp = R.parse(patch);
  assert.deepEqual(pp.errors, []);
  const md = C.toMarkdown(r, 'NTUSER.DAT', 'NTUSER-after.DAT', 'note');
  assert.match(md, /^# Registry comparison\n\n- A: NTUSER\.DAT \(16 keys\)\n- B: NTUSER-after\.DAT \(4 keys\)/);
  assert.match(md, /\| HKEY_CURRENT_USER\\Software\\Zovo Demo \| Version \| changed \| REG_DWORD \| 0x00010203 \(66051\) \| 0x00010300 \(66304\) \|/);
});
test('compare: .reg files match keys and values without regard to case; string data compares as text', () => {
  const a = R.parse('Windows Registry Editor Version 5.00\n[HKEY_CURRENT_USER\\App]\n"Name"="x"\n"Mode"=dword:00000001\n');
  const b = R.parse('Windows Registry Editor Version 5.00\n[hkey_current_user\\APP]\n"name"=hex(1):78,00\n"Mode"=dword:00000002\n[HKEY_CURRENT_USER\\App\\New]\n');
  const r = C.diff(R.entries(a), R.entries(b));
  assert.deepEqual(r.onlyA, []);
  assert.deepEqual(r.onlyB, ['HKEY_CURRENT_USER\\App\\New']);
  assert.deepEqual(r.changed[0].changes.map((x) => [x.name, x.kind]), [['Mode', 'changed']]);
  assert.deepEqual(C.topmost(['A\\B', 'A\\B\\C', 'A\\D']), ['A\\B', 'A\\D']);
});
test('exports: JSON and CSV of the sample', () => {
  const src = M.load(fs.readFileSync(path.join(SAMPLES, 'zovo-demo.hiv')), 'zovo-demo.hiv').source;
  const e = src.entries(undefined, src.h.rootKey.name);
  const j = JSON.parse(C.toJson(e, { source: 'zovo-demo.hiv' }));
  assert.equal(j.keys.length, 16);
  const app = j.keys.find((k) => k.path === 'ZovoDemo\\Software\\Zovo Demo');
  assert.equal(app.lastWrite, '2026-11-14T16:42:10.000Z');
  assert.deepEqual(app.values.find((v) => v.name === 'RecentProjects').data, ['D:\\work\\billing', 'D:\\work\\site', 'C:\\Users\\demo\\notes']);
  assert.equal(app.values.find((v) => v.name === 'LaunchCount').data, 42);
  const csv = C.toCsv(e).split('\r\n');
  assert.equal(csv[0], 'key,last_write,value,type,data');
  assert.ok(csv.includes('ZovoDemo\\Software\\Zovo Demo,2026-11-14T16:42:10.000Z,Version,REG_DWORD,66051'));
  assert.ok(csv.includes('ZovoDemo\\Software\\Zovo Demo,2026-11-14T16:42:10.000Z,(Default),REG_SZ,Zovo Demo App'));
  assert.ok(csv.includes('ZovoDemo\\Software\\Zovo Demo,2026-11-14T16:42:10.000Z,RecentProjects,REG_MULTI_SZ,"D:\\work\\billing\nD:\\work\\site\nC:\\Users\\demo\\notes"'));
});
test('timeline: newest first, date and text filters, CSV', () => {
  const src = M.load(fs.readFileSync(path.join(SAMPLES, 'zovo-demo.hiv')), 'zovo-demo.hiv').source;
  const rows = C.timeline(src.entries(undefined, 'ZovoDemo'));
  assert.equal(rows.length, 16);
  assert.equal(rows[0].path, 'ZovoDemo\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}\\Count');
  assert.equal(rows[rows.length - 1].path, 'ZovoDemo\\Control Panel');
  assert.deepEqual(C.filterTimeline(rows, { from: '2026-11-14', to: '2026-11-15' }).map((r) => r.path.split('\\').pop()), ['Editor', 'Zovo Demo']);
  assert.equal(C.filterTimeline(rows, { text: 'run' }).length, 1);
  assert.match(C.timelineCsv(rows.slice(0, 1)), /^last_write_utc,key,values,subkeys\r\n2026-11-16T07:59:12\.000Z,ZovoDemo\\Software.*\\Count,1,0\r\n$/);
});

// ---------- samples ----------
test('the shipped samples are what scripts/make-samples.js writes', () => {
  assert.equal(Buffer.compare(fs.readFileSync(path.join(SAMPLES, 'zovo-demo.reg')), S.regSample()), 0);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(SAMPLES, 'zovo-demo.hiv')), S.hiveSample()), 0);
  assert.equal(S.rot13('Zovo'), 'Mbib');
});

// ---------- real files (skipped when the download folder is missing) ----------
test('real .reg files from Microsoft samples read with no problems (fixtures in the repo)', () => {
  const a = R.parse(regText(path.join(FIX, 'credential-provider-register.reg')));
  assert.deepEqual(a.errors, []);
  assert.equal(a.counts.keys, 3);
  const b = R.parse(regText(path.join(FIX, 'Client.Reg')));
  assert.equal(b.version, 4);
  assert.equal(V.readUtf16(b.keys.get('hkey_current_user\\software\\microsoft\\terminal server client\\default\\addins\\tssysinfo').values[0].bytes), 'd:\\release\\nt\\dump\\sysinf_c.dll');
});
test('real hives: NTUSER.DAT, SAM, UsrClass.dat and a SYSTEM hive that was not closed cleanly', { skip: !hasReal('dfw-system/SYSTEM') }, () => {
  const nt = M.load(fs.readFileSync(real('dfw-ntuser/NTUSER.DAT')), 'NTUSER.DAT', { asHive: true });
  assert.equal(nt.kind, 'hive');
  assert.equal(nt.source.h.stats().keys, 1597);
  const run = nt.source.search('CurrentVersion\\Run'.split('\\').pop()).hits.find((x) => /\\CurrentVersion\\Run$/.test(x.path));
  assert.ok(run);
  const sys = M.load(fs.readFileSync(real('dfw-system/SYSTEM')), 'SYSTEM', { asHive: true });
  assert.equal(sys.source.h.header.dirty, true);
  assert.equal(sys.source.h.stats().keys, 21502);
  assert.deepEqual(sys.source.h.problems, []);
  assert.equal(M.load(fs.readFileSync(real('dfw-usrclass/UsrClass.dat')), 'UsrClass.dat', { asHive: true }).source.h.stats().values, 19987);
  assert.equal(M.load(fs.readFileSync(real('dfw-sam/SAM')), 'SAM', { asHive: true }).source.h.stats().keys, 76);
  assert.equal(M.load(fs.readFileSync(real('dfw-user9x/USER.DAT')), 'USER.DAT', { asHive: true }).kind, 'notregf');
  // a whole hive exported to .reg reads back with the same keys and values
  const e = nt.source.entries(undefined, 'HKEY_CURRENT_USER');
  const back = R.parse(R.decodeBytes(R.encodeReg(R.toRegText(e, 5), 5)).text);
  assert.deepEqual(back.errors, []);
  assert.equal(R.entries(back).length, e.length);
  const r = C.diff(e, R.entries(back));
  assert.equal(r.onlyA.length + r.onlyB.length + r.changed.length, 0);
});
