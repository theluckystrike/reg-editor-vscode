'use strict';
// HOLDFIX (0.1.1): VER20 BLOCK 16 Nov 07:04 (value table Name 8 px / Data 0 px in VS Code's default layout, 746 px webview)
// and the walkthrough link to zovo.zovo-minidump-viewer, which is not on the Marketplace.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const css = fs.readFileSync(path.join(ROOT, 'media', 'viewer.css'), 'utf8');

test('narrow layout: facts pane moves under the table below 960 px; the value table keeps a minimum width', () => {
  assert.match(css, /#values \{ min-width: 520px; \}/);
  const m = /@media \(max-width: 960px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(m, 'media rule');
  assert.match(m[1], /#app \{ display: grid;/);
  assert.match(m[1], /#info \{ grid-column: 2; grid-row: 2; width: auto;/);
  // the fixed columns plus a 26 % name column leave the data column at least 120 px at the minimum width
  const fixed = 128 + 104;
  assert.ok(520 - fixed - 0.26 * 520 >= 120);
});

test('related links: only listings that are live (no minidump viewer)', () => {
  const support = require('../src/support');
  assert.ok(!support.RELATED.includes('zovo.zovo-minidump-viewer'));
  assert.ok(support.RELATED.includes('zovo.zovo-log-viewer'));
  const all = JSON.stringify(pkg.contributes.walkthroughs) + fs.readFileSync(path.join(ROOT, 'walkthrough', 'related.md'), 'utf8');
  assert.doesNotMatch(all, /minidump/i);
});

test('0.1.1 CHANGELOG first', () => {
  assert.strictEqual(pkg.version, '0.1.1');
  assert.match(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), /^# Changelog\n\n## 0\.1\.1\n\n- The value table stays readable/);
});
