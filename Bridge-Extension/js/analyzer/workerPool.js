/**
 * A pool of decode-and-cluster workers.
 *
 * The main thread keeps the two jobs only it can do — reading files, because
 * a worker has no Node, and transcoding camera raw and PSD through `sips` —
 * and hands everything else out.
 *
 * File reads are async (fs.promises), so disk I/O overlaps with clustering
 * instead of blocking the thread that feeds the pool. Bytes go across as
 * transferable ArrayBuffers, so nothing is copied.
 *
 * Every failure path falls back to the caller's single-threaded analyse: if
 * workers cannot be created at all, if one dies, or if one job fails. A panel
 * that quietly analyses nothing would be worse than a slow one.
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
    } catch (e) {}
  }

  var WORKER_URL = 'js/analyzer/paletteWorker.js';

  /** Formats Chromium decodes natively, and the MIME to hand the worker. */
  var WEB_FORMATS = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif'
  };

  /** Formats that must go through `sips` before anything can decode them. */
  var SIPS_FORMATS = {
    tif: 1, tiff: 1, psd: 1, heic: 1, heif: 1, dng: 1, cr2: 1, cr3: 1,
    nef: 1, arw: 1, orf: 1, raf: 1, rw2: 1, pef: 1, srw: 1, jp2: 1
  };

  /**
   * How many workers to run.
   *
   * Two cores are left for the main thread and for Bridge itself, which is
   * still drawing its own grid while this runs. Capped because past a point
   * the limit is memory, not cores: each worker holds a decoded surface.
   */
  function poolSize() {
    var cores = (global.navigator && global.navigator.hardwareConcurrency) || 4;
    return Math.max(1, Math.min(cores - 2, 12));
  }

  function extensionOf(filePath) {
    var dot = filePath.lastIndexOf('.');
    return dot === -1 ? '' : filePath.slice(dot + 1).toLowerCase();
  }

  /** Transcode to a temporary PNG. Main thread only — `sips` needs Node. */
  function transcode(filePath, maxDim) {
    var tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cxb-'));
    var out = pathMod.join(tmpDir, 'preview.png');

    childProcess.execFileSync(
      '/usr/bin/sips',
      ['-s', 'format', 'png', '-Z', String(maxDim), filePath, '--out', out],
      { stdio: 'ignore', timeout: 30000 }
    );

    if (!fs.existsSync(out)) throw new Error('sips produced no output');
    return { path: out, cleanup: tmpDir };
  }

  /**
   * Read a file into an ArrayBuffer the worker can take ownership of.
   * @returns {Promise<{buffer: ArrayBuffer, mime: string}>}
   */
  function readForWorker(filePath, maxDim) {
    var ext = extensionOf(filePath);
    var mime = WEB_FORMATS[ext];
    var cleanup = null;
    var source = filePath;

    if (!mime) {
      if (!SIPS_FORMATS[ext]) {
        return Promise.reject(new Error('unsupported format: .' + ext));
      }
      try {
        var t = transcode(filePath, maxDim);
        source = t.path;
        cleanup = t.cleanup;
        mime = 'image/png';
      } catch (e) {
        return Promise.reject(e);
      }
    }

    return fs.promises.readFile(source).then(function (buf) {
      if (cleanup) {
        try { fs.rmSync(cleanup, { recursive: true, force: true }); } catch (e) {}
      }
      // Slice rather than hand over Node's shared pool buffer, whose
      // underlying ArrayBuffer is reused for other reads and would be
      // detached out from under them by the transfer.
      return {
        buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        mime: mime
      };
    }).catch(function (err) {
      if (cleanup) {
        try { fs.rmSync(cleanup, { recursive: true, force: true }); } catch (e) {}
      }
      throw err;
    });
  }

  /**
   * Analyze many files across the pool.
   *
   * @param {string[]} files
   * @param {Object} settings   {colorCount, sampleSize}
   * @param {Function} [onProgress] (done, total)
   * @returns {Promise<{results: Object, errors: Array, workers: number}>}
   *          `results` is filePath -> {dominant, palette, metadata}; a file
   *          missing from it is in `errors` and the caller should fall back.
   */
  function analyzeAll(files, settings, onProgress) {
    if (!fs || typeof global.Worker !== 'function') {
      return Promise.reject(new Error('workers unavailable'));
    }

    var colorCount = settings.colorCount || 5;
    var maxDim = settings.sampleSize || 160;
    var size = Math.min(poolSize(), files.length);

    var workers = [];
    for (var w = 0; w < size; w++) {
      try {
        workers.push(new global.Worker(WORKER_URL));
      } catch (e) {
        workers.forEach(function (x) { try { x.terminate(); } catch (e2) {} });
        return Promise.reject(new Error('could not start workers: ' + e.message));
      }
    }

    var results = {};
    var errors = [];
    var next = 0;
    var done = 0;
    var jobId = 0;

    return new Promise(function (resolve) {
      var finished = 0;

      function shutdown() {
        workers.forEach(function (x) { try { x.terminate(); } catch (e) {} });
        resolve({ results: results, errors: errors, workers: size });
      }

      function complete() {
        done++;
        if (onProgress) onProgress(done, files.length);
      }

      workers.forEach(function (worker) {
        var current = null;

        function feed() {
          if (next >= files.length) {
            finished++;
            if (finished === workers.length) shutdown();
            return;
          }

          var file = files[next++];
          current = file;
          var id = ++jobId;

          readForWorker(file, maxDim).then(function (payload) {
            worker.postMessage({
              id: id,
              bytes: payload.buffer,
              mime: payload.mime,
              maxDim: maxDim,
              colorCount: colorCount
            }, [payload.buffer]);
          }).catch(function (err) {
            errors.push({ file: file, error: err.message });
            complete();
            feed();
          });
        }

        worker.onmessage = function (event) {
          var reply = event.data;
          if (reply && reply.type === 'ready') return;

          if (reply.error) {
            errors.push({ file: current, error: reply.error });
          } else {
            results[current] = {
              dominant: reply.dominant,
              palette: reply.palette,
              metadata: {
                filePath: current,
                width: reply.width,
                height: reply.height,
                sampledPixels: reply.sampledPixels,
                analyzedAt: new Date().toISOString(),
                algorithm: 'kmeans++'
              }
            };
          }
          complete();
          feed();
        };

        worker.onerror = function (e) {
          // A dead worker must not strand the file it was holding, or the
          // queue behind it.
          if (current) errors.push({ file: current, error: 'worker: ' + (e.message || 'crashed') });
          complete();
          feed();
        };

        feed();
      });
    });
  }

  var api = {
    analyzeAll: analyzeAll,
    poolSize: poolSize,
    WORKER_URL: WORKER_URL
  };

  global.WorkerPool = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
