/**
 * The compact palette form stored in XMP, and how to read it back.
 *
 * Analysis dominates the runtime, and the answer is already embedded in each
 * file from the previous run — so this parser is what turns a several-minute
 * re-analysis into a few seconds. It is also the only thing standing between
 * a malformed string and a silently wrong color order, which is why it lives
 * in its own file with its own tests.
 *
 * Format: comma-separated "#rrggbb|dominance" pairs, most dominant first.
 *   "#c81f23|0.42,#e6d2aa|0.31,#28405a|0.27"
 */
(function (global) {
  'use strict';

  var ENTRY_RE = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

  /** Serialise a palette. Kept here so both directions share one format. */
  function format(palette, maxEntries) {
    var limit = maxEntries || 12;
    var parts = [];
    for (var i = 0; i < palette.length && i < limit; i++) {
      parts.push(palette[i].hex + '|' +
        Math.round(palette[i].dominance * 1000) / 1000);
    }
    return parts.join(',');
  }

  /**
   * Parse a stored palette string.
   *
   * Entries that do not parse are dropped rather than guessed at: a wrong
   * color would sort the file into the wrong place with no visible sign.
   *
   * @param {string} text
   * @returns {Array<{hex: string, rgb: number[], dominance: number}>} possibly empty
   */
  function parse(text) {
    var out = [];
    var parts = String(text === null || text === undefined ? '' : text).split(',');

    for (var i = 0; i < parts.length; i++) {
      var bits = parts[i].split('|');
      if (bits.length !== 2) continue;

      var m = ENTRY_RE.exec(bits[0].trim());
      if (!m) continue;

      var dominance = parseFloat(bits[1]);
      if (!isFinite(dominance) || dominance < 0) continue;

      out.push({
        hex: '#' + (m[1] + m[2] + m[3]).toLowerCase(),
        rgb: [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)],
        dominance: dominance
      });
    }
    return out;
  }

  var api = { parse: parse, format: format };

  global.StoredPalette = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
