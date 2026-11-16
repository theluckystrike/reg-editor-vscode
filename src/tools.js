'use strict';
// The three Zovo Pro tools: Export and convert, Compare two registry files, Last write timeline. Each asks
// pro.allowed() on every click and calls pro.produced() only after its result is there (the exported file written
// and opened, the comparison or timeline drawn in its panel), so Escape, Cancel or an error never uses a free try.
// Everything runs on this computer; files are read and written through VS Code's file system API. Nothing is written
// to a live registry.
const vscode = require('vscode');
const path = require('path');
const R = require('./core/regtext');
const H = require('./core/hive');
const C = require('./core/compare');
const { loadFile, VIEW_REG } = require('./editor');
const { panelHtml } = require('./html');
const support = require('./support');

const PREFIX = 'regEditor';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const base = (uri) => path.posix.basename(uri.path);
const stem = (uri) => base(uri).replace(/\.[^.]+$/, '');
const FILTERS = { 'Registry files': ['reg', 'hiv', 'dat'], 'All files': ['*'] };
const MAX_ROWS = 5000;
const n = (count, one, many) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
const OPEN_MAX = 10 * 1024 * 1024;
const isRegName = (uri) => /\.reg$/i.test(uri.path);

function sibling(uri, name) { return vscode.Uri.joinPath(uri, '..', name); }
async function writeBytes(uri, bytes) { await vscode.workspace.fs.writeFile(uri, bytes instanceof Uint8Array ? bytes : Buffer.from(bytes, 'utf8')); }
const sameFile = (a, b) => a && b && a.toString() === b.toString();
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'key';

function createTools({ context, viewer, pro, reach }) {
  const panels = {};

  function openPanel(kind, title) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const old = panels[kind];
    if (old && !old.disposed) old.panel.dispose();
    const panel = vscode.window.createWebviewPanel(`${PREFIX}.${kind}`, title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
      enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)),
    });
    panel.webview.html = panelHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
      title, head: reach ? (n) => reach.headHtml(n) : undefined, showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    let readyFn;
    const p = { panel, kind, disposed: false, actions: null, shown: null };
    p.ready = new Promise((r) => { readyFn = r; });
    p.post = (msg) => { try { const r = panel.webview.postMessage(msg); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* disposed */ } };
    p.show = async (o) => { await p.ready; p.post({ type: 'show', ...o }); };
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      try {
        if (m.type === 'ready') readyFn();
        else if (m.type === 'shown') { if (p.shown) { const f = p.shown; p.shown = null; await f(m); } }
        else if (m.type === 'action' && p.actions) await p.actions(m.id, m);
      } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); }
    });
    panel.onDidDispose(() => { p.disposed = true; if (panels[kind] === p) delete panels[kind]; });
    panels[kind] = p;
    return p;
  }

  /** The file a tool works on: the clicked one, else the file of the active viewer or .reg text editor, else a dialog. */
  async function targetFile(arg, title) {
    if (arg && arg.scheme) return arg;
    if (viewer.active) return viewer.active.uri;
    const ed = vscode.window.activeTextEditor;
    if (ed && isRegName(ed.document.uri)) return ed.document.uri;
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Choose', title, filters: FILTERS });
    return r && r[0];
  }

  /** { kind: 'reg' | 'hive', source, name } of uri: the viewer's own when it is open (unsaved edits included), else read now. */
  async function docFor(uri) {
    for (const s of viewer.sessions) if (s.uri.toString() === uri.toString() && s.data && s.data.source) return { kind: s.data.kind, source: s.data.source, name: s.name };
    const td = (vscode.workspace.textDocuments || []).find((t) => t.uri.toString() === uri.toString() && t.isDirty);
    const data = await loadFile(uri, td && isRegName(uri) ? { text: td.getText() } : { asHive: !isRegName(uri) });
    if (data.kind !== 'reg' && data.kind !== 'hive') throw new Error(`${base(uri)} could not be read: ${data.error}`);
    return { kind: data.kind, source: data.source, name: base(uri) };
  }

  async function pickOther(uriA, title) {
    const items = [];
    const seen = new Set([uriA.toString()]);
    for (const s of viewer.sessions) if (!seen.has(s.uri.toString()) && s.data && s.data.source) { seen.add(s.uri.toString()); items.push({ label: s.name, description: 'open in the viewer', uri: s.uri }); }
    let files = [];
    try { files = await vscode.workspace.findFiles('**/*.{reg,hiv}', '**/node_modules/**', 300); } catch (e) { files = []; }
    for (const u of files) if (!seen.has(u.toString())) { seen.add(u.toString()); items.push({ label: base(u), description: vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(u) : u.fsPath, uri: u }); }
    items.push({ label: 'Choose a file...', description: 'a .reg file or a hive (NTUSER.DAT, SYSTEM, SOFTWARE, .hiv)', file: true });
    const pick = await vscode.window.showQuickPick(items, { ignoreFocusOut: true, title, placeHolder: 'The file to compare with (B)', matchOnDescription: true });
    if (!pick) return undefined;
    if (!pick.file) return pick.uri;
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', title, filters: FILTERS });
    return r && r[0];
  }

  async function askPrefix(name, extra) {
    if (typeof extra.prefix === 'string') return extra.prefix;
    return vscode.window.showInputBox({
      ignoreFocusOut: true, title: `Registry path of ${name}`, value: H.mountGuess(name),
      prompt: 'The path this hive is loaded at in the registry. Every key in the .reg file starts with it.',
      validateInput: (v) => (R.ROOTS.includes(String(v).split('\\')[0].toUpperCase()) && !/\\\\|\\$/.test(v) ? undefined : 'Start with HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER, HKEY_USERS, HKEY_CLASSES_ROOT or HKEY_CURRENT_CONFIG.'),
    });
  }

  // ---------- 1. Export and convert ----------
  async function exportReg(arg, extra = {}) {
    if (!(await pro.allowed('export', arg))) return undefined;
    const uri = await targetFile(arg, 'Export: choose a .reg file or a registry hive');
    if (!uri) return undefined;
    const d = await docFor(uri);
    const src = d.source;
    const ver = d.kind === 'reg' ? src.p.version : 0;
    const items = [
      { label: '.reg, version 5.00', description: ver === 5 ? 'a clean copy, UTF-16LE as Windows writes it' : 'UTF-16LE, as Windows writes it', id: 'reg5' },
      { label: '.reg, REGEDIT4', description: 'the older format, Windows-1252 text', id: 'reg4' },
      { label: 'JSON', description: 'keys with their values, types and data', id: 'json' },
      { label: 'CSV', description: 'one row per value: key, last write, value, type, data', id: 'csv' },
    ];
    let id = extra.format;
    if (!id) {
      const pick = await vscode.window.showQuickPick(items, { ignoreFocusOut: true, title: `Export ${d.name}`, placeHolder: 'Save as...' });
      if (!pick) return undefined;
      id = pick.id;
    }
    if (!items.some((i) => i.id === id)) return undefined;
    // scope: the selected key and the keys below it, or the whole file
    let scope = extra.scope;
    if (scope === undefined) {
      const sess = viewer.sessionFor(uri);
      const sel = sess && sess.selected;
      const isRoot = d.kind === 'hive' ? Number(sel) === src.h.rootKey.off : false;
      if (sel !== undefined && sel !== null && !isRoot && src.pathOf(sel)) {
        const pick = await vscode.window.showQuickPick([
          { label: 'The whole file', id: 'all' },
          { label: `Only ${src.pathOf(sel)}`, description: 'and the keys below it', id: 'key' },
        ], { ignoreFocusOut: true, title: `Export ${d.name}`, placeHolder: 'What to export' });
        if (!pick) return undefined;
        scope = pick.id === 'key' ? sel : 'all';
      } else scope = 'all';
    }
    const sc = scope === 'all' ? undefined : scope;
    let prefix;
    if (d.kind === 'hive' && (id === 'reg5' || id === 'reg4')) { prefix = await askPrefix(d.name, extra); if (!prefix) return undefined; }
    const entries = d.kind === 'hive' ? src.entries(sc, prefix) : src.entries(sc);
    let out;
    if (id === 'reg5' || id === 'reg4') { const v = id === 'reg4' ? 4 : 5; out = R.encodeReg(R.toRegText(entries, v), v); }
    else if (id === 'json') out = Buffer.from(C.toJson(entries, { source: d.name, format: d.kind === 'hive' ? 'registry hive' : `.reg ${ver === 4 ? 'REGEDIT4' : '5.00'}` }), 'utf8');
    else out = Buffer.from(C.toCsv(entries), 'utf8');
    const part = sc !== undefined ? `-${safe(src.pathOf(sc).split('\\').pop())}` : '';
    const ext = id === 'json' ? 'json' : id === 'csv' ? 'csv' : 'reg';
    let name = `${stem(uri)}${part}.${ext}`;
    if (ext === 'reg' && d.kind === 'reg') name = `${stem(uri)}${part}.${id === 'reg4' ? 'regedit4' : 'v5'}.reg`;
    const dest = extra.dest || await vscode.window.showSaveDialog({ defaultUri: sibling(uri, name), filters: { [ext.toUpperCase()]: [ext] }, title: `Save ${d.name} as ${items.find((i) => i.id === id).label}` });
    if (!dest) return undefined;
    if (sameFile(dest, uri)) { vscode.window.showErrorMessage('Choose another file name: the export never writes over the file it reads.'); return undefined; }
    await writeBytes(dest, out);
    if (ext === 'reg') await vscode.commands.executeCommand('vscode.openWith', dest, VIEW_REG, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    else if (out.length <= OPEN_MAX) { const td = await vscode.workspace.openTextDocument(dest); await vscode.window.showTextDocument(td, { viewColumn: vscode.ViewColumn.Beside, preview: true }); }
    vscode.window.setStatusBarMessage(`Saved ${base(dest)}: ${n(entries.length, 'key', 'keys')}, ${n(out.length, 'byte', 'bytes')}`, 8000);
    await pro.produced('export');
    return { dest, format: id, size: out.length, keys: entries.length };
  }

  // ---------- 2. Compare two registry files ----------
  async function diff(arg, extra = {}) {
    if (!(await pro.allowed('diff', arg))) return undefined;
    const uriA = await targetFile(arg, 'Compare: choose the first file (A)');
    if (!uriA) return undefined;
    const uriB = extra.other || await pickOther(uriA, `Compare ${base(uriA)} with...`);
    if (!uriB) return undefined;
    const a = await docFor(uriA);
    const b = await docFor(uriB);
    let note = '';
    let prefix = '';
    if (a.kind === 'hive' || b.kind === 'hive') {
      prefix = typeof extra.prefix === 'string' ? extra.prefix : H.mountGuess(a.kind === 'hive' ? a.name : b.name);
      note = a.kind === 'hive' && b.kind === 'hive'
        ? `Both hives are compared below their root key; the paths start with ${prefix} (from the name of ${a.name}).`
        : `The keys of the hive are read as if it were loaded at ${prefix} (from its file name).`;
    }
    const ea = a.kind === 'hive' ? a.source.entries(undefined, prefix) : a.source.entries();
    const eb = b.kind === 'hive' ? b.source.entries(undefined, prefix) : b.source.entries();
    const r = C.diff(ea, eb);
    const nameA = base(uriA), nameB = base(uriB);
    const title = `Compare: ${nameA} and ${nameB}`;
    const p = openPanel('diff', title);
    p.result = r;
    p.shown = async () => { await pro.produced('diff'); };
    const fileName = `${stem(uriA)}-vs-${stem(uriB)}`;
    p.actions = async (id) => {
      if (id !== 'md' && id !== 'patch') return;
      const md = id === 'md';
      const dest = await vscode.window.showSaveDialog({ defaultUri: sibling(uriA, md ? `${fileName}.md` : `${fileName}.patch.reg`), filters: md ? { Markdown: ['md'] } : { REG: ['reg'] }, title: md ? 'Save the comparison as Markdown' : 'Save a .reg patch that turns A into B' });
      if (!dest) return;
      if (md) await writeBytes(dest, C.toMarkdown(r, nameA, nameB, note));
      else await writeBytes(dest, R.encodeReg(C.patchText(r), 5));
      p.post({ type: 'patch', target: 'saved', html: `Saved ${esc(dest.fsPath || dest.path)}.` });
    };
    const rs = C.rows(r);
    const tr = rs.slice(0, MAX_ROWS).map((x) => `<tr class="${x.kind}" data-kind="${x.kind}"><td><code>${esc(x.path)}</code></td><td><code>${esc(x.name)}</code></td><td>${x.kind}</td><td>${esc(x.type)}</td><td><code>${esc(x.a.slice(0, 400))}</code></td><td><code>${esc(x.b.slice(0, 400))}</code></td></tr>`);
    const list = (arr, id) => (arr.length ? `<ul id="${id}">${arr.slice(0, MAX_ROWS).map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>${arr.length > MAX_ROWS ? `<p class="muted">First ${MAX_ROWS} of ${arr.length}; the saved report has all.</p>` : ''}` : `<p id="${id}" class="muted">None.</p>`);
    const kindOf = (d) => (d.kind === 'hive' ? 'hive' : d.source.p.version === 4 ? 'REGEDIT4' : '.reg 5.00');
    const html = `<p class="row"><button class="tb act" data-id="patch">Save .reg patch (A to B)...</button> <button class="tb act" data-id="md">Save report as Markdown...</button> <span id="saved" class="muted"></span></p>
<div class="stats"><div><b id="nOnlyA">${r.onlyA.length}</b><span>${r.onlyA.length === 1 ? 'key' : 'keys'} only in A</span></div><div><b id="nOnlyB">${r.onlyB.length}</b><span>${r.onlyB.length === 1 ? 'key' : 'keys'} only in B</span></div><div><b id="nChanged">${r.valueChanges}</b><span>${r.valueChanges === 1 ? 'value change' : 'value changes'} in ${n(r.changed.length, 'key', 'keys')}</span></div><div><b id="nSame">${r.same}</b><span>${r.same === 1 ? 'key' : 'keys'} the same</span></div></div>
<p class="muted">A: ${esc(nameA)} (${kindOf(a)}, ${n(r.keysA, 'key', 'keys')}). B: ${esc(nameB)} (${kindOf(b)}, ${n(r.keysB, 'key', 'keys')}). Keys and values are matched by name without regard to case, as Windows does; string data is compared as text. ${esc(note)} The patch deletes keys only in A, adds keys only in B and sets every changed value; it is a file for you to review, nothing is imported.</p>
<h3>Keys only in A</h3>${list(r.onlyA, 'onlyA')}
<h3>Keys only in B</h3>${list(r.onlyB, 'onlyB')}
<h3>Changed values</h3>${tr.length ? `<table id="diffTable" class="sort"><thead><tr><th>Key</th><th>Value</th><th>Change</th><th>Type</th><th>A</th><th>B</th></tr></thead><tbody>${tr.join('')}</tbody></table>` : '<p class="muted">None.</p>'}`;
    await p.show({ title, html });
    return r;
  }

  // ---------- 3. Last write timeline ----------
  async function timeline(arg, extra = {}) {
    if (!(await pro.allowed('timeline', arg))) return undefined;
    const uri = await targetFile(arg, 'Timeline: choose a registry hive');
    if (!uri) return undefined;
    const d = await docFor(uri);
    if (d.kind !== 'hive') { vscode.window.showInformationMessage(`${d.name} is a .reg file, and .reg files hold no last write times. The timeline needs a registry hive, such as NTUSER.DAT, SYSTEM or SOFTWARE.`); return undefined; }
    const all = C.timeline(d.source.entries(undefined, d.source.h.rootKey.name));
    const title = `Timeline: ${d.name}`;
    const p = openPanel('timeline', title);
    p.result = all;
    p.shown = async () => { await pro.produced('timeline'); };
    let current = C.filterTimeline(all, extra.filter || {});
    const table = (list) => `<p class="muted" id="tlCount">Showing ${Math.min(list.length, MAX_ROWS).toLocaleString('en-US')} of ${n(list.length, 'key', 'keys')}${list.length > MAX_ROWS ? ' (the CSV has all)' : ''}, newest first.</p>
<table id="tlTable" class="sort"><thead><tr><th>Last write (UTC)</th><th>Key</th><th>Values</th><th>Subkeys</th></tr></thead><tbody>${list.slice(0, MAX_ROWS).map((r) => `<tr><td><code>${esc(r.time.replace('T', ' ').replace(/\.000Z$/, '').replace('Z', ''))}</code></td><td><code>${esc(r.path)}</code></td><td>${r.values}</td><td>${r.subkeys}</td></tr>`).join('')}</tbody></table>`;
    p.actions = async (id, m) => {
      if (id === 'filter') {
        const f = m.fields || {};
        const bad = ['from', 'to'].find((k) => f[k] && !/^\d{4}-\d{2}-\d{2}$/.test(f[k]));
        if (bad) { p.post({ type: 'patch', target: 'saved', html: 'Dates are written YYYY-MM-DD.' }); return; }
        current = C.filterTimeline(all, { from: f.from, to: f.to, text: f.text });
        p.post({ type: 'patch', target: 'tl', html: table(current) });
        p.post({ type: 'patch', target: 'saved', html: '' });
        return;
      }
      if (id !== 'csv') return;
      const dest = await vscode.window.showSaveDialog({ defaultUri: sibling(uri, `${stem(uri)}.timeline.csv`), filters: { CSV: ['csv'] }, title: 'Save the timeline as CSV' });
      if (!dest) return;
      await writeBytes(dest, C.timelineCsv(current));
      p.post({ type: 'patch', target: 'saved', html: `Saved ${esc(dest.fsPath || dest.path)} (${n(current.length, 'key', 'keys')}).` });
    };
    const newest = all.length ? all[0].time.slice(0, 10) : '';
    const oldest = all.length ? all[all.length - 1].time.slice(0, 10) : '';
    const html = `<div class="stats"><div><b id="nKeys">${all.length}</b><span>${all.length === 1 ? 'key' : 'keys'} with a last write time</span></div><div><b id="tNewest">${esc(newest)}</b><span>newest</span></div><div><b id="tOldest">${esc(oldest)}</b><span>oldest</span></div></div>
<p class="row filters"><label>From <input class="fv" data-name="from" id="fFrom" placeholder="YYYY-MM-DD" size="11" value="${esc((extra.filter || {}).from || '')}"></label> <label>To <input class="fv" data-name="to" id="fTo" placeholder="YYYY-MM-DD" size="11" value="${esc((extra.filter || {}).to || '')}"></label> <label>Key contains <input class="fv" data-name="text" id="fText" size="18"></label> <button class="tb act" data-id="filter" id="fApply">Apply</button> <button class="tb act" data-id="csv">Save as CSV...</button> <span id="saved" class="muted"></span></p>
<p class="muted">Windows sets a key's last write time when the key or one of its values changes. Times are UTC, as the hive stores them.</p>
<div id="tl">${table(current)}</div>`;
    await p.show({ title, html });
    return { rows: all, shown: current.length };
  }

  return { exportReg, diff, timeline, panels, docFor, targetFile };
}

module.exports = { createTools, sibling };
