'use strict';
// Extension tests with the vscode stub: listing, activation, the .reg editor (tree, values, search, edits as text
// edits), the hive viewer, Open as Registry Hive, problems for .reg text, webview safety, the three Pro tools with
// 1 free try each (the 2nd use opens the Pro panel, also on another file and after a reload), README and support links.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadExtension, tmpDir, cleanup } = require('./support/vscode-stub');
const { editorHtml, panelHtml } = require('../src/html');
const R = require('../src/core/regtext');
const { makeHive, sz, dword } = require('./support/mkhive');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const FIX = path.join(__dirname, 'fixtures');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await tick(10); } return f(); };
test.after(() => cleanup());

function fakePanel() {
  let onMsg;
  const posted = [];
  return {
    posted, viewColumn: 1, active: true,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal() {},
    send: (m) => onMsg(m),
    last: (type) => [...posted].reverse().find((m) => m.type === type),
  };
}

const activated = [];
function activate(folder, state) {
  const s = loadExtension();
  s.vscode.workspace.textDocuments = s.vscode.workspace.textDocuments || [];
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  if (state) for (const [k, v] of state) s.state.set(k, v);
  s.api = s.ext.activate(s.context);
  activated.push(s);
  s.log.onPost = (panel, m) => { if (m.type === 'show' && m.html) panel.send({ type: 'shown' }); };
  s.opened = [];
  s.commands.set('vscode.openWith', async (uri, viewType) => {
    s.opened.push([uri.fsPath, viewType]);
    if (!/^regEditor\./.test(viewType)) return undefined;
    const e = await openEditor(s, uri.fsPath, viewType === 'regEditor.hive');
    s.lastEditor = e;
    return undefined;
  });
  return s;
}
test.after(() => { for (const s of activated) s.api.viewer.dispose(); });

/** Opens a file in the viewer like VS Code does: .reg through the text provider, hives through the hive provider. */
async function openEditor(s, file, hive) {
  const uri = s.vscode.Uri.file(file);
  const panel = fakePanel();
  let doc = null;
  if (hive) {
    const h = await s.api.hiveProvider.openCustomDocument(uri);
    await s.api.hiveProvider.resolveCustomEditor(h, panel);
  } else {
    doc = s.vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (!doc) { doc = s.makeDoc(uri, R.decodeBytes(fs.readFileSync(file)).text, 'reg'); s.vscode.workspace.textDocuments.push(doc); }
    await s.api.regProvider.resolveCustomTextEditor(doc, panel);
  }
  await panel.send({ type: 'ready' });
  const init = panel.last('init');
  if (init && (init.kind === 'reg' || init.kind === 'hive')) await panel.send({ type: 'rendered' });
  const sess = [...s.api.viewer.sessions].find((x) => x.panel === panel);
  s.api.viewer.active = sess;
  return { panel, init, doc, sess };
}
async function ask(panel, msg, type) { const n = panel.posted.length; await panel.send(msg); return panel.posted.slice(n).find((m) => m.type === type); }

function ws() {
  const dir = tmpDir('reg-ws-');
  for (const f of fs.readdirSync(SAMPLES)) fs.copyFileSync(path.join(SAMPLES, f), path.join(dir, f));
  for (const f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), path.join(dir, f));
  fs.copyFileSync(path.join(SAMPLES, 'zovo-demo.hiv'), path.join(dir, 'NTUSER.DAT'));
  // hive B: the demo app after an update (Version changed, a new key, the rest gone)
  fs.writeFileSync(path.join(dir, 'NTUSER-after.DAT'), makeHive({ name: 'ZovoDemo', kids: [{ name: 'Software', kids: [{ name: 'Zovo Demo', time: '2026-11-20T10:00:00Z', values: [{ name: 'Version', type: 4, bytes: dword(0x00010300) }, { name: 'NewSetting', type: 1, bytes: sz('on') }], kids: [{ name: 'Plugins', values: [{ name: 'Count', type: 4, bytes: dword(2) }] }] }] }] }));
  fs.writeFileSync(path.join(dir, 'SYSTEM'), makeHive({ name: 'SYS', values: [{ name: 'a', type: 4, bytes: dword(1) }] }, { dirty: true }));
  // reg B: the sample with a changed theme and no Run key
  const t = R.decodeBytes(fs.readFileSync(path.join(SAMPLES, 'zovo-demo.reg'))).text.replace('"Theme"="dark"', '"Theme"="light"').replace(/\[HKEY_CURRENT_USER\\Software\\Microsoft[^\]]*\]\r\n[^\r]*\r\n\r\n/, '');
  fs.writeFileSync(path.join(dir, 'after.reg'), R.encodeReg(t, 5));
  fs.writeFileSync(path.join(dir, 'empty.reg'), Buffer.alloc(0));
  fs.writeFileSync(path.join(dir, 'notes.reg'), 'just some notes\nnot a registry file\n');
  return dir;
}
const proPanels = (s, title) => s.log.info.filter((m) => m.text === `${title} is part of Zovo Pro.`);

// ---------- package.json and listing ----------
test('listing: display name, phrase first, description, 5 keywords, engines, activation', () => {
  assert.equal(pkg.displayName, 'REG File Editor & Hive Viewer');
  assert.ok(pkg.displayName.length <= 30);
  assert.match(pkg.description, /^REG file editor/);
  assert.deepEqual(pkg.keywords, ['reg', 'registry', 'windows registry', 'regedit', 'hive']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.equal(pkg.publisher, 'zovo');
  assert.equal(pkg.name, 'zovo-reg-editor');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository.url, 'https://github.com/theluckystrike/reg-editor-vscode');
  assert.deepEqual(pkg.activationEvents, ['onUri', 'onLanguage:reg']);
  assert.ok(fs.existsSync(path.join(ROOT, 'icon.png')));
});
test('editors: *.reg and *.hiv by default and nothing else; *.dat is never claimed; our own reg language and grammar', () => {
  const [reg, hive] = pkg.contributes.customEditors;
  assert.deepEqual([reg.viewType, reg.priority, reg.selector.map((x) => x.filenamePattern)], ['regEditor.reg', 'default', ['*.reg']]);
  assert.deepEqual([hive.viewType, hive.priority, hive.selector.map((x) => x.filenamePattern)], ['regEditor.hive', 'default', ['*.hiv']]);
  assert.doesNotMatch(JSON.stringify(pkg.contributes.customEditors), /dat/i);
  assert.deepEqual(pkg.contributes.languages.map((l) => [l.id, l.extensions]), [['reg', ['.reg']]]);
  const g = JSON.parse(fs.readFileSync(path.join(ROOT, pkg.contributes.grammars[0].path), 'utf8'));
  assert.equal(g.scopeName, 'source.reg');
  assert.match(g.comment, /written for the Zovo REG File Editor/);
  for (const r of Object.values(g.repository)) for (const k of ['match', 'begin', 'end']) if (r[k]) new RegExp(r[k].replace('\\G', '')); // compiles
  assert.ok(fs.existsSync(path.join(ROOT, 'language-configuration.json')));
});
test('menus: single backslashes in the final package.json; the Explorer regexes; wrappers hidden from the palette; no title on menu items', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  assert.ok(!raw.includes('\\\\\\\\.'));
  const items = Object.values(pkg.contributes.menus).flat();
  assert.ok(items.every((m) => !('title' in m)));
  const reOf = (cmd) => new RegExp(/resourceFilename =~ \/(.*)\/i/.exec(pkg.contributes.menus['explorer/context'].find((m) => m.command === cmd).when)[1], 'i');
  const hive = reOf('regEditor.openAsHive');
  for (const f of ['NTUSER.DAT', 'UsrClass.dat', 'SYSTEM', 'SOFTWARE', 'SAM', 'x.hiv', 'Amcache.hve', 'old.sav']) assert.ok(hive.test(f), f);
  for (const f of ['a.reg', 'a.txt', '.gitignore', 'a.dat.bak']) assert.ok(!hive.test(f), f);
  const both = reOf('regEditor.zovoPro.diff');
  for (const f of ['a.reg', 'CLIENT.REG', 'NTUSER.DAT', 'SYSTEM']) assert.ok(both.test(f), f);
  assert.ok(!reOf('regEditor.zovoPro.timeline').test('a.reg'));
  const wrappers = pkg.contributes.commands.filter((c) => /\.zovoPro\./.test(c.command));
  assert.equal(wrappers.length, 3);
  assert.ok(wrappers.every((c) => c.title.startsWith('Zovo Pro: ')));
  for (const w of wrappers) assert.ok(pkg.contributes.menus.commandPalette.some((m) => m.command === w.command && m.when === 'false'));
});
test('every contributed command is registered, and every registered regEditor command is contributed', () => {
  const s = activate();
  const contributed = pkg.contributes.commands.map((c) => c.command);
  for (const c of contributed) assert.ok(s.commands.has(c), c);
  for (const c of s.commands.keys()) if (c.startsWith('regEditor.')) assert.ok(contributed.includes(c), c);
});
test('activation shows nothing: no message, no panel, no editor', () => {
  const s = activate();
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length, 0);
  assert.equal(s.log.panel, undefined);
  assert.equal(s.opened.length, 0);
});

// ---------- the .reg editor ----------
test('.reg editor: init sends roots, facts and the first key; children, key details and rating success', async () => {
  const s = activate();
  const { panel, init, sess } = await openEditor(s, path.join(SAMPLES, 'zovo-demo.reg'));
  assert.equal(init.kind, 'reg');
  assert.equal(init.label, 'REG 5.00');
  assert.equal(init.editable, true);
  assert.equal(init.first, 'hkey_current_user\\software\\zovo demo');
  assert.deepEqual(init.roots.map((r) => r.name), ['HKEY_CURRENT_USER']);
  assert.ok(init.facts.some((f) => f.k === 'Values' && f.v === '13'));
  const ch = await ask(panel, { type: 'children', id: 'hkey_current_user' }, 'children');
  assert.deepEqual(ch.nodes.map((n) => n.name), ['Software', 'Environment']);
  const chain = await ask(panel, { type: 'reveal', id: init.first }, 'chain');
  assert.deepEqual(chain.chain.map((c) => c.id), ['hkey_current_user', 'hkey_current_user\\software']);
  const key = await ask(panel, { type: 'select', id: init.first }, 'key');
  assert.equal(key.key.path, 'HKEY_CURRENT_USER\\Software\\Zovo Demo');
  assert.deepEqual(key.key.values.map((v) => v.typeName), ['REG_SZ', 'REG_SZ', 'REG_DWORD', 'REG_QWORD', 'REG_EXPAND_SZ', 'REG_MULTI_SZ', 'REG_BINARY']);
  assert.equal(key.key.values[4].text, '%LOCALAPPDATA%\\Zovo\\logs');
  assert.ok(sess.rendered);
});
test('.reg editor: search finds keys, value names and data; a click reveals the key', async () => {
  const s = activate();
  const { panel } = await openEditor(s, path.join(SAMPLES, 'zovo-demo.reg'));
  const r = await ask(panel, { type: 'search', q: 'tray' }, 'results');
  assert.deepEqual(r.hits.map((h) => [h.path, h.what, h.value]), [['HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'data', 'ZovoDemo']]);
  const r2 = await ask(panel, { type: 'search', q: 'fontsize' }, 'results');
  assert.equal(r2.hits[0].what, 'value');
  const empty = await ask(panel, { type: 'search', q: '' }, 'results');
  assert.deepEqual(empty.hits, []);
});
test('.reg editor: Edit, Add value and Remove change the text as text edits; the view redraws; errors are shown inline', async () => {
  const dir = ws();
  const s = activate(dir);
  const { panel, doc } = await openEditor(s, path.join(dir, 'zovo-demo.reg'));
  const id = 'hkey_current_user\\software\\zovo demo\\editor';
  let r = await ask(panel, { type: 'saveValue', id, oldName: 'FontSize', name: 'FontSize', valueType: 4, input: '0x10' }, 'editResult');
  assert.equal(r.ok, true);
  assert.match(doc.getText(), /"FontSize"=dword:00000010\r\n/);
  assert.equal(doc.isDirty, true);
  r = await ask(panel, { type: 'saveValue', id, name: 'Recent', valueType: 7, input: 'a\nb' }, 'editResult');
  assert.equal(r.ok, true);
  assert.match(doc.getText(), /"ShowMinimap"=dword:00000001\r\n"Recent"=hex\(7\):61,00,00,00,62,00,00,00,00,00\r\n/);
  r = await ask(panel, { type: 'saveValue', id, name: 'theme', valueType: 1, input: 'x' }, 'editResult');
  assert.equal(r.ok, false);
  assert.match(r.error, /already has a value named "theme"/);
  r = await ask(panel, { type: 'saveValue', id, oldName: 'Theme', name: 'Theme', valueType: 4, input: 'big' }, 'editResult');
  assert.match(r.error, /Type a number/);
  r = await ask(panel, { type: 'deleteValue', id, name: 'ShowMinimap' }, 'editResult');
  assert.equal(r.ok, true);
  assert.doesNotMatch(doc.getText(), /ShowMinimap/);
  assert.deepEqual(R.parse(doc.getText()).errors, []);
  const init = panel.last('init');
  assert.ok(init.facts.some((f) => f.k === 'Values' && f.v === '13'));
  const key = await ask(panel, { type: 'select', id }, 'key');
  assert.deepEqual(key.key.values.map((v) => [v.name, v.text]), [['Theme', 'dark'], ['FontSize', '0x00000010 (16)'], ['Recent', 'a\nb']]);
  // the file on disk is unchanged until the user saves
  assert.match(R.decodeBytes(fs.readFileSync(path.join(dir, 'zovo-demo.reg'))).text, /"ShowMinimap"=dword:00000001/);
  // a key the file deletes has nothing to edit
  r = await ask(panel, { type: 'saveValue', id: 'hkey_current_user\\software\\zovo demo\\oldcache', name: 'x', valueType: 1, input: 'y' }, 'editResult');
  assert.match(r.error, /no section of its own/);
});
test('.reg editor: typing in the text redraws the tree; broken, empty and non-registry files get notes, no error message', async () => {
  const dir = ws();
  const s = activate(dir);
  const { panel, doc } = await openEditor(s, path.join(dir, 'Client.Reg'));
  assert.equal(panel.last('init').label, 'REGEDIT4');
  doc._set(doc.getText().replace('tssysinfo]', 'tssysinfo2]'));
  for (const f of s.listeners.change) f({ document: doc });
  await until(() => panel.last('init').roots && panel.posted.filter((m) => m.type === 'init').length >= 2, 2000);
  const ch = await ask(panel, { type: 'reveal', id: 'hkey_current_user\\software\\microsoft\\terminal server client\\default\\addins\\tssysinfo2' }, 'chain');
  assert.equal(ch.chain.length, 6);
  const b = await openEditor(s, path.join(dir, 'broken.reg'));
  assert.equal(b.init.kind, 'reg');
  assert.deepEqual(b.init.errors.map((e) => e.line), [5, 6, 7, 8, 9, 10]);
  const e = await openEditor(s, path.join(dir, 'empty.reg'));
  assert.equal(e.init.kind, 'empty');
  assert.equal(e.init.canOpenText, true);
  const n = await openEditor(s, path.join(dir, 'notes.reg'));
  assert.equal(n.init.kind, 'notreg');
  assert.match(n.init.error, /not a registry file/);
  assert.equal(s.log.error.length + s.log.warn.length + s.log.info.length, 0);
  assert.equal(s.opened.length, 0);
});
test('.reg editor: a Windows-1252 REGEDIT4 file that VS Code read as UTF-8 shows from its bytes, read-only, with a note', async () => {
  const s = activate();
  const file = path.join(FIX, 'regedit4-ansi.reg');
  const doc = s.makeDoc(s.vscode.Uri.file(file), fs.readFileSync(file).toString('utf8'), 'reg');
  doc.isDirty = false;
  s.vscode.workspace.textDocuments.push(doc);
  const { panel, init } = await openEditor(s, file);
  assert.equal(init.editable, false);
  assert.match(init.notes[0], /Windows-1252 text.*Reopen with Encoding/);
  assert.ok(init.facts.some((f) => f.k === 'Encoding' && f.v === 'Windows-1252'));
  const key = await ask(panel, { type: 'select', id: 'hkey_current_user\\software\\café' }, 'key');
  assert.equal(key.key.editable, false);
  assert.equal(key.key.values[0].text, 'Café € price');
  const r = await ask(panel, { type: 'deleteValue', id: 'hkey_current_user\\software\\café', name: 'Name' }, 'editResult');
  assert.match(r.error, /Windows 1252 encoding/);
});
test('.reg editor: Open as Text shows the text beside; a line link reveals that line', async () => {
  const s = activate();
  const { panel, doc } = await openEditor(s, path.join(SAMPLES, 'zovo-demo.reg'));
  await panel.send({ type: 'openText' });
  assert.equal(s.log.opened.pop(), doc);
  await panel.send({ type: 'goLine', line: 7 });
  assert.equal(s.log.opened.pop(), doc);
});
test('problems: bad .reg lines become diagnostics with the line and a warning for an unknown root', () => {
  const s = activate();
  const text = fs.readFileSync(path.join(FIX, 'broken.reg'), 'utf8');
  const doc = s.makeDoc(s.vscode.Uri.file(path.join(FIX, 'broken.reg')), text, 'reg');
  s.api.diagnostics.update(doc);
  const d = s.diags.get(String(doc.uri));
  assert.deepEqual(d.map((x) => [x.range.start.line, x.severity]), [[4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 1]]);
  assert.equal(d[0].source, 'reg');
  const other = s.makeDoc(s.vscode.Uri.file('/x/a.txt'), 'junk', 'plaintext');
  s.api.diagnostics.update(other);
  assert.equal(s.diags.has(String(other.uri)), false);
});

// ---------- the hive viewer ----------
test('hive viewer: the sample hive, its facts, lazy children, last write times and read-only keys', async () => {
  const s = activate();
  const { panel, init } = await openEditor(s, path.join(SAMPLES, 'zovo-demo.hiv'), true);
  assert.equal(init.kind, 'hive');
  assert.equal(init.label, 'Hive 1.5');
  assert.equal(init.editable, false);
  assert.ok(init.facts.some((f) => f.k === 'State' && f.v === 'Clean'));
  const ch = await ask(panel, { type: 'children', id: init.roots[0].id }, 'children');
  assert.deepEqual(ch.nodes.map((n) => n.name), ['Control Panel', 'Environment', 'Software']);
  const env = await ask(panel, { type: 'select', id: ch.nodes[1].id }, 'key');
  assert.equal(env.key.editable, false);
  assert.equal(env.key.info[0].v, '2026-10-05 11:11:11 UTC');
  assert.deepEqual(env.key.values.map((v) => v.typeName), ['REG_EXPAND_SZ', 'REG_EXPAND_SZ']);
  const r = await ask(panel, { type: 'saveValue', id: ch.nodes[1].id, name: 'x', valueType: 1, input: 'y' }, 'editResult');
  assert.match(r.error, /Only a \.reg file can be edited/);
});
test('Open as Registry Hive: sniffs "regf"; a dirty hive opens with its note; other files get a message and no tab', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.vscode.commands.executeCommand('regEditor.openAsHive', s.vscode.Uri.file(path.join(dir, 'SYSTEM')));
  assert.deepEqual(s.opened.pop(), [path.join(dir, 'SYSTEM'), 'regEditor.hive']);
  assert.match(s.lastEditor.init.notes[0], /not closed cleanly/);
  await s.vscode.commands.executeCommand('regEditor.openAsHive', s.vscode.Uri.file(path.join(dir, 'not-a-hive.dat')));
  assert.equal(s.opened.length, 0);
  assert.match(s.log.info.pop().text, /not-a-hive\.dat is not a registry hive: its first four bytes are not "regf"/);
  // the hive viewer opened on a non-hive by other means shows a note, not an error popup
  const n = await openEditor(s, path.join(dir, 'not-a-hive.dat'), true);
  assert.equal(n.init.kind, 'notregf');
  assert.equal(s.log.error.length, 0);
});
test('samples: the .reg sample opens as a copy in storage (edits never touch the extension); the hive sample opens read-only', async () => {
  const s = activate();
  await s.vscode.commands.executeCommand('regEditor.openSample');
  const [file, view] = s.opened.pop();
  assert.equal(view, 'regEditor.reg');
  assert.ok(file.startsWith(s.context.globalStorageUri.fsPath));
  assert.equal(Buffer.compare(fs.readFileSync(file), fs.readFileSync(path.join(SAMPLES, 'zovo-demo.reg'))), 0);
  await s.vscode.commands.executeCommand('regEditor.openSampleHive');
  assert.deepEqual(s.opened.pop(), [path.join(SAMPLES, 'zovo-demo.hiv'), 'regEditor.hive']);
});

// ---------- webview safety ----------
test('webview HTML: strict CSP, nonce scripts, no remote URLs, no blob, worker or connect sources', () => {
  const e = editorHtml({ cspSource: 'vscode-resource:', scriptUri: 'media/viewer.js', styleUri: 'media/viewer.css', title: 'x<y', showSupportLinks: true, nonce: 'abc' });
  const p = panelHtml({ cspSource: 'vscode-resource:', scriptUri: 'media/panel.js', styleUri: 'media/viewer.css', title: 't', nonce: 'abc' });
  for (const h of [e, p]) {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(h)[1];
    assert.match(csp, /^default-src 'none'/);
    assert.match(csp, /script-src 'nonce-abc'(;|$)/);
    assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|connect-src|worker-src|blob:|https?:/);
    assert.ok([...h.matchAll(/<script\b[^>]*>/g)].every((m) => /nonce="abc"/.test(m[0])));
    assert.doesNotMatch(h.replace(/https:\/\/(marketplace\.visualstudio\.com|github\.com|www\.paypal\.com|open-vsx\.org)[^"]*/g, ''), /https?:\/\//);
    assert.doesNotMatch(h, /\sstyle="/);
  }
  assert.match(e, /<title>x&lt;y<\/title>/);
});
test('media scripts load nothing remote, open no connection and set no inline style attributes', () => {
  for (const f of ['viewer.js', 'panel.js']) {
    const t = fs.readFileSync(path.join(ROOT, 'media', f), 'utf8');
    assert.doesNotMatch(t, /fetch\(|XMLHttpRequest|WebSocket|new Worker|importScripts|https?:\/\/|eval\(|style="|setAttribute\('style'/, f);
  }
});
test('no source file opens a network connection, runs a program or calls a registry API', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(ROOT, 'src')).filter((x) => x.endsWith('.js') && !x.includes(`${path.sep}license${path.sep}`))) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /require\(['"](https?|net|tls|dgram|child_process|worker_threads)['"]\)|fetch\(|reg\.exe|regedit\.exe|winreg/i, f);
  }
});

// ---------- Pro: export and convert ----------
test('Pro Export: a hive to .reg 5.00 at the mount path (file written and opened); try counted after the file was written', async () => {
  const dir = ws();
  const s = activate(dir);
  s.ui.quick.push((items) => { assert.deepEqual(items.map((i) => i.id), ['reg5', 'reg4', 'json', 'csv']); return items[0]; });
  s.ui.input.push('HKEY_CURRENT_USER');
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'ntuser.reg')));
  const r = await s.api.tools.exportReg(s.vscode.Uri.file(path.join(dir, 'NTUSER.DAT')), {});
  assert.equal(r.format, 'reg5');
  assert.equal(r.keys, 16);
  const out = R.decodeBytes(fs.readFileSync(path.join(dir, 'ntuser.reg')));
  assert.equal(out.encoding, 'UTF-16LE');
  assert.match(out.text, /^Windows Registry Editor Version 5\.00\r\n\r\n\[HKEY_CURRENT_USER\]\r\n/);
  assert.match(out.text, /\[HKEY_CURRENT_USER\\Software\\Zovo Demo\]\r\n@="Zovo Demo App"/);
  assert.deepEqual(R.parse(out.text).errors, []);
  assert.deepEqual(s.opened.pop(), [path.join(dir, 'ntuser.reg'), 'regEditor.reg']);
  assert.equal(s.api.pro.used('export'), 1);
});
test('Pro Export: one key of the open .reg converted to REGEDIT4; Escape, Cancel and a write over the source use no try', async () => {
  const dir = ws();
  const s = activate(dir);
  const { panel } = await openEditor(s, path.join(dir, 'zovo-demo.reg'));
  await panel.send({ type: 'select', id: 'hkey_current_user\\software\\zovo demo\\editor' });
  s.ui.quick.push(undefined); // Escape at the format
  assert.equal(await s.vscode.commands.executeCommand('regEditor.export'), undefined);
  s.ui.quick.push((items) => items.find((i) => i.id === 'reg4'));
  s.ui.quick.push((items) => { assert.equal(items[1].label, 'Only HKEY_CURRENT_USER\\Software\\Zovo Demo\\Editor'); return items[1]; });
  s.ui.save.push(undefined); // Cancel in the save dialog
  assert.equal(await s.vscode.commands.executeCommand('regEditor.export'), undefined);
  const self = s.vscode.Uri.file(path.join(dir, 'zovo-demo.reg'));
  assert.equal(await s.api.tools.exportReg(self, { format: 'reg5', scope: 'all', dest: self }), undefined);
  assert.match(s.log.error.pop().text, /never writes over the file it reads/);
  assert.equal(s.api.pro.left('export'), 1);
  s.ui.quick.push((items) => items.find((i) => i.id === 'reg4'));
  s.ui.quick.push((items) => items[1]);
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'editor.regedit4.reg')));
  const r = await s.vscode.commands.executeCommand('regEditor.export');
  assert.equal(r.keys, 1);
  const t = fs.readFileSync(path.join(dir, 'editor.regedit4.reg'), 'latin1');
  assert.equal(t, 'REGEDIT4\r\n\r\n[HKEY_CURRENT_USER\\Software\\Zovo Demo\\Editor]\r\n"Theme"="dark"\r\n"FontSize"=dword:0000000e\r\n"ShowMinimap"=dword:00000001\r\n\r\n');
  assert.equal(s.api.pro.left('export'), 0);
});
test('Pro Export A then B: after the CSV of file A, the export of file B opens the Pro panel', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.exportReg(s.vscode.Uri.file(path.join(dir, 'NTUSER.DAT')), { format: 'csv', scope: 'all', dest: s.vscode.Uri.file(path.join(dir, 'a.csv')) });
  assert.match(fs.readFileSync(path.join(dir, 'a.csv'), 'utf8'), /^key,last_write,value,type,data\r\n/);
  assert.equal(s.api.pro.left('export'), 0);
  const r = await s.api.tools.exportReg(s.vscode.Uri.file(path.join(dir, 'Client.Reg')), { format: 'json', scope: 'all', dest: s.vscode.Uri.file(path.join(dir, 'b.json')) });
  assert.equal(r, undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'b.json')));
  assert.equal(proPanels(s, 'Export and convert').length, 1);
});

// ---------- Pro: compare ----------
test('Pro Compare: hive A with hive B (picked); the table shows; the patch and Markdown are saved; try counted after it showed', async () => {
  const dir = ws();
  const s = activate(dir);
  s.ui.quick.push((items) => items.find((i) => i.file));
  s.ui.open.push([s.vscode.Uri.file(path.join(dir, 'NTUSER-after.DAT'))]);
  const r = await s.api.tools.diff(s.vscode.Uri.file(path.join(dir, 'NTUSER.DAT')));
  assert.deepEqual(r.onlyB, ['HKEY_CURRENT_USER\\Software\\Zovo Demo\\Plugins']);
  await until(() => s.api.pro.left('diff') === 0);
  const show = s.log.panel.posted.find((m) => m.type === 'show');
  assert.match(show.html, /<b id="nOnlyB">1<\/b>/);
  assert.match(show.html, /<td><code>Version<\/code><\/td><td>changed<\/td><td>REG_DWORD<\/td><td><code>0x00010203 \(66051\)<\/code><\/td><td><code>0x00010300 \(66304\)<\/code><\/td>/);
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'patch.reg')));
  await s.log.panel.send({ type: 'action', id: 'patch' });
  const patch = R.decodeBytes(fs.readFileSync(path.join(dir, 'patch.reg'))).text;
  assert.match(patch, /\[HKEY_CURRENT_USER\\Software\\Zovo Demo\\Plugins\]\r\n"Count"=dword:00000002/);
  assert.match(patch, /\[-HKEY_CURRENT_USER\\Environment\]/);
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'report.md')));
  await s.log.panel.send({ type: 'action', id: 'md' });
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /^# Registry comparison\n\n- A: NTUSER\.DAT/);
  assert.equal(s.api.pro.used('diff'), 1);
});
test('Pro Compare A then B: after comparing two hives, comparing two .reg files opens the Pro panel; Escape used no try', async () => {
  const dir = ws();
  const s = activate(dir);
  s.ui.quick.push(undefined);
  assert.equal(await s.api.tools.diff(s.vscode.Uri.file(path.join(dir, 'zovo-demo.reg'))), undefined);
  assert.equal(s.api.pro.left('diff'), 1);
  const a = await s.api.tools.diff(s.vscode.Uri.file(path.join(dir, 'zovo-demo.reg')), { other: s.vscode.Uri.file(path.join(dir, 'after.reg')) });
  assert.deepEqual(a.onlyA, ['HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run']);
  assert.deepEqual(a.changed.map((c) => c.changes.map((x) => x.name)), [['Theme']]);
  await until(() => s.api.pro.left('diff') === 0);
  const r = await s.api.tools.diff(s.vscode.Uri.file(path.join(dir, 'NTUSER.DAT')), { other: s.vscode.Uri.file(path.join(dir, 'NTUSER-after.DAT')) });
  assert.equal(r, undefined);
  assert.equal(proPanels(s, 'Compare two registry files').length, 1);
  assert.equal(s.log.panel.posted.filter((m) => m.type === 'show').length, 1);
});

// ---------- Pro: timeline ----------
test('Pro Timeline: keys newest first, the filter and the CSV; a .reg file gets a note and uses no try', async () => {
  const dir = ws();
  const s = activate(dir);
  assert.equal(await s.api.tools.timeline(s.vscode.Uri.file(path.join(dir, 'zovo-demo.reg'))), undefined);
  assert.match(s.log.info.pop().text, /hold no last write times/);
  assert.equal(s.api.pro.left('timeline'), 1);
  const t = await s.api.tools.timeline(s.vscode.Uri.file(path.join(dir, 'NTUSER.DAT')));
  assert.equal(t.rows.length, 16);
  await until(() => s.api.pro.left('timeline') === 0);
  const show = s.log.panel.posted.find((m) => m.type === 'show');
  assert.match(show.html, /<b id="nKeys">16<\/b>/);
  assert.match(show.html, /<tbody><tr><td><code>2026-11-16 07:59:12<\/code><\/td><td><code>ZovoDemo\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\\{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA\}\\Count<\/code>/);
  await s.log.panel.send({ type: 'action', id: 'filter', fields: { from: '2026-11-14', to: '2026-11-15', text: '' } });
  const patch = s.log.panel.posted.filter((m) => m.type === 'patch' && m.target === 'tl').pop();
  assert.match(patch.html, /Showing 2 of 2 keys/);
  await s.log.panel.send({ type: 'action', id: 'filter', fields: { from: '14.11.2026' } });
  assert.match(s.log.panel.posted.filter((m) => m.type === 'patch' && m.target === 'saved').pop().html, /YYYY-MM-DD/);
  s.ui.save.push(s.vscode.Uri.file(path.join(dir, 'tl.csv')));
  await s.log.panel.send({ type: 'action', id: 'csv' });
  const csv = fs.readFileSync(path.join(dir, 'tl.csv'), 'utf8').trim().split('\r\n');
  assert.deepEqual(csv.map((l) => l.split(',')[1].split('\\').pop()), ['key', 'Editor', 'Zovo Demo']);
});
test('Pro Timeline A then B: used on one hive, the click on another hive (from the active viewer) opens the Pro panel', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.timeline(s.vscode.Uri.file(path.join(dir, 'NTUSER.DAT')));
  await until(() => s.api.pro.left('timeline') === 0);
  const shows = s.log.posted.filter((m) => m.type === 'show').length;
  await openEditor(s, path.join(dir, 'SYSTEM'), true);
  const r = await s.vscode.commands.executeCommand('regEditor.timeline');
  assert.equal(r, undefined);
  assert.equal(proPanels(s, 'Last write timeline').length, 1);
  assert.equal(s.log.posted.filter((m) => m.type === 'show').length, shows);
});

// ---------- tries across tools, reloads and the panel ----------
test('a window reload keeps the counts: after a reload every used tool opens the Pro panel', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.timeline(s.vscode.Uri.file(path.join(dir, 'NTUSER.DAT')));
  await s.api.tools.diff(s.vscode.Uri.file(path.join(dir, 'zovo-demo.reg')), { other: s.vscode.Uri.file(path.join(dir, 'after.reg')) });
  await until(() => s.api.pro.left('timeline') === 0 && s.api.pro.left('diff') === 0);
  const s2 = activate(dir, s.state);
  assert.deepEqual(s2.api.pro.tries(), { export: 1, diff: 0, timeline: 0 });
  assert.equal(await s2.api.tools.timeline(s2.vscode.Uri.file(path.join(dir, 'SYSTEM'))), undefined);
  assert.equal(proPanels(s2, 'Last write timeline').length, 1);
  assert.equal(await s2.api.tools.diff(s2.vscode.Uri.file(path.join(dir, 'after.reg')), { other: s2.vscode.Uri.file(path.join(dir, 'zovo-demo.reg')) }), undefined);
  assert.equal(proPanels(s2, 'Compare two registry files').length, 1);
});
test('the Pro panel names the other tools with their tries and no URL is opened when it is cancelled', async () => {
  const dir = ws();
  const s = activate(dir);
  await s.api.tools.timeline(s.vscode.Uri.file(path.join(dir, 'NTUSER.DAT')));
  await until(() => s.api.pro.left('timeline') === 0);
  await s.api.tools.timeline(s.vscode.Uri.file(path.join(dir, 'NTUSER.DAT')));
  const p = proPanels(s, 'Last write timeline')[0];
  assert.ok(p && p.opts.modal);
  assert.match(p.opts.detail, /You used the free try of Last write timeline on this computer\./);
  assert.match(p.opts.detail, /Export and convert: 0 of 1 free try used/);
  assert.match(p.opts.detail, /Compare two registry files: 0 of 1 free try used/);
  assert.equal(s.log.external.length, 0);
});
test('the Explorer entry runs the tool on the clicked file', async () => {
  const dir = ws();
  const s = activate(dir);
  const t = await s.vscode.commands.executeCommand('regEditor.zovoPro.timeline', s.vscode.Uri.file(path.join(dir, 'NTUSER.DAT')));
  assert.equal(t.rows.length, 16);
  assert.equal(s.log.panel.title, 'Timeline: NTUSER.DAT');
});
test('the toolbar row lists the 3 Pro tools with 1 free try each; one constant; the proinfo tries key matches', () => {
  const s = activate();
  const reachCfg = require('../src/reach-config');
  assert.deepEqual(reachCfg.tools.map((t) => t.id), ['export', 'diff', 'timeline']);
  const pro = require('../src/pro');
  assert.equal(pro.TRIAL_USES, 1);
  const cfg = require('../src/license/config');
  assert.equal(cfg.listing, 'reg');
  assert.equal(cfg.pro_info.triesKey, pro.TRIAL_KEY);
  assert.equal(reachCfg.triesKey, pro.TRIAL_KEY);
  assert.equal(cfg.pro_info.triesMax, undefined);
  assert.deepEqual(cfg.pro_info.tools.map((t) => t.id), ['export', 'diff', 'timeline']);
  assert.deepEqual(Object.keys(s.api.pro.tries()), ['export', 'diff', 'timeline']);
  const row = s.api.viewer.hooks.reach().rowHtml();
  assert.equal((row.match(/<small>1 free try<\/small>/g) || []).length, 3);
  assert.match(row, /Get Zovo Pro/);
});

// ---------- README and text ----------
test('README: first screen has the main use, a screenshot of this product, the free list and the price; by Zovo; no rival names', () => {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const first = md.split('\n').slice(0, 30).join('\n');
  assert.match(first, /^# REG File Editor & Hive Viewer/);
  assert.match(first, /\(images\/screenshot\.png\)/);
  assert.match(first, /Zovo Pro: USD 19 once/);
  assert.match(md, /by Zovo/i);
  const files = ['README.md', 'CHANGELOG.md', 'package.json', 'walkthrough/hives.md', 'walkthrough/related.md', 'THIRD-PARTY-NOTICES.md', 'syntaxes/reg.tmLanguage.json',
    'src/core/values.js', 'src/core/regtext.js', 'src/core/hive.js', 'src/core/model.js', 'src/core/compare.js', 'src/editor.js', 'src/tools.js', 'src/diagnostics.js', 'src/extension.js', 'media/viewer.js', 'media/panel.js'];
  for (const f of files) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/"regedit"/g, ''); // the keyword tag
    assert.doesNotMatch(t, /ionutvmi|m417z|isopodlabs|KeiichiMatsui|ybq|reg-visualizer|regedit-explorer|Registry Explorer|RegRipper|libregf|yarp|python-registry|Registry Finder|Registry Workshop|\bregedit\b|reg\.exe/i, f);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'screenshot.png')));
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8'), /^images\/?(\*\*|\*\.png|screenshot)?\s*$/m);
});
test('support links name this listing and related Zovo tools', () => {
  const support = require('../src/support');
  assert.equal(support.SELF_ID, 'zovo.zovo-reg-editor');
  assert.ok(support.RELATED.length >= 3 && !support.RELATED.includes(support.SELF_ID));
  assert.equal(support.PRO.getPro, 'regEditor.getPro');
  const steps = pkg.contributes.walkthroughs[0].steps;
  const links = steps.flatMap((st) => [...st.description.matchAll(/command:extension\.open\?%5B%22([^%]+)%22%5D/g)].map((m) => m[1]));
  assert.deepEqual(links, ['zovo.zovo-hex-viewer', 'zovo.zovo-elf-pe-viewer', 'zovo.zovo-log-viewer']);
  for (const id of links) assert.ok(fs.existsSync(path.join(ROOT, '..', id.replace('zovo.zovo-', '') + '-vscode')), id);
});
