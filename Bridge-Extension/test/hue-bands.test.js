/**
 * Offline tests for hue banding.
 *
 * The failure this exists to prevent is specific and was visible on a contact
 * sheet before it was understood: a boundary landing inside a dense colour
 * mass, so one block of colour ramps twice.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HueBands = require('../js/hueBands.js');

/** A cluster of `count` hues around `centre`, deterministic. */
function mass(centre, spread, count, seed) {
  let s = seed || 1;
  const rand = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(((centre + (rand() - 0.5) * spread) % 360 + 360) % 360);
  }
  return out;
}

/** How many distinct bands a set of hues is spread across. */
function bandsFor(hues, cuts) {
  return new Set(hues.map((h) => HueBands.bandOf(h, cuts))).size;
}

test('a colour mass wider than an equal arc still lands in one band', () => {
  // The measured case: golds spanning 65 degrees, which cannot fit inside a
  // 45-degree arc at any rotation. Equal arcs must split it; fitted bands
  // must not.
  const reds = mass(30, 40, 700, 2);
  const golds = mass(80, 65, 440, 3);
  const blues = mass(255, 45, 280, 4);
  const all = reds.concat(golds, blues);

  const cuts = HueBands.cuts(all, 'coarse', 8);

  assert.strictEqual(bandsFor(golds, cuts), 1,
    `golds split across ${bandsFor(golds, cuts)} bands; cuts at ${cuts.join(', ')}`);
  assert.strictEqual(bandsFor(reds, cuts), 1, 'reds split');
  assert.strictEqual(bandsFor(blues, cuts), 1, 'blues split');
});

test('equal arcs do split it — the behaviour being replaced', () => {
  const golds = mass(80, 65, 440, 3);
  const equal = [0, 45, 90, 135, 180, 225, 270, 315];
  assert.ok(bandsFor(golds, equal) > 1,
    'the fixture no longer reproduces the problem it was built for');
});

test('cuts fall between the masses, not inside them', () => {
  const all = mass(30, 40, 700, 2).concat(mass(80, 65, 440, 3), mass(255, 45, 280, 4));
  const cuts = HueBands.cuts(all, 'coarse', 8);
  const dens = HueBands.density(all);
  const peak = Math.max(...dens);

  for (const cut of cuts) {
    assert.ok(dens[cut] < peak * 0.25,
      `a cut at ${cut}deg sits at ${(dens[cut] / peak * 100).toFixed(0)}% of peak density`);
  }
});

test('finer granularity never produces fewer bands than coarser', () => {
  const all = mass(30, 40, 700, 2).concat(mass(80, 65, 440, 3), mass(255, 45, 280, 4));
  const coarse = HueBands.cuts(all, 'coarse', 8).length;
  const medium = HueBands.cuts(all, 'medium', 12).length;
  const fine = HueBands.cuts(all, 'fine', 24).length;

  assert.ok(medium >= coarse, `medium ${medium} < coarse ${coarse}`);
  assert.ok(fine >= medium, `fine ${fine} < medium ${medium}`);
});

test('two cuts never describe the same gap', () => {
  const all = mass(30, 40, 700, 2).concat(mass(80, 65, 440, 3), mass(255, 45, 280, 4));
  for (const g of ['coarse', 'medium', 'fine']) {
    const cuts = HueBands.cuts(all, g, 8);
    for (let i = 1; i < cuts.length; i++) {
      assert.ok(cuts[i] - cuts[i - 1] >= HueBands.MIN_ARC,
        `${g}: cuts at ${cuts[i - 1]} and ${cuts[i]} are closer than MIN_ARC`);
    }
  }
});

test('the wheel wraps — a mass straddling 0 degrees is not split', () => {
  // Reds sit either side of 0. Cutting at 0, as equal arcs do, halves them.
  const wrapped = mass(0, 50, 600, 9);
  const others = mass(120, 40, 300, 10).concat(mass(240, 40, 300, 11));
  const cuts = HueBands.cuts(wrapped.concat(others), 'coarse', 8);

  assert.strictEqual(bandsFor(wrapped, cuts), 1,
    `a mass straddling 0 was split; cuts at ${cuts.join(', ')}`);
});

test('every hue lands in exactly one existing band', () => {
  const all = mass(30, 40, 700, 2).concat(mass(80, 65, 440, 3), mass(255, 45, 280, 4));
  const cuts = HueBands.cuts(all, 'coarse', 8);
  for (let h = 0; h < 360; h += 0.5) {
    const b = HueBands.bandOf(h, cuts);
    assert.ok(Number.isInteger(b) && b >= 0 && b < cuts.length,
      `hue ${h} produced band ${b} with ${cuts.length} cuts`);
  }
});

test('the same input gives the same bands every time', () => {
  const all = mass(30, 40, 700, 2).concat(mass(80, 65, 440, 3), mass(255, 45, 280, 4));
  const first = HueBands.cuts(all, 'coarse', 8).join(',');
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(HueBands.cuts(all, 'coarse', 8).join(','), first);
  }
});

test.describe('degenerate input falls back to equal arcs rather than failing', () => {
  const equal8 = [0, 45, 90, 135, 180, 225, 270, 315];

  test('no hues at all', () => {
    assert.deepStrictEqual(HueBands.cuts([], 'coarse', 8), equal8);
  });

  test('fewer images than bands', () => {
    assert.deepStrictEqual(HueBands.cuts([10, 20, 30], 'coarse', 8), equal8);
  });

  test('a single-hue folder has no valleys to find', () => {
    const flat = HueBands.cuts(mass(200, 2, 400, 12), 'coarse', 8);
    // One mass and no gap between masses: any answer is arbitrary, so it must
    // at least be the predictable one.
    assert.ok(flat.length >= 2);
  });

  test('a perfectly uniform wheel', () => {
    const uniform = [];
    for (let h = 0; h < 360; h++) for (let k = 0; k < 4; k++) uniform.push(h);
    const cuts = HueBands.cuts(uniform, 'coarse', 8);
    assert.ok(cuts.length >= 2, 'must still produce usable bands');
  });
});

test('numbering starts at the band containing 0 degrees', () => {
  // The arc holding red almost always wraps through 0. Numbering the arcs in
  // cut order would give it the LAST index and put the reds at the end of the
  // library, which is a jarring change for no reason.
  const reds = mass(0, 50, 700, 21);      // straddles 0
  const golds = mass(85, 60, 440, 22);
  const blues = mass(255, 45, 280, 23);
  const cuts = HueBands.cuts(reds.concat(golds, blues), 'coarse', 8);

  assert.strictEqual(HueBands.bandOf(0, cuts), 0, 'hue 0 must be in band 0');

  const bandOfMass = (m) => {
    const counts = {};
    for (const h of m) {
      const b = HueBands.bandOf(h, cuts);
      counts[b] = (counts[b] || 0) + 1;
    }
    return Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]);
  };

  assert.strictEqual(bandOfMass(reds), 0, 'reds should open the library');
  assert.ok(bandOfMass(golds) < bandOfMass(blues),
    'golds should still precede blues going round the wheel');
});

test.describe('perceptual family bands', () => {
  const F = HueBands.FAMILY_CUTS;

  test('a colour family is one band, so it ramps once', () => {
    // The whole point: equal arcs put a boundary at 90 degrees, inside the
    // golds, and serpentine then reversed the second half — a family ramping
    // light→dark then dark→light reads as two gradients.
    const golds = mass(85, 90, 480, 31);          // tan through to yellow
    assert.strictEqual(bandsFor(golds, F), 1,
      `golds span ${bandsFor(golds, F)} family bands`);

    const equal = [0, 45, 90, 135, 180, 225, 270, 315];
    assert.ok(bandsFor(golds, equal) > 1,
      'the fixture no longer reproduces the split it was built for');
  });

  test('green, cyan and blue stay apart', () => {
    // Fitting bands to folder density lumped all three into one 152-degree
    // block ordered only by lightness, which buried greens inside the blues.
    const green = HueBands.familyOf(155);
    const cyan = HueBands.familyOf(200);
    const blue = HueBands.familyOf(260);
    assert.strictEqual(green, 'green');
    assert.strictEqual(cyan, 'cyan');
    assert.strictEqual(blue, 'blue');
  });

  test('reds open the library and wrap through 0', () => {
    assert.strictEqual(HueBands.bandOf(0, F), 0);
    assert.strictEqual(HueBands.familyOf(0), 'red');
    assert.strictEqual(HueBands.familyOf(350), 'red', 'a hue just below 360 is red');
    assert.strictEqual(HueBands.familyOf(20), 'red');
  });

  test('the families run round the wheel in spectral order', () => {
    const order = [0, 80, 155, 200, 260, 320].map((h) => HueBands.bandOf(h, F));
    assert.deepStrictEqual(order, [0, 1, 2, 3, 4, 5],
      'family bands must ascend red → gold → green → cyan → blue → magenta');
  });

  test('every family name is reachable and unique', () => {
    const seen = new Set();
    for (let h = 0; h < 360; h += 0.5) seen.add(HueBands.familyOf(h));
    assert.deepStrictEqual([...seen].sort(), [...HueBands.FAMILY_NAMES].sort());
  });

  test('the measured CSS anchors land in the family named after them', () => {
    // From Nino's HueFamily bins: the angle each CSS colour actually sits at.
    const anchors = [
      [29, 'red', 'red'], [7, 'red', 'pink'],
      [71, 'gold', 'orange'], [95, 'gold', 'gold'], [110, 'gold', 'yellow'],
      [142, 'green', 'lime'], [169, 'green', 'aquamarine'],
      [195, 'cyan', 'teal/cyan'], [232, 'cyan', 'deepskyblue'],
      [264, 'blue', 'blue'], [286, 'blue', 'slateblue'],
      [310, 'magenta', 'darkviolet'], [328, 'magenta', 'magenta']
    ];
    for (const [angle, family, css] of anchors) {
      assert.strictEqual(HueBands.familyOf(angle), family,
        `${css} at ${angle}deg should be ${family}`);
    }
  });
});

test.describe('the achromatic cutoff', () => {
  test('is defined once, and the panel reads it rather than repeating it', () => {
    // A threshold with two copies is a threshold that will drift. The prefix
    // pattern already did exactly that between the panel and the host script.
    const panel = fs.readFileSync(
      path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
    assert.ok(!/var ACHROMATIC_CHROMA = \d/.test(panel),
      'js/app.js must not define its own achromatic cutoff');
    assert.ok(/ACHROMATIC_CHROMA = HueBands\.ACHROMATIC_CHROMA/.test(panel),
      'js/app.js must read the cutoff from HueBands');
  });

  test('sits above the representative chroma floor, not at it', () => {
    // Two different questions. The representative floor asks which cluster
    // stands for an image; a muted red still represents a muted photograph.
    // This asks whether that answer is convincing enough to anchor a colour
    // family, which is a higher bar — a mauve at chroma 14 is not magenta.
    const engine = fs.readFileSync(
      path.join(__dirname, '..', 'js', 'analyzer', 'ColorEngine.js'), 'utf8');
    const floor = Number(/var MIN_CHROMA = (\d+)/.exec(engine)[1]);

    assert.ok(HueBands.ACHROMATIC_CHROMA > floor,
      `grouping cutoff ${HueBands.ACHROMATIC_CHROMA} must exceed the ` +
      `representative floor ${floor}`);
    assert.ok(HueBands.ACHROMATIC_CHROMA <= 25,
      'above about 25 this would start calling genuinely coloured images grey');
  });
});

test('bandOf with no cuts is safe', () => {
  assert.strictEqual(HueBands.bandOf(123, []), 0);
  assert.strictEqual(HueBands.bandOf(123, null), 0);
});

test('negative and out-of-range hues normalise', () => {
  const cuts = [0, 90, 180, 270];
  assert.strictEqual(HueBands.bandOf(-90, cuts), HueBands.bandOf(270, cuts));
  assert.strictEqual(HueBands.bandOf(450, cuts), HueBands.bandOf(90, cuts));
});
