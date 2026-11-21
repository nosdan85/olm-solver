'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

async function main() {
  try {
    const puppeteer = require('puppeteer');
    const executable = await puppeteer.executablePath().catch(() => null);
    if (executable && fs.existsSync(executable)) {
      console.log(`Puppeteer browser already installed: ${executable}`);
      return;
    }
  } catch {
    console.error('Puppeteer dependency is not installed. Run npm install first.');
    process.exitCode = 1;
    return;
  }

  console.log('Install Puppeteer Chromium with: npx puppeteer browsers install chrome');
  const metadata = require.resolve('puppeteer/package.json');
  const cli = path.resolve(path.dirname(metadata), require(metadata).bin.puppeteer);
  execFileSync(process.execPath, [cli, 'browsers', 'install', 'chrome'], { stdio: 'inherit' });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});