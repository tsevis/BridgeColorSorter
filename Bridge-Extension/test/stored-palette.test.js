/**
 * Offline tests for the palette form stored in XMP.
 *
 * This is the cache path: a folder that has been analysed once re-orders in
 * seconds instead of minutes because the palette is read back from here rather
 * than recomputed. A parse that quietly drops or mangles entries would produce
 * a wrong colour order with nothing visibly broken.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SP = require('../js/storedPalette.js');

test('a written palette reads back unchanged', () => {
  const palette = [
    { hex: '#c81f23', dominance: 0.421 },
    { hex: '#e6d2aa', dominance: 0.312 },
    { hex: '#28405a', dominance: 0.267 }
  ];
  const parsed = SP.parse(SP.format(palette));

  assert.strictEqual(parsed.length, 3);
  assert.deepStrictEqual(parsed.map((c) => c.hex), ['#c81f23', '#e6d2aa', '#28405a']);
  assert.deepStrictEqual(parsed.map((c) => c.dominance), [0.421, 0.312, 0.267]);
});

test('hex parses to the right rgb triple', () => {
  const [c] = SP.parse('#c81f23|1');
  assert.deepStrictEqual(c.rgb, [200, 31, 35]);
});

test('a five-entry palette round-trips within the measured tolerance', () => {
  // The README's claim about the 1,559-image folder: dominance sums land
  // within 0.999-1.002 of unity after the round trip.
  const palette = [
    { hex: '#c81f23', dominance: 0.4213 },
    { hex: '#e6d2aa', dominance: 0.2687 },
    { hex: '#28405a', dominance: 0.1544 },
    { hex: '#8a9a6b', dominance: 0.0999 },
    { hex: '#141418', dominance: 0.0557 }
  ];
  const total = SP.parse(SP.format(palette)).reduce((s, c) => s + c.dominance, 0);
  assert.ok(total > 0.999 && total < 1.002, `sum drifted to ${total}`);
});

test('rounding error stays inside the bound the format can guarantee', () => {
  // Three stored decimals means each entry can be off by at most 0.0005, so a
  // palette of n entries can drift by 0.0005n and no more. Twelve equal
  // entries is the worst case the format permits: 1/12 stores as 0.083 and the
  // sum lands at 0.996. That is the format's floor, not a bug — but if the
  // stored precision is ever reduced this test says so immediately.
  for (const n of [1, 3, 5, 8, 12]) {
    const palette = [];
    for (let i = 0; i < n; i++) palette.push({ hex: '#102030', dominance: 1 / n });

    const total = SP.parse(SP.format(palette)).reduce((s, c) => s + c.dominance, 0);
    assert.ok(Math.abs(total - 1) <= 0.0005 * n + 1e-9,
      `${n} entries drifted to ${total}, beyond the ±${0.0005 * n} the format allows`);
  }
});

test('at most twelve entries are stored', () => {
  const palette = [];
  for (let i = 0; i < 30; i++) palette.push({ hex: '#010203', dominance: 1 / 30 });
  assert.strictEqual(SP.parse(SP.format(palette)).length, 12);
});

test('the host script uses the same twelve-entry limit', () => {
  // cxbPaletteToString runs in ExtendScript and cannot import this module, so
  // the cap is duplicated. A mismatch would truncate palettes on write and
  // read them back short.
  const host = fs.readFileSync(
    path.join(__dirname, '..', 'jsx', 'ColorXBridge.jsx'), 'utf8');
  const fn = /function cxbPaletteToString\(palette\) \{[\s\S]*?\n\}/.exec(host);
  assert.ok(fn, 'cxbPaletteToString not found');
  assert.ok(/i < 12/.test(fn[0]),
    'jsx/ColorXBridge.jsx no longer caps the stored palette at 12 entries');
});

test.describe('malformed input is dropped, never guessed at', () => {
  const junk = [
    ['', 'empty string'],
    [null, 'null'],
    [undefined, 'undefined'],
    ['garbage', 'no separator'],
    ['#c81f23', 'hex with no dominance'],
    ['|0.5', 'dominance with no hex'],
    ['#xyz123|0.5', 'non-hex digits'],
    ['#c81f2|0.5', 'five hex digits'],
    ['#c81f233|0.5', 'seven hex digits'],
    ['#c81f23|notanumber', 'unparseable dominance'],
    ['#c81f23|-0.5', 'negative dominance'],
    ['#c81f23|0.5|extra', 'too many fields']
  ];

  for (const [input, why] of junk) {
    test(why, () => assert.deepStrictEqual(SP.parse(input), []));
  }
});

test('one bad entry does not discard the good ones', () => {
  const parsed = SP.parse('#c81f23|0.5,garbage,#28405a|0.3,#zzz|0.2');
  assert.deepStrictEqual(parsed.map((c) => c.hex), ['#c81f23', '#28405a']);
});

test('a missing hash and upper-case hex both parse', () => {
  // Written by an older version, or by hand.
  assert.deepStrictEqual(SP.parse('c81f23|0.5')[0].rgb, [200, 31, 35]);
  assert.strictEqual(SP.parse('#C81F23|0.5')[0].hex, '#c81f23');
});

test('whitespace around an entry is tolerated', () => {
  assert.strictEqual(SP.parse(' #c81f23 |0.5').length, 1);
});
