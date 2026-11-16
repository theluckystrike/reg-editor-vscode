'use strict';
// Writes samples/zovo-demo.reg (version 5.00, UTF-16LE with a BOM, as Windows writes it) and samples/zovo-demo.hiv
// (a small regf hive with the same made-up app settings and last write times). A unit test checks the shipped samples
// match this script. Usage: node scripts/make-samples.js [out dir]
const fs = require('fs');
const path = require('path');
const R = require('../src/core/regtext');
const { makeHive, sz, dword, qword, multi } = require('../test/support/mkhive');

const expand = (s) => ({ type: 2, bytes: sz(s) });
const str = (s) => ({ type: 1, bytes: sz(s) });
const dw = (n) => ({ type: 4, bytes: dword(n) });
const bin = (arr) => ({ type: 3, bytes: Buffer.from(arr) });
const rot13 = (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= 'Z' ? 65 : 97) + ((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26)));

function appValues() {
  return [
    { name: '', ...str('Zovo Demo App') },
    { name: 'InstallPath', ...str('C:\\Program Files\\Zovo Demo') },
    { name: 'Version', ...dw(0x00010203) },
    { name: 'LaunchCount', type: 11, bytes: qword(42) },
    { name: 'LogPath', ...expand('%LOCALAPPDATA%\\Zovo\\logs') },
    { name: 'RecentProjects', type: 7, bytes: multi(['D:\\work\\billing', 'D:\\work\\site', 'C:\\Users\\demo\\notes']) },
    { name: 'WindowPlacement', ...bin([0x2c, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x40, 1, 0, 0, 0x60, 0, 0, 0, 0xc0, 6, 0, 0, 0x20, 4, 0, 0]) },
  ];
}

function regSample() {
  const p = 'HKEY_CURRENT_USER\\Software\\Zovo Demo';
  const text = R.toRegText([
    { path: p, values: appValues() },
    { path: `${p}\\Editor`, values: [{ name: 'Theme', ...str('dark') }, { name: 'FontSize', ...dw(14) }, { name: 'ShowMinimap', ...dw(1) }] },
    { path: `${p}\\Features`, values: [{ name: 'Telemetry', type: -1, bytes: null }, { name: 'Beta', ...dw(0) }] },
    { path: `${p}\\OldCache`, deleted: true },
    { path: 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', values: [{ name: 'ZovoDemo', ...str('"C:\\Program Files\\Zovo Demo\\demo.exe" --tray') }] },
    { path: 'HKEY_CURRENT_USER\\Environment', values: [{ name: 'ZOVO_HOME', ...expand('%USERPROFILE%\\.zovo') }] },
  ]);
  return R.encodeReg(text.replace('\r\n\r\n', '\r\n\r\n; Settings of a made-up app, written for the REG File Editor samples.\r\n'), 5);
}

function hiveSample() {
  const k = (name, time, values = [], kids = []) => ({ name, time, values, kids });
  const thumb = Buffer.alloc(20000);
  for (let i = 0; i < thumb.length; i++) thumb[i] = (i * 7) & 0xff;
  const tree = k('ZovoDemo', '2026-11-02T08:00:00Z', [], [
    k('Software', '2026-11-10T10:15:00Z', [], [
      k('Zovo Demo', '2026-11-14T16:42:10Z', [...appValues(), { name: 'Thumbnail', type: 3, bytes: thumb }], [
        k('Editor', '2026-11-15T09:30:00Z', [{ name: 'Theme', ...str('light') }, { name: 'FontSize', ...dw(14) }, { name: 'ShowMinimap', ...dw(1) }]),
        k('Features', '2026-10-20T12:00:00Z', [{ name: 'Beta', ...dw(1) }]),
      ]),
      k('Microsoft', '2026-09-01T07:00:00Z', [], [k('Windows', '2026-09-01T07:00:00Z', [], [k('CurrentVersion', '2026-11-12T19:05:00Z', [], [
        k('Run', '2026-11-12T19:05:33Z', [{ name: 'ZovoDemo', ...str('"C:\\Program Files\\Zovo Demo\\demo.exe" --tray') }, { name: 'Updater', ...str('C:\\Tools\\updater.exe /background') }]),
        k('Explorer', '2026-11-13T08:00:00Z', [], [k('UserAssist', '2026-11-13T08:00:00Z', [], [k('{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}', '2026-11-13T08:00:00Z', [], [
          k('Count', '2026-11-16T07:59:12Z', [{ name: rot13('C:\\Program Files\\Zovo Demo\\demo.exe'), ...bin(new Array(72).fill(0)) }]),
        ])])]),
      ])])]),
    ]),
    k('Environment', '2026-10-05T11:11:11Z', [{ name: 'ZOVO_HOME', ...expand('%USERPROFILE%\\.zovo') }, { name: 'Path', ...expand('%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;') }]),
    k('Control Panel', '2026-08-30T06:00:00Z', [], [k('Desktop', '2026-11-01T21:00:00Z', [{ name: 'Wallpaper', ...str('C:\\Users\\demo\\Pictures\\lake.jpg') }, { name: 'WallpaperStyle', ...str('10') }])]),
  ]);
  return makeHive(tree, { fileName: '\\??\\C:\\Users\\demo\\zovo-demo.hiv', written: '2026-11-16T08:00:00Z' });
}

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, '..', 'samples');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'zovo-demo.reg'), regSample());
  fs.writeFileSync(path.join(out, 'zovo-demo.hiv'), hiveSample());
  console.log(`wrote ${out}/zovo-demo.reg and zovo-demo.hiv`);
}

module.exports = { regSample, hiveSample, rot13 };
