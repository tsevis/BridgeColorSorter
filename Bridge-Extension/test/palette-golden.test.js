/**
 * Frozen clustering output.
 *
 * The palette drives everything downstream: the colour name written as a
 * keyword, the sort order, and the filename prefix. So a change to
 * extractPalette is a change to how the whole library is arranged — which is
 * fine when it is deliberate, and invisible when it is not.
 *
 * test/fixtures/palettes.json holds the exact palettes the clustering produced
 * at the point this guard was added. Any difference fails, loudly, with the
 * before and after side by side.
 *
 * If a change here IS deliberate, regenerate the fixture — but the project's
 * rule applies: judge the result on a contact sheet of the whole folder, not
 * on a number.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CE = require('../js/analyzer/ColorEngine.js');

const GOLDEN = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'palettes.json'), 'utf8'));

/** Must match the generator exactly, or the fixture means nothing. */
function makePixels(n, seed) {
  let s = seed || 1;
  const rand = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const bases = [[180, 40, 35], [230, 210, 170], [40, 60, 90], [120, 130, 60],
    [20, 20, 25], [250, 250, 245], [90, 20, 110], [10, 140, 130]];
  const px = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = bases[Math.floor(rand() * bases.length)];
    px[i] = [
      Math.round(Math.max(0, Math.min(255, b[0] + (rand() - 0.5) * 70))),
      Math.round(Math.max(0, Math.min(255, b[1] + (rand() - 0.5) * 70))),
      Math.round(Math.max(0, Math.min(255, b[2] + (rand() - 0.5) * 70)))
    ];
  }
  return px;
}

test('the fixture covers the range it claims to', () => {
  assert.ok(GOLDEN.length >= 10, 'too few golden cases to be meaningful');
  const sizes = GOLDEN.map((c) => c.pixels);
  assert.ok(Math.min(...sizes) === 1, 'the single-pixel edge case must be covered');
  assert.ok(Math.max(...sizes) >= 25600,
    'a full 160x160 sample must be covered — that is the panel default');
});

for (const golden of GOLDEN) {
  test(`clustering is unchanged for ${golden.pixels} px, k=${golden.k}`, () => {
    const { palette } = CE.extractPalette(makePixels(golden.pixels, golden.seed), golden.k);

    const show = (p) => p.map((c) =>
      `${c.hex}@${c.dominance.toFixed(4)}`).join(' ');

    assert.strictEqual(palette.length, golden.palette.length,
      `palette size changed\n  was: ${show(golden.palette)}\n  now: ${show(palette)}`);

    for (let i = 0; i < golden.palette.length; i++) {
      assert.strictEqual(palette[i].hex, golden.palette[i].hex,
        `colour ${i} changed\n  was: ${show(golden.palette)}\n  now: ${show(palette)}`);
      assert.deepStrictEqual(palette[i].rgb, golden.palette[i].rgb,
        `rgb ${i} changed`);
      assert.ok(Math.abs(palette[i].dominance - golden.palette[i].dominance) < 1e-12,
        `dominance ${i} changed\n  was: ${show(golden.palette)}\n  now: ${show(palette)}`);
    }
  });
}
