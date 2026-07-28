/**
 * Maps a color to a human-readable family name.
 *
 * The name is stored in XMP and used for the panel's color buckets, so it
 * needs to be stable and coarse rather than poetic.
 */
(function (global) {
  'use strict';

  var HUES = [
    { name: 'Red', to: 15 },
    { name: 'Orange', to: 45 },
    { name: 'Yellow', to: 70 },
    { name: 'Green', to: 160 },
    { name: 'Cyan', to: 195 },
    { name: 'Blue', to: 255 },
    { name: 'Purple', to: 290 },
    { name: 'Magenta', to: 330 },
    { name: 'Red', to: 361 }
  ];

  /**
   * @param {[number, number, number]} hsl H 0-360, S 0-100, L 0-100
   * @returns {string}
   */
  function nameFor(hsl) {
    var h = ((hsl[0] % 360) + 360) % 360;
    var s = hsl[1];
    var l = hsl[2];

    if (l <= 8) return 'Black';
    if (l >= 94 && s <= 12) return 'White';
    if (s <= 10) return l < 45 ? 'Dark Grey' : 'Light Grey';

    var base = 'Red';
    for (var i = 0; i < HUES.length; i++) {
      if (h < HUES[i].to) { base = HUES[i].name; break; }
    }

    // Brown reads as a distinct family, but only in the orange band. A dark
    // saturated red such as #890708 is "Dark Red", not brown.
    if (h >= 10 && h < 45 && l < 42 && s > 15) return 'Brown';

    if (l < 30) return 'Dark ' + base;
    if (l > 78) return 'Light ' + base;
    return base;
  }

  /**
   * Bridge has exactly five label slots, each bound to a fixed swatch color.
   * The order here is the swatch order Bridge itself uses, which happens to run
   * roughly around the spectrum.
   */
  var LABEL_SLOTS = [
    { slot: 1, swatch: 'Red', hue: 0, defaultText: 'Select' },
    { slot: 2, swatch: 'Yellow', hue: 55, defaultText: 'Second' },
    { slot: 3, swatch: 'Green', hue: 130, defaultText: 'Approved' },
    { slot: 4, swatch: 'Blue', hue: 225, defaultText: 'Review' },
    { slot: 5, swatch: 'Purple', hue: 285, defaultText: 'To Do' }
  ];

  /**
   * Pick the nearest label swatch for a color. Achromatic colors have no
   * meaningful hue, so they get no label rather than a misleading one.
   *
   * @returns {Object|null} an entry from LABEL_SLOTS, or null to leave unlabelled
   */
  function labelFor(hsl) {
    var s = hsl[1];
    var l = hsl[2];
    if (s < 10 || l <= 8 || l >= 94) return null;

    var h = ((hsl[0] % 360) + 360) % 360;
    var best = null;
    var bestDist = Infinity;

    for (var i = 0; i < LABEL_SLOTS.length; i++) {
      var d = Math.abs(h - LABEL_SLOTS[i].hue);
      if (d > 180) d = 360 - d; // hue is circular
      if (d < bestDist) { bestDist = d; best = LABEL_SLOTS[i]; }
    }
    return best;
  }

  var api = { nameFor: nameFor, labelFor: labelFor, LABEL_SLOTS: LABEL_SLOTS };
  global.ColorNames = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
