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
    settings: {
      colorCount: 5,
      sampleSize: 160,
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
          rec.colorName = ColorNames.nameFor(rec.dominant.hsl);
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

  /** Below this saturation a colour has no meaningful hue. */
  var ACHROMATIC_SATURATION = 10;

  var SORT_KEYS = {
    // Greys, white and black all report hue 0, which would scatter them
    // through the reds. Sort them as a separate band at the end, by lightness.
    hue: {
      compare: function (a, b) {
        var aFlat = a.dominant.hsl[1] < ACHROMATIC_SATURATION;
        var bFlat = b.dominant.hsl[1] < ACHROMATIC_SATURATION;
        if (aFlat !== bFlat) return aFlat ? 1 : -1;
        if (aFlat) return a.dominant.hsl[2] - b.dominant.hsl[2];
        return a.dominant.hsl[0] - b.dominant.hsl[0];
      }
    },
    saturation: { get: function (r) { return r.dominant.hsl[1]; } },
    brightness: { get: function (r) { return r.dominant.hsl[2]; } },
    dominance: { get: function (r) { return r.dominant.dominance; }, descending: true }
  };

  function rebuildOrder() {
    var key = ($('sortSelect') || {}).value || 'hue';
    var spec = SORT_KEYS[key] || SORT_KEYS.hue;
    var flip = !!spec.descending !== state.reverse;

    var compare = spec.compare || function (a, b) {
      return spec.get(a) - spec.get(b);
    };

    // Sort one way, then reverse the finished list. Flipping the comparator
    // instead would leave tied items in their original order, so "reverse"
    // would not be an exact mirror.
    var ordered = Object.keys(state.results).sort(function (aKey, bKey) {
      var d = compare(state.results[aKey], state.results[bKey]);
      if (d !== 0) return d;
      return aKey < bKey ? -1 : (aKey > bKey ? 1 : 0); // stable on filename
    });

    state.order = flip ? ordered.reverse() : ordered;
  }

  function applySort() {
    if (Object.keys(state.results).length === 0) {
      setStatus('Nothing to sort yet — analyse some images first.');
      return;
    }
    rebuildOrder();
    renderResults();

    var key = ($('sortSelect') || {}).value || 'hue';
    setStatus('Sorted by ' + key + (state.reverse ? ' (reversed)' : '') +
      ' — click a row to select it in Bridge', 'ok');
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
      var d = rec.dominant;
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
        escapeHtml(d.hex) + ' · H' + Math.round(d.hsl[0]) +
        ' S' + Math.round(d.hsl[1]) + ' L' + Math.round(d.hsl[2]) +
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
