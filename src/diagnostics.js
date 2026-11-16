'use strict';
// Problems for .reg text: every line the parser cannot read gets a diagnostic (Problems panel and squiggles in the
// text editor), updated as you type. Only documents in the "reg" language; nothing is sent anywhere.
const vscode = require('vscode');
const R = require('./core/regtext');

function registerDiagnostics(context) {
  const coll = vscode.languages.createDiagnosticCollection('reg');
  context.subscriptions.push(coll);
  const timers = new Map();
  const isReg = (d) => d && d.languageId === 'reg' && d.uri && d.uri.scheme !== 'output';
  function update(doc) {
    if (!isReg(doc)) return;
    const p = R.parse(doc.getText());
    coll.set(doc.uri, p.errors.map((e) => {
      const last = e.endLine - 1;
      let len = 0;
      try { len = doc.lineAt(last).text.length; } catch (x) { len = 0; }
      const d = new vscode.Diagnostic(new vscode.Range(e.line - 1, 0, last, len), e.message, e.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
      d.source = 'reg';
      return d;
    }));
  }
  const later = (doc) => {
    if (!isReg(doc)) return;
    const k = doc.uri.toString();
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => { timers.delete(k); update(doc); }, 250));
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(update),
    vscode.workspace.onDidChangeTextDocument((e) => later(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => { coll.delete(d.uri); }),
  );
  for (const d of vscode.workspace.textDocuments || []) update(d);
  return { update, collection: coll };
}

module.exports = { registerDiagnostics };
