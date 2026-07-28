/**
 * ColorEngine - genuine colour extraction for ColorXBridge.
 *
 * Pixels are decoded by Chromium itself: the file is read from disk with
 * Node, wrapped in a Blob URL (same-origin, so the canvas is never tainted)
 * and drawn to an offscreen canvas. Formats Chromium cannot decode - camera
 * raw, PSD, TIFF, HEIC - are transcoded to a temporary PNG with macOS `sips`
 * first.
 *
 * This replaces the previous approach of reading raw *compressed* file bytes
 * as if they were RGB triples, which cannot produce meaningful colours.
 */
(function (global) {
  'use strict';

  var fs = null;
  var os = null;
  var pathMod = null;
  var childProcess = null;

  if (typeof require === 'function') {
    try {
      fs = require('fs');
      os = require('os');
      pathMod = require('path');
      childProcess = require('child_process');
    } catch (e) {
      // Left null; decode() reports a clear error if Node is unavailable.
    }
  }

  /** Formats Chromium decodes natively. */
  var WEB_FORMATS = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
    avif: 'image/avif'
  };

  /** Formats that must be transcoded by `sips` before decoding. */
  var SIPS_FORMATS = {
    tif: 1, tiff: 1, psd: 1, heic: 1, heif: 1, dng: 1, cr2: 1, cr3: 1,
    nef: 1, arw: 1, orf: 1, raf: 1, rw2: 1, pef: 1, srw: 1, jp2: 1
  };

  function extensionOf(filePath) {
    var dot = filePath.lastIndexOf('.');
    return dot === -1 ? '' : filePath.slice(dot + 1).toLowerCase();
  }

  function isSupported(filePath) {
    var ext = extensionOf(filePath);
    return !!(WEB_FORMATS[ext] || SIPS_FORMATS[ext]);
  }

  // ---------------------------------------------------------------------
  // Decoding
  // ---------------------------------------------------------------------

  /**
   * Transcode an unsupported format to a temporary PNG via macOS sips.
   * @returns {string} path to the temporary PNG
   */
  function transcodeWithSips(filePath, maxDim) {
    if (!childProcess) throw new Error('Node child_process unavailable');

    var tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cxb-'));
    var out = pathMod.join(tmpDir, 'preview.png');

    childProcess.execFileSync(
      '/usr/bin/sips',
      ['-s', 'format', 'png', '-Z', String(maxDim), filePath, '--out', out],
      { stdio: 'ignore', timeout: 30000 }
    );

    if (!fs.existsSync(out)) throw new Error('sips produced no output');
    return out;
  }

  /** Read a file from disk into a Blob URL. */
  function fileToBlobUrl(filePath, mime) {
    var buf = fs.readFileSync(filePath);
    // Copy into a plain ArrayBuffer slice the Blob constructor accepts.
    var bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('image decode failed')); };
      img.src = url;
    });
  }

  /**
   * Decode an image file into an array of [r,g,b] pixels.
   * @param {string} filePath absolute path
   * @param {number} maxDim   longest edge to sample at
   * @returns {Promise<{pixels: Array, width: number, height: number}>}
   */
  function decode(filePath, maxDim) {
    maxDim = maxDim || 160;

    return new Promise(function (resolve, reject) {
      if (!fs) {
        reject(new Error('Node runtime unavailable in this panel'));
        return;
      }

      var ext = extensionOf(filePath);
      var cleanupDir = null;
      var url = null;

      var prepared;
      try {
        if (WEB_FORMATS[ext]) {
          prepared = { path: filePath, mime: WEB_FORMATS[ext] };
        } else if (SIPS_FORMATS[ext]) {
          var png = transcodeWithSips(filePath, maxDim);
          cleanupDir = pathMod.dirname(png);
          prepared = { path: png, mime: 'image/png' };
        } else {
          reject(new Error('unsupported format: .' + ext));
          return;
        }
        url = fileToBlobUrl(prepared.path, prepared.mime);
      } catch (e) {
        cleanup();
        reject(e);
        return;
      }

      function cleanup() {
        if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
        if (cleanupDir) {
          try { fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch (e) {}
        }
      }

      loadImage(url).then(function (img) {
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        if (!w || !h) throw new Error('image has zero dimensions');

        var scale = Math.min(1, maxDim / Math.max(w, h));
        var tw = Math.max(1, Math.round(w * scale));
        var th = Math.max(1, Math.round(h * scale));

        var canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;

        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, tw, th);

        var data = ctx.getImageData(0, 0, tw, th).data;
        var pixels = [];

        for (var i = 0; i < data.length; i += 4) {
          // Ignore mostly-transparent pixels; they are not part of the artwork.
          if (data[i + 3] < 125) continue;
          pixels.push([data[i], data[i + 1], data[i + 2]]);
        }

        cleanup();

        if (pixels.length === 0) throw new Error('no opaque pixels found');
        resolve({ pixels: pixels, width: w, height: h });
      }).catch(function (err) {
        cleanup();
        reject(err);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Colour space helpers
  // ---------------------------------------------------------------------

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (x) {
      var s = Math.round(x).toString(16);
      return s.length === 1 ? '0' + s : s;
    }).join('');
  }

  /** @returns {[number, number, number]} H 0-360, S 0-100, L 0-100 */
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;

    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var h = 0;
    var s = 0;

    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }

    // Hue is a circle: 360 and 0 are the same angle. Rounding a near-red such
    // as rgb(215,3,4) lands on 359.7 -> 360, which would otherwise sort at the
    // opposite end of the spectrum from rgb(255,0,0) at 0.
    var hue = Math.round(h * 360) % 360;

    return [hue, Math.round(s * 100), Math.round(l * 100)];
  }

  // ---------------------------------------------------------------------
  // OKLab / OKLCH
  //
  // HSL is not a perceptual space, and sorting by HSL hue is why a colour sort
  // looks wrong even when it is numerically right:
  //
  //   - A pale pink and a deep crimson both report hue 0, so they land next to
  //     each other despite looking nothing alike.
  //   - Hue is unstable at low saturation: a near-grey gets an essentially
  //     random hue and drops into the middle of the reds.
  //   - HSL "lightness" is not perceived lightness. Pure yellow and pure blue
  //     are both L=50, though yellow is far brighter to the eye.
  //
  // OKLab fixes all three: equal numeric steps are roughly equal perceived
  // steps. https://bottosson.github.io/posts/oklab/
  // ---------------------------------------------------------------------

  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  /** @returns {[number, number, number]} OKLab L (0-1), a, b */
  function rgbToOklab(r, g, b) {
    var lr = srgbToLinear(r);
    var lg = srgbToLinear(g);
    var lb = srgbToLinear(b);

    var l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
    var m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
    var s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

    var l_ = Math.cbrt(l);
    var m_ = Math.cbrt(m);
    var s_ = Math.cbrt(s);

    return [
      0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    ];
  }

  function linearToSrgb(c) {
    var v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  }

  /** Inverse of rgbToOklab. Cluster centroids live in OKLab and come back here. */
  function oklabToRgb(L, a, b) {
    var l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    var m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    var s_ = L - 0.0894841775 * a - 1.2914855480 * b;

    var l = l_ * l_ * l_;
    var m = m_ * m_ * m_;
    var s = s_ * s_ * s_;

    return [
      linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
    ];
  }

  /** Largest chroma reachable in sRGB, used to normalise C onto 0-100. */
  var MAX_OKLCH_CHROMA = 0.33;

  /**
   * @returns {[number, number, number]} L 0-100, C 0-100, h 0-360
   * Same shape as the HSL triple, so it drops into the same sort machinery.
   */
  function rgbToOklch(r, g, b) {
    var lab = rgbToOklab(r, g, b);
    var C = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]);
    var h = Math.atan2(lab[2], lab[1]) * 180 / Math.PI;
    if (h < 0) h += 360;

    return [
      Math.round(lab[0] * 100),
      Math.round(Math.min(1, C / MAX_OKLCH_CHROMA) * 100),
      Math.round(h) % 360
    ];
  }

  // ---------------------------------------------------------------------
  // K-means++ clustering
  //
  // Distance is plain squared Euclidean in OKLab, written out inline in the
  // hot loops below rather than called through a helper. No channel
  // weighting: OKLab is constructed so that plain Euclidean distance already
  // approximates perceived difference. (The luma-weighted RGB distance this
  // replaced was a crude stand-in for the same idea.)
  // ---------------------------------------------------------------------

  /**
   * Deterministic pseudo-random source, so re-analysing a file yields the
   * same palette rather than drifting between runs.
   */
  function makeRandom(seed) {
    var state = seed || 1;
    return function () {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  /**
   * k-means++ seeding, over a flat Float64Array of OKLab triples.
   *
   * Writes the chosen centroids into `cent` and returns how many it found.
   * Selection order is identical to the array-of-arrays version this replaced:
   * same seeded random source, same cumulative-weight walk, same tie-breaks.
   */
  function initCentroids(lab, n, k, cent, rand, scratch) {
    var first = Math.floor(rand() * n);
    cent[0] = lab[first * 3];
    cent[1] = lab[first * 3 + 1];
    cent[2] = lab[first * 3 + 2];
    var have = 1;

    while (have < k) {
      var total = 0;

      for (var i = 0; i < n; i++) {
        var L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
        var best = Infinity;
        for (var c = 0; c < have; c++) {
          var dL = L - cent[c * 3];
          var da = A - cent[c * 3 + 1];
          var db = B - cent[c * 3 + 2];
          var d = dL * dL + da * da + db * db;
          if (d < best) best = d;
        }
        scratch[i] = best;
        total += best;
      }

      if (total === 0) break; // every pixel already matches a centroid

      var target = rand() * total;
      var acc = 0;
      var chosen = n - 1;

      for (var j = 0; j < n; j++) {
        acc += scratch[j];
        if (acc >= target) { chosen = j; break; }
      }

      cent[have * 3] = lab[chosen * 3];
      cent[have * 3 + 1] = lab[chosen * 3 + 1];
      cent[have * 3 + 2] = lab[chosen * 3 + 2];
      have++;
    }

    return have;
  }

  /**
   * Cluster pixels into a palette.
   * @returns {{dominant: Object, palette: Array}}
   */
  /**
   * Cluster pixels into a palette.
   *
   * Clustering runs in OKLab, not RGB. Equal distances there are roughly equal
   * perceived differences, so the clusters split where the eye sees a boundary:
   * a dark red and a bright red separate, while two near-identical greens merge
   * instead of wasting a slot. Centroids are averaged in OKLab and converted
   * back to sRGB only at the end.
   *
   * @param {Array} pixels [r,g,b] triples
   * @returns {{dominant: Object, palette: Array}}
   */
  function extractPalette(pixels, colorCount, maxIterations) {
    var n = pixels.length;
    var k = Math.max(1, Math.min(colorCount || 5, n));
    var iterations = maxIterations || 24;
    var rand = makeRandom(n * 2654435761 % 4294967296);

    // Flat Float64Arrays rather than an array of [L,a,b] arrays. A 160x160
    // sample is 25,600 pixels, so the old shape allocated 25,600 three-element
    // arrays per image and chased a pointer for every distance computation.
    // The arithmetic below is unchanged - same order, same seed, same
    // results, guarded by test/palette-golden.test.js - but it runs about 1.5x
    // faster, which is ~9 ms off every image in the folder.
    var lab = new Float64Array(n * 3);
    for (var p = 0; p < n; p++) {
      var px = pixels[p];
      var t = rgbToOklab(px[0], px[1], px[2]);
      lab[p * 3] = t[0];
      lab[p * 3 + 1] = t[1];
      lab[p * 3 + 2] = t[2];
    }

    var cent = new Float64Array(k * 3);
    var scratch = new Float64Array(n);
    k = initCentroids(lab, n, k, cent, rand, scratch);

    var assignment = new Int32Array(n);
    for (var a = 0; a < n; a++) assignment[a] = -1;

    var sums = new Float64Array(k * 3);
    var counts = new Int32Array(k);

    for (var iter = 0; iter < iterations; iter++) {
      var moved = false;

      for (var i = 0; i < n; i++) {
        var L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
        var best = 0;
        var bestDist = Infinity;
        for (var c = 0; c < k; c++) {
          var dL = L - cent[c * 3];
          var da = A - cent[c * 3 + 1];
          var db = B - cent[c * 3 + 2];
          var d = dL * dL + da * da + db * db;
          if (d < bestDist) { bestDist = d; best = c; }
        }
        if (assignment[i] !== best) { assignment[i] = best; moved = true; }
      }

      sums.fill(0);
      counts.fill(0);

      for (var q = 0; q < n; q++) {
        var cluster = assignment[q];
        sums[cluster * 3] += lab[q * 3];
        sums[cluster * 3 + 1] += lab[q * 3 + 1];
        sums[cluster * 3 + 2] += lab[q * 3 + 2];
        counts[cluster]++;
      }

      for (var m = 0; m < k; m++) {
        if (counts[m] === 0) continue; // keep an empty cluster where it is
        cent[m * 3] = sums[m * 3] / counts[m];
        cent[m * 3 + 1] = sums[m * 3 + 1] / counts[m];
        cent[m * 3 + 2] = sums[m * 3 + 2] / counts[m];
      }

      if (!moved) break;
    }

    var palette = [];
    for (var z = 0; z < k; z++) {
      if (counts[z] === 0) continue;
      var rgb = oklabToRgb(cent[z * 3], cent[z * 3 + 1], cent[z * 3 + 2]);
      palette.push({
        hex: rgbToHex(rgb[0], rgb[1], rgb[2]),
        rgb: rgb,
        hsl: rgbToHsl(rgb[0], rgb[1], rgb[2]),
        oklch: rgbToOklch(rgb[0], rgb[1], rgb[2]),
        dominance: counts[z] / n
      });
    }

    palette.sort(function (a, b) { return b.dominance - a.dominance; });

    return { dominant: palette[0], palette: palette };
  }

  /**
   * Choose the colour that best represents an image.
   *
   * Neither obvious choice works on its own:
   *   - The *average* of a red-and-green image is a muddy brown that appears
   *     nowhere in the picture.
   *   - The *dominant* cluster is often a large neutral - a grey wall, a white
   *     background - when a person looking at the image would call it "red".
   *
   * 'balanced' (the default) splits the difference: among clusters that are
   * genuinely colourful and occupy a meaningful share of the frame, take the
   * one with the best combination of area and chroma. If nothing is colourful,
   * the image really is neutral, so fall back to the plain dominant cluster.
   *
   * @param {Array} palette sorted by dominance, descending
   * @param {string} [mode] 'balanced' | 'dominant' | 'average'
   */
  function pickRepresentative(palette, mode) {
    if (!palette || palette.length === 0) return null;
    if (mode === 'dominant') return palette[0];

    if (mode === 'average') {
      var r = 0, g = 0, b = 0;
      for (var i = 0; i < palette.length; i++) {
        r += palette[i].rgb[0] * palette[i].dominance;
        g += palette[i].rgb[1] * palette[i].dominance;
        b += palette[i].rgb[2] * palette[i].dominance;
      }
      var rgb = [Math.round(r), Math.round(g), Math.round(b)];
      return {
        hex: rgbToHex(rgb[0], rgb[1], rgb[2]),
        rgb: rgb,
        hsl: rgbToHsl(rgb[0], rgb[1], rgb[2]),
        oklch: rgbToOklch(rgb[0], rgb[1], rgb[2]),
        dominance: 1
      };
    }

    var MIN_CHROMA = 8;    // OKLCH chroma below this reads as neutral
    var MIN_SHARE = 0.08;  // ignore specks; they are not what the image "is"

    var best = null;
    var bestScore = -1;

    for (var j = 0; j < palette.length; j++) {
      var c = palette[j];
      var chroma = c.oklch ? c.oklch[1] : c.hsl[1];
      if (chroma < MIN_CHROMA || c.dominance < MIN_SHARE) continue;

      // Area still leads, but chroma can lift a smaller vivid patch above a
      // larger dull one. The exponent keeps area from being overwhelmed.
      var score = c.dominance * Math.pow(chroma / 100, 0.6);
      if (score > bestScore) { bestScore = score; best = c; }
    }

    return best || palette[0];
  }

  /**
   * Full analysis of one file.
   * @returns {Promise<Object>} { dominant, palette, metadata }
   */
  function analyze(filePath, options) {
    options = options || {};
    var colorCount = options.colorCount || 5;
    var maxDim = options.sampleSize || 160;

    return decode(filePath, maxDim).then(function (decoded) {
      var result = extractPalette(decoded.pixels, colorCount);
      result.metadata = {
        filePath: filePath,
        width: decoded.width,
        height: decoded.height,
        sampledPixels: decoded.pixels.length,
        analyzedAt: new Date().toISOString(),
        algorithm: 'kmeans++'
      };
      return result;
    });
  }

  var api = {
    analyze: analyze,
    pickRepresentative: pickRepresentative,
    rgbToOklch: rgbToOklch,
    rgbToOklab: rgbToOklab,
    decode: decode,
    extractPalette: extractPalette,
    isSupported: isSupported,
    rgbToHsl: rgbToHsl,
    rgbToHex: rgbToHex
  };

  global.ColorEngine = api;

  // Also export for Node, so the clustering can be unit-tested outside Bridge.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
