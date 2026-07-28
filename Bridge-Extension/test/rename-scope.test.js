/**
 * The rename paths must never touch a folder the user is not looking at.
 *
 * Results accumulate across runs, which is right for the list and catastrophic
 * for anything that renames. Before this was fixed, analysing one folder,
 * navigating to another and pressing "Undo rename" renamed files in BOTH — it
 * read `Object.keys(state.results)`, the whole session's history. It was
 * caught by a test harness doing exactly that to a real 1,559-image folder.
 *
 * These are static checks on js/app.js. The behaviour itself lives inside an
 * IIFE with no seam to call, and the property that matters is structural: the
 * destructive paths must go through the folder scope, and must not read the
 * accumulated set directly.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PANEL = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

/** Source of one top-level function inside the panel IIFE. */
function bodyOf(name) {
  const start = PANEL.indexOf(`\n  function ${name}(`);
  if (start === -1) return null;
  const end = PANEL.indexOf('\n  }', start);
  return end === -1 ? PANEL.slice(start) : PANEL.slice(start, end + 4);
}

test('the folder scope helper exists', () => {
  const scope = bodyOf('scopeToCurrentFolder');
  assert.ok(scope, 'scopeToCurrentFolder is missing');
  assert.ok(/cxbGetFolderImages\(\)/.test(scope),
    'the scope must come from Bridge, not from panel state');
});

test.describe('every destructive path is scoped to the open folder', () => {
  for (const fn of ['renameForBridge', 'undoRename']) {
    test(fn, () => {
      const body = bodyOf(fn);
      assert.ok(body, `${fn} is missing`);
      assert.ok(/scopeToCurrentFolder\(/.test(body),
        `${fn} must narrow to the folder Bridge is showing before renaming`);
    });
  }
});

test('undo does not read the whole accumulated result set into the payload', () => {
  // The exact shape of the bug: Object.keys(state.results) handed straight to
  // the host script.
  const body = bodyOf('undoRename');
  assert.ok(!/writeTempJson\([^)]*Object\.keys\(state\.results\)/.test(body),
    'undoRename must not send every accumulated result to be renamed');
});

test('the confirmation names the folder, so the scope is visible', () => {
  // "Restore the original filenames for 1959 file(s)?" was technically true
  // and told the user nothing about which folders those were in.
  for (const fn of ['renameForBridge', 'undoRename']) {
    const body = bodyOf(fn);
    assert.ok(/window\.confirm\(/.test(body), `${fn} must confirm first`);
    assert.ok(/scope\.folder/.test(body),
      `${fn}'s confirmation must name the folder it is about to change`);
  }
});

test('results outside the folder are reported, not silently dropped', () => {
  assert.ok(bodyOf('otherFolderNote'),
    'otherFolderNote is missing — excluding files silently is its own bug');
  for (const fn of ['renameForBridge', 'undoRename']) {
    assert.ok(/otherFolderNote\(scope\)/.test(bodyOf(fn)),
      `${fn} must say how many analysed files it is leaving alone`);
  }
});
