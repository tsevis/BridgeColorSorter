/**
 * Ordering images by whole-palette similarity.
 *
 * Sorting on a single representative colour has a hard ceiling: a busy artwork
 * is not one colour. Two tiles can share a dominant red and look nothing alike
 * because one carries gold and cream while the other carries blue and white.
 * No amount of tuning to the sort criteria fixes that, because the information
 * was thrown away before the sort began.
 *
 * This orders by the *whole palette* instead. Each image keeps its full set of
 * clustered colours with their weights, a perceptual distance is defined
 * between two such palettes, and the images are arranged into a path where each
 * is as close as possible to the one before it.
 *
 * The resulting order cannot be expressed as "sort by X then Y" - it is a
 * sequence - which is exactly why the renaming path is needed to carry it into
 * Bridge.
 */
(function (global) {
  'use strict';

  /**
   * Pack a record's palette into flat typed arrays.
   * OKLab is used directly, so a plain Euclidean distance is perceptual.
   */
  function pack(record, maxColours) {
    var palette = (record.palette || []).slice(0, maxColours || 5);
    var n = palette.length;
    var lab = new Float64Array(n * 3);
    var w = new Float64Array(n);
    var total = 0;

    for (var i = 0; i < n; i++) {
      var c = palette[i];
      var rgb = c.rgb;
      var t = ColorEngine.rgbToOklab
        ? ColorEngine.rgbToOklab(rgb[0], rgb[1], rgb[2])
        : null;

      // Fall back to deriving OKLab from OKLCH if the raw helper is not exposed.
      if (!t) {
        var o = c.oklch || ColorEngine.rgbToOklch(rgb[0], rgb[1], rgb[2]);
        var rad = o[2] * Math.PI / 180;
        var chroma = (o[1] / 100) * 0.33;
        t = [o[0] / 100, Math.cos(rad) * chroma, Math.sin(rad) * chroma];
      }

      lab[i * 3] = t[0];
      lab[i * 3 + 1] = t[1];
      lab[i * 3 + 2] = t[2];
      w[i] = c.dominance;
      total += c.dominance;
    }

    // Normalise weights so images with different palette sizes compare fairly.
    if (total > 0) for (var j = 0; j < n; j++) w[j] /= total;

    return { n: n, lab: lab, w: w };
  }

  /**
   * Distance between two palettes.
   *
   * For every colour in A, find its nearest counterpart in B and weight that
   * gap by how much of A the colour occupies; then do the same from B to A and
   * average. This is the standard cheap approximation of earth-mover's
   * distance: it asks "how far would I have to move A's colours to land on B's"
   * without solving the full transport problem, which would be far too slow for
   * a million pairs.
   */
  function distance(A, B) {
    var sum = 0;
    var i, j, k, best, dl, da, db, d;

    for (i = 0; i < A.n; i++) {
      best = Infinity;
      for (j = 0; j < B.n; j++) {
        dl = A.lab[i * 3] - B.lab[j * 3];
        da = A.lab[i * 3 + 1] - B.lab[j * 3 + 1];
        db = A.lab[i * 3 + 2] - B.lab[j * 3 + 2];
        d = dl * dl + da * da + db * db;
        if (d < best) best = d;
      }
      sum += A.w[i] * Math.sqrt(best);
    }

    for (k = 0; k < B.n; k++) {
      best = Infinity;
      for (j = 0; j < A.n; j++) {
        dl = B.lab[k * 3] - A.lab[j * 3];
        da = B.lab[k * 3 + 1] - A.lab[j * 3 + 1];
        db = B.lab[k * 3 + 2] - A.lab[j * 3 + 2];
        d = dl * dl + da * da + db * db;
        if (d < best) best = d;
      }
      sum += B.w[k] * Math.sqrt(best);
    }

    return sum * 0.5;
  }

  /** Mean lightness of a palette, used to pick a sensible starting image. */
  function meanLightness(p) {
    var sum = 0;
    for (var i = 0; i < p.n; i++) sum += p.lab[i * 3] * p.w[i];
    return sum;
  }

  /**
   * Greedy nearest-neighbour path, then a windowed 2-opt clean-up.
   *
   * Greedy alone leaves occasional long jumps where it strands an image and has
   * to leap back for it. 2-opt reverses a segment when doing so shortens the
   * path; restricting it to a window keeps the pass linear rather than
   * quadratic, and local crossings are the ones that show up visually anyway.
   */
  function orderByPalette(records, options) {
    options = options || {};
    var maxColours = options.maxColours || 5;
    var window = options.window || 40;
    var onProgress = options.onProgress;

    var n = records.length;
    if (n < 3) return records.map(function (r) { return r.key; });

    var packed = new Array(n);
    for (var i = 0; i < n; i++) packed[i] = pack(records[i], maxColours);

    // Start from the darkest image, so the path begins at an edge of the
    // colour space rather than somewhere in the middle.
    var seed = 0;
    var darkest = Infinity;
    for (var s = 0; s < n; s++) {
      var m = meanLightness(packed[s]);
      if (m < darkest) { darkest = m; seed = s; }
    }

    var used = new Uint8Array(n);
    var order = new Int32Array(n);
    order[0] = seed;
    used[seed] = 1;
    var cur = seed;

    for (var step = 1; step < n; step++) {
      var best = -1;
      var bestD = Infinity;
      for (var j = 0; j < n; j++) {
        if (used[j]) continue;
        var d = distance(packed[cur], packed[j]);
        if (d < bestD) { bestD = d; best = j; }
      }
      order[step] = best;
      used[best] = 1;
      cur = best;
      if (onProgress && (step % 100 === 0)) onProgress(step, n);
    }

    // Windowed 2-opt: reverse order[a+1..b] when that shortens the path.
    var improved = true;
    var passes = 0;
    while (improved && passes < 4) {
      improved = false;
      passes++;
      for (var a = 0; a < n - 2; a++) {
        var limit = Math.min(n - 1, a + window);
        for (var b = a + 2; b <= limit; b++) {
          var before = distance(packed[order[a]], packed[order[a + 1]]) +
                       distance(packed[order[b - 1]], packed[order[b]]);
          var after = distance(packed[order[a]], packed[order[b - 1]]) +
                      distance(packed[order[a + 1]], packed[order[b]]);
          if (after < before - 1e-9) {
            var lo = a + 1;
            var hi = b - 1;
            while (lo < hi) {
              var t = order[lo]; order[lo] = order[hi]; order[hi] = t;
              lo++; hi--;
            }
            improved = true;
          }
        }
      }
      if (onProgress) onProgress(n, n);
    }

    var out = new Array(n);
    for (var k = 0; k < n; k++) out[k] = records[order[k]].key;
    return out;
  }

  /** Mean distance between consecutive images - lower is a smoother run. */
  function measure(records, orderedKeys, maxColours) {
    var byKey = {};
    records.forEach(function (r) { byKey[r.key] = pack(r, maxColours || 5); });

    var total = 0;
    var worst = 0;
    for (var i = 1; i < orderedKeys.length; i++) {
      var d = distance(byKey[orderedKeys[i - 1]], byKey[orderedKeys[i]]);
      total += d;
      if (d > worst) worst = d;
    }
    var count = Math.max(1, orderedKeys.length - 1);
    return { mean: total / count, worst: worst };
  }

  var api = {
    orderByPalette: orderByPalette,
    distance: distance,
    pack: pack,
    measure: measure
  };

  global.Similarity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
