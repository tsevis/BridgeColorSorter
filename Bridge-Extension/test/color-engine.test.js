/**
 * Offline tests for the colour engine.
 *
 * Everything here runs in plain Node — no Bridge, no Chromium. Only decode()
 * needs a browser; extractPalette() and the colour-space maths do not, and
 * those are where the regressions have been.
 *
 * Run: npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const CE = require('../js/analyzer/ColorEngine.js');

/** Build a flat block of one colour, as decode() would return it. */
function block(rgb, count) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = rgb.slice();
  return out;
}

test('hue never reaches 360 across an exhaustive sweep', () => {
  // rgb(215,3,4) rounded to 360 and sorted at the opposite end of the
  // spectrum from rgb(255,0,0) at 0. Step 4 covers 64^3 = 262,144 colours.
  let worst = null;
  for (let r = 0; r < 256; r += 4) {
    for (let g = 0; g < 256; g += 4) {
      for (let b = 0; b < 256; b += 4) {
        const h = CE.rgbToHsl(r, g, b)[0];
        if (!(h >= 0 && h < 360)) { worst = [r, g, b, h]; break; }
      }
    }
  }
  assert.strictEqual(worst, null, `hue out of [0,360): ${JSON.stringify(worst)}`);

  // The specific colour that used to fail.
  assert.ok(CE.rgbToHsl(215, 3, 4)[0] < 360);
});

test('OKLCH hue also stays in [0,360)', () => {
  for (let r = 0; r < 256; r += 8) {
    for (let g = 0; g < 256; g += 8) {
      for (let b = 0; b < 256; b += 8) {
        const h = CE.rgbToOklch(r, g, b)[2];
        assert.ok(h >= 0 && h < 360, `oklch hue ${h} for ${r},${g},${b}`);
      }
    }
  }
});

test('OKLab round-trips back to the same sRGB', () => {
  // Clustering averages centroids in OKLab and converts back only at the end,
  // so a lossy round trip would shift every palette colour.
  const probes = [
    [0, 0, 0], [255, 255, 255], [128, 128, 128],
    [255, 0, 0], [0, 255, 0], [0, 0, 255],
    [215, 3, 4], [17, 92, 140], [230, 210, 170]
  ];
  for (const [r, g, b] of probes) {
    const lab = CE.rgbToOklab(r, g, b);
    // oklabToRgb is not exported; go through extractPalette on a solid block,
    // which exercises exactly that path.
    const { dominant } = CE.extractPalette(block([r, g, b], 64), 1);
    assert.deepStrictEqual(
      dominant.rgb, [r, g, b],
      `round trip drifted for ${r},${g},${b} (lab ${lab.map((v) => v.toFixed(4))})`
    );
  }
});

test('a 70/30 image reports 70.0% and 30.0%', () => {
  const pixels = block([0, 0, 255], 700).concat(block([255, 0, 0], 300));
  const { palette } = CE.extractPalette(pixels, 5);

  assert.strictEqual(palette.length, 2, 'two flat colours must give two clusters');
  assert.ok(Math.abs(palette[0].dominance - 0.70) < 1e-9);
  assert.ok(Math.abs(palette[1].dominance - 0.30) < 1e-9);
  assert.deepStrictEqual(palette[0].rgb, [0, 0, 255]);
  assert.deepStrictEqual(palette[1].rgb, [255, 0, 0]);
});

test('a 50/30/20 image recovers 50.0 / 30.0 / 20.0%', () => {
  const pixels = block([255, 0, 0], 500)
    .concat(block([0, 255, 0], 300))
    .concat(block([0, 0, 255], 200));
  const { palette } = CE.extractPalette(pixels, 5);

  assert.strictEqual(palette.length, 3);
  const shares = palette.map((c) => Math.round(c.dominance * 1000) / 1000);
  assert.deepStrictEqual(shares, [0.5, 0.3, 0.2]);
});

test('dominance always sums to 1', () => {
  const pixels = block([200, 30, 40], 137)
    .concat(block([30, 90, 200], 211))
    .concat(block([240, 230, 200], 53))
    .concat(block([20, 20, 20], 99));
  const { palette } = CE.extractPalette(pixels, 5);
  const total = palette.reduce((s, c) => s + c.dominance, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `sum was ${total}`);
});

test('the same pixels give the same palette every time', () => {
  // The clustering is seeded from the pixel count so re-analysing a file does
  // not drift; a drifting palette would reorder the library on every run.
  const pixels = block([180, 40, 35], 300)
    .concat(block([230, 210, 170], 250))
    .concat(block([40, 60, 90], 450));

  const first = JSON.stringify(CE.extractPalette(pixels, 5).palette);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(JSON.stringify(CE.extractPalette(pixels, 5).palette), first);
  }
});

test('a palette never has more entries than requested', () => {
  const pixels = [];
  for (let i = 0; i < 300; i++) pixels.push([i % 256, (i * 7) % 256, (i * 13) % 256]);
  for (const k of [1, 2, 3, 5, 8, 12]) {
    assert.ok(CE.extractPalette(pixels, k).palette.length <= k);
  }
});

test('a single pixel does not break clustering', () => {
  const { dominant, palette } = CE.extractPalette([[10, 20, 30]], 5);
  assert.strictEqual(palette.length, 1);
  assert.strictEqual(dominant.dominance, 1);
});

test.describe('pickRepresentative', () => {
  // 62% grey wall behind a 22% red dress. A person calls this image red.
  const wallAndDress = [
    { hex: '#9a9a9a', rgb: [154, 154, 154], oklch: CE.rgbToOklch(154, 154, 154), hsl: CE.rgbToHsl(154, 154, 154), dominance: 0.62 },
    { hex: '#c81f23', rgb: [200, 31, 35], oklch: CE.rgbToOklch(200, 31, 35), hsl: CE.rgbToHsl(200, 31, 35), dominance: 0.22 },
    { hex: '#20242c', rgb: [32, 36, 44], oklch: CE.rgbToOklch(32, 36, 44), hsl: CE.rgbToHsl(32, 36, 44), dominance: 0.16 }
  ];

  test('balanced picks the red dress, not the grey wall', () => {
    assert.strictEqual(CE.pickRepresentative(wallAndDress, 'balanced').hex, '#c81f23');
  });

  test('dominant picks the grey wall', () => {
    assert.strictEqual(CE.pickRepresentative(wallAndDress, 'dominant').hex, '#9a9a9a');
  });

  test('balanced falls back to dominant when nothing is colourful', () => {
    const greys = [
      { hex: '#808080', rgb: [128, 128, 128], oklch: CE.rgbToOklch(128, 128, 128), hsl: CE.rgbToHsl(128, 128, 128), dominance: 0.7 },
      { hex: '#303030', rgb: [48, 48, 48], oklch: CE.rgbToOklch(48, 48, 48), hsl: CE.rgbToHsl(48, 48, 48), dominance: 0.3 }
    ];
    assert.strictEqual(CE.pickRepresentative(greys, 'balanced').hex, '#808080');
  });

  test('balanced ignores a vivid speck', () => {
    // 3% of the frame is not what the image "is".
    const speck = [
      { hex: '#9a9a9a', rgb: [154, 154, 154], oklch: CE.rgbToOklch(154, 154, 154), hsl: CE.rgbToHsl(154, 154, 154), dominance: 0.97 },
      { hex: '#ff0000', rgb: [255, 0, 0], oklch: CE.rgbToOklch(255, 0, 0), hsl: CE.rgbToHsl(255, 0, 0), dominance: 0.03 }
    ];
    assert.strictEqual(CE.pickRepresentative(speck, 'balanced').hex, '#9a9a9a');
  });

  test('average of red and green is a colour in neither', () => {
    const rg = [
      { hex: '#ff0000', rgb: [255, 0, 0], oklch: CE.rgbToOklch(255, 0, 0), hsl: CE.rgbToHsl(255, 0, 0), dominance: 0.5 },
      { hex: '#00ff00', rgb: [0, 255, 0], oklch: CE.rgbToOklch(0, 255, 0), hsl: CE.rgbToHsl(0, 255, 0), dominance: 0.5 }
    ];
    const avg = CE.pickRepresentative(rg, 'average');
    assert.deepStrictEqual(avg.rgb, [128, 128, 0]); // the muddy result, documented
  });

  test('an empty palette yields null rather than throwing', () => {
    assert.strictEqual(CE.pickRepresentative([], 'balanced'), null);
    assert.strictEqual(CE.pickRepresentative(null, 'balanced'), null);
  });
});

test('isSupported covers what the panel claims to read', () => {
  for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff',
    'psd', 'heic', 'dng', 'cr2', 'nef', 'arw']) {
    assert.ok(CE.isSupported(`/x/y.${ext}`), `${ext} should be supported`);
  }
  for (const ext of ['txt', 'pdf', 'mov', 'doc']) {
    assert.ok(!CE.isSupported(`/x/y.${ext}`), `${ext} should not be supported`);
  }
});
