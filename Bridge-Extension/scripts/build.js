#!/usr/bin/env node
/**
 * Package BridgeColorSorter for distribution.
 *
 *   node scripts/build.js            stage a validated package in dist/
 *   node scripts/build.js --zxp      stage, then sign it into a .zxp
 *   node scripts/build.js --clean    remove dist/
 *
 * Signing needs Adobe's ZXPSignCmd. Point at it with ZXP_SIGN_CMD, or install
 * the wrapper (`npm i -g zxp-sign-cmd`) and this will find it. A self-signed
 * certificate is enough to make the package installable — see --make-cert.
 *
 * ---------------------------------------------------------------------------
 * This script was rewritten because the original could not have worked.
 *
 * It copied `manifest.xml` from the extension root — which is fault #2 from
 * the README, the one that cost this project months: CEP only ever reads
 * `<extension>/CSXS/manifest.xml`. Worse, its directory list was
 * ['css', 'js', 'assets'], so `CSXS/` and `jsx/` were not copied at all. The
 * package it produced had no manifest and no host script.
 *
 * And it *warned and skipped* on anything missing, so it would have reported a
 * successful build of an extension that could never load. That is the exact
 * shape of the original installer bug — a tool checking its own wrong
 * assumption and printing a tick. Everything here fails loudly instead.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'dist');
const NAME = 'BridgeColorSorter';
const ZXP_OUTPUT = path.join(ROOT, `${NAME}.zxp`);

/**
 * Exactly what the installer copies. Kept identical on purpose: a package that
 * differs from what is known to work in Bridge is a package nobody has tested.
 */
const PAYLOAD = ['CSXS', 'index.html', 'css', 'js', 'jsx', 'assets'];

/** Never ship these, whatever they are next to. */
const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'node_modules', '.git', '.debug']);

function log(message) { console.log('[build]', message); }

function fail(message) {
  console.error('\n[build] ERROR: ' + message + '\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

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
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function stage() {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const entry of PAYLOAD) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) fail(`missing from the source tree: ${entry}`);
    copyTree(src, path.join(OUTPUT_DIR, entry));
  }
  log(`staged ${PAYLOAD.length} items in dist/`);
}

// ---------------------------------------------------------------------------
// Validate what was staged, not what was intended
// ---------------------------------------------------------------------------

function validate() {
  const manifestPath = path.join(OUTPUT_DIR, 'CSXS', 'manifest.xml');

  if (!fs.existsSync(manifestPath)) {
    fail('dist/CSXS/manifest.xml is missing.\n' +
      'CEP reads the manifest from CSXS/ and nowhere else, so a package ' +
      'without it installs and then silently never loads.');
  }

  const xml = fs.readFileSync(manifestPath, 'utf8');

  if (!/Host\s+Name="KBRG"/.test(xml)) {
    fail('the manifest does not declare Host Name="KBRG".\n' +
      "Adobe Bridge's CEP host code is KBRG; anything else matches no Adobe " +
      'application.');
  }

  // The host script the manifest points at must actually be in the package.
  const scriptPath = (xml.match(/<ScriptPath>\.?\/?([^<]+)<\/ScriptPath>/) || [])[1];
  if (!scriptPath) fail('the manifest declares no <ScriptPath>.');
  if (!fs.existsSync(path.join(OUTPUT_DIR, scriptPath))) {
    fail(`the manifest points at ${scriptPath}, which is not in the package.`);
  }

  const mainPath = (xml.match(/<MainPath>\.?\/?([^<]+)<\/MainPath>/) || [])[1];
  if (!mainPath) fail('the manifest declares no <MainPath>.');
  if (!fs.existsSync(path.join(OUTPUT_DIR, mainPath))) {
    fail(`the manifest points at ${mainPath}, which is not in the package.`);
  }

  // Every <script src> the panel loads has to be there too, or the panel opens
  // to a blank rectangle.
  const html = fs.readFileSync(path.join(OUTPUT_DIR, mainPath), 'utf8');
  const missing = [];
  const re = /<script src="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!fs.existsSync(path.join(OUTPUT_DIR, m[1]))) missing.push(m[1]);
  }
  if (missing.length) fail('scripts referenced but not packaged: ' + missing.join(', '));

  if (fs.existsSync(path.join(OUTPUT_DIR, '.debug'))) {
    fail('.debug is in the package. It opens a remote debugging port and must ' +
      'never ship.');
  }

  const bundleId = (xml.match(/ExtensionBundleId="([^"]+)"/) || [])[1];
  const version = (xml.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1];
  log(`validated: ${bundleId} v${version}, host script ${scriptPath}`);
  return { bundleId, version };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function findSignCmd() {
  if (process.env.ZXP_SIGN_CMD && fs.existsSync(process.env.ZXP_SIGN_CMD)) {
    return process.env.ZXP_SIGN_CMD;
  }
  const candidates = [
    '/Applications/Adobe CEP Extensions/CEP/CEPExtras/ZXPSignCmd',
    '/Applications/Adobe Extension Manager CC/ZXPSignCmd',
    path.join(ROOT, 'ZXPSignCmd'),
    path.join(ROOT, 'node_modules', 'zxp-sign-cmd', 'bin', 'ZXPSignCmd')
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const CERT = path.join(ROOT, 'cert.p12');

function makeCert(signCmd) {
  const password = process.env.ZXP_PASSWORD;
  if (!password) fail('set ZXP_PASSWORD to the password for the new certificate.');

  execFileSync(signCmd, [
    '-selfSignedCert', 'GR', 'Attica',
    process.env.ZXP_ORG || 'BridgeColorSorter',
    process.env.ZXP_CERT_ID || 'BridgeColorSorter',
    password, CERT
  ], { stdio: 'inherit' });

  log(`self-signed certificate written to ${CERT}`);
  log('It identifies you as the publisher. Keep it (and its password) if you');
  log('want future versions to be recognised as the same publisher.');
}

function sign(signCmd) {
  const password = process.env.ZXP_PASSWORD;
  if (!password) fail('set ZXP_PASSWORD to the certificate password.');
  if (!fs.existsSync(CERT)) {
    fail(`no certificate at ${CERT}. Create one with:\n` +
      '  ZXP_PASSWORD=... node scripts/build.js --make-cert');
  }

  fs.rmSync(ZXP_OUTPUT, { force: true });
  execFileSync(signCmd, ['-sign', OUTPUT_DIR, ZXP_OUTPUT, CERT, password, '-tsa',
    'http://timestamp.digicert.com'], { stdio: 'inherit' });

  if (!fs.existsSync(ZXP_OUTPUT)) fail('signing reported success but produced no file.');

  const size = (fs.statSync(ZXP_OUTPUT).size / 1024).toFixed(0);
  log(`signed: ${ZXP_OUTPUT} (${size} KB)`);
}

function verify(signCmd) {
  try {
    execFileSync(signCmd, ['-verify', ZXP_OUTPUT, '-certinfo'], { stdio: 'inherit' });
  } catch (e) {
    fail('the signed package does not verify.');
  }
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes('--clean')) {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  log('cleaned dist/');
  process.exit(0);
}

const signCmd = findSignCmd();

if (args.includes('--make-cert')) {
  if (!signCmd) fail('ZXPSignCmd not found. Set ZXP_SIGN_CMD to its path.');
  makeCert(signCmd);
  process.exit(0);
}

stage();
validate();

if (args.includes('--zxp')) {
  if (!signCmd) {
    fail('ZXPSignCmd not found, so no .zxp was produced.\n' +
      'Get it from Adobe: https://github.com/Adobe-CEP/CEP-Resources\n' +
      'then set ZXP_SIGN_CMD to its path.\n\n' +
      'dist/ is staged and validated, so signing is the only step left.');
  }
  sign(signCmd);
  verify(signCmd);
} else {
  log('dist/ is ready. Add --zxp to sign it.');
}
