'use strict';
// REACH1: this listing's Pro tools for the viewer toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'regEditor',
  triesKey: 'regEditor.proTrial',
  slot: '#toolbar',
  tools: [
    { id: 'export', title: 'Export and convert', command: 'regEditor.export' },
    { id: 'diff', title: 'Compare two registry files', command: 'regEditor.diff' },
    { id: 'timeline', title: 'Last write timeline', command: 'regEditor.timeline' },
  ],
};
