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

  // -----------------------------------------------------------------------
  // Cluster, then order
  //
  // A single nearest-neighbour path is smooth between adjacent images but has
  // no global structure. Measured on a 1,559-image folder it changed colour
  // region 722 times across only 9 regions - it entered blue 87 separate times
  // and neutrals 187. Every individual step was short, so the local metric
  // looked excellent while the grid still read as scattered.
  //
  // Grouping first fixes what the path cannot: cluster the palettes, order the
  // clusters, then order within each. Each colour region is then visited
  // exactly once, as one contiguous block.
  // -----------------------------------------------------------------------

  /**
   * Lightness-free descriptor of a palette: pure colour identity.
   *
   * Two problems were caused by clustering on the full OKLab palette:
   *
   *  - OKLab compresses a and b toward zero as lightness falls, so a dark red
   *    and a dark yellow sit close together numerically. Being *both dark* then
   *    pushed them into the same cluster, which is why dark reds and dark
   *    yellows appeared side by side.
   *  - A dark red and a bright red are far apart in L, so they landed in
   *    different clusters - when they are obviously the same colour family.
   *
   * Each colour is therefore reduced to a direction on the hue circle scaled by
   * how colourful it is, plus a third axis for how neutral it is. Lightness is
   * excluded entirely: it is the job of the within-group ramp, not of grouping.
   * Dark red and bright red now coincide; dark red and dark yellow do not.
   */
  function packHue(record, maxColours) {
    var palette = (record.palette || []).slice(0, maxColours || 5);
    var n = palette.length;
    var v = new Float64Array(n * 3);
    var w = new Float64Array(n);
    var total = 0;

    for (var i = 0; i < n; i++) {
      var c = palette[i];
      var o = c.oklch || ColorEngine.rgbToOklch(c.rgb[0], c.rgb[1], c.rgb[2]);

      // "Colourfulness" saturates quickly, so a muted red still reads as red
      // rather than drifting toward neutral.
      var s = Math.min(1, o[1] / 25);
      var rad = o[2] * Math.PI / 180;

      v[i * 3] = Math.cos(rad) * s;
      v[i * 3 + 1] = Math.sin(rad) * s;
      v[i * 3 + 2] = 1 - s;             // neutral axis
      w[i] = c.dominance;
      total += c.dominance;
    }

    if (total > 0) for (var j = 0; j < n; j++) w[j] /= total;
    return { n: n, lab: v, w: w };
  }

  /** k-medoids over the palette distance. Medoids are real images, not means. */
  function clusterPalettes(packed, k, iterations) {
    var n = packed.length;
    k = Math.max(1, Math.min(k, n));
    iterations = iterations || 8;

    // Spread the initial medoids out, k-means++ style.
    var medoids = [0];
    var i, j, c;
    while (medoids.length < k) {
      var far = 0;
      var farthest = -1;
      for (i = 0; i < n; i++) {
        var nearest = Infinity;
        for (c = 0; c < medoids.length; c++) {
          var d0 = distance(packed[i], packed[medoids[c]]);
          if (d0 < nearest) nearest = d0;
        }
        if (nearest > far) { far = nearest; farthest = i; }
      }
      if (farthest < 0) break;
      medoids.push(farthest);
    }
    k = medoids.length;

    var assign = new Int32Array(n);

    for (var iter = 0; iter < iterations; iter++) {
      var moved = false;

      for (i = 0; i < n; i++) {
        var best = 0;
        var bestD = Infinity;
        for (c = 0; c < k; c++) {
          var d = distance(packed[i], packed[medoids[c]]);
          if (d < bestD) { bestD = d; best = c; }
        }
        if (assign[i] !== best) { assign[i] = best; moved = true; }
      }

      // New medoid = the member with the smallest total distance to the rest.
      var members = [];
      for (c = 0; c < k; c++) members.push([]);
      for (i = 0; i < n; i++) members[assign[i]].push(i);

      for (c = 0; c < k; c++) {
        var m = members[c];
        if (m.length === 0) continue;
        var bestIdx = m[0];
        var bestSum = Infinity;
        for (i = 0; i < m.length; i++) {
          var sum = 0;
          for (j = 0; j < m.length; j++) sum += distance(packed[m[i]], packed[m[j]]);
          if (sum < bestSum) { bestSum = sum; bestIdx = m[i]; }
        }
        medoids[c] = bestIdx;
      }

      if (!moved) break;
    }

    return { medoids: medoids, assign: assign, k: k };
  }

  /** Shortest path visiting every cluster once: greedy, then full 2-opt. */
  function orderClusters(packed, medoids) {
    var k = medoids.length;
    if (k < 3) { var trivial = []; for (var t = 0; t < k; t++) trivial.push(t); return trivial; }

    var seed = 0;
    var darkest = Infinity;
    for (var s = 0; s < k; s++) {
      var m = meanLightness(packed[medoids[s]]);
      if (m < darkest) { darkest = m; seed = s; }
    }

    var used = new Uint8Array(k);
    var path = [seed];
    used[seed] = 1;

    for (var step = 1; step < k; step++) {
      var cur = path[path.length - 1];
      var best = -1;
      var bestD = Infinity;
      for (var j = 0; j < k; j++) {
        if (used[j]) continue;
        var d = distance(packed[medoids[cur]], packed[medoids[j]]);
        if (d < bestD) { bestD = d; best = j; }
      }
      path.push(best);
      used[best] = 1;
    }

    // k is small, so a full 2-opt is affordable and worth it here.
    var improved = true;
    var guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (var a = 0; a < k - 2; a++) {
        for (var b = a + 2; b < k; b++) {
          var before = distance(packed[medoids[path[a]]], packed[medoids[path[a + 1]]]) +
                       distance(packed[medoids[path[b - 1]]], packed[medoids[path[b]]]);
          var after = distance(packed[medoids[path[a]]], packed[medoids[path[b - 1]]]) +
                      distance(packed[medoids[path[a + 1]]], packed[medoids[path[b]]]);
          if (after < before - 1e-9) {
            var lo = a + 1, hi = b - 1;
            while (lo < hi) { var tmp = path[lo]; path[lo] = path[hi]; path[hi] = tmp; lo++; hi--; }
            improved = true;
          }
        }
      }
    }
    return path;
  }

  /**
   * Angle of a block on the hue wheel, and how colourful it is overall.
   * Averaging hue as a vector avoids the wrap-around problem that plagues
   * averaging degrees directly.
   */
  function blockHue(hues, members) {
    var x = 0, y = 0, neutral = 0, total = 0;
    for (var i = 0; i < members.length; i++) {
      var p = hues[members[i]];
      for (var j = 0; j < p.n; j++) {
        x += p.lab[j * 3] * p.w[j];
        y += p.lab[j * 3 + 1] * p.w[j];
        neutral += p.lab[j * 3 + 2] * p.w[j];
        total += p.w[j];
      }
    }
    if (total > 0) { x /= total; y /= total; neutral /= total; }
    var angle = Math.atan2(y, x) * 180 / Math.PI;
    if (angle < 0) angle += 360;
    return { angle: angle, neutral: neutral, chroma: Math.sqrt(x * x + y * y) };
  }

  /** Blocks in hue-wheel order, neutrals last. */
  function orderBlocksByHue(hues, clustered) {
    var members = [];
    for (var c = 0; c < clustered.k; c++) members.push([]);
    for (var i = 0; i < hues.length; i++) members[clustered.assign[i]].push(i);

    var info = [];
    for (var b = 0; b < clustered.k; b++) {
      if (members[b].length === 0) continue;
      var h = blockHue(hues, members[b]);
      info.push({ index: b, angle: h.angle, neutral: h.neutral, chroma: h.chroma });
    }

    // A block with almost no chroma has no meaningful place on the wheel.
    var NEUTRAL_CHROMA = 0.18;

    info.sort(function (p, q) {
      var pn = p.chroma < NEUTRAL_CHROMA;
      var qn = q.chroma < NEUTRAL_CHROMA;
      if (pn !== qn) return pn ? 1 : -1;
      if (pn) return p.neutral - q.neutral;
      return p.angle - q.angle;
    });

    return info.map(function (e) { return e.index; });
  }

  /** Greedy nearest-neighbour path over one block's members. */
  function pathWithin(packed, members) {
    var m = members.length;
    if (m < 3) return members.slice();

    // Start from the darkest member, so each block runs dark to light.
    var seed = 0;
    var darkest = Infinity;
    for (var i = 0; i < m; i++) {
      var v = meanLightness(packed[members[i]]);
      if (v < darkest) { darkest = v; seed = i; }
    }

    var used = new Uint8Array(m);
    var seq = [members[seed]];
    used[seed] = 1;
    var cur = seed;

    for (var step = 1; step < m; step++) {
      var best = -1;
      var bestD = Infinity;
      for (var j = 0; j < m; j++) {
        if (used[j]) continue;
        var d = distance(packed[members[cur]], packed[members[j]]);
        if (d < bestD) { bestD = d; best = j; }
      }
      seq.push(members[best]);
      used[best] = 1;
      cur = best;
    }
    return seq;
  }

  /**
   * Order by clustering into colour groups, ordering the groups, then walking a
   * short path inside each.
   *
   * @param {Array} records  [{key, palette}]
   * @param {Object} options {groups, maxColours, serpentine}
   */
  function orderByClusters(records, options) {
    options = options || {};
    var maxColours = options.maxColours || 5;
    var serpentineOn = options.serpentine !== false;
    var n = records.length;
    if (n < 3) return records.map(function (r) { return r.key; });

    var groups = options.groups || Math.max(6, Math.min(24, Math.round(Math.sqrt(n / 8))));

    var packed = new Array(n);
    var hues = new Array(n);
    for (var i = 0; i < n; i++) {
      packed[i] = pack(records[i], maxColours);
      hues[i] = packHue(records[i], maxColours);
    }

    // Group on colour identity alone.
    var clustered = clusterPalettes(hues, groups, options.iterations || 8);

    // Order the blocks around the hue wheel rather than by a nearest-neighbour
    // chain. A chain can leave two blue blocks at opposite ends of the path -
    // locally reasonable, globally wrong. Since the blocks are hue-coherent,
    // walking the wheel guarantees red sits by orange and every blue together.
    // Neutral blocks carry no hue, so they go last.
    var path = orderBlocksByHue(hues, clustered);

    var buckets = [];
    for (var c = 0; c < clustered.k; c++) buckets.push([]);
    for (var m = 0; m < n; m++) buckets[clustered.assign[m]].push(m);

    var out = [];
    var prevEnd = -1;

    for (var p = 0; p < path.length; p++) {
      var members = buckets[path[p]];
      if (!members || members.length === 0) continue;

      // Inside a block, a strict lightness ramp - dark to light, monotonically.
      // A similarity path here reads as noise: it optimises colour closeness,
      // which does not move in step with lightness, so the block visibly jumps
      // between light and dark. Grouping already handled colour; lightness is
      // the only thing left for this level to express.
      var seq = members.slice().sort(function (x, y) {
        return meanLightness(packed[x]) - meanLightness(packed[y]);
      });

      // Flip the ramp when that puts its matching end against the previous
      // block, so the seam is dark-to-dark or light-to-light rather than a jump.
      if (prevEnd >= 0 && seq.length > 1) {
        var pl = meanLightness(packed[prevEnd]);
        var head = Math.abs(pl - meanLightness(packed[seq[0]]));
        var tail = Math.abs(pl - meanLightness(packed[seq[seq.length - 1]]));
        if (tail < head) seq.reverse();
      }

      for (var q = 0; q < seq.length; q++) out.push(records[seq[q]].key);
      prevEnd = seq[seq.length - 1];
    }

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
    orderByClusters: orderByClusters,
    clusterPalettes: clusterPalettes,
    distance: distance,
    pack: pack,
    measure: measure
  };

  global.Similarity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
