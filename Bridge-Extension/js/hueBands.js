/**
 * Where to cut the hue wheel into groups.
 *
 * Hue is circular, so any linear ordering has to cut it somewhere, and the
 * fixed 45-degree arcs this replaces cut wherever the arithmetic landed. On a
 * real 1,559-image folder that put a boundary at exactly 90 degrees — straight
 * through the densest part of the golds (80-89: 105 images, 90-99: 71) — so the
 * gold family was split into two groups and ramped twice. The grid showed two
 * gradients where the eye reads one block of colour.
 *
 * Rotating the arcs does not fix it: the golds span 65 degrees and an arc is
 * 45, so no rotation fits them in one. The arcs have to be unequal.
 *
 * Two ways to make them unequal were tried and rejected:
 *
 *  - **Fixed perceptual families.** Nino derives 14 hue families from the
 *    measured OKLCH angles of the CSS named colours, which is a better basis
 *    than intuition. But this folder's golds still straddle three of them
 *    (orange 40-75, amber 75-100, yellow 100-122), so the split moves rather
 *    than closing.
 *  - **Cutting at the globally emptiest angles.** That puts every cut in the
 *    unused greens and purples and none in the crowded warm end, collapsing
 *    76% of the library into one band.
 *
 * What works is cutting at the *valleys between the masses*, chosen by
 * prominence: how far you have to climb out of a dip before you can reach a
 * lower one. A shallow dip inside one colour mass has low prominence; the gap
 * between the reds and the golds has high prominence. On the same folder this
 * yields five bands - reds, golds, greens-through-blues, a small violet band,
 * and the wrap - each of which reads as one block.
 */
(function (global) {
  'use strict';

  /** Below this OKLCH chroma a colour has no meaningful hue at all. */
  var ACHROMATIC_CHROMA = 8;

  /**
   * How prominent a valley must be, as a fraction of the busiest hue, before it
   * becomes a group boundary. Coarse keeps only the gaps between major colour
   * masses; fine also splits within them.
   *
   * The measured folder has five valleys above 15% and then a cliff to 1%, so
   * these are set either side of that cliff rather than on a smooth scale.
   */
  var PROMINENCE = { coarse: 0.10, medium: 0.01, fine: 0.003 };

  /** Two cuts closer than this describe the same gap; keep the stronger. */
  var MIN_ARC = 12;

  /**
   * Perceptual colour families: one group per family, so a family ramps once.
   *
   * Equal arcs split the golds because a boundary fell at 90 degrees, in the
   * middle of them. Serpentine then reversed the second half, and a family
   * that ramps light-to-dark and then dark-to-light reads as two gradients —
   * which is exactly what it looks like on a contact sheet.
   *
   * These boundaries come from Nino's `HueFamily` bins, which were measured
   * from the OKLCH hue angles of the CSS named colours rather than guessed:
   *
   *   pink 15 · red 40 · orange 75 · amber 100 · yellow 122 · chartreuse 139
   *   green 162 · emerald 180 · cyan 210 · azure 240 · blue 272 · indigo 295
   *   violet 316 · magenta 345
   *
   * Fourteen families is finer than the eye groups a library, so adjacent ones
   * a viewer would name together are merged: pink+red, orange+amber+yellow+
   * chartreuse (everything from tan through to yellow), green+emerald,
   * cyan+azure, blue+indigo, violet+magenta. Six groups, and the warm run that
   * used to split is now one.
   *
   * Deliberately NOT merged: green, cyan and blue stay apart. Fitting bands to
   * this folder's density lumped all three into a single 152-degree block
   * ordered only by lightness, which put greens and cyans inside the blues.
   */
  var FAMILY_CUTS = [40, 139, 180, 240, 295, 345];

  /** Names of the FAMILY_CUTS bands, numbered from the one containing 0. */
  var FAMILY_NAMES = ['red', 'gold', 'green', 'cyan', 'blue', 'magenta'];

  /** Smoothing window either side, in degrees. Wide enough to ignore noise. */
  var SMOOTH = 10;

  /**
   * Circular density of hue angles, smoothed.
   * @param {number[]} hues degrees
   */
  function density(hues) {
    var raw = new Array(360);
    var i;
    for (i = 0; i < 360; i++) raw[i] = 0;
    for (i = 0; i < hues.length; i++) {
      raw[((Math.floor(hues[i]) % 360) + 360) % 360]++;
    }

    var out = new Array(360);
    var width = 2 * SMOOTH + 1;
    for (i = 0; i < 360; i++) {
      var sum = 0;
      for (var d = -SMOOTH; d <= SMOOTH; d++) sum += raw[((i + d) % 360 + 360) % 360];
      out[i] = sum / width;
    }
    return out;
  }

  /**
   * Cut angles for the hue wheel, ascending.
   *
   * @param {number[]} hues       representative hue of each image, degrees
   * @param {string} granularity  'coarse' | 'medium' | 'fine'
   * @param {number} fallbackArcs bands to fall back to when there is no
   *                              structure to find (a single-hue folder)
   * @returns {number[]} cut angles; images before the first cut belong to the
   *                     wrap-around band, which is the last one
   */
  function cuts(hues, granularity, fallbackArcs) {
    var arcs = fallbackArcs || 8;
    var fixed = [];
    var f;
    for (f = 0; f < arcs; f++) fixed.push(Math.round(f * 360 / arcs));

    if (!hues || hues.length < arcs * 2) return fixed;

    var dens = density(hues);
    var peak = 0;
    var i;
    for (i = 0; i < 360; i++) if (dens[i] > peak) peak = dens[i];
    if (peak <= 0) return fixed;

    var at = function (index) { return dens[((index % 360) + 360) % 360]; };

    // Local minima. A flat run yields one cut at its centre, not one per degree.
    var minima = [];
    for (i = 0; i < 360; i++) {
      if (at(i) <= at(i - 1) && at(i) <= at(i + 1)) {
        var j = i;
        while (at(j + 1) === at(i) && j - i < 360) j++;
        minima.push({ angle: Math.round((i + j) / 2) % 360, depth: at(i) });
        i = j;
      }
    }
    if (minima.length === 0) return fixed;

    // Prominence: the smaller of the two climbs out of the valley.
    for (i = 0; i < minima.length; i++) {
      var m = minima[i];
      var left = m.depth;
      var right = m.depth;
      var d, v;
      for (d = 1; d < 360; d++) {
        v = at(m.angle - d);
        if (v < m.depth) break;
        if (v > left) left = v;
      }
      for (d = 1; d < 360; d++) {
        v = at(m.angle + d);
        if (v < m.depth) break;
        if (v > right) right = v;
      }
      m.prominence = Math.min(left, right) - m.depth;
    }

    var floor = peak * (PROMINENCE[granularity] || PROMINENCE.coarse);
    var strong = [];
    for (i = 0; i < minima.length; i++) {
      if (minima[i].prominence >= floor) strong.push(minima[i]);
    }
    if (strong.length < 2) return fixed;

    strong.sort(function (a, b) { return b.prominence - a.prominence; });

    // Drop cuts that sit on top of a stronger one - they describe the same gap.
    var chosen = [];
    for (i = 0; i < strong.length; i++) {
      var clash = false;
      for (var c = 0; c < chosen.length; c++) {
        var gap = Math.abs(chosen[c] - strong[i].angle);
        if (Math.min(gap, 360 - gap) < MIN_ARC) { clash = true; break; }
      }
      if (!clash) chosen.push(strong[i].angle);
    }
    if (chosen.length < 2) return fixed;

    chosen.sort(function (a, b) { return a - b; });
    return chosen;
  }

  /** Raw arc index: which pair of cuts the angle sits between. */
  function arcOf(hue, cutList) {
    var h = ((hue % 360) + 360) % 360;
    for (var i = cutList.length - 1; i >= 0; i--) {
      if (h >= cutList[i]) return i;
    }
    // Below the first cut: this is the arc that starts at the last cut and
    // runs through 0.
    return cutList.length - 1;
  }

  /**
   * Which band a hue falls in, numbered from the band containing 0 degrees.
   *
   * The wheel is a cycle, so the band indices only need to be consistent — but
   * they also decide which colour the library opens on, and the arc holding
   * red almost always wraps through 0, which would otherwise number it last
   * and put the reds at the end. Anchoring at 0 keeps the familiar red → gold
   * → green → blue reading regardless of where the cuts landed.
   */
  function bandOf(hue, cutList) {
    if (!cutList || cutList.length === 0) return 0;
    var n = cutList.length;
    var origin = arcOf(0, cutList);
    return (arcOf(hue, cutList) - origin + n) % n;
  }

  /** The family a hue belongs to, by name. */
  function familyOf(hue) {
    return FAMILY_NAMES[bandOf(hue, FAMILY_CUTS)];
  }

  var api = {
    ACHROMATIC_CHROMA: ACHROMATIC_CHROMA,
    PROMINENCE: PROMINENCE,
    MIN_ARC: MIN_ARC,
    FAMILY_CUTS: FAMILY_CUTS,
    FAMILY_NAMES: FAMILY_NAMES,
    density: density,
    cuts: cuts,
    bandOf: bandOf,
    familyOf: familyOf
  };

  global.HueBands = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
