#!/usr/bin/env node
/**
 * Reclaim disk space lost to block slack after repeated XMP writes.
 *
 *   node scripts/compact.js <dir>            report only, changes nothing
 *   node scripts/compact.js <dir> --apply    rewrite files that have slack
 *   node scripts/compact.js <dir> --limit 5 --apply
 *   node scripts/compact.js <dir> --apply --force   rewrite regardless
 *
 * Writing XMP closes the file with CLOSE_UPDATE_SAFELY, which rewrites it
 * rather than editing in place. Do that a few times over a folder and the
 * files end up occupying noticeably more disk blocks than they contain:
 * measured on a 1,559-image folder, 3.17 GB of content sat in 3.92 GB of
 * allocation — 31% slack, 0.75 GB of it. Nothing is wrong with the files; a
 * plain `cp` of one allocates exactly its size, which is what this does.
 *
 * **Content is never altered.** Every byte is preserved, including the
 * embedded XMP, so `colorxbridge:originalName` survives and Undo stays exact.
 * Only the blocks underneath change.
 *
 * Safety, in order:
 *   1. read the original and hash it
 *   2. write a temp file in the SAME directory — same filesystem, so the
 *      rename below is atomic
 *   3. re-read the temp file and hash it; a copy that does not match byte for
 *      byte is abandoned and the original left untouched
 *   4. restore mtime/atime, so nothing looks freshly edited
 *   5. rename the temp over the original
 *
 * The rename is the only destructive step and it is atomic, so an interruption
 * at any point leaves either the intact original or a complete replacement —
 * never a truncated file, and never no file at all.
 *
 * Close Bridge, or at least navigate away from the folder, before running with
 * --apply: it has its own view of these files.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = process.argv[2];
const apply = process.argv.includes('--apply');
/** Rewrite even files that have no slack to reclaim. */
const force = process.argv.includes('--force');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg === -1 ? Infinity : Number(process.argv[limitArg + 1]);

if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error('usage: node scripts/compact.js <dir> [--limit N] [--apply]');
  console.error('       reports only; --apply rewrites the files in place');
  process.exit(1);
}

// Windows does not report allocated blocks, so every figure below would be NaN
// and every file would look like it needed rewriting. Refuse rather than
// silently rewrite a whole folder on a measurement that does not exist.
if (typeof fs.statSync(dir).blocks !== 'number') {
  console.error('This platform does not report allocated blocks, so there is ' +
    'no way to tell\nwhich files have slack. Not supported here.');
  process.exit(1);
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** Allocated bytes, from 512-byte blocks. */
const allocated = (p) => fs.statSync(p).blocks * 512;

const files = fs.readdirSync(dir)
  .filter((n) => /\.(png|jpe?g|tiff?|gif|webp)$/i.test(n))
  .slice(0, limit);

let before = 0;
let after = 0;
let apparent = 0;
let rewritten = 0;
let skipped = 0;
const failures = [];

for (const name of files) {
  const full = path.join(dir, name);
  let stat;
  try { stat = fs.statSync(full); } catch (e) { failures.push([name, e.message]); continue; }

  const alloc = stat.blocks * 512;
  before += alloc;
  apparent += stat.size;

  // Nothing to gain if it already fits in its own blocks.
  if (!force && alloc <= Math.ceil(stat.size / 4096) * 4096) {
    after += alloc;
    skipped++;
    continue;
  }

  if (!apply) { after += Math.ceil(stat.size / 4096) * 4096; continue; }

  const tmp = path.join(dir, '.compact-' + process.pid + '-' + name);
  try {
    const original = fs.readFileSync(full);
    const want = sha(original);

    fs.writeFileSync(tmp, original);

    const check = fs.readFileSync(tmp);
    if (check.length !== original.length || sha(check) !== want) {
      fs.unlinkSync(tmp);
      failures.push([name, 'copy did not match — left untouched']);
      after += alloc;
      continue;
    }

    fs.utimesSync(tmp, stat.atime, stat.mtime);
    fs.renameSync(tmp, full);          // atomic within the directory

    after += allocated(full);
    rewritten++;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
    failures.push([name, e.message]);
    after += alloc;
  }
}

const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
console.log(`${apply ? 'REWROTE' : 'DRY RUN'} — ${files.length} files in ${dir}`);
console.log(`  content (apparent) : ${gb(apparent)}`);
console.log(`  allocated before   : ${gb(before)}`);
console.log(`  allocated ${apply ? 'after   ' : 'if applied'} : ${gb(after)}`);
console.log(`  reclaimed          : ${gb(before - after)}`);
console.log(`  rewritten ${rewritten}, already compact ${skipped}, failed ${failures.length}`);
failures.slice(0, 10).forEach(([n, e]) => console.log(`    ${n}: ${e}`));
