'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { log } = require('../src/session-store');

async function main() {
  try {
    const puppeteer = require('puppeteer');
    const executable = puppeteer.executablePath();
    if (fs.existsSync(executable)) {
      console.log(`Puppeteer browser already installed: ${executable}`);
      return;
    }
  } catch {
    console.error('Puppeteer dependency is not installed. Run npm install first.');
    process.exitCode = 1;
    return;
  }

  console.log('Install Puppeteer Chromium with: npx puppeteer browsers install chrome');
  execFileSync('npx', ['puppeteer', 'browsers', 'install', 'chrome'], { stdio: 'inherit' });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});