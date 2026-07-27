/**
 * ColorXBridge - panel controller.
 *
 * Orchestrates: ask Bridge what is selected -> decode and cluster each image
 * here in the panel -> hand the results back to Bridge as XMP plus colour
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
    activeFilter: null, // { name } - the colour family being shown
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
      grouping: 'medium',
      serpentine: true,
      writeXmp: true,
      writeKeywords: true // additive; drives Bridge's Filter panel
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

  function baseName(p) {
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1];
  }

  //= ==========================================================================
  // Analysis
  //= ==========================================================================

  /** Run analyses with limited concurrency so the panel stays responsive. */
  function analyzeAll(files, onProgress) {
    var results = {};
    var errors = [];
    var index = 0;
    var done = 0;
    var limit = Math.min(4, files.length);

    function worker() {
      if (index >= files.length) return Promise.resolve();
      var file = files[index++];

      return ColorEngine.analyze(file, state.settings)
        .then(function (rec) {
          rec.filePath = file;
          rec.representative =
            ColorEngine.pickRepresentative(rec.palette, state.settings.representative);
          rec.colorName = ColorNames.nameFor((rec.representative || rec.dominant).hsl);
          results[file] = rec;
        })
        .catch(function (err) {
          errors.push({ file: file, error: err.message });
        })
        .then(function () {
          done++;
          if (onProgress) onProgress(done, files.length);
          return worker();
        });
    }

    var runners = [];
    for (var i = 0; i < limit; i++) runners.push(worker());

    return Promise.all(runners).then(function () {
      return { results: results, errors: errors };
    });
  }

  function collectFiles(which) {
    var call = which === 'folder' ? 'cxbGetFolderImages()' : 'cxbGetSelection()';
    return evalScript(call).then(function (reply) {
      if (!reply.success) throw new Error(reply.error || 'Bridge refused the request');
      return reply.files || [];
    });
  }

  function run(which) {
    if (state.busy) return;
    state.busy = true;
    setStatus('Asking Bridge for files…');

    collectFiles(which)
      .then(function (files) {
        if (files.length === 0) {
          throw new Error(which === 'folder'
            ? 'No images in this folder.'
            : 'Nothing selected in Bridge. Select some images first.');
        }

        setStatus('Analysing ' + files.length + ' image' + (files.length === 1 ? '' : 's') + '…');
        setProgress(0, files.length);

        return analyzeAll(files, setProgress);
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

        var note = count + ' analysed';
        if (outcome.errors.length) note += ', ' + outcome.errors.length + ' skipped';

        if (!state.settings.writeXmp) {
          setStatus(note + ' (metadata writing off)', 'ok');
          return null;
        }

        setStatus(note + ' — writing metadata…');
        return pushToBridge(outcome.results).then(function (msg) {
          setStatus(note + ' — ' + msg, 'ok');
        });
      })
      .catch(function (err) {
        setStatus(err.message, 'error');
      })
      .then(function () {
        state.busy = false;
        setProgress(0, 0);
      });
  }

  /** Send records to Bridge to be written as XMP and colour keywords. */
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

        var embedded = 0;
        var sidecar = 0;
        var embedError = null;
        (reply.modes || []).forEach(function (m) {
          if (m.mode === 'embedded') {
            embedded++;
          } else {
            sidecar++;
            if (!embedError && m.embedError) embedError = m.embedError;
          }
        });

        // Bridge only reads sidecars for camera raw. If everything fell back,
        // the metadata is somewhere Bridge will never look - say so loudly.
        if (embedded === 0 && sidecar > 0 && embedError) {
          throw new Error('Could not embed XMP in any file (' + embedError +
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
        return evalScript('cxbRefresh("")').then(function () { return msg; })
          .catch(function () { return msg; });
      });
  }

  /** Bridge's Sort menu cannot be extended, so be plain about what this does. */
  function describeNativeSorting() {
    var box = $('sortNote');
    if (!box) return;
    box.textContent = 'Orders the list below. Bridge’s own Sort menu ' +
      'cannot be extended — to narrow the Bridge grid by colour, use the ' +
      'Colour keywords in Bridge’s Filter panel.';
  }

  //= ==========================================================================
  // Sorting
  //= ==========================================================================

  /** Below this OKLCH chroma a colour has no meaningful hue. */
  var ACHROMATIC_CHROMA = 8;

  /** Perceptual coordinates of a colour: L 0-100, C 0-100, h 0-360. */
  function lch(colour) {
    return colour.oklch ||
      ColorEngine.rgbToOklch(colour.rgb[0], colour.rgb[1], colour.rgb[2]);
  }

  /**
   * How many buckets each criterion is quantised into when it is used for
   * grouping. Coarser grouping means larger groups, which is what lets the
   * next criterion actually order anything.
   */
  var GRANULARITY = {
    fine:   { hue: 24, chroma: 8, lightness: 8, dominance: 5 },
    medium: { hue: 12, chroma: 5, lightness: 5, dominance: 4 },
    coarse: { hue: 8,  chroma: 3, lightness: 3, dominance: 3 }
  };

  var CRITERIA = [
    { key: 'hue', label: 'hue', letter: 'H', max: 359,
      raw: function (c) { return lch(c)[2]; } },
    { key: 'chroma', label: 'chroma', letter: 'C', max: 100,
      raw: function (c) { return lch(c)[1]; } },
    { key: 'lightness', label: 'lightness', letter: 'L', max: 100,
      raw: function (c) { return lch(c)[0]; } },
    { key: 'dominance', label: 'dominance', letter: 'D', max: 100,
      raw: function (c) { return Math.round(c.dominance * 100); } }
  ];

  var FIELD_WIDTH = 3;
  var ACHROMATIC_BUCKET = 9999;

  /** The colour a record is judged by, honouring the "Colour used" setting. */
  function repOf(rec) {
    return rec.representative || rec.dominant;
  }

  function isAchromatic(colour) {
    return lch(colour)[1] < ACHROMATIC_CHROMA;
  }

  function pad(n, width) {
    var s = String(Math.max(0, Math.round(n)));
    while (s.length < width) s = '0' + s;
    return s;
  }

  function enabledCriteria() {
    return CRITERIA.filter(function (c) { return state.criteria[c.key].on; });
  }

  /**
   * Quantise a criterion into buckets.
   *
   * This is the fix for the sort looking noisy. Measured on a real 1,559-image
   * folder sorted by hue then chroma then lightness: chroma at full 0-100
   * resolution produced 452 groups averaging 3.4 images, 166 of them
   * singletons. Lightness therefore never ordered anything and jumped by more
   * than 20 points between 11% of neighbours - which is visible as noise.
   *
   * Quantising every criterion *except the last* creates groups big enough for
   * the last one to sort smoothly inside.
   */
  function bucket(criterion, value) {
    var steps = GRANULARITY[state.settings.grouping][criterion.key];
    if (!steps) return value;
    var span = criterion.max + 1;
    return Math.min(steps - 1, Math.floor(value / (span / steps)));
  }

  /** Grouping key: every ticked criterion except the last, quantised. */
  function groupKey(rec) {
    var list = enabledCriteria();
    var colour = repOf(rec);
    var key = [];

    for (var i = 0; i < list.length - 1; i++) {
      var c = list[i];
      if (c.key === 'hue' && isAchromatic(colour)) key.push(ACHROMATIC_BUCKET);
      else key.push(bucket(c, c.raw(colour)));
    }
    return key;
  }

  /** The last ticked criterion, left continuous so it orders finely. */
  function fineValue(rec) {
    var list = enabledCriteria();
    if (list.length === 0) return 0;
    var last = list[list.length - 1];
    var colour = repOf(rec);

    if (last.key === 'hue' && isAchromatic(colour)) return lch(colour)[0];
    return last.raw(colour);
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

  function rebuildOrder() {
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

      return aKey < bKey ? -1 : (aKey > bKey ? 1 : 0); // stable on filename
    });

    if (state.settings.serpentine) ordered = serpentine(ordered);
    state.order = state.reverse ? ordered.reverse() : ordered;
  }

  /**
   * Filename prefixes for the finished order.
   *
   * Grouping fields stay readable, and a rank within the group carries the fine
   * ordering - including any serpentine reversal, which the raw criterion
   * values could not express on their own.
   */
  function buildPrefixes(files) {
    var list = enabledCriteria();
    var out = {};
    var rank = 0;
    var lastKey = null;

    files.forEach(function (f) {
      var rec = state.results[f];
      var key = groupKey(rec);
      var joined = key.join(',');
      if (joined !== lastKey) { rank = 0; lastKey = joined; }

      var parts = [];
      for (var i = 0; i < key.length; i++) {
        parts.push(key[i] === ACHROMATIC_BUCKET
          ? 'Z' + pad(lch(repOf(rec))[0], FIELD_WIDTH)
          : list[i].letter + pad(key[i], FIELD_WIDTH));
      }
      parts.push('S' + pad(rank++, FIELD_WIDTH));
      out[f] = parts.join('-');
    });

    return out;
  }

  /** Matches any prefix this panel has ever written, so re-runs never stack. */
  var PREFIX_RE = /^(?:[A-Z]\d{3}(?:-[A-Z]\d{3})*_|\d{4,}_)/;

  function stripPrefix(name) {
    return String(name).replace(PREFIX_RE, '');
  }

  function describeSort() {
    var list = enabledCriteria();
    if (list.length === 0) return 'nothing ticked';
    return list.map(function (c) {
      return c.label + (state.criteria[c.key].desc ? ' ▼' : ' ▲');
    }).join(' → ') + ' · ' + state.settings.grouping + ' grouping' +
      (state.settings.serpentine ? ', smoothed' : '');
  }

  /** Re-sort after a checkbox or direction change, without shouting about it. */
  function applySortQuietly() {
    if (Object.keys(state.results).length === 0 || enabledCriteria().length === 0) {
      updateRenamePreview();
      return;
    }
    rebuildOrder();
    renderResults();
    updateRenamePreview();
  }

  /** The "Colour used" setting changed, so every record needs re-judging. */
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
    setStatus('Using ' + state.settings.representative + ' colour', 'ok');
  }

  function applySort() {
    if (Object.keys(state.results).length === 0) {
      setStatus('Nothing to sort yet - analyse some images first.');
      return;
    }
    if (enabledCriteria().length === 0) {
      setStatus('Tick at least one criterion.', 'error');
      return;
    }
    rebuildOrder();
    renderResults();
    updateRenamePreview();
    setStatus('Sorted by ' + describeSort(), 'ok');
  }


  //= ==========================================================================
  // Numbering files so Bridge's own grid follows the colour order
  //= ==========================================================================

  /** Show what the next rename would do, without touching anything. */
  function updateRenamePreview() {
    var box = $('renamePreview');
    if (!box) return;

    var shown = state.order.filter(function (f) { return passesFilter(state.results[f]); });
    if (shown.length === 0 || enabledCriteria().length === 0) {
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
   * Rename files so an alphabetical sort in Bridge equals the colour order.
   *
   * Bridge's Sort menu is a fixed enum with no way to add a criterion, and its
   * manual order cannot be set from a script. Filename is the only ordering
   * Bridge exposes that can be made to carry arbitrary data, so the colour
   * order is encoded into a prefix and Bridge is switched to Sort > By Filename.
   *
   * The original name is preserved intact after the prefix, and stored in XMP,
   * so Undo is exact.
   */
  function renameForBridge() {
    var shown = state.order.filter(function (f) { return passesFilter(state.results[f]); });
    if (shown.length === 0) {
      setStatus('Nothing to number — analyse some images first.');
      return;
    }
    if (enabledCriteria().length === 0) {
      setStatus('Tick at least one criterion first.', 'error');
      return;
    }

    var prefixes = buildPrefixes(shown);
    var items = shown.map(function (f) {
      return { filePath: f, prefix: prefixes[f] };
    });

    var sample = items[0];
    if (!window.confirm(
      'Rename ' + items.length + ' file(s) so Bridge can show them in colour order?\n\n' +
      'Sorted by: ' + describeSort() + '\n\n' +
      '    ' + baseName(sample.filePath) + '\n' +
      ' →  ' + sample.prefix + '_' + stripPrefix(baseName(sample.filePath)) + '\n\n' +
      'Your original filename is kept after the prefix and saved in the file, ' +
      'so Undo restores it exactly. Pixels are not touched.')) return;

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
        setStatus(msg + '. Bridge is now sorting by filename.', 'ok');

        rekeyAfterRename(items, reply.renames || {});
      })
      .catch(function (e) { setStatus(e.message, 'error'); });
  }

  /** Restore the original filenames. */
  function undoRename() {
    var all = Object.keys(state.results);
    if (all.length === 0) {
      setStatus('Nothing to undo.');
      return;
    }
    if (!window.confirm('Restore the original filenames for ' + all.length + ' file(s)?')) return;

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
        setStatus(reply.restored + ' filename(s) restored', 'ok');
        rekeyAfterRename(all.map(function (f) { return { filePath: f }; }), reply.renames || {});
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
   * Group Bridge's own grid by colour using its five label slots.
   *
   * Bridge's Sort menu is a fixed enum with no registration API, and Label is
   * the only field it sorts on that can be made to carry a colour. It
   * overwrites any existing label, so it confirms first.
   */
  function applyColourLabels() {
    var shown = state.order.filter(function (f) { return passesFilter(state.results[f]); });
    if (shown.length === 0) {
      setStatus('Nothing to label — analyse some images first.');
      return;
    }

    var items = shown.map(function (f) {
      var slot = ColorNames.labelFor(state.results[f].dominant.hsl);
      return {
        filePath: f,
        labelText: slot ? slot.defaultText : '',
        swatch: slot ? slot.swatch : null
      };
    });

    var counts = {};
    items.forEach(function (it) {
      var k = it.swatch || 'no label (grey/black/white)';
      counts[k] = (counts[k] || 0) + 1;
    });
    var summary = Object.keys(counts).map(function (k) {
      return '  ' + k + ': ' + counts[k];
    }).join('\n');

    if (!window.confirm(
      'Set Bridge labels on ' + shown.length + ' file(s)?\n\n' + summary +
      '\n\nThis OVERWRITES any existing label. Bridge has only five label ' +
      'slots, so colours are grouped into five families.')) return;

    var payload;
    try {
      payload = writeTempJson('labels.json', items);
    } catch (e) {
      setStatus(e.message, 'error');
      return;
    }

    setStatus('Writing labels to ' + shown.length + ' file(s)…');
    evalScript('cxbApplyLabels("' + esc(payload) + '")')
      .then(function (reply) {
        if (!reply.success) throw new Error(reply.error || 'label write failed');
        var msg = reply.written + ' labelled';
        if (reply.cleared) msg += ', ' + reply.cleared + ' cleared (no hue)';
        if (reply.failed && reply.failed.length) msg += ', ' + reply.failed.length + ' failed';
        setStatus(msg + '. Bridge is now sorting by Label.', 'ok');
      })
      .catch(function (e) { setStatus(e.message, 'error'); });
  }

  /** Select everything currently listed, in order, in Bridge's content pane. */
  function selectInBridge() {
    var shown = state.order.filter(function (f) { return passesFilter(state.results[f]); });
    if (shown.length === 0) {
      setStatus('Nothing to select.');
      return;
    }

    var payload;
    try {
      payload = writeTempJson('select.json', shown);
    } catch (e) {
      setStatus(e.message, 'error');
      return;
    }

    setStatus('Selecting ' + shown.length + ' file(s) in Bridge…');
    evalScript('cxbSelectFiles("' + esc(payload) + '")')
      .then(function (reply) {
        if (reply.success) {
          setStatus('Selected ' + reply.selected + ' of ' + shown.length + ' in Bridge', 'ok');
        } else {
          setStatus('Could not select: ' + (reply.error || 'unknown'), 'error');
        }
      })
      .catch(function (e) { setStatus(e.message, 'error'); });
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
      host.innerHTML = '<div class="placeholder">Analyse images to see colours</div>';
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
        (state.order.length ? 'No images match that colour' : 'No results yet') + '</div>';
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
        btn.textContent = state.criteria[key].desc ? '\u25BC' : '\u25B2';
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();           // the button sits inside a <label>
          state.criteria[key].desc = !state.criteria[key].desc;
          btn.textContent = state.criteria[key].desc ? '\u25BC' : '\u25B2';
          applySortQuietly();
        });
      });

    var groupSelect = $('groupingSelect');
    if (groupSelect) {
      groupSelect.value = state.settings.grouping;
      groupSelect.addEventListener('change', function () {
        state.settings.grouping = groupSelect.value;
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

    var labelsBtn = $('colourLabelsBtn');
    if (labelsBtn) labelsBtn.addEventListener('click', applyColourLabels);

    var sortSelect = $('sortSelect');
    if (sortSelect) {
      sortSelect.addEventListener('change', function () {
        rebuildOrder();
        renderResults();
      });
    }

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

  function boot() {
    applyHostTheme();
    showHost();
    wire();

    if (typeof require !== 'function') {
      setStatus('Node runtime unavailable — image decoding will not work.', 'error');
    } else {
      setStatus('Ready. Select images in Bridge, then Analyse.');
    }

    describeNativeSorting();
    evalScript('cxbDiagnosticsToFile("/tmp/cxb-diag.json")').catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
