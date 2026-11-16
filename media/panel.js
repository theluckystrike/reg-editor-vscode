// Panel of a Zovo Pro tool (comparison report, timeline): the report HTML comes from the extension host.
// Sortable tables (click a column head); buttons send their id and the values of the filter inputs. No network request.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  function sortable(table) {
    const head = table.tHead;
    if (!head) return;
    [...head.rows[0].cells].forEach((th, col) => {
      th.classList.add('sortable');
      th.addEventListener('click', () => {
        const body = table.tBodies[0];
        const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
        [...head.rows[0].cells].forEach((h) => delete h.dataset.dir);
        th.dataset.dir = dir;
        const key = (tr) => { const c = tr.cells[col]; const t = c ? (c.dataset.sort || c.textContent) : ''; return t; };
        const num = (s) => (/^0x[0-9a-f]+$/i.test(s) ? BigInt(s) : /^-?\d+$/.test(s) ? BigInt(s) : null);
        const rows = [...body.rows].sort((a, b) => {
          const x = key(a), y = key(b); const nx = num(x), ny = num(y);
          let r;
          if (nx !== null && ny !== null) r = nx < ny ? -1 : nx > ny ? 1 : 0;
          else if (nx !== null) r = -1; else if (ny !== null) r = 1;
          else r = x.localeCompare(y);
          return dir === 'asc' ? r : -r;
        });
        for (const r of rows) body.appendChild(r);
      });
    });
  }
  function fields() {
    const out = {};
    document.querySelectorAll('input.fv').forEach((i) => { out[i.dataset.name] = i.value.trim(); });
    return out;
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'show') {
      $('title').textContent = m.title || '';
      document.title = m.title || document.title;
      $('report').innerHTML = m.html;
      document.querySelectorAll('table.sort').forEach(sortable);
      document.body.dataset.state = 'shown';
      vscode.postMessage({ type: 'shown' });
    } else if (m.type === 'patch') {
      const t = $(m.target);
      if (t) { t.innerHTML = m.html; t.querySelectorAll('table.sort').forEach(sortable); }
    }
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button.act');
    if (b) vscode.postMessage({ type: 'action', id: b.dataset.id, fields: fields() });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('fv')) vscode.postMessage({ type: 'action', id: 'filter', fields: fields() });
  });
  vscode.postMessage({ type: 'ready' });
}());
