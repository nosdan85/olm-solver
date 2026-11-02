'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proxyManager = require('../src/proxy');

test('proxyManager parses standard URL and host:port:user:pass', () => {
  const p1 = proxyManager.parseProxy('http://myuser:mypass@1.2.3.4:8080');
  assert.equal(p1.host, '1.2.3.4');
  assert.equal(p1.port, 8080);
  assert.equal(p1.username, 'myuser');
  assert.equal(p1.password, 'mypass');
  assert.equal(p1.serverArg, 'http://1.2.3.4:8080');

  const p2 = proxyManager.parseProxy('103.15.20.1:9999:user888:secret999');
  assert.equal(p2.host, '103.15.20.1');
  assert.equal(p2.port, 9999);
  assert.equal(p2.username, 'user888');
  assert.equal(p2.password, 'secret999');
  assert.equal(p2.serverArg, 'http://103.15.20.1:9999');
});
