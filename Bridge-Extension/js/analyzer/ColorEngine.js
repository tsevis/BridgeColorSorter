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

  function distanceSq(a, b) {
    var dr = a[0] - b[0];
    var dg = a[1] - b[1];
    var db = a[2] - b[2];
    // Weighted to approximate perceived difference (green matters most).
    return dr * dr * 0.30 + dg * dg * 0.59 + db * db * 0.11;
  }

  // ---------------------------------------------------------------------
  // K-means++ clustering
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

  function initCentroids(pixels, k, rand) {
    var centroids = [pixels[Math.floor(rand() * pixels.length)]];

    while (centroids.length < k) {
      var distances = new Array(pixels.length);
      var total = 0;

      for (var i = 0; i < pixels.length; i++) {
        var best = Infinity;
        for (var c = 0; c < centroids.length; c++) {
          var d = distanceSq(pixels[i], centroids[c]);
          if (d < best) best = d;
        }
        distances[i] = best;
        total += best;
      }

      if (total === 0) break; // every pixel already matches a centroid

      var target = rand() * total;
      var acc = 0;
      var chosen = pixels.length - 1;

      for (var j = 0; j < pixels.length; j++) {
        acc += distances[j];
        if (acc >= target) { chosen = j; break; }
      }
      centroids.push(pixels[chosen]);
    }

    return centroids;
  }

  /**
   * Cluster pixels into a palette.
   * @returns {{dominant: Object, palette: Array}}
   */
  function extractPalette(pixels, colorCount, maxIterations) {
    var k = Math.max(1, Math.min(colorCount || 5, pixels.length));
    var iterations = maxIterations || 24;
    var rand = makeRandom(pixels.length * 2654435761 % 4294967296);

    var centroids = initCentroids(pixels, k, rand);
    k = centroids.length;

    var assignment = new Array(pixels.length);
    var counts;

    for (var iter = 0; iter < iterations; iter++) {
      var moved = false;

      for (var i = 0; i < pixels.length; i++) {
        var best = 0;
        var bestDist = Infinity;
        for (var c = 0; c < k; c++) {
          var d = distanceSq(pixels[i], centroids[c]);
          if (d < bestDist) { bestDist = d; best = c; }
        }
        if (assignment[i] !== best) { assignment[i] = best; moved = true; }
      }

      var sums = [];
      counts = [];
      for (var s = 0; s < k; s++) { sums.push([0, 0, 0]); counts.push(0); }

      for (var p = 0; p < pixels.length; p++) {
        var cluster = assignment[p];
        sums[cluster][0] += pixels[p][0];
        sums[cluster][1] += pixels[p][1];
        sums[cluster][2] += pixels[p][2];
        counts[cluster]++;
      }

      for (var m = 0; m < k; m++) {
        if (counts[m] === 0) continue; // keep an empty cluster where it is
        centroids[m] = [
          sums[m][0] / counts[m],
          sums[m][1] / counts[m],
          sums[m][2] / counts[m]
        ];
      }

      if (!moved) break;
    }

    var palette = [];
    for (var n = 0; n < k; n++) {
      if (counts[n] === 0) continue;
      var rgb = [
        Math.round(centroids[n][0]),
        Math.round(centroids[n][1]),
        Math.round(centroids[n][2])
      ];
      palette.push({
        hex: rgbToHex(rgb[0], rgb[1], rgb[2]),
        rgb: rgb,
        hsl: rgbToHsl(rgb[0], rgb[1], rgb[2]),
        dominance: counts[n] / pixels.length
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
        dominance: 1
      };
    }

    var MIN_SATURATION = 15;  // below this a colour reads as neutral
    var MIN_SHARE = 0.08;     // ignore specks; they are not what the image "is"

    var best = null;
    var bestScore = -1;

    for (var j = 0; j < palette.length; j++) {
      var c = palette[j];
      if (c.hsl[1] < MIN_SATURATION || c.dominance < MIN_SHARE) continue;

      // Area still leads, but chroma can lift a smaller vivid patch above a
      // larger dull one. The exponent keeps area from being overwhelmed.
      var score = c.dominance * Math.pow(c.hsl[1] / 100, 0.6);
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
