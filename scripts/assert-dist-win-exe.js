#!/usr/bin/env node

/**
 * Ensures dist/ contains a top-level NSIS-style .exe after electron-builder --win.
 * Used by postbuild:publish and scripts/release.js so GitHub gets an artifact electron-updater can use.
 */

const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(distDir)) {
  console.error('Expected dist/ after build, but it does not exist.');
  process.exit(1);
}

const entries = fs.readdirSync(distDir, { withFileTypes: true });
const exeFiles = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe')).map((e) => e.name);

if (exeFiles.length === 0) {
  console.error(
    'No .exe installer under dist/. electron-updater on Windows needs an NSIS (.exe) on GitHub.\n' +
      'Ensure package.json build.win.target includes "nsis".',
  );
  process.exit(1);
}

console.log(`Windows .exe installer(s): ${exeFiles.join(', ')}`);
process.exit(0);
