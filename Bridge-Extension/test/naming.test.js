/**
 * Offline tests for filename prefixing.
 *
 * Renaming is the only reversible-but-destructive thing this panel does, so
 * the round trip has to be exact. The prefix regex is duplicated between the
 * panel and the ExtendScript host — they run in different engines and cannot
 * share a file — and they have already drifted apart once.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Naming = require('../js/naming.js');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const HOST = read('jsx', 'BridgeColorSorter.jsx');
const PANEL = read('js', 'naming.js');

test('the host script and the panel use the identical prefix pattern', () => {
  // The regression this guards: the panel widened its sequence field to P0042
  // while the host kept a fixed-width \d{3}, so the host silently stopped
  // stripping and the next run would have stacked a second prefix.
  //
  // Both literals are compared as they appear in source. Comparing the host's
  // source text against the panel's *runtime* value would fail on backslash
  // escaping alone and say nothing about whether the patterns agree.
  const host = /var CXB_PREFIX_SOURCE = '([^']*)';/.exec(HOST);
  const panel = /var PREFIX_SOURCE = '([^']*)';/.exec(PANEL);

  assert.ok(host, 'CXB_PREFIX_SOURCE not found in jsx/BridgeColorSorter.jsx');
  assert.ok(panel, 'PREFIX_SOURCE not found in js/naming.js');
  assert.strictEqual(host[1], panel[1],
    'jsx/BridgeColorSorter.jsx and js/naming.js disagree about the prefix pattern');

  // And the panel's literal really is what it compiles at runtime, so the
  // comparison above is about live behaviour rather than two stale strings.
  // The captured text is still an escaped JS string literal — \\d in source is
  // \d at runtime — so unescape it before comparing against the live regex.
  const unescaped = JSON.parse(`"${panel[1]}"`);
  assert.strictEqual(unescaped, Naming.PREFIX_SOURCE);
  assert.strictEqual(new RegExp(unescaped).source, Naming.PREFIX_RE.source);
});

test('the host script builds its regex from that constant', () => {
  // A literal /.../ alongside the constant would pass the test above while
  // the code still used the stale pattern.
  assert.ok(/var CXB_PREFIX_RE = new RegExp\(CXB_PREFIX_SOURCE\);/.test(HOST),
    'the host must compile CXB_PREFIX_RE from CXB_PREFIX_SOURCE');
});

test.describe('stripPrefix', () => {
  const cases = [
    // [ prefixed name, original ]
    ['H002-L059_photo.jpg', 'photo.jpg'],
    ['Z013-L013_photo.jpg', 'photo.jpg'],
    ['H003-S000-L070_photo.jpg', 'photo.jpg'],
    ['P0042-H028-L059_photo.jpg', 'photo.jpg'],   // wide similarity field
    ['P0000-H000-L000_a.png', 'a.png'],
    ['0042_legacy.jpg', 'legacy.jpg'],            // the old numbering scheme
    ['H000-S000-L012_Chinese_0438.png', 'Chinese_0438.png']
  ];

  for (const [prefixed, original] of cases) {
    test(`${prefixed} → ${original}`, () => {
      assert.strictEqual(Naming.stripPrefix(prefixed), original);
    });
  }
});

test.describe('stripPrefix leaves innocent filenames alone', () => {
  const untouched = [
    'photo.jpg',
    'IMG_2043.jpg',
    'Chinese_0438.png',
    'DSC00123.jpg',
    '2024-06-01 shoot.tif',
    'A_photo.jpg',          // one letter, no digits
    'H2_photo.jpg',         // too few digits for a field
    'H02_photo.jpg',        // still too few
    'my-H002-file.jpg'      // a field, but not at the start
  ];

  for (const name of untouched) {
    test(name, () => assert.strictEqual(Naming.stripPrefix(name), name));
  }
});

test('a prefix is never applied twice', () => {
  // Re-running the numbering must replace the prefix, not stack another on.
  let name = 'photo.jpg';
  for (let run = 0; run < 5; run++) {
    name = `H00${run}-S001-L0${40 + run}_` + Naming.stripPrefix(name);
  }
  assert.strictEqual(Naming.stripPrefix(name), 'photo.jpg');
  assert.strictEqual((name.match(/_/g) || []).length, 1,
    `prefixes stacked: ${name}`);
});

test('switching between criteria and similarity mode still strips cleanly', () => {
  // The two modes emit different field widths, and a run of one over the
  // other is the normal case.
  const criteria = 'H002-S007-L059_photo.jpg';
  const similarity = 'P0042-H028-L059_' + Naming.stripPrefix(criteria);
  assert.strictEqual(Naming.stripPrefix(similarity), 'photo.jpg');

  const backAgain = 'H004-S000-L022_' + Naming.stripPrefix(similarity);
  assert.strictEqual(Naming.stripPrefix(backAgain), 'photo.jpg');
});

test.describe('pad', () => {
  test('pads to the field width', () => {
    assert.strictEqual(Naming.pad(7, 3), '007');
    assert.strictEqual(Naming.pad(42, 3), '042');
    assert.strictEqual(Naming.pad(359, 3), '359');
    assert.strictEqual(Naming.pad(42, 4), '0042');
  });

  test('never emits a negative, which would break alphabetical order', () => {
    assert.strictEqual(Naming.pad(-5, 3), '000');
  });

  test('rounds rather than truncating', () => {
    assert.strictEqual(Naming.pad(58.6, 3), '059');
  });

  test('a value wider than the field is not truncated', () => {
    // Better a misaligned field than a silently wrong sort key.
    assert.strictEqual(Naming.pad(1234, 3), '1234');
  });

  test('padded values sort in numeric order as strings', () => {
    const nums = [0, 1, 9, 10, 42, 99, 100, 359];
    const padded = nums.map((n) => Naming.pad(n, 3));
    assert.deepStrictEqual([...padded].sort(), padded);
  });
});

test('baseName handles both separators', () => {
  assert.strictEqual(Naming.baseName('/a/b/c.jpg'), 'c.jpg');
  assert.strictEqual(Naming.baseName('C:\\a\\b\\c.jpg'), 'c.jpg');
  assert.strictEqual(Naming.baseName('c.jpg'), 'c.jpg');
});
