#!/usr/bin/env node
/**
 * BridgeColorShorter installer.
 *
 *   node scripts/install.js             install into the user CEP folder
 *   node scripts/install.js --status    report what is installed
 *   node scripts/install.js --uninstall remove it
 *
 * Two details matter and were wrong in earlier versions of this project:
 *   1. CEP only reads the manifest from <extension>/CSXS/manifest.xml.
 *   2. Adobe Bridge's CEP host code is KBRG, not BRG.
 * Both are asserted here so a broken build fails loudly instead of silently
 * installing something Bridge will ignore.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NAME = 'BridgeColorShorter';
const PAYLOAD = ['CSXS', 'index.html', 'css', 'js', 'jsx', 'assets'];
/** CSXS preference domains across the Bridge/CEP versions in the wild. */
const CSXS_VERSIONS = [8, 9, 10, 11, 12, 13, 14, 15];

function extensionsDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA, 'Adobe', 'CEP', 'extensions');
  }
  throw new Error('Unsupported platform: ' + process.platform);
}

const TARGET = path.join(extensionsDir(), NAME);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateSource() {
  const manifest = path.join(ROOT, 'CSXS', 'manifest.xml');

  if (!fs.existsSync(manifest)) {
    fail('CSXS/manifest.xml is missing.\n' +
      'CEP will not detect an extension whose manifest sits anywhere else.');
  }

  const xml = fs.readFileSync(manifest, 'utf8');

  if (!/Host\s+Name="KBRG"/.test(xml)) {
    fail('CSXS/manifest.xml does not declare Host Name="KBRG".\n' +
      "Adobe Bridge's CEP host code is KBRG - \"BRG\" matches no Adobe application,\n" +
      'so the extension would never load.');
  }

  for (const entry of PAYLOAD) {
    if (!fs.existsSync(path.join(ROOT, entry))) {
      fail(`Missing required item: ${entry}`);
    }
  }

  const bundleId = (xml.match(/ExtensionBundleId="([^"]+)"/) || [])[1];
  const version = (xml.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1];
  return { bundleId, version };
}

function fail(message) {
  console.error('\n  ERROR: ' + message + '\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Debug mode (unsigned extensions only load when this is on)
// ---------------------------------------------------------------------------

function debugModeState() {
  if (process.platform !== 'darwin') return null;
  const state = {};
  for (const v of CSXS_VERSIONS) {
    try {
      state[v] = execFileSync('defaults', ['read', `com.adobe.CSXS.${v}`, 'PlayerDebugMode'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {
      state[v] = null;
    }
  }
  return state;
}

function enableDebugMode() {
  if (process.platform !== 'darwin') return;
  for (const v of CSXS_VERSIONS) {
    try {
      execFileSync('defaults', ['write', `com.adobe.CSXS.${v}`, 'PlayerDebugMode', '1'],
        { stdio: 'ignore' });
    } catch (e) {
      // Some versions may not be present; that is fine.
    }
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'node_modules', '.git']);

function copyTree(src, dest) {
  const stat = fs.statSync(src);

  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (SKIP.has(entry)) continue;
      copyTree(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  fs.copyFileSync(src, dest);
}

function install() {
  const info = validateSource();

  console.log('BridgeColorShorter installer');
  console.log('  bundle : ' + info.bundleId + ' v' + info.version);
  console.log('  target : ' + TARGET);

  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.mkdirSync(TARGET, { recursive: true });

  for (const entry of PAYLOAD) {
    copyTree(path.join(ROOT, entry), path.join(TARGET, entry));
  }

  // Optional CEP remote-debugging config. Development aid only - it opens a
  // DevTools port, so it is off unless you deliberately copy
  // .debug.example to .debug. Never ship it.
  const debugFile = path.join(ROOT, '.debug');
  if (fs.existsSync(debugFile)) {
    fs.copyFileSync(debugFile, path.join(TARGET, '.debug'));
    const port = (fs.readFileSync(debugFile, 'utf8').match(/Port="(\d+)"/) || [])[1];
    console.log('  debug  : remote debugging enabled on port ' + (port || '?') +
      ' (.debug present - remove before distributing)');
  }

  // The installed copy must satisfy the same rule as the source.
  const installedManifest = path.join(TARGET, 'CSXS', 'manifest.xml');
  if (!fs.existsSync(installedManifest)) {
    fail('Install finished but CSXS/manifest.xml is not at the target.');
  }

  enableDebugMode();

  console.log('\n  Installed.\n');
  console.log('  Next: restart Adobe Bridge, then open');
  console.log('        Window > Extensions > BridgeColorShorter\n');
}

function uninstall() {
  if (!fs.existsSync(TARGET)) {
    console.log('Not installed at ' + TARGET);
    return;
  }
  fs.rmSync(TARGET, { recursive: true, force: true });
  console.log('Removed ' + TARGET + '\n  Restart Bridge to finish.');
}

function status() {
  console.log('BridgeColorShorter status');
  console.log('  target : ' + TARGET);

  const installed = fs.existsSync(path.join(TARGET, 'CSXS', 'manifest.xml'));
  console.log('  state  : ' + (installed ? 'INSTALLED' : 'not installed'));

  if (installed) {
    const xml = fs.readFileSync(path.join(TARGET, 'CSXS', 'manifest.xml'), 'utf8');
    console.log('  version: ' + (xml.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1]);
    console.log('  host   : ' + ((xml.match(/Host\s+Name="([^"]+)"/) || [])[1] || 'unknown'));
  }

  const debug = debugModeState();
  if (debug) {
    const on = Object.keys(debug).filter((v) => debug[v] === '1');
    console.log('  debug  : ' + (on.length ? 'enabled for CSXS ' + on.join(', ') : 'DISABLED'));
    if (!on.length) {
      console.log('           unsigned extensions will not load; run the installer to enable');
    }
  }
  console.log('');
}

const args = process.argv.slice(2);
if (args.includes('--uninstall')) uninstall();
else if (args.includes('--status')) status();
else install();
