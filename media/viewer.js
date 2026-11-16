// REG File Editor & Hive Viewer webview: key tree (loaded on demand), value table with decoded types, value editing
// for .reg files, search, file facts and problems. Data comes from the extension host; this page makes no network
// request (CSP default-src 'none') and sets no inline style attributes (styles go through the style object).
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const k = (id) => String(id);
  let data = null;
  let roots = [];
  const cache = new Map(); // id -> child nodes
  const nodes = new Map(); // id -> node
  const open = new Set();
  let sel = null; // id string
  let selRaw = null;
  let key = null; // details of the selected key
  let query = '';
  let editing = null;
  let first = true;

  function footer() {
    const f = $('zovo-footer');
    if (f && !$('footer').childElementCount) $('footer').innerHTML = f.innerHTML;
  }
  function status(t) { $('statusText').textContent = t; }
  function showMessage(html) { const m = $('msg'); m.innerHTML = html; m.hidden = !html; }
  const post = (m) => vscode.postMessage(m);
  const remember = (list) => { for (const n of list) nodes.set(k(n.id), n); };

  function init(m) {
    data = m;
    document.body.dataset.kind = m.kind;
    footer();
    editing = null;
    if (m.kind !== 'reg' && m.kind !== 'hive') {
      document.body.dataset.state = m.kind === 'notregf' ? 'notregf' : 'error';
      $('fmt').textContent = m.sizeText || '';
      $('tree').innerHTML = '';
      $('details').innerHTML = '';
      $('facts').innerHTML = '';
      $('problems').innerHTML = '';
      const btns = [];
      if (m.hex) btns.push(`<button class="tb" id="mHex">Open in ${esc(m.hex)}</button>`);
      if (m.canOpenText) btns.push('<button class="tb" id="mText">Open as Text</button>');
      showMessage(`<p>${esc(m.error)}</p>${btns.length ? `<p>${btns.join(' ')}</p>` : ''}`);
      if ($('mHex')) $('mHex').onclick = () => post({ type: 'openHex' });
      if ($('mText')) $('mText').onclick = () => post({ type: 'openText' });
      $('openText').hidden = !m.canOpenText;
      ['search', 'collapse'].forEach((id) => { $(id).disabled = true; });
      status(m.error);
      return;
    }
    ['search', 'collapse'].forEach((id) => { $(id).disabled = false; });
    $('fmt').textContent = `${m.label}, ${m.sizeText}`;
    if (m.kind === 'hive') {
      $('openText').hidden = !m.hex;
      $('openText').textContent = m.hex ? `Open in ${m.hex}` : '';
      $('openText').title = 'Show the bytes of the hive';
    } else {
      $('openText').hidden = false;
      $('openText').textContent = 'Open as Text';
      $('openText').title = 'Open the .reg text beside this view; the tree follows your typing';
    }
    const notes = (m.notes || []).map((n) => `<p class="note">${esc(n)}</p>`);
    if (m.errors && m.errors.length) notes.unshift(`<p>${m.errors.length === 1 ? '1 line has a problem' : `${m.errors.length} lines have problems`}: see Problems on the right. The tree shows every line that could be read.</p>`);
    showMessage(notes.join(''));
    roots = m.roots || [];
    cache.clear();
    nodes.clear();
    remember(roots);
    $('facts').innerHTML = `<h3>File</h3><dl>${m.facts.map((f) => `<dt>${esc(f.k)}</dt><dd>${esc(f.v)}</dd>`).join('')}</dl>`;
    $('problems').innerHTML = m.errors && m.errors.length ? `<h3>Problems (${m.errors.length})</h3><ul id="errList">${m.errors.slice(0, 500).map((e) => `<li class="${e.severity === 'warning' ? 'warn' : 'err'}"><a href="#" data-line="${e.line}">Line ${e.line}</a> ${esc(e.message)}</li>`).join('')}</ul>` : '';
    const keysFact = m.facts.find((f) => f.k === 'Keys');
    const valsFact = m.facts.find((f) => f.k === 'Values');
    const pl = (f, one, many) => (f ? `${f.v} ${f.v === '1' ? one : many}` : `? ${many}`);
    status(`${pl(keysFact, 'key', 'keys')}, ${pl(valsFact, 'value', 'values')}${m.editable ? '. Changes made here are text edits: save the file to keep them, or undo them.' : m.kind === 'hive' ? '. Read-only.' : ''}`);
    if (first) {
      for (const r of roots) open.add(k(r.id));
    }
    drawTree();
    for (const id of open) { const n = nodes.get(id); post({ type: 'children', id: n ? n.id : rawId(id) }); }
    if (first && m.first !== undefined && m.first !== null) { reveal(m.first); }
    else if (sel !== null) { post({ type: 'reveal', id: selRaw }); }
    else if (roots.length) select(roots[0].id);
    if (query) post({ type: 'search', q: query });
    document.body.dataset.state = 'ready';
    if (first) post({ type: 'rendered' });
    first = false;
  }
  const rawId = (s) => (data && data.kind === 'hive' ? Number(s) : s);

  // ---------- tree ----------
  function rows(list, depth, out) {
    for (const n of list) {
      out.push([n, depth]);
      const kids = cache.get(k(n.id));
      if (open.has(k(n.id)) && kids) rows(kids, depth + 1, out);
    }
    return out;
  }
  function drawTree() {
    const list = rows(roots, 0, []);
    $('tree').innerHTML = list.map(([n, d]) => {
      const id = k(n.id);
      const cls = ['node'];
      if (id === sel) cls.push('sel');
      if (n.del) cls.push('del');
      if (n.imp) cls.push('imp');
      return `<div class="${cls.join(' ')}" role="treeitem" data-id="${esc(id)}" data-depth="${d}"${n.n ? ` aria-expanded="${open.has(id)}"` : ''}><span class="tw">${n.n ? (open.has(id) ? '&#9662;' : '&#9656;') : ''}</span><span class="nm">${esc(n.name)}</span>${n.del ? '<span class="st off">deleted</span>' : ''}</div>`;
    }).join('');
    for (const el of $('tree').children) el.style.paddingLeft = `${4 + Number(el.dataset.depth) * 14}px`;
  }
  function toggle(id) {
    if (open.has(id)) { open.delete(id); drawTree(); return; }
    open.add(id);
    const n = nodes.get(id);
    if (!cache.has(id)) post({ type: 'children', id: n ? n.id : rawId(id) }); else drawTree();
  }

  // ---------- details ----------
  function dataHtml(v) {
    if (v.kind === 'delete') return '<span class="muted delv">(deleted by this file)</span>';
    if (v.kind === 'multi') return v.parts.length ? v.parts.map((p) => `<div class="part">${esc(p) || '&nbsp;'}</div>`).join('') : '<span class="muted">(empty list)</span>';
    if (v.kind === 'hex') return `<code class="hex">${esc(v.text)}</code>`;
    if (v.kind === 'string' && v.text === '') return '<span class="muted">(empty string)</span>';
    return esc(v.text);
  }
  function select(id) {
    sel = k(id); selRaw = id;
    drawTree();
    const row = document.querySelector(`#tree .node[data-id="${CSS.escape(sel)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest', inline: 'start' });
    post({ type: 'select', id });
  }
  function showKey(kd) {
    key = kd;
    if (k(kd.id) !== sel) return;
    const h = [];
    h.push(`<h2 id="kPath">${esc(kd.path)}</h2>`);
    h.push(`<p class="meta">${kd.info.map((i) => `<span class="kv"><b>${esc(i.k)}</b> ${esc(i.v)}</span>`).join(' ')}</p>`);
    const btns = ['<button class="tb" id="copyPath">Copy key path</button>'];
    if (kd.line) btns.push(`<button class="tb" id="goKey" data-line="${kd.line}">Go to line ${kd.line}</button>`);
    if (kd.editable) btns.push('<button class="tb" id="addValue">Add value</button>');
    h.push(`<p class="row">${btns.join(' ')}</p>`);
    if (kd.values.length) {
      h.push(`<table id="values"><thead><tr><th class="cn">Name</th><th class="ct">Type</th><th>Data</th>${kd.editable ? '<th class="ca"></th>' : ''}</tr></thead><tbody>${kd.values.map((v, i) => `<tr data-i="${i}" class="${v.kind === 'delete' ? 'delrow' : ''}"><td class="vn">${v.name === '' ? '<span class="muted">(Default)</span>' : esc(v.name)}${v.line ? ` <a href="#" class="ln" data-line="${v.line}">${v.line}</a>` : ''}</td><td class="vt">${esc(v.typeName)}</td><td class="vd">${dataHtml(v)}${v.damaged ? ' <span class="st off">damaged</span>' : ''}</td>${kd.editable ? `<td class="va">${v.kind !== 'delete' && !v.cut && [1, 2, 3, 4, 7, 11].includes(v.type) ? `<button class="mini edit" data-i="${i}" title="Edit this value">Edit</button>` : ''}<button class="mini delete" data-i="${i}" title="Remove this line from the file">Remove</button></td>` : ''}</tr>`).join('')}</tbody></table>`);
    } else h.push('<p class="muted">No values.</p>');
    h.push('<div id="editForm" hidden></div>');
    $('details').innerHTML = h.join('');
  }

  const TYPES = [[1, 'REG_SZ'], [2, 'REG_EXPAND_SZ'], [7, 'REG_MULTI_SZ'], [4, 'REG_DWORD'], [11, 'REG_QWORD'], [3, 'REG_BINARY']];
  function openForm(v) {
    editing = { oldName: v ? v.name : undefined };
    const f = $('editForm');
    const type = v ? v.type : 1;
    const input = !v ? '' : v.kind === 'multi' ? v.parts.join('\n') : v.kind === 'number' ? v.number : v.text;
    f.innerHTML = `<h3>${v ? 'Edit value' : 'New value'}</h3>
<p class="row"><label>Name <input id="eName" type="text" spellcheck="false" value="${esc(v ? v.name : '')}" placeholder="empty for (Default)"></label>
<label>Type <select id="eType">${TYPES.map(([t, n]) => `<option value="${t}"${t === type ? ' selected' : ''}>${n}</option>`).join('')}</select></label></p>
<p><textarea id="eData" rows="${type === 7 || type === 3 ? 5 : 2}" spellcheck="false">${esc(input)}</textarea></p>
<p class="muted" id="eHint"></p>
<p class="row"><button class="tb primary" id="eSave">Save to the text</button> <button class="tb" id="eCancel">Cancel</button> <span id="eErr" class="err"></span></p>`;
    f.hidden = false;
    hint();
    $('eType').addEventListener('change', hint);
    $('eData').focus();
  }
  function hint() {
    const t = Number($('eType').value);
    $('eHint').textContent = t === 7 ? 'One string per line.' : t === 4 || t === 11 ? 'A number: 42 or 0x2a.' : t === 3 ? 'Hex bytes: 01 02 ff.' : t === 2 ? 'Text; %NAME% parts stay as written.' : 'Text.';
  }
  function closeForm() { editing = null; const f = $('editForm'); if (f) { f.hidden = true; f.innerHTML = ''; } }

  // ---------- search ----------
  function showResults(m) {
    const r = $('results');
    if (!m.q) { r.hidden = true; r.innerHTML = ''; $('count').textContent = ''; return; }
    r.hidden = false;
    $('count').textContent = `${m.hits.length}${m.more ? '+' : ''} match${m.hits.length === 1 ? '' : 'es'}`;
    r.innerHTML = m.hits.length ? `<h3>Matches for "${esc(m.q)}"${m.more ? ' (first 500)' : ''}</h3><ul id="hits">${m.hits.map((h, i) => `<li><a href="#" data-i="${i}">${esc(h.path)}</a>${h.what !== 'key' ? ` <span class="muted">${h.what === 'value' ? 'value' : 'data of'} ${h.value === '' ? '(Default)' : esc(h.value)}</span>` : ''}</li>`).join('')}</ul>` : `<p class="muted">No key, value name or data contains "${esc(m.q)}".</p>`;
    r.hits = m.hits;
  }
  function reveal(id) { post({ type: 'reveal', id }); }

  // ---------- events ----------
  $('tree').addEventListener('click', (e) => {
    const row = e.target.closest('.node');
    if (!row) return;
    const id = row.dataset.id;
    const n = nodes.get(id);
    if (e.target.closest('.tw') && n && n.n) { toggle(id); return; }
    if (id === sel && n && n.n) { toggle(id); return; }
    select(n ? n.id : rawId(id));
  });
  $('tree').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.node');
    if (!row) return;
    if (key && key.line && k(key.id) === row.dataset.id) post({ type: 'goLine', line: key.line });
  });
  $('details').addEventListener('click', (e) => {
    const t = e.target;
    if (t.id === 'copyPath' && key) { post({ type: 'copy', text: key.path, what: 'the key path' }); return; }
    if (t.id === 'goKey') { post({ type: 'goLine', line: Number(t.dataset.line) }); return; }
    if (t.classList.contains('ln')) { e.preventDefault(); post({ type: 'goLine', line: Number(t.dataset.line) }); return; }
    if (t.id === 'addValue') { openForm(null); return; }
    if (t.classList.contains('edit')) { openForm(key.values[Number(t.dataset.i)]); return; }
    if (t.classList.contains('delete')) {
      if (t.dataset.confirm !== '1') { t.dataset.confirm = '1'; t.textContent = 'Click again to remove'; setTimeout(() => { if (t.isConnected) { t.dataset.confirm = ''; t.textContent = 'Remove'; } }, 4000); return; }
      post({ type: 'deleteValue', id: key.id, name: key.values[Number(t.dataset.i)].name });
      return;
    }
    if (t.id === 'eCancel') { closeForm(); return; }
    if (t.id === 'eSave' && editing) {
      $('eErr').textContent = '';
      post({ type: 'saveValue', id: key.id, oldName: editing.oldName, name: $('eName').value, valueType: Number($('eType').value), input: $('eData').value });
    }
  });
  $('results').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const h = $('results').hits[Number(a.dataset.i)];
    if (h) reveal(h.id);
  });
  $('problems').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    post({ type: 'goLine', line: Number(a.dataset.line) });
  });
  let timer = null;
  $('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = $('search').value.trim(); post({ type: 'search', q: query }); }, 250); });
  $('collapse').addEventListener('click', () => { open.clear(); for (const r of roots) open.add(k(r.id)); drawTree(); });
  $('openText').addEventListener('click', () => post({ type: data && data.kind === 'hive' ? 'openHex' : 'openText' }));

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') init(m);
    else if (m.type === 'children') { remember(m.nodes); cache.set(k(m.id), m.nodes); drawTree(); }
    else if (m.type === 'key') showKey(m.key);
    else if (m.type === 'results') { if (m.q === query || !query) showResults(m); }
    else if (m.type === 'chain') {
      if (m.roots) { roots = m.roots; remember(roots); }
      for (const c of m.chain) { remember(c.nodes); cache.set(k(c.id), c.nodes); open.add(k(c.id)); }
      select(m.id);
    } else if (m.type === 'editResult') {
      if (m.ok) closeForm(); else if ($('eErr')) $('eErr').textContent = m.error; else status(m.error);
    }
  });
  footer();
  post({ type: 'ready' });
}());
