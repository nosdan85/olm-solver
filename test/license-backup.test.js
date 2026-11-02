'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const licenseStore = require('../src/license-store');

test('license-store exportAll and importAll', () => {
  licenseStore.createKey({ name: 'Backup Test User', type: '1_month' });
  const exported = licenseStore.exportAll();
  assert.equal(typeof exported, 'object');
  assert.ok(Object.keys(exported).length > 0);

  const sampleKey = Object.keys(exported)[0];
  assert.ok(exported[sampleKey].key);

  const importResult = licenseStore.importAll(exported, { merge: true });
  assert.ok(importResult.count > 0);
  assert.equal(importResult.total, Object.keys(exported).length);

  licenseStore.clearAll();
});
