/**
 * Decode one image and cluster it, off the main thread.
 *
 * Analysis was entirely single-threaded: reading the file, building the Blob,
 * drawImage, getImageData and the k-means all ran on the panel's one JS
 * thread. Measured on a 20-core machine, raising the old concurrency dial from
 * 1 to 20 changed nothing at all - ~41 ms per image either way - because none
 * of that work was ever concurrent. Nineteen cores sat idle.
 *
 * This is the half that can genuinely move. The main thread still reads the
 * file (only it has Node), then hands the bytes over as a transferable
 * ArrayBuffer - zero copy - and the worker does the expensive part.
 *
 * The maths is not reimplemented here. ColorEngine.js is loaded as-is, so
 * extractPalette is literally the same function the main thread runs, guarded
 * by the same golden fixture. Only the route to the pixels differs:
 * createImageBitmap + OffscreenCanvas instead of Image + <canvas>, because a
 * worker has no DOM.
 */

/* global ColorEngine, OffscreenCanvas, createImageBitmap */
'use strict';

importScripts('ColorEngine.js');

/**
 * Build the pixel array exactly as ColorEngine.decode does on the main thread.
 *
 * Identical in every respect that reaches the clustering: the same scale
 * calculation, the same rounding, the same alpha cutoff, and the same
 * [r,g,b] ordering. extractPalette seeds its random source from the pixel
 * COUNT, so a single dropped or added pixel would change the whole palette.
 */
function pixelsFrom(bitmap, maxDim) {
  var w = bitmap.width;
  var h = bitmap.height;
  if (!w || !h) throw new Error('image has zero dimensions');

  var scale = Math.min(1, maxDim / Math.max(w, h));
  var tw = Math.max(1, Math.round(w * scale));
  var th = Math.max(1, Math.round(h * scale));

  var canvas = new OffscreenCanvas(tw, th);
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, tw, th);

  var data = ctx.getImageData(0, 0, tw, th).data;
  var pixels = [];

  for (var i = 0; i < data.length; i += 4) {
    // Ignore mostly-transparent pixels; they are not part of the artwork.
    if (data[i + 3] < 125) continue;
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }

  return { pixels: pixels, width: w, height: h };
}

self.onmessage = function (event) {
  var job = event.data;

  if (job && job.type === 'ping') {
    self.postMessage({ type: 'ready' });
    return;
  }

  createImageBitmap(new Blob([job.bytes], { type: job.mime }))
    .then(function (bitmap) {
      var decoded;
      try {
        decoded = pixelsFrom(bitmap, job.maxDim);
      } finally {
        // Free the decoded surface before clustering, which is the memory
        // peak when several workers are busy at once.
        try { bitmap.close(); } catch (e) {}
      }

      if (decoded.pixels.length === 0) throw new Error('no opaque pixels found');

      var result = ColorEngine.extractPalette(decoded.pixels, job.colorCount);

      self.postMessage({
        id: job.id,
        palette: result.palette,
        dominant: result.dominant,
        width: decoded.width,
        height: decoded.height,
        sampledPixels: decoded.pixels.length
      });
    })
    .catch(function (err) {
      self.postMessage({ id: job.id, error: String((err && err.message) || err) });
    });
};
