/**
 * Offline tests for whole-palette similarity ordering.
 *
 * The three failures the README documents — dark reds among dark yellows,
 * lightness jumping inside a colour group, blues at both ends of the library —
 * are all structural, and all three are checkable without looking at pixels:
 * each colour family must come out as one contiguous block, the blocks must
 * run round the hue wheel, and neutrals must land at the end.
 *
 * Ordering quality beyond that is judged by eye on a contact sheet, not here.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const CE = require('../js/analyzer/ColorEngine.js');   // sets globalThis.ColorEngine
const Similarity = require('../js/similarity.js');

function colour(rgb, dominance) {
  return {
    hex: CE.rgbToHex(rgb[0], rgb[1], rgb[2]),
    rgb,
    hsl: CE.rgbToHsl(rgb[0], rgb[1], rgb[2]),
    oklch: CE.rgbToOklch(rgb[0], rgb[1], rgb[2]),
    dominance
  };
}

/** Deterministic jitter, so the fixtures are stable across runs. */
function makeRand(seed) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

/**
 * A library of synthetic images: several per colour family, each a two-colour
 * palette of that family at a range of lightnesses, plus a neutral family.
 */
function buildLibrary(perFamily) {
  const families = [
    { name: 'red', hue: 0 },
    { name: 'yellow', hue: 60 },
    { name: 'green', hue: 120 },
    { name: 'cyan', hue: 180 },
    { name: 'blue', hue: 240 },
    { name: 'magenta', hue: 300 }
  ];
  const rand = makeRand(7);
  const records = [];

  for (const f of families) {
    for (let i = 0; i < perFamily; i++) {
      // Walk lightness across the family so each block has a real ramp.
      const t = i / (perFamily - 1);
      const light = 0.25 + t * 0.6;
      const rgb = hsvToRgb(f.hue + (rand() - 0.5) * 14, 0.85, light);
      const rgb2 = hsvToRgb(f.hue + (rand() - 0.5) * 14, 0.55, light * 0.8);
      records.push({
        key: `${f.name}-${i}`,
        family: f.name,
        palette: [colour(rgb, 0.7), colour(rgb2, 0.3)]
      });
    }
  }

  // Neutrals: no meaningful hue at all.
  for (let i = 0; i < perFamily; i++) {
    const v = Math.round(20 + (i / (perFamily - 1)) * 210);
    records.push({
      key: `neutral-${i}`,
      family: 'neutral',
      palette: [colour([v, v, v], 0.8), colour([v, v, v], 0.2)]
    });
  }
  return records;
}

function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((u) => Math.round((u + m) * 255));
}

/** Positions of each family in the output, in order. */
function familyRuns(records, order) {
  const byKey = new Map(records.map((r) => [r.key, r.family]));
  const runs = [];
  for (const key of order) {
    const fam = byKey.get(key);
    if (runs.length === 0 || runs[runs.length - 1] !== fam) runs.push(fam);
  }
  return runs;
}

test('the order is a permutation — nothing lost, nothing duplicated', () => {
  const records = buildLibrary(10);
  const order = Similarity.orderByClusters(records, { maxColours: 5, groups: 8 });

  assert.strictEqual(order.length, records.length, 'wrong number of files came back');
  assert.deepStrictEqual(
    [...order].sort(),
    records.map((r) => r.key).sort(),
    'the set of files changed'
  );
});

// Grouping is a budget, not a promise about these particular fixtures: with
// fewer clusters than colour families, k-medoids correctly merges the two
// nearest, and a block holding two hues interleaves them along its lightness
// ramp by design. The fixture hues are 60° apart in HSV but not in OKLCH —
// yellow lands at h 110 and green at h 143, only 33° apart, while red→yellow
// is 83° — so the families only separate when the budget allows it. GROUPS is
// therefore set above the family count wherever a test names families.
const GROUPS = 12;

test('each colour family comes out as one contiguous block', () => {
  // "Blues appearing at both ends of the library" was a nearest-neighbour
  // chain problem: locally sensible, globally wrong. A family appearing twice
  // in the run list means it has been split again.
  const records = buildLibrary(10);
  const order = Similarity.orderByClusters(records, { maxColours: 5, groups: GROUPS });

  const runs = familyRuns(records, order);
  const seen = new Set();
  const repeated = runs.filter((f) => (seen.has(f) ? true : (seen.add(f), false)));

  assert.deepStrictEqual(repeated, [], `families split across the order: ${runs.join(' → ')}`);
});

test('neutrals land at the end, not scattered through the reds', () => {
  const records = buildLibrary(10);
  const order = Similarity.orderByClusters(records, { maxColours: 5, groups: GROUPS });
  const runs = familyRuns(records, order);

  assert.strictEqual(runs[runs.length - 1], 'neutral',
    `neutrals should be last; order was ${runs.join(' → ')}`);
});

test('blocks run round the hue wheel rather than by nearest neighbour', () => {
  const records = buildLibrary(10);
  const order = Similarity.orderByClusters(records, { maxColours: 5, groups: GROUPS });
  const runs = familyRuns(records, order).filter((f) => f !== 'neutral');

  // The wheel is a cycle, so any rotation is correct — but the sequence must
  // be a rotation of the wheel, in one direction or the other.
  const wheel = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'];
  const rotations = [];
  for (let i = 0; i < wheel.length; i++) {
    const fwd = wheel.slice(i).concat(wheel.slice(0, i));
    rotations.push(fwd.join(','), [...fwd].reverse().join(','));
  }
  assert.ok(rotations.includes(runs.join(',')),
    `not a hue-wheel order: ${runs.join(' → ')}`);
});

test('clusters are hue-coherent, so dark reds do not join dark yellows', () => {
  // Clustering used to run on the full OKLab palette. OKLab compresses a and b
  // as lightness falls, so a dark red and a dark yellow read as close and
  // merged; a dark red and a bright red read as far apart and split. The
  // lightness-free descriptor fixed both, and this is the direct check:
  // every member of a cluster must sit near that cluster's mean hue, and each
  // family must be wholly inside one cluster despite spanning the lightness
  // range.
  const records = buildLibrary(10);

  const hueOf = (rec) => {
    const c = rec.palette[0];
    return CE.rgbToOklch(c.rgb[0], c.rgb[1], c.rgb[2]);
  };

  const order = Similarity.orderByClusters(records, { maxColours: 5, groups: GROUPS });
  const byKey = new Map(records.map((r) => [r.key, r]));

  // Walk the output; within each family run, hues must stay tight even though
  // lightness sweeps from 0.25 to 0.85.
  let run = [];
  let lastFamily = null;
  const checkRun = () => {
    if (lastFamily === 'neutral' || run.length < 2) return;
    const hues = run.map((k) => hueOf(byKey.get(k))[2]);
    const spread = Math.max(...hues) - Math.min(...hues);
    assert.ok(spread < 40,
      `${lastFamily} spans ${spread}° of hue in one block: ${hues.join(',')}`);
  };
  for (const key of order) {
    const fam = byKey.get(key).family;
    if (fam !== lastFamily) { checkRun(); run = []; lastFamily = fam; }
    run.push(key);
  }
  checkRun();
});

test('lightness reverses direction about once per block, not constantly', () => {
  // "Lightness jumping about inside a colour group" came from running a
  // similarity path within each block: it optimises colour closeness, which
  // does not move in step with lightness. A strict ramp per block means the
  // direction can only turn at a block boundary, so the number of reversals
  // is bounded by the number of blocks — whereas a similarity path reverses
  // on nearly every step.
  const records = buildLibrary(10);
  const order = Similarity.orderByClusters(records, { maxColours: 5, groups: GROUPS });

  const byKey = new Map(records.map((r) => [r.key, r]));
  const lightnessOf = (key) => {
    const p = byKey.get(key).palette;
    let sum = 0, w = 0;
    for (const c of p) { sum += CE.rgbToOklab(c.rgb[0], c.rgb[1], c.rgb[2])[0] * c.dominance; w += c.dominance; }
    return sum / w;
  };

  const ls = order.map(lightnessOf);
  let reversals = 0;
  let dir = 0;
  for (let i = 1; i < ls.length; i++) {
    const step = Math.sign(ls[i] - ls[i - 1]);
    if (step === 0) continue;
    if (dir !== 0 && step !== dir) reversals++;
    dir = step;
  }

  assert.ok(reversals <= GROUPS,
    `lightness reversed ${reversals} times across ${ls.length} images ` +
    `with at most ${GROUPS} blocks — the ramp is not holding`);
});

test('the same input gives the same order every time', () => {
  const records = buildLibrary(8);
  const first = Similarity.orderByClusters(records, { maxColours: 5, groups: 6 }).join(',');
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(
      Similarity.orderByClusters(records, { maxColours: 5, groups: 6 }).join(','),
      first
    );
  }
});

test('fewer than three images is returned unchanged rather than crashing', () => {
  for (const n of [0, 1, 2]) {
    const records = buildLibrary(10).slice(0, n);
    const order = Similarity.orderByClusters(records, { maxColours: 5, groups: 8 });
    assert.deepStrictEqual(order, records.map((r) => r.key));
  }
});

test('asking for more groups than images does not lose any', () => {
  const records = buildLibrary(3);           // 21 records
  const order = Similarity.orderByClusters(records, { maxColours: 5, groups: 200 });
  assert.deepStrictEqual([...order].sort(), records.map((r) => r.key).sort());
});

test('an empty palette does not take the whole order down', () => {
  const records = buildLibrary(6);
  records[3].palette = [];
  records[10].palette = [];
  const order = Similarity.orderByClusters(records, { maxColours: 5, groups: 6 });
  assert.deepStrictEqual([...order].sort(), records.map((r) => r.key).sort());
});

test('palette distance is a metric where it matters', () => {
  const red = Similarity.pack({ palette: [colour([255, 0, 0], 1)] }, 5);
  const red2 = Similarity.pack({ palette: [colour([250, 8, 6], 1)] }, 5);
  const blue = Similarity.pack({ palette: [colour([0, 0, 255], 1)] }, 5);

  assert.ok(Math.abs(Similarity.distance(red, red)) < 1e-12, 'distance to self must be 0');
  assert.ok(Math.abs(Similarity.distance(red, blue) - Similarity.distance(blue, red)) < 1e-12,
    'distance must be symmetric');
  assert.ok(Similarity.distance(red, red2) < Similarity.distance(red, blue),
    'two reds must be closer than a red and a blue');
});
