'use strict';
// REG File Editor & Hive Viewer by Zovo: opens .reg files as a key tree with a value table (edits go into the text as
// normal edits), colors .reg text and marks bad lines, and opens binary registry hives read-only. No network, no
// telemetry, no registry API and no other program is run. Activation shows nothing: no message, no popup. The viewer
// opens only for files the user opens, and it never reopens a tab in another editor by itself.
const vscode = require('vscode');
const path = require('path');
const { Viewer, RegTextProvider, HiveProvider, sniffHive, VIEW_REG, VIEW_HIVE } = require('./editor');
const { registerDiagnostics } = require('./diagnostics');
const { createTools } = require('./tools');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const PREFIX = 'regEditor';
const EXT_ID = 'zovo.zovo-reg-editor';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

/** The file of the active editor tab (text, custom or other), if any. */
function activeTabUri() {
  try {
    const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab && tab.input;
    if (input && input.uri && input.uri.scheme) return input.uri;
  } catch (e) { /* older API */ }
  const ed = vscode.window.activeTextEditor;
  return ed ? ed.document.uri : undefined;
}

function activate(context) {
  const sub = (d) => context.subscriptions.push(d);
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'REG File Editor' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  const pro = createPro({ vscode, context });
  const reach = createReach({ vscode, ...reachConfig, maximum: pro.TRIAL_USES, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  sub(pro.onDidChange(() => reach.refresh()));

  const viewer = new Viewer(context, {
    reach: () => reach,
    onSuccess: (s) => rating.success(s.uri),
    onFailure: () => rating.failure(),
  });
  sub(viewer);
  const regProvider = new RegTextProvider(viewer);
  const hiveProvider = new HiveProvider(viewer);
  sub(vscode.window.registerCustomEditorProvider(VIEW_REG, regProvider, { webviewOptions: { retainContextWhenHidden: true } }));
  sub(vscode.window.registerCustomEditorProvider(VIEW_HIVE, hiveProvider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }));
  const diagnostics = registerDiagnostics(context);
  const tools = createTools({ context, viewer, pro, reach });

  const reg = (id, fn) => sub(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); return undefined; }
  }));
  const target = (uri) => (uri && uri.scheme ? uri : undefined);
  const sample = (name) => vscode.Uri.joinPath(context.extensionUri, 'samples', name);
  const extraOf = (extra) => (extra && !extra.scheme && !Array.isArray(extra) ? extra : {});

  reg(`${PREFIX}.openAsHive`, async (uri) => {
    let u = target(uri) || (viewer.active && viewer.active.uri) || activeTabUri();
    if (!u || u.scheme === 'untitled') {
      const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Open as Hive', title: 'Open a registry hive (NTUSER.DAT, UsrClass.dat, SYSTEM, SOFTWARE, SAM, .hiv)' });
      u = r && r[0];
      if (!u) return undefined;
    }
    if (!(await sniffHive(u))) { vscode.window.showInformationMessage(`${path.posix.basename(u.path)} is not a registry hive: its first four bytes are not "regf".`); return undefined; }
    return vscode.commands.executeCommand('vscode.openWith', u, VIEW_HIVE);
  });
  reg(`${PREFIX}.openWithViewer`, (uri) => {
    const u = target(uri) || activeTabUri();
    if (!u || !/\.reg$/i.test(u.path)) { vscode.window.showInformationMessage('Select a .reg file first. For a hive, use Open as Registry Hive.'); return undefined; }
    return vscode.commands.executeCommand('vscode.openWith', u, VIEW_REG);
  });
  reg(`${PREFIX}.openAsText`, async (uri) => {
    const u = target(uri) || (viewer.active && viewer.active.uri);
    if (!u) return undefined;
    const s = viewer.sessionFor(u);
    if (s && s.textDoc) return vscode.window.showTextDocument(s.textDoc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    return vscode.commands.executeCommand('vscode.openWith', u, 'default');
  });
  // The .reg sample opens as a copy in the extension's storage folder, so edits never change the installed files.
  reg(`${PREFIX}.openSample`, async () => {
    const dir = vscode.Uri.joinPath(context.globalStorageUri, 'samples');
    const copy = vscode.Uri.joinPath(dir, 'zovo-demo.reg');
    let exists = false;
    try { await vscode.workspace.fs.stat(copy); exists = true; } catch (e) { exists = false; }
    if (!exists) { await vscode.workspace.fs.createDirectory(dir); await vscode.workspace.fs.writeFile(copy, await vscode.workspace.fs.readFile(sample('zovo-demo.reg'))); }
    return vscode.commands.executeCommand('vscode.openWith', copy, VIEW_REG);
  });
  reg(`${PREFIX}.openSampleHive`, () => vscode.commands.executeCommand('vscode.openWith', sample('zovo-demo.hiv'), VIEW_HIVE));
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  reg(`${PREFIX}.export`, reach.wrap((uri, extra) => tools.exportReg(target(uri), extraOf(extra))));
  reg(`${PREFIX}.diff`, reach.wrap((uri, extra) => tools.diff(target(uri), extraOf(extra))));
  reg(`${PREFIX}.timeline`, reach.wrap((uri, extra) => tools.timeline(target(uri), extraOf(extra))));
  sub(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) reach.refresh(); }));
  sub(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { viewer, regProvider, hiveProvider, tools, pro, diagnostics };
}

function deactivate() {}

module.exports = { activate, deactivate };
