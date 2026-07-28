/**
 * Static checks on the worker analysis path.
 *
 * The workers themselves need a browser — OffscreenCanvas, createImageBitmap
 * and Worker do not exist in Node — so what is checkable offline is the
 * structure: that the worker runs the same clustering code rather than a copy
 * of it, that the pixel-building rules match the main thread exactly, and that
 * every failure still has a way back to a single-threaded analysis.
 *
 * The consequences of getting those wrong are severe and quiet. extractPalette
 * seeds its random source from the pixel COUNT, so one extra or missing pixel
 * silently changes an image's whole palette — and therefore its place in the
 * library.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const WORKER = read('js', 'analyzer', 'paletteWorker.js');
const POOL = read('js', 'analyzer', 'workerPool.js');
const ENGINE = read('js', 'analyzer', 'ColorEngine.js');
const PANEL = read('js', 'app.js');

test('both files parse', () => {
  assert.doesNotThrow(() => new vm.Script(WORKER, { filename: 'paletteWorker.js' }));
  assert.doesNotThrow(() => new vm.Script(POOL, { filename: 'workerPool.js' }));
});

test('the worker runs the shared clustering, not a copy of it', () => {
  // A second implementation of extractPalette would drift from the golden
  // fixture without anything failing.
  assert.ok(/importScripts\(['"]ColorEngine\.js['"]\)/.test(WORKER),
    'the worker must importScripts ColorEngine.js');
  assert.ok(/ColorEngine\.extractPalette\(/.test(WORKER),
    'the worker must call the shared extractPalette');
  assert.ok(!/function extractPalette/.test(WORKER),
    'the worker must not define its own extractPalette');
  assert.ok(!/kmeans|centroid/i.test(WORKER.replace(/\/\*[\s\S]*?\*\//g, '')),
    'clustering internals must not be reimplemented in the worker');
});

test('ColorEngine can load in a worker, which has no DOM and no Node', () => {
  // importScripts runs the file top to bottom. Anything touching document or
  // requiring Node at load time would throw and take the whole worker down.
  const top = ENGINE.split('function decode')[0];
  assert.ok(!/document\./.test(top),
    'ColorEngine must not touch document at load time');
  assert.ok(/typeof require === ['"]function['"]/.test(ENGINE),
    'ColorEngine must guard its require() calls');
  assert.ok(/typeof window !== ['"]undefined['"] \? window : globalThis/.test(ENGINE),
    'ColorEngine must attach to globalThis when there is no window');
});

test('the worker samples pixels by exactly the main thread rules', () => {
  // These three must agree or the palettes diverge: the alpha cutoff, the
  // scale calculation, and the rounding.
  const engineDecode = ENGINE.slice(ENGINE.indexOf('function decode'));

  for (const [pattern, what] of [
    [/data\[i \+ 3\] < 125/, 'the alpha cutoff'],
    [/Math\.min\(1, maxDim \/ Math\.max\(w, h\)\)/, 'the scale calculation'],
    [/Math\.max\(1, Math\.round\(w \* scale\)\)/, 'the width rounding'],
    [/Math\.max\(1, Math\.round\(h \* scale\)\)/, 'the height rounding'],
    [/pixels\.push\(\[data\[i\], data\[i \+ 1\], data\[i \+ 2\]\]\)/, 'the channel order']
  ]) {
    assert.ok(pattern.test(WORKER), `worker is missing ${what}`);
    assert.ok(pattern.test(engineDecode), `ColorEngine.decode is missing ${what}`);
  }
});

test('the pool hands over ArrayBuffers it owns', () => {
  // Node's readFile returns a view onto a shared pool buffer. Transferring
  // that ArrayBuffer would detach it from every other read still using it.
  assert.ok(/buf\.buffer\.slice\(buf\.byteOffset/.test(POOL),
    'the pool must copy out of Node\'s shared buffer before transferring');
  assert.ok(/postMessage\([\s\S]*?\[payload\.buffer\]\)/.test(POOL),
    'bytes must be transferred, not copied');
});

test('every worker failure has a way back to the main thread', () => {
  for (const [pattern, what] of [
    [/onerror = function/, 'a dead worker is handled'],
    [/reply\.error/, 'a failed job is handled'],
    [/reject\(new Error\('workers unavailable'\)\)/, 'a missing Worker API is handled']
  ]) {
    assert.ok(pattern.test(POOL), `workerPool.js: ${what}`);
  }

  const analyze = PANEL.slice(PANEL.indexOf('function analyzeAll('));
  assert.ok(/analyzeOnMainThread\(/.test(analyze),
    'js/app.js must fall back to a single-threaded analysis');
  assert.ok(/\.catch\(function \(err\) \{[\s\S]*?analyzeOnMainThread\(files/.test(analyze),
    'a pool that fails wholesale must fall back for every file');
  assert.ok(/stranded/.test(analyze),
    'files the pool could not do must be retried on the main thread');
});

test('the pool leaves cores for the main thread and Bridge', () => {
  const pool = require('../js/analyzer/workerPool.js');

  // navigator is a getter-only global in Node, so it has to be redefined
  // rather than assigned.
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setCores = (value) =>
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });

  try {
    // Never zero, never more than 12, always two short of the core count in
    // between: Bridge is still drawing its own grid while this runs.
    for (const [cores, expected] of [[1, 1], [2, 1], [4, 2], [8, 6], [20, 12], [64, 12]]) {
      setCores({ hardwareConcurrency: cores });
      assert.strictEqual(pool.poolSize(), expected,
        `${cores} cores should give ${expected} workers`);
    }

    setCores(undefined);
    assert.ok(pool.poolSize() >= 1, 'must still return a usable size with no navigator');
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
});

test('the worker script ships', () => {
  const pool = require('../js/analyzer/workerPool.js');
  assert.ok(fs.existsSync(path.join(__dirname, '..', pool.WORKER_URL)),
    `${pool.WORKER_URL} must exist relative to the panel root`);

  const installer = read('scripts', 'install.js');
  assert.ok(/'js'/.test(installer),
    'the installer must copy js/, which is where the worker lives');
});
