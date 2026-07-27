#!/usr/bin/env node
/**
 * Copy the canonical colour engine from the Bridge extension into this app's
 * vendor folder, so both surfaces cluster colours identically and the packaged
 * .app carries its own copy.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', '..', 'Bridge-Extension', 'js', 'analyzer', 'ColorEngine.js');
const DEST_DIR = path.join(__dirname, '..', 'src', 'vendor');
const DEST = path.join(DEST_DIR, 'ColorEngine.js');

if (!fs.existsSync(SOURCE)) {
  console.error('ERROR: cannot find the colour engine at ' + SOURCE);
  process.exit(1);
}

fs.mkdirSync(DEST_DIR, { recursive: true });
fs.copyFileSync(SOURCE, DEST);
console.log('Synced ColorEngine.js -> src/vendor/ColorEngine.js');
