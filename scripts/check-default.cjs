const assert = require('node:assert/strict');
const fs = require('node:fs');
const dir = 'com.mor4ee.yeelight.plugin';
assert.deepStrictEqual(JSON.parse(fs.readFileSync(dir+'/config.json')), {
  schemaVersion: 1, manualAddresses: [], catalog: []
}, 'Refusing to package a non-default device configuration');
const m = JSON.parse(fs.readFileSync(dir+'/manifest.json'));
assert(m.keyLibrary.children.every(k=>k.data.targetId === ''), 'Bound control in manifest');
