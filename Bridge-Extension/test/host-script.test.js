/**
 * Static checks on the ExtendScript host layer.
 *
 * jsx/ColorXBridge.jsx runs in Bridge's own engine, so nothing here can call
 * it — but a syntax error, a missing entry point, or a language feature
 * ExtendScript does not have all fail the same way at runtime: evalScript
 * returns the bare string "EvalScript error." and every panel button stops
 * working with no clue why. All three are detectable from the source alone.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HOST_PATH = path.join(__dirname, '..', 'jsx', 'ColorXBridge.jsx');
const HOST = fs.readFileSync(HOST_PATH, 'utf8');

test('the host script parses', () => {
  assert.doesNotThrow(() => new vm.Script(HOST, { filename: HOST_PATH }));
});

/** The host functions the panel actually invokes, read out of js/app.js. */
function entryPoints() {
  const panel = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  const found = new Set();
  const re = /evalScript\('(cxb[A-Za-z]+)\(/g;
  let m;
  while ((m = re.exec(panel)) !== null) found.add(m[1]);
  return [...found];
}

/**
 * Every match of `pattern` that sits inside a `for` or `while` body.
 *
 * Walks braces rather than pattern-matching loop bodies, so it does not care
 * how the source is formatted. Loops are tracked by the brace depth at which
 * their body opened; a match counts when any such depth is still on the stack.
 */
function findInsideLoops(code, pattern) {
  const loopHeader = /\b(for|while)\s*\(/g;
  const loopAt = new Set();
  let m;

  // Record the index of the `{` that opens each loop body.
  while ((m = loopHeader.exec(code)) !== null) {
    let i = m.index + m[0].length;
    let parens = 1;
    while (i < code.length && parens > 0) {
      if (code[i] === '(') parens++;
      else if (code[i] === ')') parens--;
      i++;
    }
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] === '{') loopAt.add(i);
  }

  const openLoops = [];
  const hits = [];
  let depth = 0;
  let next = 0;
  const matches = [...code.matchAll(pattern)].map((x) => x.index);

  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') {
      depth++;
      if (loopAt.has(i)) openLoops.push(depth);
    } else if (code[i] === '}') {
      if (openLoops.length && openLoops[openLoops.length - 1] === depth) openLoops.pop();
      depth--;
    }
    while (next < matches.length && matches[next] === i) {
      if (openLoops.length) {
        hits.push({
          line: code.slice(0, i).split('\n').length,
          text: code.slice(i, code.indexOf('\n', i) === -1 ? undefined : code.indexOf('\n', i)).trim()
        });
      }
      next++;
    }
  }
  return hits;
}

/** Source text of one top-level function, from `function name(` to its close. */
function bodyOf(name) {
  const start = HOST.indexOf(`\nfunction ${name}(`);
  if (start === -1) return null;
  const end = HOST.indexOf('\n}', start);
  return end === -1 ? HOST.slice(start) : HOST.slice(start, end + 2);
}

test('every entry point the panel calls exists', () => {
  // The panel reaches Bridge only through these names. A rename on one side
  // is invisible until a button is pressed.
  const called = entryPoints();
  assert.ok(called.length > 0, 'no evalScript calls found — has the panel changed shape?');

  for (const fn of called) {
    assert.ok(bodyOf(fn),
      `js/app.js calls ${fn}() but jsx/ColorXBridge.jsx does not define it`);
  }
});

test('every entry point replies with JSON, and cannot throw past the panel', () => {
  // The panel JSON.parses whatever comes back and reports "Bad reply from
  // Bridge" otherwise, so an entry point that returns a bare value — or lets
  // an exception escape — is a dead button with a useless message.
  for (const fn of entryPoints()) {
    const body = bodyOf(fn);
    assert.ok(/return cxbJSON\(/.test(body),
      `${fn}() must return cxbJSON(...) so the panel can parse the reply`);
    assert.ok(/catch \([^)]*\) \{[\s\S]*?return cxbErr\(/.test(body),
      `${fn}() must catch and return cxbErr(...) rather than let a throw escape`);
  }
});

test.describe('ExtendScript cannot run these, so they must not appear', () => {
  // ExtendScript is ES3 with a few extras. Anything below parses fine in Node
  // and throws inside Bridge, which is the worst possible failure mode.
  const banned = [
    [/=>/, 'arrow functions'],
    [/\bconst\s+\w/, 'const'],
    [/\blet\s+\w/, 'let'],
    [/`[^`]*`/, 'template literals'],
    [/\.\.\./, 'spread or rest'],
    [/\bJSON\.(parse|stringify)\b/, 'the JSON object (ExtendScript has none)'],
    [/\bObject\.keys\b/, 'Object.keys'],
    [/\bArray\.isArray\b/, 'Array.isArray'],
    [/\.forEach\s*\(/, 'Array#forEach'],
    [/\.indexOf\s*\(\s*\w+\s*,/, 'Array#indexOf with a fromIndex'],
    [/\bPromise\b/, 'Promise'],
    [/\basync\s+function\b/, 'async functions']
  ];

  // Strip comments first: the file explains several of these in prose.
  const code = HOST
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  for (const [pattern, what] of banned) {
    test(what, () => {
      const hit = pattern.exec(code);
      assert.strictEqual(hit, null,
        `${what} found in the host script: ${hit && hit[0]}`);
    });
  }
});

test('the two XMP mistakes that broke this project cannot come back', () => {
  const code = HOST.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Fault 4: XMPConst.UNKNOWN does not exist; the real one is FILE_UNKNOWN.
  assert.ok(!/XMPConst\.UNKNOWN\b/.test(code),
    'XMPConst.UNKNOWN does not exist — use XMPConst.FILE_UNKNOWN');

  // Fault 5: appendArrayItem takes arrayOptions LAST.
  //   (schemaNS, arrayName, itemValue, itemOptions, arrayOptions)
  const calls = code.match(/appendArrayItem\([^)]*\)/g) || [];
  assert.ok(calls.length > 0, 'no appendArrayItem call found — has keyword writing moved?');
  for (const call of calls) {
    assert.ok(/,\s*XMPConst\.ARRAY_IS_\w+\s*\)$/.test(call),
      `arrayOptions must be the last argument: ${call}`);
  }
});

test('no Thumbnail is constructed inside a loop', () => {
  // This is the measured cause of the crash at 1,559 files, and it is not the
  // one the code originally blamed. Driving app.document.select() 1,559 times
  // over the folder's existing child thumbnails takes 3.6 s and Bridge is
  // fine. Constructing `new Thumbnail(new File(path))` per file is what kills
  // it, because each construction makes Bridge build a whole thumbnail record.
  //
  // So the rule is about construction, not about selection: index the
  // document's own children and reuse them.
  const code = HOST.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Brace-matched rather than regex-matched. A pattern that assumed the
  // closing brace sat on its own line silently missed a single-line
  // `for (...) { new Thumbnail(...) }` — a guard that only catches tidily
  // formatted mistakes is not a guard.
  const inLoop = findInsideLoops(code, /new Thumbnail\s*\(/g);
  assert.deepStrictEqual(inLoop, [],
    'a Thumbnail is constructed inside a loop — this is what crashed Bridge:\n' +
    inLoop.map((h) => '  line ' + h.line + ': ' + h.text).join('\n'));

  // [\s\S]*? rather than [^)]*: the argument is normally `new File(p)`, which
  // contains its own parenthesis and defeated the simpler pattern.
  assert.ok(!/new Thumbnail\([\s\S]*?\)\s*\.\s*refresh\s*\(/.test(code),
    'per-file Thumbnail refresh is back — it crashes Bridge at scale');
});

test('nothing relies on assigning app.document.selections', () => {
  // Measured: `app.document.selections = [...]` is a silent no-op in Bridge
  // 2026. It does not throw and it does not select, so any code that assigns
  // it and reports success reports a success that never happened — which is
  // exactly what shipped in 96fab3f.
  const code = HOST.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const assignment = /app\.document\.selections\s*=/.exec(code);
  assert.strictEqual(assignment, null,
    'app.document.selections cannot be assigned — Bridge ignores it silently. ' +
    'Use app.document.select() over the folder\'s existing children.');
});

test('a selection result is verified against Bridge, not assumed', () => {
  // Bridge settles app.document.selections lazily, so the check cannot happen
  // inside cxbSelectFiles — measured: 1,559 files selected fine but the same
  // call still read 0. The panel polls cxbSelectionCount() instead, and must
  // report that number rather than the number it asked for.
  const select = bodyOf('cxbSelectFiles');
  assert.ok(select, 'cxbSelectFiles is missing');
  assert.ok(!/app\.document\.selections\.length/.test(select),
    'cxbSelectFiles must not read the selection back inline — Bridge has not ' +
    'settled it yet, so the answer is a false negative');

  assert.ok(bodyOf('cxbSelectionCount'),
    'cxbSelectionCount is missing — the panel needs it to verify the selection');

  const panel = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  assert.ok(/cxbSelectionCount\(\)/.test(panel),
    'js/app.js must poll cxbSelectionCount() after selecting');
  assert.ok(/Selected ' \+ count \+ ' in Bridge/.test(panel),
    'the status must report the count Bridge confirms, not the count requested');
});
