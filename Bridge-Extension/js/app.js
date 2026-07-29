/**
 * BridgeColorSorter - panel controller.
 *
 * Orchestrates: ask Bridge what is selected -> decode and cluster each image
 * here in the panel -> hand the results back to Bridge as XMP plus color
 * keywords, which is what Bridge's Filter panel indexes.
 */
(function () {
  'use strict';

  var fs = null;
  var os = null;
  var pathMod = null;

  if (typeof require === 'function') {
    try {
      fs = require('fs');
      os = require('os');
      pathMod = require('path');
    } catch (e) {}
  }

  var cs = new CSInterface();

  var state = {
    results: {},        // filePath -> analysis record
    order: [],          // display order
    activeFilter: null, // { name } - the color family being shown
    reverse: false,
    busy: false,
    criteria: {
      // Hue alone leaves the within-band order to the filename tiebreak, which
      // reads as noise. Lightness as the tiebreaker gives each hue band a
      // dark-to-light run, which is what makes the grid look sorted.
      hue:       { on: true,  desc: false },
      chroma:    { on: false, desc: false },
      lightness: { on: true,  desc: false },
      dominance: { on: false, desc: true }
    },
    settings: {
      colorCount: 5,
      sampleSize: 160,
      representative: 'balanced',
      sortMode: 'criteria',
      grouping: 'coarse',
      // How the hue wheel is divided into groups:
      //   'family'   one group per perceptual color family, so a family
      //              ramps once instead of splitting into two gradients
      //   'fixed'    equal 45-degree arcs, which cut wherever the arithmetic
      //              lands - on the measured folder that was the middle of
      //              the golds
      //   'adaptive' bands fitted to this folder's own color masses; rejected
      //              by eye because it lumped greens and cyans in with blues
      hueBands: 'family',
      serpentine: true,
      writeXmp: true,
      writeKeywords: true, // additive; drives Bridge's Filter panel
      forceReanalyze: false
    }
  };

  //= ==========================================================================
  // Small helpers
  //= ==========================================================================

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, kind) {
    var el = $('statusText');
    if (!el) return;
    el.textContent = msg;
    el.className = 'status ' + (kind || '');
  }

  /**
   * Mark a run as in flight, in the DOM as well as in state.
   *
   * The flag alone only made the buttons ignore clicks. Pressing Analyze
   * during an analysis then looked exactly like the panel having frozen, so
   * the CSS now dims the actions while one is running.
   */
  function setBusy(busy) {
    state.busy = busy;
    if (document.body) document.body.classList.toggle('is-busy', busy);
  }

  function setProgress(done, total) {
    var wrap = $('progressSection');
    var fill = $('progressFill');
    var text = $('progressText');
    if (!wrap) return;

    if (total <= 0) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    if (fill) fill.style.width = Math.round((done / total) * 100) + '%';
    if (text) text.textContent = done + ' / ' + total;
  }

  function evalScript(script) {
    return new Promise(function (resolve, reject) {
      cs.evalScript(script, function (raw) {
        if (raw === 'EvalScript error.') {
          reject(new Error('ExtendScript failed: ' + script.slice(0, 60)));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('Bad reply from Bridge: ' + String(raw).slice(0, 200)));
        }
      });
    });
  }

  /** Escape a string for embedding inside an ExtendScript string literal. */
  function esc(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
  }

  function writeTempJson(name, data) {
    if (!fs) throw new Error('Node unavailable; cannot hand data to Bridge');
    var dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cxb-'));
    var file = pathMod.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    return file;
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var baseName = Naming.baseName;
  var stripPrefix = Naming.stripPrefix;
  var pad = Naming.pad;

  /** Human-readable duration. Speed on large folders is the point. */
  function fmtSeconds(ms) {
    if (ms < 1000) return ms + ' ms';
    return (ms / 1000).toFixed(1) + ' s';
  }

  //= ==========================================================================
  // Analysis
  //= ==========================================================================

  /** Everything a raw {dominant, palette} needs before the panel can use it. */
  function completeRecord(rec, file) {
    rec.filePath = file;
    rec.representative =
      ColorEngine.pickRepresentative(rec.palette, state.settings.representative);
    rec.colorName = ColorNames.nameFor((rec.representative || rec.dominant).hsl);
    return rec;
  }

  /**
   * Analyze across a pool of workers, falling back to the main thread.
   *
   * The fallback matters more than the speed: if workers cannot start, if one
   * dies, or if a single file fails inside one, that file is analyzed here
   * instead. A panel that quietly analyzed nothing would be worse than a slow
   * one, and this project has already shipped one silent success.
   */
  function analyzeAll(files, onProgress) {
    if (typeof WorkerPool === 'undefined' || typeof Worker !== 'function') {
      return analyzeOnMainThread(files, onProgress);
    }

    return WorkerPool.analyzeAll(files, state.settings, onProgress)
      .then(function (outcome) {
        var results = {};
        Object.keys(outcome.results).forEach(function (f) {
          results[f] = completeRecord(outcome.results[f], f);
        });

        var stranded = outcome.errors.map(function (e) { return e.file; })
          .filter(function (f) { return f && !results[f]; });

        if (stranded.length === 0) {
          return { results: results, errors: outcome.errors, workers: outcome.workers };
        }

        // Retry whatever the pool could not do, here. Formats Chromium cannot
        // decode at all will fail again and be reported, which is correct.
        return analyzeOnMainThread(stranded).then(function (retry) {
          Object.keys(retry.results).forEach(function (f) { results[f] = retry.results[f]; });
          return { results: results, errors: retry.errors, workers: outcome.workers };
        });
      })
      .catch(function (err) {
        setStatus('Workers unavailable (' + err.message + '), analyzing on one thread…');
        return analyzeOnMainThread(files, onProgress);
      });
  }

  /**
   * The single-threaded path, kept as the fallback.
   *
   * The concurrency here is close to meaningless - measured at 1, 2, 4, 8, 12,
   * 16 and 20 it was ~41 ms per image every time, because the file read, the
   * Blob, drawImage, getImageData and the clustering all run on this one
   * thread. Four only bounds how many decoded images are resident at once.
   */
  var ANALYSIS_CONCURRENCY = 4;

  function analyzeOnMainThread(files, onProgress) {
    var results = {};
    var errors = [];
    var index = 0;
    var done = 0;
    var limit = Math.min(ANALYSIS_CONCURRENCY, files.length);

    function runner() {
      if (index >= files.length) return Promise.resolve();
      var file = files[index++];

      return ColorEngine.analyze(file, state.settings)
        .then(function (rec) {
          results[file] = completeRecord(rec, file);
        })
        .catch(function (err) {
          errors.push({ file: file, error: err.message });
        })
        .then(function () {
          done++;
          if (onProgress) onProgress(done, files.length);
          return runner();
        });
    }

    var runners = [];
    for (var i = 0; i < limit; i++) runners.push(runner());

    return Promise.all(runners).then(function () {
      return { results: results, errors: errors, workers: 0 };
    });
  }

  /** Rebuild a full record from the compact form stored in XMP. */
  function recordFromStored(filePath, stored) {
    // HSL and OKLCH are recomputed from the hex rather than stored, so the
    // color spaces can change without invalidating every file's cache.
    var palette = StoredPalette.parse(stored.palette).map(function (c) {
      return {
        hex: c.hex,
        rgb: c.rgb,
        hsl: ColorEngine.rgbToHsl(c.rgb[0], c.rgb[1], c.rgb[2]),
        oklch: ColorEngine.rgbToOklch(c.rgb[0], c.rgb[1], c.rgb[2]),
        dominance: c.dominance
      };
    });

    if (palette.length === 0) return null;

    var rec = {
      filePath: filePath,
      palette: palette,
      dominant: palette[0],
      metadata: { analyzedAt: stored.analyzedAt, fromCache: true }
    };
    rec.representative =
      ColorEngine.pickRepresentative(palette, state.settings.representative);
    rec.colorName = ColorNames.nameFor(repOf(rec).hsl);
    return rec;
  }

  /**
   * Fetch color data already embedded in the files.
   *
   * Analysis dominates the runtime, and the answer is normally sitting in each
   * file's XMP from the previous run. Reading it back turns a several-minute
   * re-analysis of a large folder into a few seconds.
   */
  function loadStored(files) {
    // A failed cache read is not fatal - everything is simply re-analyzed -
    // but it turns a 4-second re-order into a several-minute one, so the
    // reason is carried back rather than silently absorbed.
    function noCache(why) {
      return { cached: {}, remaining: files, warning: why };
    }

    if (state.settings.forceReanalyze) {
      return Promise.resolve({ cached: {}, remaining: files });
    }

    var payload;
    try {
      payload = writeTempJson('paths.json', files);
    } catch (e) {
      return Promise.resolve(noCache('could not hand the file list to Bridge: ' +
        e.message));
    }

    return evalScript('cxbReadColorBatch("' + esc(payload) + '")')
      .then(function (reply) {
        if (!reply.success) {
          return noCache('Bridge could not read saved color data: ' +
            (reply.error || 'unknown'));
        }

        var cached = {};
        var remaining = [];
        var unparsable = 0;

        files.forEach(function (f) {
          var stored = reply.data ? reply.data[f] : null;
          var rec = stored ? recordFromStored(f, stored) : null;
          if (rec) { cached[f] = rec; return; }
          // Stored but unreadable is different from never analyzed: it means
          // the palette string in XMP did not parse.
          if (stored) unparsable++;
          remaining.push(f);
        });

        return {
          cached: cached,
          remaining: remaining,
          elapsedMs: reply.elapsedMs,
          warning: unparsable
            ? unparsable + ' file(s) had saved color data that would not parse'
            : null
        };
      })
      .catch(function (e) {
        return noCache('saved color data could not be read: ' + e.message);
      });
  }

  function collectFiles(which) {
    var call = which === 'folder' ? 'cxbGetFolderImages()' : 'cxbGetSelection()';
    return evalScript(call).then(function (reply) {
      if (!reply.success) throw new Error(reply.error || 'Bridge refused the request');

      var files = reply.files || [];
      if (files.length > 0) {
        // Losing a few files to unreadable thumbnails is worth saying out loud;
        // it is otherwise indistinguishable from those files not existing.
        if (reply.unreadable) {
          setStatus(reply.unreadable + ' item(s) had no readable path and were ' +
            'skipped.', 'error');
        }
        return files;
      }

      // Empty needs a reason. "Select some images first" is a lie when the
      // selection was full of things whose paths Bridge would not hand over.
      if (reply.noDocument) throw new Error('Bridge has no folder open.');
      if (reply.unreadable) {
        throw new Error('Bridge would not give a path for any of the ' +
          reply.unreadable + ' selected item(s). Try clicking into the folder ' +
          'in Bridge first.');
      }
      if (reply.notImages) {
        throw new Error('None of the ' + reply.notImages + ' selected item(s) ' +
          'are image formats BridgeColorSorter can read.');
      }
      throw new Error(which === 'folder'
        ? 'No images in this folder.'
        : 'Nothing selected in Bridge. Select some images first.');
    });
  }

  function run(which) {
    if (state.busy) return;
    setBusy(true);
    setStatus('Asking Bridge for files…');

    collectFiles(which)
      .then(function (files) {
        setStatus('Checking ' + files.length + ' file' +
          (files.length === 1 ? '' : 's') + ' for saved color data…');

        return loadStored(files).then(function (split) {
          var todo = split.remaining;

          if (todo.length === 0) {
            setStatus('Loaded ' + files.length + ' from saved data' +
              (split.elapsedMs ? ' in ' + fmtSeconds(split.elapsedMs) : ''));
            return {
              results: split.cached, errors: [], reused: files.length, fresh: 0,
              warning: split.warning
            };
          }

          setStatus((split.remaining.length === files.length
            ? 'Analysing ' + todo.length
            : 'Reusing ' + (files.length - todo.length) + ', analyzing ' + todo.length) +
            ' image' + (todo.length === 1 ? '' : 's') + '…');
          setProgress(0, todo.length);

          var analysisStart = Date.now();
          return analyzeAll(todo, setProgress).then(function (outcome) {
            var merged = {};
            for (var a in split.cached) {
              if (split.cached.hasOwnProperty(a)) merged[a] = split.cached[a];
            }
            for (var b in outcome.results) {
              if (outcome.results.hasOwnProperty(b)) merged[b] = outcome.results[b];
            }
            return {
              results: merged,
              errors: outcome.errors,
              reused: Object.keys(split.cached).length,
              fresh: outcome.results,
              freshCount: Object.keys(outcome.results).length,
              analysisMs: Date.now() - analysisStart,
              warning: split.warning
            };
          });
        });
      })
      .then(function (outcome) {
        var count = Object.keys(outcome.results).length;
        if (count === 0) {
          throw new Error('Could not read any of those images.' +
            (outcome.errors[0] ? ' (' + outcome.errors[0].error + ')' : ''));
        }

        // Merge into existing results so repeated runs accumulate.
        for (var k in outcome.results) {
          if (outcome.results.hasOwnProperty(k)) state.results[k] = outcome.results[k];
        }
        rebuildOrder();
        renderSwatches();
        renderResults();
        updateRenamePreview();

        var note = outcome.reused
          ? outcome.reused + ' reused' +
            (outcome.freshCount ? ', ' + outcome.freshCount + ' analyzed' : '')
          : count + ' analyzed';
        if (outcome.freshCount && outcome.analysisMs) {
          note += ' in ' + fmtSeconds(outcome.analysisMs) +
            ' (' + Math.round(outcome.analysisMs / outcome.freshCount) + ' ms each)';
        }
        if (outcome.errors.length) note += ', ' + outcome.errors.length + ' skipped';

        // A cache miss the user did not ask for is the difference between a
        // few seconds and several minutes, so it is stated rather than left to
        // be inferred from the wait.
        if (outcome.warning) note += ' — ' + outcome.warning;

        // Only newly analyzed files need writing; the rest came from XMP.
        var toWrite = outcome.fresh && typeof outcome.fresh === 'object' ? outcome.fresh : {};
        if (!state.settings.writeXmp || Object.keys(toWrite).length === 0) {
          setStatus(note, outcome.warning ? 'error' : 'ok');
          return null;
        }

        setStatus(note + ' — writing metadata…');
        return pushToBridge(toWrite).then(function (msg) {
          setStatus(note + ' — ' + msg, outcome.warning ? 'error' : 'ok');
        });
      })
      .catch(function (err) {
        setStatus(err.message, 'error');
      })
      .then(function () {
        setBusy(false);
        setProgress(0, 0);
      });
  }

  /** Send records to Bridge to be written as XMP and color keywords. */
  function pushToBridge(results) {
    var records = [];
    for (var k in results) {
      if (results.hasOwnProperty(k)) records.push(results[k]);
    }

    var payload;
    try {
      payload = writeTempJson('results.json', {
        records: records,
        options: { writeKeywords: state.settings.writeKeywords }
      });
    } catch (e) {
      return Promise.reject(e);
    }

    return evalScript('cxbApplyResults("' + esc(payload) + '")')
      .then(function (reply) {
        if (!reply.success) throw new Error(reply.error || 'metadata write failed');

        var embedded = reply.embedded || 0;
        var sidecar = reply.sidecar || 0;

        // Bridge only reads sidecars for camera raw. If everything fell back,
        // the metadata is somewhere Bridge will never look - say so loudly.
        if (embedded === 0 && sidecar > 0 && reply.embedError) {
          throw new Error('Could not embed XMP in any file (' + reply.embedError +
            '). Bridge only reads .xmp sidecars for camera raw, so these ' +
            'keywords will not appear in the Filter panel.');
        }

        var bits = [];
        if (embedded) bits.push(embedded + ' embedded');
        if (sidecar) bits.push(sidecar + ' sidecar');
        var msg = 'metadata written (' + bits.join(', ') + ')';
        if (reply.failed && reply.failed.length) {
          msg += ', ' + reply.failed.length + ' failed';
        }
        if (reply.elapsedMs) msg += ' in ' + fmtSeconds(reply.elapsedMs);

        return evalScript('cxbRefresh()').then(function () { return msg; })
          .catch(function () { return msg; });
      });
  }

  /** Bridge's Sort menu cannot be extended, so be plain about what this does. */
  function describeNativeSorting() {
    var box = $('sortNote');
    if (!box) return;
    box.textContent = 'Orders the list below. Bridge’s own Sort menu ' +
      'cannot be extended — to narrow the Bridge grid by color, use the ' +
      'Colour keywords in Bridge’s Filter panel.';
  }

  //= ==========================================================================
  // Sorting
  //= ==========================================================================

  // Below this OKLCH chroma a color has no hue worth grouping by. Defined in
  // js/hueBands.js and read from there rather than repeated: a second copy of
  // a threshold is a second thing to forget to change, which is exactly how
  // the prefix pattern drifted apart from the host script's copy.
  var ACHROMATIC_CHROMA = HueBands.ACHROMATIC_CHROMA;

  /** Perceptual coordinates of a color: L 0-100, C 0-100, h 0-360. */
  function lch(color) {
    return color.oklch ||
      ColorEngine.rgbToOklch(color.rgb[0], color.rgb[1], color.rgb[2]);
  }

  /**
   * How many buckets each criterion is quantized into when it is used for
   * grouping. Coarser grouping means larger groups, which is what lets the
   * next criterion actually order anything.
   */
  var GRANULARITY = {
    fine:   { hue: 24, chroma: 8, lightness: 8, dominance: 5 },
    medium: { hue: 12, chroma: 5, lightness: 5, dominance: 4 },
    coarse: { hue: 8,  chroma: 3, lightness: 3, dominance: 3 }
  };

  /**
   * How light the whole image reads, 0-100.
   *
   * NOT the lightness of the representative color, which is what this used to
   * sort on. The representative is one swatch — the most colorful significant
   * cluster — and on a real folder its lightness disagrees with the image's by
   * 14 points on average, and by more than 20 points for a quarter of the
   * library. The worst case measured was a bright tile whose representative was
   * a near-black blue accent at L 21 against an actual lightness of 73: sorting
   * put it at the dark end of the blue ramp, where it read as noise.
   *
   * The eye judges a thumbnail by the whole tile, so the ramp has to be built
   * on the whole tile. Ordering on this instead cut the mean lightness step
   * between neighbors from 8.16 to 0.34.
   *
   * Returned CONTINUOUS, not rounded. Rounding here made the ordering depend
   * on where a value sat relative to an x.5 boundary, and the dominance stored
   * in XMP carries only three decimals — so a file analyzed fresh and the same
   * file read back from its own cache could round to 36 and 37 and swap places.
   * Measured on the 1,559-image folder: 598 files differed that way between a
   * fresh analysis and a cached re-read, which meant the panel's list no longer
   * matched the order its own filenames encoded.
   *
   * Everything that writes this into a filename goes through pad(), which
   * rounds. So the sort is continuous and the displayed field is an integer,
   * which is the right way round.
   *
   * Cached on the record: it is read once per comparison in a sort.
   */
  function meanLightness(rec) {
    if (rec._meanL !== undefined) return rec._meanL;

    var palette = rec.palette || [];
    var sum = 0;
    var weight = 0;
    for (var i = 0; i < palette.length; i++) {
      var c = palette[i];
      sum += ColorEngine.rgbToOklab(c.rgb[0], c.rgb[1], c.rgb[2])[0] * c.dominance;
      weight += c.dominance;
    }

    rec._meanL = weight > 0
      ? (sum / weight) * 100
      : lch(repOf(rec))[0];
    return rec._meanL;
  }

  // `raw` takes the representative color AND the record: hue and chroma are
  // properties of the chosen swatch, lightness is a property of the picture.
  var CRITERIA = [
    { key: 'hue', label: 'hue', letter: 'H', max: 359,
      raw: function (c) { return lch(c)[2]; } },
    { key: 'chroma', label: 'chroma', letter: 'C', max: 100,
      raw: function (c) { return lch(c)[1]; } },
    { key: 'lightness', label: 'lightness', letter: 'L', max: 100,
      raw: function (c, rec) { return meanLightness(rec); } },
    { key: 'dominance', label: 'dominance', letter: 'D', max: 100,
      raw: function (c) { return Math.round(c.dominance * 100); } }
  ];

  var FIELD_WIDTH = 3;
  var ACHROMATIC_BUCKET = 9999;

  /** The color a record is judged by, honouring the "Color used" setting. */
  function repOf(rec) {
    return rec.representative || rec.dominant;
  }

  /**
   * A sort key that survives renaming: the user's own filename, with any
   * prefix this panel wrote stripped off. Used only to break exact ties, where
   * the relative order of two records is otherwise arbitrary.
   */
  function stableKey(filePath) {
    return stripPrefix(baseName(filePath));
  }

  function isAchromatic(color) {
    return lch(color)[1] < ACHROMATIC_CHROMA;
  }

  function enabledCriteria() {
    return CRITERIA.filter(function (c) { return state.criteria[c.key].on; });
  }

  /**
   * Quantize a criterion into buckets.
   *
   * This is the fix for the sort looking noisy. Measured on a real 1,559-image
   * folder sorted by hue then chroma then lightness: chroma at full 0-100
   * resolution produced 452 groups averaging 3.4 images, 166 of them
   * singletons. Lightness therefore never ordered anything and jumped by more
   * than 20 points between 11% of neighbors - which is visible as noise.
   *
   * Quantising every criterion *except the last* creates groups big enough for
   * the last one to sort smoothly inside.
   */
  function bucket(criterion, value) {
    // Hue is circular and its groups are fitted to the folder, so it does not
    // use the fixed-width scheme the linear criteria do.
    if (criterion.key === 'hue') return HueBands.bandOf(value, hueCuts());

    var steps = GRANULARITY[state.settings.grouping][criterion.key];
    if (!steps) return value;
    var span = criterion.max + 1;
    return Math.min(steps - 1, Math.floor(value / (span / steps)));
  }

  /**
   * Where the hue wheel is cut for the current set of results.
   *
   * Recomputed whenever the results or the grouping change, and cached in
   * between: every comparison in a sort asks for it.
   */
  var hueCutCache = null;

  function invalidateHueBands() { hueCutCache = null; }

  function hueCuts() {
    if (hueCutCache) return hueCutCache;

    if (state.settings.hueBands === 'family') {
      hueCutCache = HueBands.FAMILY_CUTS;
      return hueCutCache;
    }

    if (state.settings.hueBands === 'fixed') {
      var arcs = GRANULARITY[state.settings.grouping].hue;
      hueCutCache = [];
      for (var f = 0; f < arcs; f++) hueCutCache.push(Math.round(f * 360 / arcs));
      return hueCutCache;
    }

    var hues = [];
    Object.keys(state.results).forEach(function (k) {
      var color = repOf(state.results[k]);
      if (!isAchromatic(color)) hues.push(lch(color)[2]);
    });

    hueCutCache = HueBands.cuts(
      hues, state.settings.grouping, GRANULARITY[state.settings.grouping].hue);
    return hueCutCache;
  }

  /** Grouping key: every ticked criterion except the last, quantized. */
  function groupKey(rec) {
    var list = enabledCriteria();
    var color = repOf(rec);
    var key = [];

    for (var i = 0; i < list.length - 1; i++) {
      var c = list[i];
      if (c.key === 'hue' && isAchromatic(color)) key.push(ACHROMATIC_BUCKET);
      else key.push(bucket(c, c.raw(color, rec)));
    }
    return key;
  }

  /** The last ticked criterion, left continuous so it orders finely. */
  function fineValue(rec) {
    var list = enabledCriteria();
    if (list.length === 0) return 0;
    var last = list[list.length - 1];
    var color = repOf(rec);

    // A gray has no hue to order by, so the only axis with anything to say
    // about it is how light it is.
    if (last.key === 'hue' && isAchromatic(color)) return meanLightness(rec);
    return last.raw(color, rec);
  }

  function compareGroups(a, b) {
    var ka = groupKey(a);
    var kb = groupKey(b);
    var list = enabledCriteria();

    for (var i = 0; i < ka.length; i++) {
      if (ka[i] === kb[i]) continue;
      // The achromatic band sorts last, whichever way the rest is going.
      if (ka[i] === ACHROMATIC_BUCKET || kb[i] === ACHROMATIC_BUCKET) {
        return ka[i] === ACHROMATIC_BUCKET ? 1 : -1;
      }
      return state.criteria[list[i].key].desc ? kb[i] - ka[i] : ka[i] - kb[i];
    }
    return 0;
  }

  /**
   * Reverse every second group, so the fine criterion runs dark-to-light then
   * light-to-dark instead of snapping back at each boundary. Without this the
   * grid shows a sawtooth: a smooth run, a hard reset, another smooth run.
   */
  function serpentine(ordered) {
    var out = [];
    var group = [];
    var lastKey = null;
    var flip = false;

    function flush() {
      if (group.length === 0) return;
      out = out.concat(flip ? group.slice().reverse() : group);
      flip = !flip;
      group = [];
    }

    for (var i = 0; i < ordered.length; i++) {
      var k = groupKey(state.results[ordered[i]]).join(',');
      if (lastKey !== null && k !== lastKey) flush();
      lastKey = k;
      group.push(ordered[i]);
    }
    flush();
    return out;
  }

  /**
   * Order by whole-palette similarity instead of by criteria.
   *
   * Each image keeps its full palette, and the images are arranged into a path
   * where each is as close as possible to the one before it. Measured on a
   * 1,559-image folder this halves the mean perceptual gap between neighbors
   * compared with sorting on a single representative color, because a busy
   * artwork is not one color and sorting on one throws the rest away.
   */
  function rebuildOrderBySimilarity() {
    var records = Object.keys(state.results).map(function (k) {
      return { key: k, palette: state.results[k].palette };
    });
    // Cluster first, then walk a path inside each block. A single path over
    // the whole set is smooth between neighbors but has no global structure:
    // it consumes the dense regions first and its tail wanders, scattering
    // blues through the reds. Clustering keeps each color region contiguous.
    var groups = { coarse: 8, medium: 14, fine: 24 }[state.settings.grouping] || 14;

    state.order = Similarity.orderByClusters(records, {
      maxColors: state.settings.colorCount,
      groups: groups
    });
    if (state.reverse) state.order = state.order.slice().reverse();
  }

  function rebuildOrder() {
    // The hue groups are fitted to the set being sorted, so they are stale the
    // moment the set or the granularity changes. Recomputed here, once, rather
    // than inside the comparator.
    invalidateHueBands();

    if (state.settings.sortMode === 'similarity') {
      rebuildOrderBySimilarity();
      return;
    }

    var list = enabledCriteria();
    if (list.length === 0) { state.order = Object.keys(state.results); return; }

    var lastDesc = state.criteria[list[list.length - 1].key].desc;

    var ordered = Object.keys(state.results).sort(function (aKey, bKey) {
      var a = state.results[aKey];
      var b = state.results[bKey];

      var g = compareGroups(a, b);
      if (g !== 0) return g;

      var d = fineValue(a) - fineValue(b);
      if (d !== 0) return lastDesc ? -d : d;

      // Ties break on the ORIGINAL filename, not the current one. Numbering
      // rewrites the current name, so tiebreaking on it made the order depend
      // on whether the folder had been numbered before: pressing "Number
      // files" a second time reshuffled the tied items and renamed 134 of 400
      // for no reason. The stripped name does not move, so a second run is now
      // a no-op.
      var na = stableKey(aKey);
      var nb = stableKey(bKey);
      return na < nb ? -1 : (na > nb ? 1 : 0);
    });

    if (state.settings.serpentine) ordered = serpentine(ordered);
    state.order = state.reverse ? ordered.reverse() : ordered;
  }

  /**
   * Filename prefixes for the finished order.
   *
   * Every ticked criterion appears as its own labelled field, in priority
   * order, so the name says what it sorted on: H002-L059_photo.jpg is hue
   * band 2, lightness 59.
   *
   * Smoothing complicates this. It reverses every second group, and a raw
   * value cannot express that - sorting alphabetically on lightness would undo
   * the reversal. So when smoothing is on, a rank field is inserted *before*
   * the fine value: H002-S045-L059_photo.jpg. Sorting then runs on H then S,
   * while L rides along purely as information.
   *
   * Separators are hyphens inside the prefix and an underscore only at the
   * boundary, so the original filename stays unambiguous to strip on Undo.
   */
  function buildPrefixes(files) {
    // A similarity path is a sequence, not a set of sortable values, so the
    // position itself has to carry the order. The representative color rides
    // along as information, the same way the fine value does elsewhere.
    if (state.settings.sortMode === 'similarity') {
      var width = Math.max(4, String(files.length).length);
      var seqOut = {};
      files.forEach(function (f, i) {
        var c = lch(repOf(state.results[f]));
        seqOut[f] = 'P' + pad(i, width) +
          '-H' + pad(c[2], FIELD_WIDTH) + '-L' + pad(c[0], FIELD_WIDTH);
      });
      return seqOut;
    }

    var list = enabledCriteria();
    if (list.length === 0) return {};

    var last = list[list.length - 1];
    var smoothing = state.settings.serpentine;
    var out = {};
    var rank = 0;
    var lastKey = null;

    files.forEach(function (f) {
      var rec = state.results[f];
      var color = repOf(rec);
      var key = groupKey(rec);
      var joined = key.join(',');
      if (joined !== lastKey) { rank = 0; lastKey = joined; }

      var parts = [];

      // Grouping criteria, quantized, in priority order.
      for (var i = 0; i < key.length; i++) {
        parts.push(key[i] === ACHROMATIC_BUCKET
          ? 'Z' + pad(meanLightness(rec), FIELD_WIDTH)
          : list[i].letter + pad(key[i], FIELD_WIDTH));
      }

      // The rank has to precede the fine value, or the value would drive the
      // sort and cancel the serpentine reversal.
      if (smoothing) parts.push('S' + pad(rank, FIELD_WIDTH));
      rank++;

      // The final criterion's real value - ordering when unsmoothed,
      // information when smoothed.
      var fine = (last.key === 'hue' && isAchromatic(color))
        ? meanLightness(rec)
        : last.raw(color, rec);
      parts.push(last.letter + pad(fine, FIELD_WIDTH));

      out[f] = parts.join('-');
    });

    return out;
  }

  function describeSort() {
    if (state.settings.sortMode === 'similarity') return 'whole-palette similarity';
    var list = enabledCriteria();
    if (list.length === 0) return 'nothing ticked';
    return list.map(function (c) {
      return c.label + (state.criteria[c.key].desc ? ' ▼' : ' ▲');
    }).join(' → ') + ' · ' + state.settings.grouping + ' grouping' +
      (state.settings.serpentine ? ', smoothed' : '');
  }

  /** Re-sort after a checkbox or direction change, without shouting about it. */
  function applySortQuietly() {
    if (Object.keys(state.results).length === 0) { updateRenamePreview(); return; }
    if (state.settings.sortMode === 'criteria' && enabledCriteria().length === 0) {
      updateRenamePreview();
      return;
    }
    rebuildOrder();
    renderResults();
    updateRenamePreview();
  }

  /** The "Color used" setting changed, so every record needs re-judging. */
  function recomputeRepresentatives() {
    Object.keys(state.results).forEach(function (f) {
      var rec = state.results[f];
      rec.representative =
        ColorEngine.pickRepresentative(rec.palette, state.settings.representative);
      rec.colorName = ColorNames.nameFor(repOf(rec).hsl);
    });
    rebuildOrder();
    renderSwatches();
    renderResults();
    updateRenamePreview();
    setStatus('Using ' + state.settings.representative + ' color', 'ok');
  }

  function applySort() {
    if (Object.keys(state.results).length === 0) {
      setStatus('Nothing to sort yet - analyse some images first.');
      return;
    }
    if (state.settings.sortMode === 'criteria' && enabledCriteria().length === 0) {
      setStatus('Tick at least one criterion.', 'error');
      return;
    }
    setStatus('Ordering ' + Object.keys(state.results).length + ' images…');
    rebuildOrder();
    renderResults();
    updateRenamePreview();
    setStatus('Sorted by ' + describeSort(), 'ok');
  }


  //= ==========================================================================
  // Numbering files so Bridge's own grid follows the color order
  //= ==========================================================================

  /** Show what the next rename would do, without touching anything. */
  function updateRenamePreview() {
    var box = $('renamePreview');
    if (!box) return;

    var shown = state.order.filter(function (f) { return passesFilter(state.results[f]); });
    if (shown.length === 0 ||
        (state.settings.sortMode === 'criteria' && enabledCriteria().length === 0)) {
      box.textContent = '';
      return;
    }

    var first = shown[0];
    var name = stripPrefix(baseName(first));
    var prefixes = buildPrefixes(shown);
    box.textContent = 'Prefix example:  ' + prefixes[first] + '_' + name +
      '   (' + shown.length + ' files · ' + describeSort() + ')';
  }

  /**
   * Rename files so an alphabetical sort in Bridge equals the color order.
   *
   * Bridge's Sort menu is a fixed enum with no way to add a criterion, and its
   * manual order cannot be set from a script. Filename is the only ordering
   * Bridge exposes that can be made to carry arbitrary data, so the color
   * order is encoded into a prefix and Bridge is switched to Sort > By Filename.
   *
   * The original name is preserved intact after the prefix, and stored in XMP,
   * so Undo is exact.
   */
  /**
   * Narrow a list of results to the folder Bridge is actually showing.
   *
   * Results accumulate across runs so repeated analyses build up, which is
   * right for the list — but catastrophic for anything that renames. Analysing
   * one folder, moving to another and pressing Undo used to rename files in
   * BOTH, because the rename paths read the whole accumulated set. That is a
   * silent edit to files the user is not even looking at.
   *
   * @returns {Promise<{here: string[], elsewhere: number, folder: string}>}
   */
  function scopeToCurrentFolder(candidates) {
    return evalScript('cxbGetFolderImages()').then(function (reply) {
      if (!reply.success || !reply.files) {
        throw new Error('Could not ask Bridge which folder is open.');
      }
      var inFolder = {};
      reply.files.forEach(function (f) { inFolder[f] = true; });

      var here = candidates.filter(function (f) { return inFolder[f]; });
      return {
        here: here,
        elsewhere: candidates.length - here.length,
        folder: reply.folder || 'this folder'
      };
    });
  }

  /** Warn about results belonging to other folders, which will be left alone. */
  function otherFolderNote(scope) {
    return scope.elsewhere
      ? '\n\n' + scope.elsewhere + ' other analyzed file(s) are not in this ' +
        'folder and will NOT be touched.'
      : '';
  }

  function renameForBridge() {
    var shown = state.order.filter(function (f) { return passesFilter(state.results[f]); });
    if (shown.length === 0) {
      setStatus('Nothing to number — analyse some images first.');
      return;
    }
    if (state.settings.sortMode === 'criteria' && enabledCriteria().length === 0) {
      setStatus('Tick at least one criterion first.', 'error');
      return;
    }

    setStatus('Checking which files are in this folder…');
    scopeToCurrentFolder(shown).then(function (scope) {
      if (scope.here.length === 0) {
        setStatus('None of the listed files are in the folder Bridge is ' +
          'showing, so there is nothing to number here.', 'error');
        return;
      }

      // Prefixes are built from the scoped list, so the numbering runs
      // 0..n across what is actually being renamed.
      var prefixes = buildPrefixes(scope.here);
      var items = scope.here.map(function (f) {
        return { filePath: f, prefix: prefixes[f] };
      });

      var sample = items[0];
      if (!window.confirm(
        'Rename ' + items.length + ' file(s) in “' + scope.folder + '” so Bridge ' +
        'can show them in color order?\n\n' +
        'Sorted by: ' + describeSort() + '\n\n' +
        '    ' + baseName(sample.filePath) + '\n' +
        ' →  ' + sample.prefix + '_' + stripPrefix(baseName(sample.filePath)) + '\n\n' +
        'Your original filename is kept after the prefix and saved in the file, ' +
        'so Undo restores it exactly. Pixels are not touched.' +
        otherFolderNote(scope))) return;

      applyPrefixes(items);
    }).catch(function (e) { setStatus(e.message, 'error'); });
  }

  function applyPrefixes(items) {
    var payload;
    try {
      payload = writeTempJson('rename.json', items);
    } catch (e) {
      setStatus(e.message, 'error');
      return;
    }

    setStatus('Renaming ' + items.length + ' file(s)…');
    evalScript('cxbApplyPrefixes("' + esc(payload) + '")')
      .then(function (reply) {
        if (!reply.success) throw new Error(reply.error || 'rename failed');

        var msg = reply.renamed + ' renamed';
        if (reply.skipped) msg += ', ' + reply.skipped + ' already correct';
        if (reply.failed && reply.failed.length) msg += ', ' + reply.failed.length + ' failed';
        if (reply.orphanedSidecars) {
          msg += ', ' + reply.orphanedSidecars + ' .xmp sidecar(s) left orphaned';
        }

        // Re-key first: the files really were renamed, so the panel's state is
        // stale whatever the warnings below say.
        rekeyAfterRename(items, reply.renames || {});

        // Undo guesses the original name from the prefix when XMP could not
        // record it. That guess is wrong for a file legitimately named like
        // "A123_photo.jpg", so say so now rather than at Undo time.
        if (reply.nameUnrecorded) {
          setStatus(msg + ' — but the original filename could not be saved for ' +
            reply.nameUnrecorded + ' file(s) (' + (reply.nameError || 'unknown') +
            '). Undo will fall back to stripping the prefix, which is exact ' +
            'only if none of your filenames already look like a prefix.', 'error');
          return;
        }
        if (reply.sortError) {
          setStatus(msg + ', but Bridge refused to switch to Sort by Filename (' +
            reply.sortError + '). Set it yourself to see the color order.', 'error');
          return;
        }
        setStatus(msg + '. Bridge is now sorting by filename.', 'ok');
      })
      .catch(function (e) { setStatus(e.message, 'error'); });
  }

  /**
   * Restore the original filenames, in the folder Bridge is showing.
   *
   * Scoped deliberately. This used to run over every result accumulated in the
   * session — `Object.keys(state.results)` — so after analyzing one folder and
   * moving to another, Undo silently renamed files in both. It was doing
   * exactly what it was told, on files the user could not see.
   */
  function undoRename() {
    var all = Object.keys(state.results);
    if (all.length === 0) {
      setStatus('Nothing to undo.');
      return;
    }

    setStatus('Checking which files are in this folder…');
    scopeToCurrentFolder(all).then(function (scope) {
      if (scope.here.length === 0) {
        setStatus('None of the analyzed files are in the folder Bridge is ' +
          'showing, so there is nothing to undo here.', 'error');
        return;
      }
      if (!window.confirm(
        'Restore the original filenames for ' + scope.here.length +
        ' file(s) in “' + scope.folder + '”?' + otherFolderNote(scope))) return;

      restoreNames(scope.here);
    }).catch(function (e) { setStatus(e.message, 'error'); });
  }

  function restoreNames(all) {
    var payload;
    try {
      payload = writeTempJson('undo.json', all);
    } catch (e) {
      setStatus(e.message, 'error');
      return;
    }

    setStatus('Restoring filenames…');
    evalScript('cxbRestoreNames("' + esc(payload) + '")')
      .then(function (reply) {
        if (!reply.success) throw new Error(reply.error || 'restore failed');
        rekeyAfterRename(all.map(function (f) { return { filePath: f }; }), reply.renames || {});

        var msg = reply.restored + ' filename(s) restored';
        if (reply.failed && reply.failed.length) msg += ', ' + reply.failed.length + ' failed';

        // An exact restore reads the name back from XMP. Stripping the prefix
        // is a guess, so say when it was used instead of reporting a clean win.
        if (reply.fromStrip) {
          setStatus(msg + ' — ' + reply.fromStrip + ' of them by stripping the ' +
            'prefix rather than from the saved original name. Check those ' +
            'filenames.', reply.fromXmp ? '' : 'error');
          return;
        }
        setStatus(msg, 'ok');
      })
      .catch(function (e) { setStatus(e.message, 'error'); });
  }

  /**
   * Results are keyed by path, and renaming invalidates those keys. Re-key from
   * the map Bridge returned so the list, filters and Undo keep working without
   * a re-analysis.
   */
  function rekeyAfterRename(items, renames) {
    var moved = {};

    Object.keys(state.results).forEach(function (oldPath) {
      var rec = state.results[oldPath];
      var newPath = renames[oldPath] || oldPath;
      rec.filePath = newPath;
      moved[newPath] = rec;
    });

    state.results = moved;
    rebuildOrder();
    renderResults();
    updateRenamePreview();
  }

  /**
   * Select everything currently listed, in Bridge's content pane.
   *
   * Not truncated. The old 500-file cap was sized against a crash that turned
   * out to be caused by constructing a Thumbnail per file, not by the size of
   * the selection; with that gone, 1,559 files select in 3.6 s and Bridge is
   * fine. Silently selecting a third of what the user asked for is worse than
   * a wait they agreed to, so above the threshold it asks and then does all of
   * them.
   */
  var SELECTION_WARN_AT = 1000;

  /** Measured on this folder: ~2.3 ms per file, slightly superlinear. */
  function estimateSelectSeconds(count) {
    return Math.max(1, Math.round(count * 0.0023));
  }

  function selectInBridge() {
    var shown = state.order.filter(function (f) { return passesFilter(state.results[f]); });
    if (shown.length === 0) {
      setStatus('Nothing to select.');
      return;
    }

    if (shown.length > SELECTION_WARN_AT && !window.confirm(
      'Select all ' + shown.length + ' listed files in Bridge?\n\n' +
      'Bridge selects them one at a time, so this takes about ' +
      estimateSelectSeconds(shown.length) + ' seconds and Bridge will be busy ' +
      'until it finishes. Nothing is modified.')) return;

    var payload;
    try {
      payload = writeTempJson('select.json', { paths: shown });
    } catch (e) {
      setStatus(e.message, 'error');
      return;
    }

    setStatus('Selecting ' + shown.length + ' in Bridge…');
    evalScript('cxbSelectFiles("' + esc(payload) + '")')
      .then(function (reply) {
        if (!reply.success) throw new Error(reply.error || 'could not select');

        return confirmSelection(reply.attempted).then(function (count) {
          var msg = 'Selected ' + count + ' in Bridge';
          if (reply.elapsedMs) msg += ' in ' + fmtSeconds(reply.elapsedMs);
          if (reply.notInFolder) {
            msg += '; ' + reply.notInFolder + ' are not in the folder Bridge is showing';
          }

          // The count comes from Bridge itself. Reporting what was asked for
          // rather than what happened is how this button spent a release
          // claiming to select 500 files while selecting none at all.
          if (count !== reply.attempted) {
            setStatus(msg + ' — but ' + reply.attempted + ' were requested. ' +
              'Bridge did not take the whole selection.', 'error');
            return;
          }
          setStatus(msg, 'ok');
        });
      })
      .catch(function (e) { setStatus(e.message, 'error'); });
  }

  /**
   * Read the selection back from Bridge, polling until it settles.
   *
   * Bridge updates app.document.selections lazily: immediately after selecting
   * 1,559 files it still reports 0, and only becomes truthful a few hundred
   * milliseconds later. A single read would therefore call a working selection
   * a failure, so this waits for the expected count and gives up with whatever
   * Bridge last said.
   */
  function confirmSelection(expected) {
    var attempts = 8;
    var gap = 250;

    function poll() {
      return evalScript('cxbSelectionCount()').then(function (r) {
        var count = (r && r.success) ? r.count : -1;
        if (count === expected || --attempts <= 0) return count;
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(poll()); }, gap);
        });
      });
    }
    return poll().catch(function () { return -1; });
  }


  //= ==========================================================================
  // Rendering
  //= ==========================================================================

  function renderSwatches() {
    var host = $('colorSwatches');
    if (!host) return;

    var buckets = {};
    state.order.forEach(function (file) {
      var rec = state.results[file];
      var name = rec.colorName;
      if (!buckets[name]) {
        buckets[name] = { name: name, hex: rec.dominant.hex, hue: rec.dominant.hsl[0], count: 0 };
      }
      buckets[name].count++;
    });

    var list = Object.keys(buckets).map(function (n) { return buckets[n]; });
    if (list.length === 0) {
      host.innerHTML = '<div class="placeholder">Analyze images to see colors</div>';
      return;
    }

    list.sort(function (a, b) { return b.count - a.count; });

    host.innerHTML = list.map(function (b) {
      var active = state.activeFilter && state.activeFilter.name === b.name ? ' active' : '';
      return '<button class="swatch' + active + '" data-name="' + escapeHtml(b.name) + '"' +
        ' data-hue="' + b.hue + '" style="background:' + escapeHtml(b.hex) + '"' +
        ' title="' + escapeHtml(b.name + ' — ' + b.count + ' image(s)') + '">' +
        '<span class="swatch-count">' + b.count + '</span></button>';
    }).join('');

    Array.prototype.forEach.call(host.querySelectorAll('.swatch'), function (el) {
      el.addEventListener('click', function () {
        var name = el.getAttribute('data-name');
        state.activeFilter = (state.activeFilter && state.activeFilter.name === name)
          ? null
          : { name: name };
        renderSwatches();
        renderResults();
      });
    });
  }

  function passesFilter(rec) {
    if (!state.activeFilter) return true;
    return rec.colorName === state.activeFilter.name;
  }

  function renderResults() {
    var host = $('resultsList');
    if (!host) return;

    var shown = state.order.filter(function (f) { return passesFilter(state.results[f]); });

    if (shown.length === 0) {
      host.innerHTML = '<div class="placeholder">' +
        (state.order.length ? 'No images match that color' : 'No results yet') + '</div>';
      updateCount(0);
      return;
    }

    host.innerHTML = shown.map(function (file) {
      var rec = state.results[file];
      var d = repOf(rec);
      var strip = (rec.palette || []).slice(0, 5).map(function (c) {
        return '<i style="background:' + escapeHtml(c.hex) + '"></i>';
      }).join('');

      return '<div class="result" data-file="' + escapeHtml(file) + '">' +
        '<div class="result-top">' +
        '<span class="chip" style="background:' + escapeHtml(d.hex) + '"></span>' +
        '<span class="result-name" title="' + escapeHtml(file) + '">' +
        escapeHtml(baseName(file)) + '</span>' +
        '</div>' +
        '<div class="result-meta">' + escapeHtml(rec.colorName) + ' · ' +
        escapeHtml(d.hex) + ' · h' + lch(d)[2] +
        ' C' + lch(d)[1] + ' L' + lch(d)[0] +
        ' · ' + Math.round(d.dominance * 100) + '%</div>' +
        '<div class="strip">' + strip + '</div>' +
        '</div>';
    }).join('');

    Array.prototype.forEach.call(host.querySelectorAll('.result'), function (el) {
      el.addEventListener('click', function () {
        revealInBridge(el.getAttribute('data-file'));
      });
    });

    updateCount(shown.length);
  }

  function updateCount(n) {
    var el = $('resultCount');
    if (el) el.textContent = n ? n + ' shown' : '';
  }

  /** Select the clicked file in Bridge's content pane. */
  function revealInBridge(file) {
    evalScript('cxbRevealFile("' + esc(file) + '")')
      .then(function (reply) {
        if (reply.success) setStatus('Selected ' + baseName(file) + ' in Bridge', 'ok');
        else setStatus('Could not select it: ' + (reply.error || 'unknown'), 'error');
      })
      .catch(function (e) { setStatus(e.message, 'error'); });
  }

  //= ==========================================================================
  // Theme + wiring
  //= ==========================================================================

  function applyHostTheme() {
    try {
      var info = cs.getHostEnvironment().appSkinInfo;
      var bg = info.panelBackgroundColor.color;
      var root = document.documentElement;
      root.style.setProperty('--cxb-bg', 'rgb(' +
        Math.round(bg.red) + ',' + Math.round(bg.green) + ',' + Math.round(bg.blue) + ')');
      var light = (bg.red + bg.green + bg.blue) / 3 > 128;
      root.setAttribute('data-theme', light ? 'light' : 'dark');
    } catch (e) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  }

  function showHost() {
    var el = $('hostInfo');
    if (!el) return;
    try {
      var env = cs.getHostEnvironment();
      el.textContent = env.appName + ' ' + env.appVersion;
    } catch (e) {
      el.textContent = '';
    }
  }

  function wire() {
    var analyze = $('analyzeBtn');
    if (analyze) analyze.addEventListener('click', function () { run('selection'); });

    var analyzeAllBtn = $('analyzeAllBtn');
    if (analyzeAllBtn) analyzeAllBtn.addEventListener('click', function () { run('folder'); });

    var sortBtn = $('sortBtn');
    if (sortBtn) sortBtn.addEventListener('click', applySort);

    var renameBtn = $('renameBtn');
    if (renameBtn) renameBtn.addEventListener('click', renameForBridge);

    var undoBtn = $('undoRenameBtn');
    if (undoBtn) undoBtn.addEventListener('click', undoRename);

    // Criterion checkboxes and their direction toggles.
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-criterion]'), function (box) {
        var key = box.getAttribute('data-criterion');
        box.checked = state.criteria[key].on;
        box.addEventListener('change', function () {
          state.criteria[key].on = box.checked;
          applySortQuietly();
        });
      });

    Array.prototype.forEach.call(
      document.querySelectorAll('[data-dir]'), function (btn) {
        var key = btn.getAttribute('data-dir');
        label(btn, key);
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();           // the button sits inside a <label>
          state.criteria[key].desc = !state.criteria[key].desc;
          label(btn, key);
          applySortQuietly();
        });
      });

    /**
     * Say what the direction actually means for this criterion. A bare
     * triangle told the user nothing about what it would do.
     */
    function label(btn, key) {
      var desc = state.criteria[key].desc;
      var words = {
        hue:       ['red to violet', 'violet to red'],
        chroma:    ['dull to vivid', 'vivid to dull'],
        lightness: ['dark to light', 'light to dark'],
        dominance: ['weakest first', 'strongest first']
      }[key] || ['ascending', 'descending'];

      btn.textContent = (desc ? '\u2193 ' : '\u2191 ') + words[desc ? 1 : 0];
    }

    var modeSelect = $('sortModeSelect');
    if (modeSelect) {
      modeSelect.value = state.settings.sortMode;
      modeSelect.addEventListener('change', function () {
        state.settings.sortMode = modeSelect.value;
        reflectSortMode();
        applySortQuietly();
      });
    }

    var groupSelect = $('groupingSelect');
    if (groupSelect) {
      groupSelect.value = state.settings.grouping;
      groupSelect.addEventListener('change', function () {
        state.settings.grouping = groupSelect.value;
        applySortQuietly();
      });
    }

    var bandsSelect = $('hueBandsSelect');
    if (bandsSelect) {
      bandsSelect.value = state.settings.hueBands;
      bandsSelect.addEventListener('change', function () {
        state.settings.hueBands = bandsSelect.value;
        applySortQuietly();
      });
    }

    var smoothToggle = $('serpentineToggle');
    if (smoothToggle) {
      smoothToggle.checked = state.settings.serpentine;
      smoothToggle.addEventListener('change', function () {
        state.settings.serpentine = smoothToggle.checked;
        applySortQuietly();
      });
    }

    var repSelect = $('representativeSelect');
    if (repSelect) {
      repSelect.value = state.settings.representative;
      repSelect.addEventListener('change', function () {
        state.settings.representative = repSelect.value;
        recomputeRepresentatives();
      });
    }

    var reverseBtn = $('reverseBtn');
    if (reverseBtn) {
      reverseBtn.addEventListener('click', function () {
        state.reverse = !state.reverse;
        applySort();
      });
    }

    var selectBtn = $('selectInBridgeBtn');
    if (selectBtn) selectBtn.addEventListener('click', selectInBridge);


    var clear = $('clearFilterBtn');
    if (clear) {
      clear.addEventListener('click', function () {
        state.activeFilter = null;
        renderSwatches();
        renderResults();
      });
    }

    var reset = $('resetBtn');
    if (reset) {
      reset.addEventListener('click', function () {
        state.results = {};
        state.order = [];
        state.activeFilter = null;
        renderSwatches();
        renderResults();
        setStatus('Cleared');
      });
    }

    var count = $('colorCountInput');
    if (count) {
      count.addEventListener('change', function () {
        state.settings.colorCount = Math.max(2, Math.min(12, parseInt(count.value, 10) || 5));
        count.value = state.settings.colorCount;
      });
    }

    bindToggle('writeXmpToggle', 'writeXmp');
    bindToggle('writeKeywordsToggle', 'writeKeywords');
    bindToggle('forceReanalyzeToggle', 'forceReanalyze');
  }

  function bindToggle(id, key, after) {
    var el = $(id);
    if (!el) return;
    el.checked = state.settings[key];
    el.addEventListener('change', function () {
      state.settings[key] = el.checked;
      if (after) after();
    });
  }

  /** Grey out the criteria controls when they have no effect. */
  function reflectSortMode() {
    var off = state.settings.sortMode === 'similarity';
    var box = $('criteriaBlock');
    if (box) {
      box.style.opacity = off ? '0.4' : '1';
      box.style.pointerEvents = off ? 'none' : 'auto';
    }
    var note = $('modeNote');
    if (note) {
      note.textContent = off
        ? 'Every image is placed next to the one it most resembles across its ' +
          'whole palette, so the criteria below do not apply.'
        : '';
    }
  }

  function boot() {
    applyHostTheme();
    showHost();
    wire();

    if (typeof require !== 'function') {
      setStatus('Node runtime unavailable — image decoding will not work.', 'error');
    } else {
      setStatus('Ready. Select images in Bridge, then Analyze.');
    }

    reflectSortMode();
    describeNativeSorting();
    evalScript('cxbDiagnosticsToFile("/tmp/cxb-diag.json")').catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
