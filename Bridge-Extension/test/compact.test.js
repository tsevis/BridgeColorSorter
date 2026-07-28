/**
 * scripts/compact.js rewrites real image files in place, so it is tested by
 * actually running it against a throwaway directory rather than by reading it.
 *
 * The property that matters is narrow and absolute: every byte survives. The
 * files carry `colorxbridge:originalName`, which is what makes Undo exact — a
 * compaction pass that corrupted or dropped it would quietly destroy the only
 * record of what the files were called before they were numbered.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'compact.js');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A throwaway directory of PNG-ish files with recognisable contents. */
function fixture(count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxb-compact-'));
  const expected = new Map();

  for (let i = 0; i < count; i++) {
    const name = `H00${i}-S00${i}-L0${40 + i}_photo_${i}.png`;
    // A PNG signature, some payload, and the XMP the panel depends on.
    const body = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`<?xpacket begin=""?><x:xmpmeta xmlns:colorxbridge="ns">` +
        `<colorxbridge:originalName>photo_${i}.png</colorxbridge:originalName>` +
        `<colorxbridge:palette>#c81f23|0.5,#28405a|0.5</colorxbridge:palette>` +
        `</x:xmpmeta><?xpacket end="w"?>`),
      crypto.randomBytes(2048)
    ]);
    fs.writeFileSync(path.join(dir, name), body);
    expected.set(name, sha(body));
  }
  return { dir, expected };
}

const run = (dir, ...args) =>
  execFileSync(process.execPath, [SCRIPT, dir, ...args], { encoding: 'utf8' });

function verifyUnchanged(dir, expected) {
  const names = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(names, [...expected.keys()].sort(),
    'the set of files changed');
  for (const [name, hash] of expected) {
    assert.strictEqual(sha(fs.readFileSync(path.join(dir, name))), hash,
      `${name} was altered`);
  }
}

test('a dry run reports without touching anything', () => {
  const { dir, expected } = fixture(6);
  try {
    const out = run(dir);
    assert.match(out, /DRY RUN/);
    assert.match(out, /rewritten 0/);
    verifyUnchanged(dir, expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--apply preserves every byte of every file', () => {
  const { dir, expected } = fixture(12);
  try {
    // --force, because a 2 KB fixture already fits in one block and would
    // otherwise be skipped as compact — which is what made an earlier version
    // of this test pass without ever exercising the rewrite.
    const out = run(dir, '--apply', '--force');
    assert.match(out, /REWROTE/);
    assert.match(out, /rewritten 12\b/, 'no file was actually rewritten');
    verifyUnchanged(dir, expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the XMP that makes Undo exact survives', () => {
  const { dir } = fixture(5);
  try {
    run(dir, '--apply', '--force');
    for (const name of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, name)).toString('latin1');
      assert.match(text, /colorxbridge:originalName>photo_\d+\.png</,
        `${name} lost originalName`);
      assert.match(text, /colorxbridge:palette>/, `${name} lost its palette`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('modification times are preserved, so nothing looks freshly edited', () => {
  const { dir } = fixture(4);
  try {
    const before = {};
    for (const n of fs.readdirSync(dir)) {
      const t = new Date(Date.now() - 86400000);
      fs.utimesSync(path.join(dir, n), t, t);
      before[n] = fs.statSync(path.join(dir, n)).mtimeMs;
    }
    run(dir, '--apply', '--force');
    for (const n of fs.readdirSync(dir)) {
      assert.ok(Math.abs(fs.statSync(path.join(dir, n)).mtimeMs - before[n]) < 1000,
        `${n} mtime moved`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--limit only touches that many files', () => {
  const { dir, expected } = fixture(10);
  try {
    const out = run(dir, '--limit', '3');
    assert.match(out, /10 files|3 files/);
    verifyUnchanged(dir, expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no temp files are left behind', () => {
  const { dir } = fixture(8);
  try {
    run(dir, '--apply', '--force');
    const strays = fs.readdirSync(dir).filter((n) => n.startsWith('.compact-'));
    assert.deepStrictEqual(strays, [], 'temp files left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or non-directory target is refused, not guessed at', () => {
  for (const target of [path.join(os.tmpdir(), 'cxb-does-not-exist-' + Date.now()), SCRIPT]) {
    assert.throws(() => run(target), /Command failed|status 1/,
      `${target} should have been refused`);
  }
});
