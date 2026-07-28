/**
 * Offline tests for colour family naming.
 *
 * The name is written into each file as a `Colour: <name>` keyword, which is
 * what Bridge's Filter panel indexes — so a change here silently re-buckets
 * every file the next time it is analysed.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const CE = require('../js/analyzer/ColorEngine.js');
const ColorNames = require('../js/colorNames.js');

const nameOf = (rgb) => ColorNames.nameFor(CE.rgbToHsl(rgb[0], rgb[1], rgb[2]));

test.describe('the spectrum names in order', () => {
  const spectrum = [
    [[255, 0, 0], 'Red'],
    [[255, 128, 0], 'Orange'],
    [[255, 255, 0], 'Yellow'],
    [[0, 255, 0], 'Green'],
    [[0, 255, 255], 'Cyan'],
    [[0, 0, 255], 'Blue'],
    [[128, 0, 255], 'Purple'],
    [[255, 0, 255], 'Magenta']
  ];

  for (const [rgb, expected] of spectrum) {
    test(`rgb(${rgb}) is ${expected}`, () => assert.strictEqual(nameOf(rgb), expected));
  }
});

test.describe('achromatic colours get their own names', () => {
  test('black', () => assert.strictEqual(nameOf([0, 0, 0]), 'Black'));
  test('near-black', () => assert.strictEqual(nameOf([12, 10, 14]), 'Black'));
  test('white', () => assert.strictEqual(nameOf([255, 255, 255]), 'White'));
  test('dark grey', () => assert.strictEqual(nameOf([70, 70, 70]), 'Dark Grey'));
  test('light grey', () => assert.strictEqual(nameOf([190, 190, 190]), 'Light Grey'));
});

test('brown is only claimed inside the orange band', () => {
  assert.strictEqual(nameOf([120, 70, 25]), 'Brown');
  // A dark saturated red is Dark Red, not brown — the case that drove the
  // hue >= 10 lower bound.
  assert.strictEqual(nameOf([137, 7, 8]), 'Dark Red');
});

test('the near-red that used to round to hue 360 is still Red', () => {
  assert.strictEqual(nameOf([215, 3, 4]), 'Red');
  assert.strictEqual(nameOf([255, 0, 0]), 'Red');
});

test('every colour gets a name — no undefined leaks into a keyword', () => {
  for (let r = 0; r < 256; r += 16) {
    for (let g = 0; g < 256; g += 16) {
      for (let b = 0; b < 256; b += 16) {
        const n = nameOf([r, g, b]);
        assert.strictEqual(typeof n, 'string');
        assert.ok(n.length > 0, `empty name for ${r},${g},${b}`);
      }
    }
  }
});

test('the name set stays small enough to be a usable filter', () => {
  const names = new Set();
  for (let r = 0; r < 256; r += 8) {
    for (let g = 0; g < 256; g += 8) {
      for (let b = 0; b < 256; b += 8) names.add(nameOf([r, g, b]));
    }
  }
  // Coarse and stable by design: a poetic naming scheme would make the Filter
  // panel useless.
  assert.ok(names.size <= 32, `${names.size} distinct names: ${[...names].join(', ')}`);
});

test.describe('label slots', () => {
  test('there are exactly five, because Bridge has five', () => {
    assert.strictEqual(ColorNames.LABEL_SLOTS.length, 5);
  });

  test('a red picks the red slot, a blue the blue slot', () => {
    assert.strictEqual(ColorNames.labelFor(CE.rgbToHsl(200, 31, 35)).swatch, 'Red');
    assert.strictEqual(ColorNames.labelFor(CE.rgbToHsl(40, 60, 200)).swatch, 'Blue');
  });

  test('achromatic colours get no label rather than a misleading one', () => {
    assert.strictEqual(ColorNames.labelFor(CE.rgbToHsl(128, 128, 128)), null);
    assert.strictEqual(ColorNames.labelFor(CE.rgbToHsl(0, 0, 0)), null);
    assert.strictEqual(ColorNames.labelFor(CE.rgbToHsl(255, 255, 255)), null);
  });

  test('hue wraps, so a magenta takes the nearer of red and purple', () => {
    // 330° is 30° from red at 0° and 45° from purple at 285°.
    assert.strictEqual(ColorNames.labelFor([330, 80, 50]).swatch, 'Red');
  });
});
