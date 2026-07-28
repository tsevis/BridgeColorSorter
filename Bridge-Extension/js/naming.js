/**
 * Filename prefixing: the one mechanism that can carry an arbitrary colour
 * order into Bridge's own grid.
 *
 * Split out of app.js so it can be tested offline. The host script
 * (jsx/BridgeColorShorter.jsx) runs in a separate ExtendScript engine and cannot
 * load this file, so it keeps its own copy of PREFIX_SOURCE — and
 * test/naming.test.js asserts the two are character-for-character identical.
 * They failed to stay in sync once already: the panel widened the sequence
 * field to P0000 and the host's fixed-width \d{3} silently stopped matching,
 * which would have stacked a second prefix on the next run.
 */
(function (global) {
  'use strict';

  /**
   * Any prefix this panel has ever written.
   *
   * \d{3,} rather than \d{3}: the similarity mode writes a wider sequence
   * field (P0042), and a fixed width fails to strip it.
   * The trailing \d{4,}_ alternative matches the numbering scheme used before
   * the fields were labelled.
   */
  var PREFIX_SOURCE = '^(?:[A-Z]\\d{3,}(?:-[A-Z]\\d{3,})*_|\\d{4,}_)';
  var PREFIX_RE = new RegExp(PREFIX_SOURCE);

  /** Remove a BridgeColorShorter prefix, leaving the user's own filename. */
  function stripPrefix(name) {
    return String(name).replace(PREFIX_RE, '');
  }

  /** Zero-pad a number to a fixed field width, so it sorts alphabetically. */
  function pad(n, width) {
    var s = String(Math.max(0, Math.round(n)));
    while (s.length < width) s = '0' + s;
    return s;
  }

  /** Last path component, for both separators. */
  function baseName(p) {
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1];
  }

  var api = {
    PREFIX_SOURCE: PREFIX_SOURCE,
    PREFIX_RE: PREFIX_RE,
    stripPrefix: stripPrefix,
    pad: pad,
    baseName: baseName
  };

  global.Naming = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
