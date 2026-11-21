'use strict';

const { cpSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const output = join(root, 'dist');
const rawOrigin = (process.env.PUBLIC_API_ORIGIN || '').trim();
let apiOrigin = '';
if (rawOrigin) {
  const url = new URL(rawOrigin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_API_ORIGIN must be an HTTPS origin without a path or credentials.');
  }
  apiOrigin = url.origin;
}

cpSync(join(root, 'public'), output, { recursive: true });
const settings = { apiOrigin, liveEvents: false };
writeFileSync(join(output, 'js', 'deployment.js'), 'window.OLM_DEPLOYMENT = ' + JSON.stringify(settings) + ';\n');

