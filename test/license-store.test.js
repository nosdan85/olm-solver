'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const licenseStore = require('../src/license-store');

test('license-store generates 3-day, 1-month and lifetime keys', () => {
  const k3 = licenseStore.createKey({ name: 'Nguyen Van A', type: '3_days' });
  assert.ok(k3.key.startsWith('OLM-3D-'));
  assert.equal(k3.type, '3_days');
  assert.equal(k3.status, 'unused');

  const k30 = licenseStore.createKey({ name: 'Tran Thi B', type: '1_month' });
  assert.ok(k30.key.startsWith('OLM-30D-'));
  assert.equal(k30.type, '1_month');

  const kLife = licenseStore.createKey({ name: 'Le Van C', type: 'lifetime' });
  assert.ok(kLife.key.startsWith('OLM-LIFE-'));
  assert.equal(kLife.type, 'lifetime');

  licenseStore.clearAll();
});

test('activation binds HWID and name', () => {
  const lic = licenseStore.createKey({ name: 'Hoang Nam', type: '3_days' });
  
  // Wrong name fails
  const wrongNameRes = licenseStore.activate({
    key: lic.key,
    name: 'Sai Ten',
    hwid: 'hwid-iphone-1',
  });
  assert.equal(wrongNameRes.ok, false);
  assert.match(wrongNameRes.error, /không khớp/);

  // Correct name succeeds
  const okRes = licenseStore.activate({
    key: lic.key,
    name: 'Hoang Nam',
    hwid: 'hwid-iphone-1',
    deviceInfo: 'iPhone 15',
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.license.status, 'active');
  assert.ok(okRes.license.expiresAt > Date.now());

  // Second device fails (single device enforcement)
  const secondDeviceRes = licenseStore.activate({
    key: lic.key,
    name: 'Hoang Nam',
    hwid: 'hwid-iphone-2',
  });
  assert.equal(secondDeviceRes.ok, false);
  assert.match(secondDeviceRes.error, /thiết bị khác/);

  // Same device verifies OK
  const verifyRes = licenseStore.verify({
    key: lic.key,
    hwid: 'hwid-iphone-1',
  });
  assert.equal(verifyRes.ok, true);
  assert.equal(verifyRes.valid, true);

  // Clean up
  licenseStore.deleteKey(lic.key);
});

test('lifetime key has null expiresAt', () => {
  const lic = licenseStore.createKey({ name: 'Vip User', type: 'lifetime' });
  const act = licenseStore.activate({
    key: lic.key,
    name: 'Vip User',
    hwid: 'hwid-pc-1',
  });
  assert.equal(act.ok, true);
  assert.equal(act.license.expiresAt, null);
  assert.equal(act.license.remainingText, 'Vĩnh viễn');

  licenseStore.deleteKey(lic.key);
});
