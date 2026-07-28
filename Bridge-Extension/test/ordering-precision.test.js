/**
 * A sort key must not be rounded.
 *
 * Lightness is stored in XMP only via the palette's dominance values, which are
 * written to three decimals. If the ordering rounds its lightness to an
 * integer, that stored precision decides which side of an x.5 boundary a file
 * lands on — so the same image analysed fresh and read back from its own cache
 * can produce 36 and 37 and swap places with its neighbour.
 *
 * Measured on the 1,559-image folder before the fix: 598 files ordered
 * differently between a fresh analysis and a cached re-read, so the panel's
 * list disagreed with the order its own filenames encoded. Sorting on the
 * continuous value and rounding only for display made the two identical.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CE = require('../js/analyzer/ColorEngine.js');
const StoredPalette = require('../js/storedPalette.js');

const PANEL = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

test('meanLightness is not rounded before it is used to sort', () => {
  const body = PANEL.slice(
    PANEL.indexOf('function meanLightness('),
    PANEL.indexOf('function meanLightness(') + 900);

  assert.ok(!/rec\._meanL = [\s\S]*?Math\.round/.test(body),
    'meanLightness must return the continuous value — rounding it makes the ' +
    'order depend on the three decimals stored in XMP');
});

test('everything that writes lightness into a filename rounds it', () => {
  // pad() is the only thing that should round, and it does.
  const naming = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'naming.js'), 'utf8');
  assert.ok(/Math\.round\(n\)/.test(naming), 'pad() must round');

  for (const call of PANEL.match(/pad\(meanLightness\(rec\)[^)]*\)/g) || []) {
    assert.ok(/pad\(/.test(call), `${call} must go through pad()`);
  }
});

/** The weighted mean lightness the panel sorts on. */
function meanL(palette) {
  let sum = 0;
  let weight = 0;
  for (const c of palette) {
    sum += CE.rgbToOklab(c.rgb[0], c.rgb[1], c.rgb[2])[0] * c.dominance;
    weight += c.dominance;
  }
  return (sum / weight) * 100;
}

/** Deterministic palettes whose dominances do not land on tidy numbers. */
function palettes(count) {
  let s = 99;
  const rand = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const out = [];
  for (let i = 0; i < count; i++) {
    const n = 3 + Math.floor(rand() * 3);
    const raw = [];
    let total = 0;
    for (let k = 0; k < n; k++) { const w = rand(); raw.push(w); total += w; }
    out.push(raw.map((w) => {
      const rgb = [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)];
      return { hex: CE.rgbToHex(rgb[0], rgb[1], rgb[2]), rgb, dominance: w / total };
    }));
  }
  return out;
}

test('a round trip through storage barely moves the continuous value', () => {
  let worst = 0;
  for (const p of palettes(400)) {
    const back = StoredPalette.parse(StoredPalette.format(p));
    if (back.length !== p.length) continue;
    worst = Math.max(worst, Math.abs(meanL(p) - meanL(back)));
  }
  assert.ok(worst < 0.5,
    `storage moved the continuous mean lightness by ${worst.toFixed(4)} points`);
});

test('but it flips the ROUNDED value often enough to reorder a library', () => {
  // This is the failure the fix prevents, demonstrated rather than asserted
  // away: rounding turns a drift far below one point into a whole-integer
  // difference for every file sitting near a boundary.
  let flipped = 0;
  let compared = 0;
  for (const p of palettes(400)) {
    const back = StoredPalette.parse(StoredPalette.format(p));
    if (back.length !== p.length) continue;
    compared++;
    if (Math.round(meanL(p)) !== Math.round(meanL(back))) flipped++;
  }
  assert.ok(compared > 300, 'not enough comparable palettes to be meaningful');
  assert.ok(flipped > 0,
    'the fixture no longer reproduces the rounding flip it exists to document');
});
