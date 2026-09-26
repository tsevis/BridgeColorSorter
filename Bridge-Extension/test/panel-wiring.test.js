/**
 * The panel's JavaScript and its markup must agree about what exists.
 *
 * Every lookup in app.js is guarded with `if (el)`, which is right — a missing
 * element should not take the panel down — but it also means a control can
 * disappear from index.html and nothing complains. Three had: the ⇅ reverse
 * button (documented in the README as a control), a colour-labels button whose
 * implementation is complete on both sides, and a vestigial sort <select>.
 *
 * A feature with no way to invoke it is the same failure as an installer that
 * prints "✓ installed successfully" against the wrong path.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const PANEL = read('js', 'app.js');
const HTML = read('index.html');

/**
 * Element ids app.js looks up.
 *
 * Both routes have to be scanned. Only checking `$('id')` let a real break
 * through: a spelling pass renamed `forceReanalyseToggle` to
 * `forceReanalyzeToggle` in the markup but not in app.js, and because that one
 * is reached through `bindToggle('id', ...)` rather than `$('id')` directly,
 * this test passed while the checkbox was dead.
 */
function wanted() {
  const ids = new Set();
  for (const re of [
    /\$\('([a-zA-Z][\w-]*)'\)/g,          // $('someId')
    /bindToggle\('([a-zA-Z][\w-]*)'/g     // bindToggle('someId', ...)
  ]) {
    let m;
    while ((m = re.exec(PANEL)) !== null) ids.add(m[1]);
  }
  return [...ids].sort();
}

/** Element ids index.html defines. */
function defined() {
  const ids = new Set();
  const re = /\bid="([a-zA-Z][\w-]*)"/g;
  let m;
  while ((m = re.exec(HTML)) !== null) ids.add(m[1]);
  return ids;
}

test('every element app.js wires up actually exists in the markup', () => {
  const have = defined();
  const missing = wanted().filter((id) => !have.has(id));

  assert.deepStrictEqual(missing, [],
    'app.js wires controls that index.html does not define, so the features ' +
    'behind them cannot be reached: ' + missing.join(', '));
});

test('no element id is declared twice', () => {
  const seen = new Set();
  const dupes = [];
  const re = /\bid="([a-zA-Z][\w-]*)"/g;
  let m;
  while ((m = re.exec(HTML)) !== null) {
    if (seen.has(m[1])) dupes.push(m[1]);
    seen.add(m[1]);
  }
  assert.deepStrictEqual(dupes, [], 'duplicate ids: ' + dupes.join(', '));
});

test('every script the panel loads exists', () => {
  const re = /<script src="([^"]+)"/g;
  let m;
  const missing = [];
  while ((m = re.exec(HTML)) !== null) {
    if (!fs.existsSync(path.join(__dirname, '..', m[1]))) missing.push(m[1]);
  }
  assert.deepStrictEqual(missing, [], 'missing scripts: ' + missing.join(', '));
});

test('modules load before the code that uses them', () => {
  // app.js reads HueBands.ACHROMATIC_CHROMA at definition time, not lazily, so
  // load order is load-bearing rather than incidental.
  const order = [];
  const re = /<script src="([^"]+)"/g;
  let m;
  while ((m = re.exec(HTML)) !== null) order.push(m[1]);

  const at = (f) => order.findIndex((s) => s.endsWith(f));
  for (const dep of ['hueBands.js', 'colorNames.js', 'naming.js', 'storedPalette.js',
    'analyzer/ColorEngine.js', 'similarity.js']) {
    assert.ok(at(dep) !== -1 && at(dep) < at('app.js'),
      `${dep} must load before app.js`);
  }
  assert.ok(at('analyzer/ColorEngine.js') < at('analyzer/workerPool.js'),
    'ColorEngine must load before workerPool');
});
