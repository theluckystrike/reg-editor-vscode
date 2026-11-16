'use strict';
// The two custom editors:
// - regEditor.reg (default for *.reg) sits on VS Code's text document of the file, so edits made in the viewer are
//   normal text edits (Undo, Save and dirty state work as for any text file) and typing in the text editor beside it
//   redraws the tree.
// - regEditor.hive opens binary registry hives read-only (default for *.hiv; any other file through the Open as
//   Registry Hive command, after its first four bytes read "regf"). It never writes to the file.
// The webview has no network access (CSP default-src 'none'). Keys load on demand, so a large hive opens fast.
// Nothing here calls a Windows registry API or another program.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const M = require('./core/model');
const R = require('./core/regtext');
const V = require('./core/values');
const { editorHtml } = require('./html');
const support = require('./support');

const VIEW_REG = 'regEditor.reg';
const VIEW_HIVE = 'regEditor.hive';
const PREFIX = 'regEditor';
const MAX_HIVE = 512 * 1024 * 1024;
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const HEX_EDITORS = [['zovo.zovo-hex-viewer', 'hexViewer.editor', 'Hex Viewer'], ['ms-vscode.hexeditor', 'hexEditor.hexedit', 'Hex Editor']];
const EDIT_TYPES = new Set([1, 2, 3, 4, 7, 11]);

/** Reads a file as a hive or a .reg file. Shared by the viewer and the Pro tools. */
async function loadFile(uri, opts = {}) {
  const name = path.posix.basename(uri.path);
  if (typeof opts.text === 'string') return { ...M.load(null, name, { text: opts.text }), name, size: Buffer.byteLength(opts.text) };
  try {
    const st = await vscode.workspace.fs.stat(uri);
    if (st && st.size > MAX_HIVE) return { kind: 'error', error: `This file is ${M.sizeText(st.size)}, more than the 512 MB the viewer reads.`, name, size: st.size, notes: [] };
  } catch (e) { /* stat is optional */ }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return { ...M.load(bytes, name, { asHive: !!opts.asHive }), name, size: bytes.byteLength };
}

/** First bytes of a file are "regf". */
async function sniffHive(uri) {
  const isRegf = (b) => b.length >= 4 && b[0] === 0x72 && b[1] === 0x65 && b[2] === 0x67 && b[3] === 0x66;
  try {
    if (uri.scheme === 'file') {
      const fd = fs.openSync(uri.fsPath, 'r');
      try { const b = Buffer.alloc(4); const n = fs.readSync(fd, b, 0, 4, 0); return isRegf(b.subarray(0, n)); } finally { fs.closeSync(fd); }
    }
    const st = await vscode.workspace.fs.stat(uri);
    if (st && st.size > MAX_HIVE) return false;
    return isRegf(await vscode.workspace.fs.readFile(uri));
  } catch (e) { return false; }
}

function eolOf(doc) { return doc.eol === 2 || /\r\n/.test(doc.getText().slice(0, 4096)) ? '\r\n' : '\n'; }

class Viewer {
  constructor(context, hooks = {}) {
    this.context = context;
    this.hooks = hooks;
    this.sessions = new Set();
    this.active = null;
    this._success = new WeakSet();
  }
  dispose() { for (const s of this.sessions) for (const l of s.listeners) { try { l.dispose(); } catch (e) { /* gone */ } } this.sessions.clear(); }

  get docs() { return this.sessions; }

  setup(s, panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const reach = this.hooks.reach ? this.hooks.reach() : null;
    panel.webview.options = { enableScripts: true, localResourceRoots: [media], enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)) };
    panel.webview.html = editorHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
      title: s.name, head: reach ? (n) => reach.headHtml(n) : undefined, showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    this.sessions.add(s);
    const setActive = () => { if (panel.active) { this.active = s; if (this.hooks.onActive) this.hooks.onActive(s); } };
    setActive();
    s.listeners.push(panel.onDidChangeViewState(setActive));
    panel.onDidDispose(() => { this.sessions.delete(s); for (const l of s.listeners) { try { l.dispose(); } catch (e) { /* gone */ } } if (this.active === s) this.active = null; });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      try { await this.onMessage(s, m); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); }
    });
  }

  send(s, msg) { try { const r = s.panel.webview.postMessage(msg); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* disposed */ } }

  hexEditor() {
    for (const [id, viewType, name] of HEX_EDITORS) { try { if (vscode.extensions.getExtension(id)) return { viewType, name }; } catch (e) { /* none */ } }
    return null;
  }

  init(s) {
    let d = s.data || { kind: 'error', error: 'The file could not be read.' };
    if (d.kind === 'reg' && !d.source.p.version && !d.source.p.counts.keys) {
      const blank = !d.source.p.lineCount || (d.textSeen !== undefined && !d.textSeen.trim());
      d = { ...d, kind: blank ? 'empty' : 'notreg', error: blank
        ? 'This .reg file is empty. Open it as text to write keys and values; the tree follows your typing.'
        : 'This file is not a registry file: its first line is not "Windows Registry Editor Version 5.00" or "REGEDIT4", and it has no key lines. Open it as text to see it.' };
    }
    const base = { type: 'init', name: s.name, kind: d.kind, settings: { showPro: setting('showProTools', true) !== false } };
    if (d.kind !== 'reg' && d.kind !== 'hive') {
      const hex = this.hexEditor();
      this.send(s, { ...base, error: d.error || 'The file could not be read.', hex: hex ? hex.name : '', canOpenText: s.kind === 'reg', sizeText: M.sizeText(d.size || 0) });
      if (d.kind === 'error' && this.hooks.onFailure) this.hooks.onFailure(s);
      return;
    }
    const src = d.source;
    const errors = d.kind === 'reg' ? src.p.errors : [];
    const label = d.kind === 'hive' ? `Hive ${src.h.version}` : src.p.version === 4 ? 'REGEDIT4' : src.p.version === 5 ? 'REG 5.00' : 'REG';
    this.send(s, {
      ...base, label, sizeText: M.sizeText(d.size || 0), roots: src.roots(), facts: src.facts({ encoding: d.encoding, size: d.size }),
      first: d.kind === 'hive' ? src.h.rootKey.off : (R.entries(src.p)[0] || { key: { id: null } }).key.id,
      errors, notes: d.notes || [], editable: d.kind === 'reg' && !!s.textDoc && !d.ansiView, hex: d.kind === 'hive' && this.hexEditor() ? this.hexEditor().name : '',
    });
  }

  async reload(s, text) {
    try { s.data = await loadFile(s.uri, { text, asHive: s.kind === 'hive' }); } catch (e) { s.data = { kind: 'error', error: String((e && e.message) || e), notes: [] }; }
    if (typeof text === 'string') s.data.textSeen = text;
    // A REGEDIT4 file in Windows-1252 that VS Code read as UTF-8: show it from the file bytes, read-only, with a note.
    if (s.data.kind === 'reg' && typeof text === 'string' && text.includes('\ufffd') && s.textDoc && !s.textDoc.isDirty) {
      try {
        const bytes = await vscode.workspace.fs.readFile(s.uri);
        const dd = R.decodeBytes(bytes);
        if (dd.encoding === 'Windows-1252') {
          s.data = { ...M.load(null, s.name, { text: dd.text }), name: s.name, size: bytes.byteLength, encoding: 'Windows-1252', ansiView: true, textSeen: text,
            notes: ['This file is Windows-1252 text (as REGEDIT4 files often are), and VS Code opened it as UTF-8. The tree shows it from the file bytes, and editing in the table is off. To edit it here, reopen the text with the Windows 1252 encoding (Reopen with Encoding in the status bar).'] };
        }
      } catch (e) { /* keep what the text document holds */ }
    }
    if (s.data && s.data.kind === 'reg' && s.textDoc && s.textDoc.encoding) s.data.encoding = String(s.textDoc.encoding).toUpperCase().replace('UTF16LE', 'UTF-16LE').replace('UTF16BE', 'UTF-16BE').replace(/^UTF8(BOM)?$/, 'UTF-8');
  }

  /** The session showing uri (the active one first), or null. */
  sessionFor(uri) {
    const key = uri.toString();
    if (this.active && this.active.uri.toString() === key) return this.active;
    for (const s of this.sessions) if (s.uri.toString() === key) return s;
    return null;
  }

  async revealLine(s, line) {
    if (!s.textDoc) return undefined;
    const l = Math.max(0, (Number(line) || 1) - 1);
    return vscode.window.showTextDocument(s.textDoc, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(l, 0, l, 0), preview: true, preserveFocus: false });
  }

  async onMessage(s, m) {
    const src = s.data && s.data.source;
    switch (m.type) {
      case 'ready': this.init(s); return;
      case 'rendered':
        s.rendered = { at: Date.now() };
        if (!this._success.has(s) && src) { this._success.add(s); if (this.hooks.onSuccess) this.hooks.onSuccess(s); }
        return;
      case 'children': if (src) this.send(s, { type: 'children', id: m.id, nodes: src.children(m.id) }); return;
      case 'select': {
        if (!src) return;
        s.selected = m.id;
        const key = src.key(m.id);
        if (key) this.send(s, { type: 'key', key: { ...key, editable: key.editable && !!s.textDoc && !s.data.ansiView } });
        return;
      }
      case 'reveal': {
        if (!src) return;
        const chain = src.chain(m.id);
        this.send(s, { type: 'chain', id: m.id, chain: chain.slice(0, -1).map((id) => ({ id, nodes: src.children(id) })), roots: src.roots() });
        return;
      }
      case 'search': {
        if (!src) return;
        const q = String(m.q || '').trim();
        const r = q ? src.search(q, 500) : { hits: [], more: false };
        this.send(s, { type: 'results', q, hits: r.hits, more: r.more });
        return;
      }
      case 'goLine': await this.revealLine(s, m.line); return;
      case 'openText':
        if (s.textDoc) await vscode.window.showTextDocument(s.textDoc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        else await vscode.commands.executeCommand('vscode.openWith', s.uri, 'default');
        return;
      case 'openHex': { const h = this.hexEditor(); if (h) await vscode.commands.executeCommand('vscode.openWith', s.uri, h.viewType); return; }
      case 'copy': if (typeof m.text === 'string') { await vscode.env.clipboard.writeText(m.text.slice(0, 1000000)); vscode.window.setStatusBarMessage(`Copied ${m.what || 'the text'}`, 3000); } return;
      case 'saveValue': { const r = await this.saveValue(s, m); this.send(s, { type: 'editResult', ok: !r.error, error: r.error || '', name: m.name }); return; }
      case 'deleteValue': { const r = await this.deleteValue(s, m); this.send(s, { type: 'editResult', ok: !r.error, error: r.error || '', deleted: true }); return; }
      default:
    }
  }

  /** Writes one value into the .reg text as a normal edit. m: { id, oldName?, name, valueType, input }. */
  async saveValue(s, m) {
    const doc = s.textDoc;
    const src = s.data && s.data.source;
    if (!doc || !src || src.kind !== 'reg') return { error: 'Only a .reg file can be edited.' };
    if (s.data.ansiView) return { error: 'Reopen the text with the Windows 1252 encoding to edit this file.' };
    const key = src.find(m.id);
    if (!key || key.implicit || key.deleted) return { error: 'This key has no section of its own in the file, so it has no values to edit.' };
    const type = Number(m.valueType);
    if (!EDIT_TYPES.has(type)) return { error: 'Choose a value type.' };
    const name = String(m.name === undefined ? '' : m.name);
    if (/[\r\n]/.test(name)) return { error: 'A value name cannot hold a line break.' };
    const old = typeof m.oldName === 'string' ? key.valueMap.get(m.oldName.toLowerCase()) : null;
    if (typeof m.oldName === 'string' && !old) return { error: 'The value is no longer in the file. The view shows the current text now.' };
    const clash = key.valueMap.get(name.toLowerCase());
    if (clash && clash !== old) return { error: `This key already has a value named "${name || '(Default)'}".` };
    const v = R.valueFromInput(type, m.input === undefined ? '' : m.input);
    if (v.error) return v;
    const version = src.p.version === 4 ? 4 : 5;
    const eol = eolOf(doc);
    const text = R.valueLines({ name, type, bytes: v.bytes }, version).join(eol);
    const we = new vscode.WorkspaceEdit();
    if (old) {
      const endLen = doc.lineAt(old.endLine - 1).text.length;
      we.replace(doc.uri, new vscode.Range(old.line - 1, 0, old.endLine - 1, endLen), text);
    } else {
      const sec = [...key.sections].reverse().find((x) => !x.del);
      const at = sec.last - 1;
      const len = doc.lineAt(at).text.length;
      we.replace(doc.uri, new vscode.Range(at, len, at, len), eol + text);
    }
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) return { error: 'VS Code did not apply the edit.' };
    await this.reload(s, doc.getText());
    this.init(s);
    vscode.window.setStatusBarMessage(`${old ? 'Changed' : 'Added'} ${name === '' ? '(Default)' : name} in ${key.name}. Save the file to keep it.`, 5000);
    return { ok: true };
  }

  async deleteValue(s, m) {
    const doc = s.textDoc;
    const src = s.data && s.data.source;
    if (!doc || !src || src.kind !== 'reg') return { error: 'Only a .reg file can be edited.' };
    if (s.data.ansiView) return { error: 'Reopen the text with the Windows 1252 encoding to edit this file.' };
    const key = src.find(m.id);
    const old = key && key.valueMap.get(String(m.name).toLowerCase());
    if (!old) return { error: 'The value is no longer in the file.' };
    const we = new vscode.WorkspaceEdit();
    const lineCount = doc.lineCount || doc.getText().split(/\r\n|\n/).length;
    if (old.endLine < lineCount) we.replace(doc.uri, new vscode.Range(old.line - 1, 0, old.endLine, 0), '');
    else { const prev = old.line - 2; we.replace(doc.uri, new vscode.Range(prev, doc.lineAt(prev).text.length, old.endLine - 1, doc.lineAt(old.endLine - 1).text.length), ''); }
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) return { error: 'VS Code did not apply the edit.' };
    await this.reload(s, doc.getText());
    this.init(s);
    vscode.window.setStatusBarMessage(`Removed ${old.name === '' ? '(Default)' : old.name} from ${key.name}. Save the file to keep it.`, 5000);
    return { ok: true };
  }
}

/** regEditor.reg: a custom text editor over the .reg file's text document. */
class RegTextProvider {
  constructor(viewer) { this.viewer = viewer; }
  async resolveCustomTextEditor(document, panel) {
    const v = this.viewer;
    const s = { uri: document.uri, name: path.posix.basename(document.uri.path), kind: 'reg', panel, textDoc: document, listeners: [], data: null };
    await v.reload(s, document.getText());
    let timer = null;
    s.listeners.push(vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const text = document.getText();
        if (s.data && s.data.textSeen === text) return; // the viewer's own edit, already drawn
        await v.reload(s, text); v.init(s); if (v.hooks.onChange) v.hooks.onChange(s);
      }, 300);
    }));
    v.setup(s, panel);
  }
}

/** regEditor.hive: a read-only custom editor for binary hives. */
class HiveProvider {
  constructor(viewer) { this.viewer = viewer; }
  async openCustomDocument(uri) { return { uri, dispose() {} }; }
  async resolveCustomEditor(handle, panel) {
    const v = this.viewer;
    const s = { uri: handle.uri, name: path.posix.basename(handle.uri.path), kind: 'hive', panel, textDoc: null, listeners: [], data: null };
    await v.reload(s);
    try {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(handle.uri, '..'), path.posix.basename(handle.uri.path)));
      let timer = null;
      const again = () => { clearTimeout(timer); timer = setTimeout(async () => { await v.reload(s); v.init(s); }, 500); };
      s.listeners.push(w, w.onDidChange(again), w.onDidCreate(again));
    } catch (e) { /* no watcher: the view still works */ }
    v.setup(s, panel);
  }
}

module.exports = { Viewer, RegTextProvider, HiveProvider, loadFile, sniffHive, VIEW_REG, VIEW_HIVE, EDIT_TYPES, V };
